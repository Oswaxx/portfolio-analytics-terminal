"""
indicators.py — Technical indicators for portfolio_web.
Fuentes: Binance (crypto), Finnhub (stocks), CoinPaprika (dominancia BTC).
"""

import csv
import json
import logging
import math
import os
import threading
import time
from datetime import datetime

import numpy as np
import pandas as pd
import requests

try:
    import feedparser as _feedparser
    _HAS_FEEDPARSER = True
except ImportError:
    _HAS_FEEDPARSER = False

log = logging.getLogger(__name__)

# ── API key ────────────────────────────────────────────────────────────────────
def _load_finnhub_key() -> str:
    try:
        _p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'api_keys.json')
        with open(_p) as f:
            return json.load(f).get('finnhub_key', '')
    except Exception:
        return ''

FINNHUB_KEY = _load_finnhub_key()

# ── In-memory cache ────────────────────────────────────────────────────────────
_CACHE: dict = {}
_CACHE_TTL   = 300   # 5 min — bg thread refreshes every 3 min, so always fresh
_LOCK        = threading.Lock()


def _cget(key):
    with _LOCK:
        e = _CACHE.get(key)
        if e and time.monotonic() - e['ts'] < _CACHE_TTL:
            return e['v']
    return None


def _cset(key, value):
    with _LOCK:
        _CACHE[key] = {'ts': time.monotonic(), 'v': value}


# ── Asset map ──────────────────────────────────────────────────────────────────
ASSET_MAP = {
    'BTC':  {'type': 'crypto', 'id': 'BTCUSDT'},
    'ETH':  {'type': 'crypto', 'id': 'ETHUSDT'},
    'SOL':  {'type': 'crypto', 'id': 'SOLUSDT'},
    'XRP':  {'type': 'crypto', 'id': 'XRPUSDT'},
    'DOGE': {'type': 'crypto', 'id': 'DOGEUSDT'},
    'TTWO': {'type': 'stock',  'id': 'TTWO'},
}

# ── Binance history (crypto) ───────────────────────────────────────────────────

def _binance_history(symbol: str, days: int = 90) -> pd.DataFrame:
    key = f'bn_{symbol}_{days}'
    cached = _cget(key)
    if cached is not None:
        return cached
    try:
        r = requests.get(
            'https://api.binance.com/api/v3/klines',
            params={'symbol': symbol, 'interval': '1d', 'limit': min(days, 1000)},
            timeout=6,
        )
        if r.status_code != 200:
            log.warning('Binance klines %s: HTTP %s', symbol, r.status_code)
            return pd.DataFrame()
        cols = ['open_time','open','high','low','close','volume',
                'close_time','quote_vol','trades','taker_base','taker_quote','ignore']
        df = pd.DataFrame(r.json(), columns=cols)
        df['ds'] = pd.to_datetime(df['open_time'], unit='ms').dt.normalize()
        df['y']  = df['close'].astype(float)
        _cset(f'bn_vol_{symbol}', float(df['volume'].astype(float).tail(7).mean()))
        df = df[['ds', 'y']].drop_duplicates('ds').sort_values('ds').reset_index(drop=True)
        _cset(key, df)
        return df
    except Exception as exc:
        log.warning('Binance history %s: %s', symbol, exc)
        return pd.DataFrame()


# ── yfinance history (stocks) — free, no API key needed ───────────────────────

def _yf_history(ticker: str, days: int = 365) -> pd.DataFrame:
    key = f'yf_{ticker}_{days}'
    cached = _cget(key)
    if cached is not None:
        return cached
    try:
        import yfinance as yf
        import datetime
        end_date   = datetime.date.today()
        start_date = end_date - datetime.timedelta(days=days)
        hist = yf.Ticker(ticker).history(
            start=str(start_date), end=str(end_date), auto_adjust=True
        )
        if hist.empty:
            log.warning('yfinance history %s: empty', ticker)
            return pd.DataFrame()
        hist = hist.reset_index()
        date_col = 'Date' if 'Date' in hist.columns else hist.columns[0]
        df = pd.DataFrame({
            'ds': pd.to_datetime(hist[date_col]).dt.tz_localize(None).dt.normalize(),
            'y':  hist['Close'].astype(float),
        })
        if 'Volume' in hist.columns:
            # cache last trading day volume as 24h proxy for stocks
            _cset(f'fh_vol_{ticker}', float(hist['Volume'].astype(float).iloc[-1]))
        df = df.sort_values('ds').reset_index(drop=True)
        _cset(key, df)
        return df
    except Exception as exc:
        log.warning('yfinance history %s: %s', ticker, exc)
        return pd.DataFrame()


def _get_history(asset: str) -> pd.DataFrame:
    info = ASSET_MAP.get(asset.upper(), {})
    if info.get('type') == 'crypto':
        return _binance_history(info['id'], days=90)
    return _yf_history(info.get('id', asset), days=365)


# ── Indicator math ─────────────────────────────────────────────────────────────

def _rsi(prices: pd.Series, period: int = 14) -> float:
    if len(prices) < period + 2:
        return float('nan')
    d    = prices.diff().dropna()
    gain = d.clip(lower=0).ewm(com=period - 1, adjust=False).mean()
    loss = (-d.clip(upper=0)).ewm(com=period - 1, adjust=False).mean()
    rs   = gain.iloc[-1] / (loss.iloc[-1] if loss.iloc[-1] != 0 else 1e-9)
    return round(100 - 100 / (1 + rs), 2)


def _ma(prices: pd.Series, period: int) -> float:
    if len(prices) < period:
        return float('nan')
    return round(float(prices.iloc[-period:].mean()), 6)


def _macd_full(prices: pd.Series, fast=12, slow=26, signal=9):
    if len(prices) < slow + signal:
        return None, None, None, [], [], []
    ema_f  = prices.ewm(span=fast,   adjust=False).mean()
    ema_s  = prices.ewm(span=slow,   adjust=False).mean()
    macd_s = ema_f - ema_s
    sig_s  = macd_s.ewm(span=signal, adjust=False).mean()
    hist_s = macd_s - sig_s

    def _tail(s):
        return [None if math.isnan(v) else round(v, 6) for v in s.iloc[-60:].tolist()]

    return (
        round(float(macd_s.iloc[-1]), 6),
        round(float(sig_s.iloc[-1]),  6),
        round(float(hist_s.iloc[-1]), 6),
        _tail(macd_s), _tail(sig_s), _tail(hist_s),
    )


def _bollinger(prices: pd.Series, period=20, k=2):
    if len(prices) < period:
        return None, None, None
    rm    = prices.rolling(period).mean()
    rs    = prices.rolling(period).std()
    upper = float((rm + k * rs).iloc[-1])
    mid   = float(rm.iloc[-1])
    lower = float((rm - k * rs).iloc[-1])
    return round(upper, 6), round(mid, 6), round(lower, 6)


def _ma_signal(price, ma50, ma200, ma50_prev=None, ma200_prev=None) -> str:
    n50  = math.isnan(ma50)  if isinstance(ma50,  float) else ma50  is None
    n200 = math.isnan(ma200) if isinstance(ma200, float) else ma200 is None
    if n50 and n200:
        return 'N/D'
    if n200:
        return 'Alcista' if price > ma50 else 'Bajista'
    if ma50_prev is not None and ma200_prev is not None:
        p50  = ma50_prev  if not (isinstance(ma50_prev,  float) and math.isnan(ma50_prev))  else None
        p200 = ma200_prev if not (isinstance(ma200_prev, float) and math.isnan(ma200_prev)) else None
        if p50 and p200:
            if p50 <= p200 and ma50 > ma200:
                return 'Golden Cross'
            if p50 >= p200 and ma50 < ma200:
                return 'Death Cross'
    if price > ma50 and ma50 > ma200:
        return 'Alcista fuerte'
    if price > ma50 and ma50 <= ma200:
        return 'Recuperación'
    if price < ma50 and ma50 < ma200:
        return 'Bajista'
    return 'Lateral'


# ── Market-wide data ──────────────────────────────────────────────────────────

def get_fear_greed() -> dict:
    cached = _cget('fear_greed')
    if cached is not None:
        return cached
    try:
        r = requests.get('https://api.alternative.me/fng/', params={'limit': 1}, timeout=8)
        if r.status_code == 200:
            d      = r.json()['data'][0]
            result = {'value': int(d['value']), 'label': d['value_classification']}
            _cset('fear_greed', result)
            return result
    except Exception as exc:
        log.warning('Fear&Greed: %s', exc)
    return {'value': None, 'label': 'N/D'}


def get_btc_dominance() -> dict:
    cached = _cget('btc_dom')
    if cached is not None:
        return cached
    try:
        r = requests.get('https://api.coinpaprika.com/v1/global', timeout=8)
        if r.status_code == 200:
            dom    = round(float(r.json()['bitcoin_dominance_percentage']), 2)
            interp = ('BTC dominante — Altcoins bajo presión' if dom > 55
                      else 'Altseason posible'                if dom < 45
                      else 'Mercado equilibrado')
            result = {'dominance': dom, 'interpretation': interp}
            _cset('btc_dom', result)
            return result
    except Exception as exc:
        log.warning('BTC dominance: %s', exc)
    return {'dominance': None, 'interpretation': 'N/D'}


def _get_binance_volumes(symbols: list) -> dict:
    """Fetch 24h quote volume for each crypto symbol individually in parallel.
    Batch endpoint requires literal JSON array in URL which requests URL-encodes (HTTP 400).
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    cached = _cget('bn_volumes')
    if cached is not None:
        return cached
    if not symbols:
        return {}

    def _fetch_one_vol(symbol):
        try:
            r = requests.get(
                'https://api.binance.com/api/v3/ticker/24hr',
                params={'symbol': symbol},
                timeout=6,
            )
            if r.status_code == 200:
                return symbol, float(r.json()['quoteVolume'])
        except Exception as exc:
            log.warning('Binance volume %s: %s', symbol, exc)
        return symbol, None

    result = {}
    with ThreadPoolExecutor(max_workers=min(len(symbols), 8)) as ex:
        futs = {ex.submit(_fetch_one_vol, s): s for s in symbols}
        for fut in as_completed(futs):
            sym, vol = fut.result()
            if vol is not None:
                result[sym] = vol

    if result:
        _cset('bn_volumes', result)
    return result


# ── News sentiment ─────────────────────────────────────────────────────────────

_POS = {'surge', 'rally', 'bullish', 'adoption', 'partnership', 'ath', 'growth',
        'gain', 'rise', 'pump', 'soar', 'record', 'high', 'buy', 'milestone'}
_NEG = {'crash', 'ban', 'hack', 'bearish', 'dump', 'lawsuit', 'fraud', 'fall',
        'drop', 'loss', 'sell', 'fear', 'down', 'decline', 'plunge', 'warning',
        'risk', 'attack', 'scam', 'investigation', 'collapse'}

_COIN_KEYS = {
    'BTC':  ['bitcoin', 'btc'],
    'ETH':  ['ethereum', 'eth'],
    'SOL':  ['solana', 'sol'],
    'XRP':  ['ripple', 'xrp'],
    'DOGE': ['dogecoin', 'doge'],
    'TTWO': ['take-two', 'ttwo', '2k games', 'rockstar'],
}
_CRYPTO_TICKERS = {'BTC', 'ETH', 'SOL', 'XRP', 'DOGE'}


def _score(text: str) -> int:
    t = text.lower()
    p = sum(1 for w in _POS if w in t)
    n = sum(1 for w in _NEG if w in t)
    return 1 if p > n else (-1 if n > p else 0)


def get_news_sentiment(asset: str) -> dict:
    key    = f'sentiment_{asset}'
    cached = _cget(key)
    if cached is not None:
        return cached

    keywords = _COIN_KEYS.get(asset.upper(), [asset.lower()])
    articles = []

    if asset.upper() in _CRYPTO_TICKERS:
        try:
            r = requests.get(
                'https://cryptopanic.com/api/free/v1/posts/',
                params={'auth_token': 'free', 'currencies': asset.upper(), 'public': 'true'},
                timeout=4,
            )
            if r.status_code == 200:
                for item in r.json().get('results', [])[:6]:
                    title = item.get('title', '')
                    if title:
                        articles.append({'title': title, 'source': 'CryptoPanic'})
        except Exception:
            pass

    if not articles and _HAS_FEEDPARSER:
        try:
            feed = _feedparser.parse('https://www.coindesk.com/arc/outboundfeeds/rss/')
            for entry in feed.entries[:30]:
                title = entry.get('title', '')
                if any(kw in title.lower() for kw in keywords):
                    articles.append({'title': title, 'source': 'CoinDesk'})
                if len(articles) >= 6:
                    break
        except Exception:
            pass

    if not articles:
        r = {'score': None, 'label': 'N/D', 'articles': []}
        _cset(key, r)
        return r

    scored = [
        {**a, 's': _score(a['title']),
         'label': ('Positivo' if _score(a['title']) > 0
                   else ('Negativo' if _score(a['title']) < 0 else 'Neutral'))}
        for a in articles[:6]
    ]
    avg    = round(sum(a['s'] for a in scored) / len(scored) * 100)
    label  = 'Positivo' if avg > 10 else ('Negativo' if avg < -10 else 'Neutral')
    result = {
        'score': avg, 'label': label,
        'articles': [{'title': a['title'], 'source': a['source'],
                      'sentiment_label': a['label']} for a in scored[:3]],
    }
    _cset(key, result)
    return result


# ── Per-asset indicator computation ───────────────────────────────────────────

def compute_indicators(asset: str) -> dict:
    key    = f'ind_{asset}'
    cached = _cget(key)
    if cached is not None:
        return cached

    info = ASSET_MAP.get(asset.upper())
    if not info:
        return {'asset': asset, 'error': 'Unknown asset'}

    df        = _get_history(asset)
    empty     = df.empty or len(df) < 10
    sentiment = get_news_sentiment(asset)

    if empty:
        return {
            'asset': asset, 'rsi': None, 'rsi_label': 'N/D',
            'ma50': None, 'ma200': None, 'ma_signal': 'N/D',
            'macd': None, 'macd_signal_val': None, 'macd_hist': None,
            'macd_trend': 'N/D', 'macd_dates': [], 'macd_vals': [],
            'macd_sig_vals': [], 'macd_hist_vals': [],
            'bb_upper': None, 'bb_mid': None, 'bb_lower': None,
            'bb_position': 'N/D', 'bb_width': None,
            'sentiment': sentiment, 'volume_24h': None,
        }

    prices = df['y']
    dates  = df['ds'].dt.strftime('%Y-%m-%d').tolist()
    cur    = float(prices.iloc[-1])

    rsi       = _rsi(prices)
    rsi_val   = None if math.isnan(rsi) else rsi
    rsi_label = ('Sobrecomprado' if rsi_val and rsi_val > 70
                 else ('Sobrevendido' if rsi_val and rsi_val < 30 else 'Neutral'))

    ma50   = _ma(prices, 50)
    ma200  = _ma(prices, 200)
    ma50p  = _ma(prices.iloc[:-1], 50)  if len(prices) > 50  else float('nan')
    ma200p = _ma(prices.iloc[:-1], 200) if len(prices) > 200 else float('nan')
    ma50_safe  = None if math.isnan(ma50)  else ma50
    ma200_safe = None if math.isnan(ma200) else ma200
    ma_sig     = _ma_signal(cur, ma50, ma200, ma50p, ma200p)

    mv, sv, hv, ms, ss, hs = _macd_full(prices)
    macd_dates = dates[-len(ms):] if ms else []
    macd_trend = 'N/D'
    if mv is not None and sv is not None:
        macd_trend = 'Alcista' if mv > sv else 'Bajista'

    bb_u, bb_m, bb_l = _bollinger(prices)
    bb_pos   = 'N/D'
    bb_width = None
    if bb_u is not None:
        bb_width = round((bb_u - bb_l) / bb_m * 100, 2) if bb_m else None
        if cur >= bb_u * 0.97:
            bb_pos = 'Cerca de banda superior'
        elif cur <= bb_l * 1.03:
            bb_pos = 'Cerca de banda inferior'
        else:
            bb_pos = 'Dentro de bandas'

    result = {
        'asset': asset, 'price': cur,
        'rsi': rsi_val, 'rsi_label': rsi_label,
        'ma50': ma50_safe, 'ma200': ma200_safe, 'ma_signal': ma_sig,
        'macd': mv, 'macd_signal_val': sv, 'macd_hist': hv,
        'macd_trend': macd_trend,
        'macd_dates': macd_dates, 'macd_vals': ms,
        'macd_sig_vals': ss, 'macd_hist_vals': hs,
        'bb_upper': bb_u, 'bb_mid': bb_m, 'bb_lower': bb_l,
        'bb_position': bb_pos, 'bb_width': bb_width,
        'sentiment': sentiment, 'volume_24h': None,
    }
    _cset(key, result)
    return result


def compute_all_indicators(assets: list, **_kwargs) -> dict:
    """Return {asset: indicators_dict} for all assets with volumes attached.
    Assets are computed in parallel — reduces wall-clock from O(n×t) to O(t).
    **_kwargs absorbs legacy callers that pass markets_cache=...
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    crypto_symbols = [ASSET_MAP[a]['id'] for a in assets
                      if ASSET_MAP.get(a, {}).get('type') == 'crypto']
    bn_volumes = _get_binance_volumes(crypto_symbols) if crypto_symbols else {}

    def _one(asset):
        info = ASSET_MAP.get(asset.upper(), {})
        ind  = compute_indicators(asset)
        if info.get('type') == 'crypto':
            symbol            = info.get('id', '')
            ind['volume_24h'] = bn_volumes.get(symbol)
            vol7              = _cget(f'bn_vol_{symbol}')
            ind['vol_7d_avg'] = float(vol7) if vol7 is not None else None
        else:
            vol7              = _cget(f"fh_vol_{info.get('id', asset)}")
            ind['volume_24h'] = float(vol7) if vol7 is not None else None
            ind['vol_7d_avg'] = None
        return asset, ind

    result = {}
    n = len(assets)
    with ThreadPoolExecutor(max_workers=min(n, 6)) as ex:
        futs = {ex.submit(_one, a): a for a in assets}
        for fut in as_completed(futs):
            asset = futs[fut]
            try:
                a, ind = fut.result()
                result[a] = ind
            except Exception as exc:
                log.error('compute_indicators %s: %s', asset, exc)
                result[asset] = {'asset': asset, 'error': str(exc)}
    return result


# ── Correlation matrix ────────────────────────────────────────────────────────

def get_correlation_matrix(assets: list) -> dict:
    cached = _cget('corr_matrix')
    if cached is not None:
        return cached

    series = {}
    for asset in assets:
        try:
            df = _get_history(asset)
            if not df.empty:
                series[asset] = df.set_index('ds')['y']
        except Exception:
            pass

    if len(series) < 2:
        return {'matrix': {}, 'assets': [], 'insights': []}

    combined = pd.DataFrame(series).dropna()
    if len(combined) < 10:
        return {'matrix': {}, 'assets': [], 'insights': []}

    corr   = combined.corr().round(3)
    matrix = {k: {k2: (None if math.isnan(v) else v) for k2, v in row.items()}
              for k, row in corr.to_dict().items()}

    insights = []
    seen     = set()
    for i, a1 in enumerate(series.keys()):
        for a2 in list(series.keys())[i + 1:]:
            pair = tuple(sorted([a1, a2]))
            if pair in seen:
                continue
            seen.add(pair)
            try:
                val = corr.loc[a1, a2]
                if abs(val) >= 0.70:
                    pct = f'{abs(val):.0%}'
                    if val > 0:
                        insights.append(
                            f'{a1} y {a2} tienen {pct} de correlación — '
                            'si uno cae, el otro probablemente también'
                        )
                    else:
                        insights.append(
                            f'{a1} y {a2} tienen {pct} de correlación inversa — '
                            'se mueven en dirección opuesta'
                        )
            except Exception:
                pass

    result = {'matrix': matrix, 'assets': list(series.keys()), 'insights': insights}
    _cset('corr_matrix', result)
    return result


# ── Logging ───────────────────────────────────────────────────────────────────

def log_indicators(result: dict, prices: dict, fg: dict, dom: dict):
    ind_log = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'indicators_log.csv')
    try:
        if os.path.exists(ind_log):
            with open(ind_log, 'rb') as fh:
                fh.seek(max(0, -400), 2)
                tail = fh.read().decode('utf-8', errors='ignore')
            last_ts = None
            for ln in tail.strip().split('\n')[::-1]:
                parts = ln.split(',')
                if len(parts) > 1 and '-' in parts[0]:
                    try:
                        last_ts = datetime.strptime(parts[0], '%Y-%m-%d %H:%M:%S')
                        break
                    except Exception:
                        pass
            if last_ts and (datetime.now() - last_ts).total_seconds() < 55:
                return

        row = {'Timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
        for asset, ind in result.items():
            row[f'{asset}_RSI']    = ind.get('rsi', '')
            row[f'{asset}_MA_Sig'] = ind.get('ma_signal', '')
            row[f'{asset}_Price']  = prices.get(asset, '')
        row['FearGreed'] = fg.get('value', '')
        row['BTC_Dom']   = dom.get('dominance', '')

        file_exists = os.path.exists(ind_log)
        with open(ind_log, 'a', newline='') as fh:
            w = csv.DictWriter(fh, fieldnames=list(row.keys()))
            if not file_exists:
                w.writeheader()
            w.writerow(row)
    except Exception as exc:
        log.warning('log_indicators: %s', exc)
