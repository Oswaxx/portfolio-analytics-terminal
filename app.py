import time
import csv
import json
import os
import copy
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from io import BytesIO
import requests
from flask import Flask, render_template, request, jsonify
import pandas as pd
import predictor
import indicators as ind_mod

def _load_finnhub_key() -> str:
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'api_keys.json')) as f:
            return json.load(f).get('finnhub_key', '')
    except Exception:
        return ''

FINNHUB_KEY = _load_finnhub_key()

try:
    import lstm_model as lstm_mod
    _LSTM_AVAILABLE = True
except ImportError:
    _LSTM_AVAILABLE = False

app = Flask(__name__)

# ── Global in-memory cache — the ONLY source of truth for HTTP routes ──────────
# Populated at startup and refreshed every 60 s by _bg_refresh_loop().
# Routes NEVER call external APIs directly; they read from here.
_cache      = {'data': None, 'sparklines': None, 'indicators': None}
_cache_lock = threading.Lock()

# Background thread handles — prevent spawning duplicates when a cycle takes > 3 min
_sparks_thread:     threading.Thread | None = None
_indicators_thread: threading.Thread | None = None

# Max rows to keep in portfolio_log.csv (48 h at 1 row/min)
_LOG_MAX_ROWS = 2880

# Exchange-rate: simple 1-hour TTL global (no external library needed)
_fx_cache = {'rate': 17.5, 'ts': 0.0}

# dashboard-extra: static CSV aggregates — recompute at most every 5 min
_DASH_EXTRA_CACHE: dict = {'payload': None, 'ts': 0.0}
_DASH_EXTRA_TTL   = 300.0

# resumen-global: 5 CSV reads — cache to avoid re-reading on every request
_RG_CACHE: dict = {'payload': None, 'ts': 0.0}
_RG_TTL   = 300.0

# Asset metadata (type and market ID — no prices/amounts here)
ASSET_META = {
    'BTC':  {'type': 'crypto', 'id': 'BTCUSDT'},
    'ETH':  {'type': 'crypto', 'id': 'ETHUSDT'},
    'TTWO': {'type': 'stock',  'id': 'TTWO'},
    'SOL':  {'type': 'crypto', 'id': 'SOLUSDT'},
    'XRP':  {'type': 'crypto', 'id': 'XRPUSDT'},
    'DOGE': {'type': 'crypto', 'id': 'DOGEUSDT'},
}

# Kept for backward compat with code that reads BASE_PORTFOLIO keys/ids
BASE_PORTFOLIO = {k: {**v, 'amount_invested': 0, 'buy_price': 0} for k, v in ASSET_META.items()}

LOG_FILE = "portfolio_log.csv"
MOVEMENTS_FILE = "movimientos.csv"
DEPOSITS_FILE = "depositos.csv"
VENTAS_FILE = "ventas.csv"
COMPRAS_FILE = "compras.csv"
GOALS_FILE = "metas.json"
CONFIG_FILE = "config.json"
HISTORIAL_CERRADO_FILE = "historial_cerrado.csv"
DEPOSITOS_RETIROS_FILE = "depositos_retiros.csv"

COMPRAS_HEADERS = [
    'Fecha', 'Activo', 'Cantidad', 'Precio_USD', 'Monto_Bruto_USD',
    'Metodo_Fondeo', 'Comision_Tipo', 'Comision_USD', 'Monto_Real_USD', 'Notas',
]


def _build_portfolio_from_compras():
    """Calculate weighted avg cost and total invested from compras.csv."""
    portfolio = {k: {**v, 'amount_invested': 0.0, 'buy_price': 0.0, 'quantity': 0.0,
                      'total_commissions': 0.0}
                 for k, v in ASSET_META.items()}

    if not os.path.exists(COMPRAS_FILE):
        return portfolio

    try:
        df = pd.read_csv(COMPRAS_FILE)
        for _, row in df.iterrows():
            asset = str(row.get('Activo', '')).strip().upper()
            if asset not in portfolio:
                continue
            qty     = float(row.get('Cantidad', 0) or 0)
            price   = float(row.get('Precio_USD', 0) or 0)
            monto   = float(row.get('Monto_Real_USD', 0) or 0)
            comision = float(row.get('Comision_USD', 0) or 0)
            if qty <= 0 or price <= 0:
                continue
            portfolio[asset]['quantity']          += qty
            portfolio[asset]['amount_invested']   += monto
            portfolio[asset]['total_commissions'] += comision

        for asset, data in portfolio.items():
            if data['quantity'] > 0 and data['amount_invested'] > 0:
                data['buy_price'] = data['amount_invested'] / data['quantity']
    except Exception as e:
        print(f"Error building portfolio from compras: {e}")

    return portfolio

DEFAULT_GOALS = {
    asset: {"take_profit": 0, "stop_loss": 0, "sell_pct": 50}
    for asset in ['BTC', 'ETH', 'TTWO', 'SOL', 'XRP', 'DOGE']
}

# Global state memory
initial_prices = {}
previous_pnl_percent = {}
previous_global_pnl_percent = None
last_known_data = {}

def get_dynamic_portfolio():
    portfolio = _build_portfolio_from_compras()

    if os.path.exists(MOVEMENTS_FILE):
        try:
            df = pd.read_csv(MOVEMENTS_FILE)
            for _, row in df.iterrows():
                asset = str(row.get('Activo', ''))
                tipo = str(row.get('Tipo', ''))
                if asset in portfolio and pd.notna(row.get('Cantidad')):
                    qty = float(row.get('Cantidad', 0))
                    if tipo == 'Compra':
                        try:
                            net_paid = float(row.get('Monto_Neto_USD', 0))
                            old_qty = portfolio[asset]['quantity']
                            old_invested = portfolio[asset]['amount_invested']
                            new_qty = old_qty + qty
                            new_invested = old_invested + net_paid
                            
                            portfolio[asset]['quantity'] = new_qty
                            portfolio[asset]['amount_invested'] = new_invested
                            portfolio[asset]['buy_price'] = new_invested / new_qty if new_qty > 0 else 0
                        except:
                            pass
                    elif tipo == 'Venta':
                        try:
                            portfolio[asset]['quantity'] = max(0, portfolio[asset]['quantity'] - qty)
                            if portfolio[asset]['quantity'] > 0:
                                portfolio[asset]['amount_invested'] = portfolio[asset]['quantity'] * portfolio[asset]['buy_price']
                            else:
                                portfolio[asset]['amount_invested'] = 0
                        except:
                            pass
        except Exception as e:
            print(f"Error parseando CSV para recalc de portfolio: {e}")
            
    return portfolio

def get_prices(portfolio):
    prices      = {}
    crypto_syms = {k: v['id'] for k, v in portfolio.items() if v['type'] == 'crypto'}
    stock_items = [(k, v) for k, v in portfolio.items() if v['type'] == 'stock']

    def _fetch_one_crypto(ticker, symbol):
        """Individual Binance price — avoids batch JSON array encoding issue."""
        try:
            r = requests.get('https://api.binance.com/api/v3/ticker/price',
                             params={'symbol': symbol}, timeout=6)
            if r.status_code == 200:
                return ticker, float(r.json()['price'])
        except Exception as e:
            print(f'[prices] Binance {ticker}: {e}')
        return ticker, None

    def _fetch_stock(k, v):
        """Finnhub real-time quote."""
        if not FINNHUB_KEY or FINNHUB_KEY == 'TU_FINNHUB_API_KEY_AQUI':
            return k, None
        try:
            r = requests.get('https://finnhub.io/api/v1/quote',
                             params={'symbol': v['id'], 'token': FINNHUB_KEY},
                             timeout=8)
            if r.status_code == 200:
                price = float(r.json().get('c', 0))
                if price > 0:
                    return k, price
        except Exception as e:
            print(f'[prices] Finnhub {k} error: {e}')
        return k, None

    all_tasks = [(t, s, 'crypto') for t, s in crypto_syms.items()] + \
                [(k, v, 'stock') for k, v in stock_items]
    workers = max(len(all_tasks), 1)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = []
        for t, s, kind in all_tasks:
            if kind == 'crypto':
                futs.append(ex.submit(_fetch_one_crypto, t, s))
            else:
                futs.append(ex.submit(_fetch_stock, t, s))
        for fut in futs:
            k, price = fut.result()
            if price is not None:
                prices[k] = price

    return prices

def _read_log_tail(n: int = 100) -> pd.DataFrame | None:
    """Read last n rows from LOG_FILE without loading the whole file."""
    if not os.path.exists(LOG_FILE):
        return None
    try:
        BYTES_PER_ROW = 600  # generous estimate for 6-asset rows (~300 chars each)
        with open(LOG_FILE, 'rb') as f:
            header = f.readline()
            f.seek(0, 2)
            file_size = f.tell()
            read_from = max(len(header), file_size - (n + 5) * BYTES_PER_ROW)
            f.seek(read_from)
            tail_bytes = f.read()
        lines = tail_bytes.split(b'\n')
        if read_from > len(header):
            lines = lines[1:]  # drop potentially partial first line
        lines = [l for l in lines if l.strip()]
        content = header + b'\n'.join(lines[-n:])
        return pd.read_csv(BytesIO(content))
    except Exception as e:
        print(f"[log_tail] error: {e}")
        return None


def _rotate_portfolio_log():
    """Trim portfolio_log.csv to the last _LOG_MAX_ROWS rows at startup."""
    if not os.path.exists(LOG_FILE):
        return
    try:
        df = pd.read_csv(LOG_FILE)
        if len(df) > _LOG_MAX_ROWS:
            df.tail(_LOG_MAX_ROWS).to_csv(LOG_FILE, index=False)
            print(f"[log] rotated portfolio_log.csv: kept last {_LOG_MAX_ROWS} rows "
                  f"(was {len(df)})")
    except Exception as e:
        print(f"[log] rotation error: {e}")


def _rotate_indicators_log():
    """Trim indicators_log.csv to the last 5760 rows at startup.
    Skips malformed lines (column count mismatches from schema changes).
    """
    ind_log = os.path.join(os.path.dirname(os.path.abspath(__file__)), "indicators_log.csv")
    if not os.path.exists(ind_log):
        return
    try:
        df = pd.read_csv(ind_log, on_bad_lines='skip')
        if len(df) > 5760:
            df.tail(5760).to_csv(ind_log, index=False)
            print(f"[log] rotated indicators_log.csv: kept last {len(df.tail(5760))} rows")
        else:
            print(f"[log] indicators_log.csv OK ({len(df)} rows)")
    except Exception as e:
        print(f"[log] indicators rotation error: {e}")


def append_to_log(row_dict, portfolio_keys):
    headers = ['Timestamp', 'Global_Value', 'Global_Invested', 'Global_PnL_USD', 'Global_PnL_Perc']
    for k in portfolio_keys:
        headers.extend([f'{k}_Price', f'{k}_Value', f'{k}_PnL_USD', f'{k}_PnL_Perc'])
        
    file_exists = os.path.exists(LOG_FILE)
    with open(LOG_FILE, 'a', newline='') as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(headers)
            
        row = [
            row_dict.get('Timestamp'),
            row_dict.get('Global_Value'),
            row_dict.get('Global_Invested'),
            row_dict.get('Global_PnL_USD'),
            row_dict.get('Global_PnL_Perc')
        ]
        
        for k in portfolio_keys:
            k_data = row_dict.get('assets', {}).get(k, {})
            row.extend([
                k_data.get('price', ''),
                k_data.get('value', ''),
                k_data.get('pnl_usd', ''),
                k_data.get('pnl_perc', '')
            ])
            
        writer.writerow(row)

@app.route('/')
def index():
    if not os.path.exists(MOVEMENTS_FILE):
        with open(MOVEMENTS_FILE, 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['Fecha', 'Activo', 'Tipo', 'Cantidad', 'Precio_USD', 'Deducciones_USD', 'Monto_Neto_USD', 'Notas', 'Origen'])
    return render_template('index.html')

def _fallback_data_from_log():
    """Read last row from portfolio_log.csv; reconstructs /api/data shape instantly."""
    try:
        df = _read_log_tail(1)
        if df is None or df.empty:
            return None
        row       = df.iloc[0]
        portfolio = _build_portfolio_from_compras()
        assets_out, total_value, total_invested = {}, 0.0, 0.0
        for asset, meta in portfolio.items():
            price_col = f'{asset}_Price'
            if price_col not in row:
                continue
            price    = float(row.get(price_col, 0) or 0)
            qty      = meta['quantity']
            invested = meta['amount_invested']
            val      = qty * price
            pnl_usd  = val - invested
            pnl_perc = (pnl_usd / invested * 100) if invested > 0 else 0
            assets_out[asset] = {
                'price': price, 'avg_cost': meta['buy_price'],
                'value': val, 'invested': invested,
                'pnl_usd': pnl_usd, 'pnl_perc': pnl_perc,
                'dist_be': 0, 'quantity': qty,
            }
            total_value    += val
            total_invested += invested
        g_pnl  = total_value - total_invested
        g_perc = (g_pnl / total_invested * 100) if total_invested > 0 else 0
        return {
            'Timestamp': str(row.get('Timestamp', '')),
            'Global_Value': total_value, 'Global_Invested': total_invested,
            'Global_PnL_USD': g_pnl, 'Global_PnL_Perc': g_perc,
            'assets': assets_out, 'alerts': [], '_stale': True,
        }
    except Exception as e:
        print(f"[fallback] log read error: {e}")
        return None


def _compute_data_payload():
    """Compute the full /api/data payload (called by bg thread only)."""
    global previous_global_pnl_percent, last_known_data

    portfolio = get_dynamic_portfolio()
    prices    = get_prices(portfolio)

    if not initial_prices and prices:
        for k, p in prices.items():
            initial_prices[k] = p

    if not prices:
        return last_known_data or {}

    timestamp     = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    total_invested = 0
    total_value    = 0
    alerts         = []
    assets_out     = {}

    for asset, data in portfolio.items():
        if asset in prices:
            current_price = prices[asset]
        else:
            prev_data     = (last_known_data or {}).get('assets', {}).get(asset)
            current_price = prev_data.get('price', 0) if prev_data else 0
            prices[asset] = current_price

        buy_price = data['buy_price']
        qty       = data['quantity']
        invested  = data['amount_invested']

        val      = qty * current_price
        pnl_usd  = val - invested
        pnl_perc = (pnl_usd / invested) * 100 if invested > 0 else 0
        dist_be  = ((buy_price - current_price) / current_price) * 100 \
                   if current_price < buy_price and current_price > 0 else 0

        total_invested += invested
        total_value    += val

        prev_pnl = previous_pnl_percent.get(asset, -1)
        if prev_pnl < 0 and pnl_perc >= 0:
            alerts.append({'type': 'success', 'msg': f"¡Break-even alcanzado para {asset} (0% P&L)!"})
        if asset == 'ETH' and current_price <= initial_prices.get('ETH', 0) * 0.90:
            alerts.append({'type': 'error', 'msg': "ETH caída del 10% adicional. Señal de salida."})
        if current_price <= initial_prices.get(asset, 0) * 0.85:
            alerts.append({'type': 'error', 'msg': f"{asset} caída del 15% adicional. Stop-loss activado."})

        previous_pnl_percent[asset] = pnl_perc
        assets_out[asset] = {
            'price': current_price, 'avg_cost': buy_price,
            'value': val, 'invested': invested,
            'pnl_usd': pnl_usd, 'pnl_perc': pnl_perc,
            'dist_be': dist_be, 'quantity': qty,
        }

    global_pnl_usd  = total_value - total_invested
    global_pnl_perc = (global_pnl_usd / total_invested) * 100 if total_invested > 0 else 0

    if previous_global_pnl_percent is not None and previous_global_pnl_percent <= -20 and global_pnl_perc > -20:
        alerts.append({'type': 'warning', 'msg': "El portafolio se está recuperando por encima de -20% histórico."})
    previous_global_pnl_percent = global_pnl_perc

    payload = {
        'Timestamp': timestamp,
        'Global_Value': total_value, 'Global_Invested': total_invested,
        'Global_PnL_USD': global_pnl_usd, 'Global_PnL_Perc': global_pnl_perc,
        'assets': assets_out, 'alerts': alerts,
    }
    last_known_data = payload
    append_to_log(payload, portfolio.keys())
    return payload


@app.route('/api/data')
def api_data():
    t0 = time.time()
    with _cache_lock:
        payload = _cache['data']
    if payload is None:
        payload = _fallback_data_from_log()
    elapsed = (time.time() - t0) * 1000
    src = 'cache' if _cache['data'] is not None else 'log_fallback'
    print(f"[timing] /api/data  {elapsed:.1f} ms  ({src})")
    return jsonify(payload or {})

@app.route('/api/predict/<asset>')
def api_predict(asset):
    portfolio = get_dynamic_portfolio()
    buy_price = 0
    coin_id = ""
    for k, v in portfolio.items():
        if k.upper() == asset.upper():
            buy_price = v['buy_price']
            coin_id = v['id']
            break
            
    if not coin_id:
        return jsonify({'error': 'Activo no soportado'}), 404
        
    result = predictor.predict_asset(coin_id, buy_price, ticker=asset.upper())
    return jsonify(result)

def _fetch_sparklines_payload():
    """Compute sparklines — all assets in one parallel ThreadPoolExecutor."""
    sparklines = {k: [] for k in BASE_PORTFOLIO}

    def _one(ticker, asset_type, symbol):
        if asset_type == 'crypto':
            try:
                r = requests.get(
                    'https://api.binance.com/api/v3/klines',
                    params={'symbol': symbol, 'interval': '1h', 'limit': 168},
                    timeout=10,
                )
                if r.status_code == 200:
                    return ticker, [float(c[4]) for c in r.json()]
            except Exception as e:
                print(f'[sparklines] Binance {ticker}: {e}')
        else:
            if not FINNHUB_KEY or FINNHUB_KEY == 'TU_FINNHUB_API_KEY_AQUI':
                return ticker, []
            try:
                to_ts   = int(time.time())
                from_ts = to_ts - 10 * 86400
                r = requests.get(
                    'https://finnhub.io/api/v1/stock/candle',
                    params={'symbol': symbol, 'resolution': 'D',
                            'from': from_ts, 'to': to_ts, 'token': FINNHUB_KEY},
                    timeout=10,
                )
                if r.status_code == 200:
                    data = r.json()
                    if data.get('s') == 'ok' and data.get('c'):
                        return ticker, [float(p) for p in data['c']]
            except Exception as e:
                print(f'[sparklines] Finnhub {ticker}: {e}')
        return ticker, []

    tasks = [(k, v['type'], v['id']) for k, v in BASE_PORTFOLIO.items()]
    with ThreadPoolExecutor(max_workers=len(tasks)) as ex:
        for fut in [ex.submit(_one, *t) for t in tasks]:
            k, vals = fut.result()
            sparklines[k] = vals

    return sparklines


@app.route('/api/sparklines')
def api_sparklines():
    t0 = time.time()
    with _cache_lock:
        payload = _cache['sparklines']
    elapsed = (time.time() - t0) * 1000
    src = 'cache' if payload is not None else 'empty'
    print(f"[timing] /api/sparklines  {elapsed:.1f} ms  ({src})")
    return jsonify(payload or {k: [] for k in BASE_PORTFOLIO})

@app.route('/api/movements', methods=['GET', 'POST'])
def api_movements():
    if request.method == 'POST':
        data = request.json
        with open(MOVEMENTS_FILE, 'a', newline='') as f:
            writer = csv.writer(f)
            writer.writerow([
                data.get('fecha'), data.get('activo'), data.get('tipo'),
                data.get('cantidad'), data.get('precio_usd'), data.get('deducciones_usd'),
                data.get('monto_neto'), data.get('notas', ''), 'Manual'
            ])
        return jsonify({"status": "ok"})
    else:
        if not os.path.exists(MOVEMENTS_FILE):
             return jsonify([])
        df = pd.read_csv(MOVEMENTS_FILE)
        return jsonify(df.to_dict(orient='records'))

@app.route('/api/import_csv', methods=['POST'])
def api_import_csv():
    data = request.json
    imported_count = 0
    ignored_count = 0
    existing = set()
    
    if not os.path.exists(MOVEMENTS_FILE):
        with open(MOVEMENTS_FILE, 'w', newline='') as f:
            csv.writer(f).writerow(['Fecha', 'Activo', 'Tipo', 'Cantidad', 'Precio_USD', 'Deducciones_USD', 'Monto_Neto_USD', 'Notas', 'Origen'])
            
    df = pd.read_csv(MOVEMENTS_FILE)
    for _, r in df.iterrows():
        # Using Fecha + Activo + Cantidad logic as hash to suppress duplicates
        h = f"{r.get('Fecha')}_{r.get('Activo')}_{r.get('Cantidad')}"
        existing.add(h)
            
    with open(MOVEMENTS_FILE, 'a', newline='') as f:
        writer = csv.writer(f)
        for row in data.get('rows', []):
            h = f"{row.get('fecha')}_{row.get('activo')}_{row.get('cantidad')}"
            if h in existing:
                ignored_count += 1
            else:
                writer.writerow([
                    row.get('fecha'), row.get('activo'), row.get('tipo'),
                    row.get('cantidad'), row.get('precio_usd'), row.get('deducciones_usd'),
                    row.get('monto_neto'), row.get('notas', ''), 'Importado'
                ])
                imported_count += 1
                existing.add(h)
                
    return jsonify({"imported": imported_count, "ignored": ignored_count})

@app.route('/api/log')
def api_log():
    try:
        df = _read_log_tail(100)
        if df is None or df.empty:
            return jsonify([])
        return jsonify({
            'timestamps': df['Timestamp'].tolist(),
            'global_values': df['Global_Value'].tolist()
        })
    except Exception:
        return jsonify([])


@app.route('/api/indicators')
def api_indicators():
    t0 = time.time()
    with _cache_lock:
        payload = _cache['indicators']
    elapsed = (time.time() - t0) * 1000
    src = 'cache' if payload is not None else 'empty'
    print(f"[timing] /api/indicators  {elapsed:.1f} ms  ({src})")
    return jsonify(payload or {'indicators': {}, 'fear_greed': {}, 'btc_dominance': {}})


@app.route('/api/correlations')
def api_correlations():
    assets = list(BASE_PORTFOLIO.keys())
    return jsonify(ind_mod.get_correlation_matrix(assets))


@app.route('/api/exchange-rate')
def api_exchange_rate():
    global _fx_cache
    # Refresh at most once per hour — never blocks on repeated calls
    if time.monotonic() - _fx_cache['ts'] > 3600:
        try:
            r = requests.get('https://api.exchangerate-api.com/v4/latest/USD', timeout=8)
            if r.status_code == 200:
                _fx_cache = {'rate': r.json()['rates']['MXN'], 'ts': time.monotonic()}
                print(f"[fx] rate refreshed: {_fx_cache['rate']:.4f}")
        except Exception as e:
            print(f"[fx] refresh error (using last known): {e}")
    return jsonify({'usd_to_mxn': _fx_cache['rate']})


@app.route('/api/deposits', methods=['GET', 'POST'])
def api_deposits():
    if request.method == 'POST':
        data = request.json
        file_exists = os.path.exists(DEPOSITS_FILE)
        with open(DEPOSITS_FILE, 'a', newline='') as f:
            writer = csv.writer(f)
            if not file_exists:
                writer.writerow(['Fecha', 'Monto_MXN', 'Metodo', 'Fee_USD', 'Neto_USD', 'Tipo_Cambio'])
            writer.writerow([
                data.get('fecha'), data.get('monto_mxn'), data.get('metodo'),
                data.get('fee_usd'), data.get('neto_usd'), data.get('tipo_cambio')
            ])
        return jsonify({'status': 'ok'})
    else:
        if not os.path.exists(DEPOSITS_FILE):
            return jsonify([])
        try:
            df = pd.read_csv(DEPOSITS_FILE)
            return jsonify(df.to_dict(orient='records'))
        except:
            return jsonify([])


@app.route('/api/compras', methods=['GET', 'POST'])
def api_compras():
    if request.method == 'POST':
        data = request.json
        file_exists = os.path.exists(COMPRAS_FILE)
        with open(COMPRAS_FILE, 'a', newline='') as f:
            writer = csv.writer(f)
            if not file_exists:
                writer.writerow(COMPRAS_HEADERS)
            writer.writerow([
                data.get('fecha'), data.get('activo'), data.get('cantidad'),
                data.get('precio_usd'), data.get('monto_bruto_usd'),
                data.get('metodo_fondeo'), data.get('comision_tipo'),
                data.get('comision_usd'), data.get('monto_real_usd'),
                data.get('notas', ''),
            ])
        return jsonify({'status': 'ok'})
    else:
        if not os.path.exists(COMPRAS_FILE):
            return jsonify([])
        try:
            df = pd.read_csv(COMPRAS_FILE)
            return jsonify(df.to_dict(orient='records'))
        except:
            return jsonify([])


@app.route('/api/compras/summary')
def api_compras_summary():
    """Weighted average cost and totals per asset."""
    portfolio = _build_portfolio_from_compras()
    summary = {}
    for asset, data in portfolio.items():
        summary[asset] = {
            'quantity':          round(data['quantity'], 8),
            'amount_invested':   round(data['amount_invested'], 2),
            'avg_cost':          round(data['buy_price'], 6),
            'total_commissions': round(data['total_commissions'], 2),
        }
    return jsonify(summary)


@app.route('/api/ventas', methods=['GET', 'POST'])
def api_ventas():
    if request.method == 'POST':
        data = request.json
        file_exists = os.path.exists(VENTAS_FILE)
        with open(VENTAS_FILE, 'a', newline='') as f:
            writer = csv.writer(f)
            if not file_exists:
                writer.writerow(['Fecha', 'Activo', 'Cantidad', 'Precio_Venta', 'Precio_Compra',
                                  'Tipo_Comision', 'Fee_USD', 'Bruto_USD', 'Neto_USD', 'PnL_USD'])
            writer.writerow([
                data.get('fecha'), data.get('activo'), data.get('cantidad'),
                data.get('precio_venta'), data.get('precio_compra'),
                data.get('tipo_comision'), data.get('fee_usd'),
                data.get('bruto_usd'), data.get('neto_usd'), data.get('pnl_usd')
            ])
        return jsonify({'status': 'ok'})
    else:
        if not os.path.exists(VENTAS_FILE):
            return jsonify([])
        try:
            df = pd.read_csv(VENTAS_FILE)
            return jsonify(df.to_dict(orient='records'))
        except:
            return jsonify([])


def _deep_merge_goals(base, override):
    """Deep merge: per-asset fields from override win, missing fields fall back to base."""
    result = {}
    all_assets = set(list(base.keys()) + list(override.keys()))
    for asset in all_assets:
        result[asset] = {**base.get(asset, {}), **override.get(asset, {})}
    return result


@app.route('/api/goals', methods=['GET', 'POST'])
def api_goals():
    existing = {}
    if os.path.exists(GOALS_FILE):
        try:
            with open(GOALS_FILE, 'r') as f:
                existing = json.load(f)
        except:
            existing = {}

    if request.method == 'POST':
        # Deep merge so saving one field doesn't wipe others for the same asset
        merged = _deep_merge_goals(existing, request.json)
        with open(GOALS_FILE, 'w') as f:
            json.dump(merged, f, indent=2)
        return jsonify({'status': 'ok'})
    else:
        # Deep merge defaults + saved so every asset always has all three fields
        merged = _deep_merge_goals(DEFAULT_GOALS, existing)
        return jsonify(merged)


@app.route('/api/fiscal')
def api_fiscal():
    year = request.args.get('year', str(datetime.now().year))
    if not os.path.exists(VENTAS_FILE):
        return jsonify({'rows': [], 'total_gains': 0, 'total_losses': 0, 'net': 0})
    try:
        df = pd.read_csv(VENTAS_FILE)
        df['Fecha'] = pd.to_datetime(df['Fecha'], errors='coerce')
        df = df[df['Fecha'].dt.year == int(year)]
        df['PnL_USD'] = pd.to_numeric(df['PnL_USD'], errors='coerce').fillna(0)
        gains = float(df[df['PnL_USD'] > 0]['PnL_USD'].sum())
        losses = float(df[df['PnL_USD'] < 0]['PnL_USD'].sum())
        rows = df.to_dict(orient='records')
        # Convert Timestamps to strings for JSON
        for r in rows:
            if hasattr(r.get('Fecha'), 'strftime'):
                r['Fecha'] = r['Fecha'].strftime('%Y-%m-%d')
        return jsonify({'rows': rows, 'total_gains': gains, 'total_losses': losses, 'net': gains + losses})
    except Exception as e:
        return jsonify({'error': str(e)})


@app.route('/api/config', methods=['GET', 'POST'])
def api_config():
    if request.method == 'POST':
        data = request.json
        existing = {}
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r') as f:
                    existing = json.load(f)
            except:
                existing = {}
        existing.update(data)
        with open(CONFIG_FILE, 'w') as f:
            json.dump(existing, f)
        return jsonify({'status': 'ok'})
    else:
        if not os.path.exists(CONFIG_FILE):
            return jsonify({'hapi_balance': 0})
        try:
            with open(CONFIG_FILE, 'r') as f:
                return jsonify(json.load(f))
        except:
            return jsonify({'hapi_balance': 0})


# ── LSTM routes ────────────────────────────────────────────────────────────────

_lstm_training_lock = threading.Lock()
_lstm_training_status = {}   # {asset: 'training'|'done'|'error'}


@app.route('/api/lstm/predictions/<asset>')
def api_lstm_predictions(asset):
    asset = asset.upper()
    if not _LSTM_AVAILABLE:
        return jsonify({'error': 'lstm_model not available'}), 503
    preds = lstm_mod.get_predictions(asset)
    if not preds:
        return jsonify({'error': f'No predictions for {asset}. Needs training.'}), 404
    return jsonify(preds)


@app.route('/api/lstm/status')
def api_lstm_status():
    if not _LSTM_AVAILABLE:
        return jsonify({'available': False})
    status = lstm_mod.get_training_status()
    return jsonify({'available': True, 'training_status': _lstm_training_status, **status})


@app.route('/api/lstm/train', methods=['POST'])
def api_lstm_train():
    if not _LSTM_AVAILABLE:
        return jsonify({'error': 'lstm_model not available'}), 503
    data   = request.json or {}
    assets = data.get('assets') or list(lstm_mod.ASSETS.keys())

    if _lstm_training_lock.locked():
        return jsonify({'status': 'already_training'}), 409

    def _do_train():
        with _lstm_training_lock:
            for a in assets:
                _lstm_training_status[a] = 'training'
            try:
                result = lstm_mod.train_all(assets)
                for a, r in result.items():
                    _lstm_training_status[a] = r.get('status', 'done')
            except Exception as e:
                for a in assets:
                    _lstm_training_status[a] = 'error'
                print(f"LSTM training error: {e}")

    threading.Thread(target=_do_train, daemon=True).start()
    return jsonify({'status': 'started', 'assets': assets})


@app.route('/api/lstm/signal/<asset>')
def api_lstm_signal(asset):
    """Combined IA signal: LSTM + RSI + MACD + sentiment + fear_greed."""
    asset = asset.upper()
    preds = lstm_mod.get_predictions(asset) if _LSTM_AVAILABLE else {}
    ind   = ind_mod.compute_indicators(asset)
    fg    = ind_mod.get_fear_greed()

    score = 0
    reasons = []

    # LSTM direction
    if preds.get('30d') and ind.get('price'):
        cur = ind['price']
        p30 = preds['30d']
        if p30 > cur * 1.02:
            score += 2; reasons.append(f"LSTM +{((p30/cur-1)*100):.1f}% en 30d")
        elif p30 < cur * 0.98:
            score -= 2; reasons.append(f"LSTM {((p30/cur-1)*100):.1f}% en 30d")

    # RSI
    rsi = ind.get('rsi')
    if rsi:
        if rsi < 35:   score += 1; reasons.append(f"RSI sobrevendido ({rsi:.0f})")
        elif rsi > 65: score -= 1; reasons.append(f"RSI sobrecomprado ({rsi:.0f})")

    # MACD
    if ind.get('macd_trend') == 'Alcista': score += 1; reasons.append("MACD alcista")
    elif ind.get('macd_trend') == 'Bajista': score -= 1; reasons.append("MACD bajista")

    # Sentiment
    sent = (ind.get('sentiment') or {}).get('label')
    if sent == 'Positivo': score += 1; reasons.append("Sentiment positivo")
    elif sent == 'Negativo': score -= 1; reasons.append("Sentiment negativo")

    # Fear & Greed
    fg_val = fg.get('value')
    if fg_val is not None:
        if fg_val < 25:   score += 1; reasons.append(f"Fear&Greed: Miedo extremo ({fg_val})")
        elif fg_val > 75: score -= 1; reasons.append(f"Fear&Greed: Codicia extrema ({fg_val})")

    if score >= 3:        signal = 'Compra'
    elif score >= 1:      signal = 'Mantener'
    elif score <= -3:     signal = 'Venta'
    elif score <= -1:     signal = 'Mantener'
    else:                 signal = 'Sin señal'

    return jsonify({
        'asset': asset, 'signal': signal, 'score': score,
        'reasons': reasons,
        'disclaimer': 'Señal informativa, no consejo financiero'
    })


@app.route('/api/historial-cerrado', methods=['GET', 'POST'])
def api_historial_cerrado():
    if request.method == 'POST':
        data = request.json
        file_exists = os.path.exists(HISTORIAL_CERRADO_FILE)
        with open(HISTORIAL_CERRADO_FILE, 'a', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            if not file_exists:
                writer.writerow(['Activo', 'Fecha_Compra', 'Costo_Total', 'Fecha_Venta',
                                  'Ingreso_Total', 'Ganancia_Perdida', 'Tipo', 'Comision', 'Notas'])
            writer.writerow([
                data.get('activo'), data.get('fecha_compra'), data.get('costo_total'),
                data.get('fecha_venta'), data.get('ingreso_total'),
                data.get('ganancia_perdida'), data.get('tipo'),
                data.get('comision', 0), data.get('notas', ''),
            ])
        return jsonify({'status': 'ok'})
    else:
        if not os.path.exists(HISTORIAL_CERRADO_FILE):
            return jsonify([])
        try:
            df = pd.read_csv(HISTORIAL_CERRADO_FILE, encoding='utf-8')
            # df.to_json() converts NaN → null correctly; json.loads gives Python None.
            # df.to_dict() leaves NaN as float('nan') which Flask serializes as
            # the non-standard literal "NaN", causing browser res.json() to throw.
            records = json.loads(df.to_json(orient='records'))
            return jsonify(records)
        except Exception as e:
            print(f"Error reading historial_cerrado: {e}")
            return jsonify([])


@app.route('/api/depositos-retiros', methods=['GET', 'POST'])
def api_depositos_retiros():
    if request.method == 'POST':
        data = request.json
        file_exists = os.path.exists(DEPOSITOS_RETIROS_FILE)
        with open(DEPOSITOS_RETIROS_FILE, 'a', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            if not file_exists:
                writer.writerow(['Fecha', 'Tipo', 'Monto'])
            writer.writerow([data.get('fecha'), data.get('tipo'), data.get('monto')])
        return jsonify({'status': 'ok'})
    else:
        if not os.path.exists(DEPOSITOS_RETIROS_FILE):
            return jsonify([])
        try:
            df = pd.read_csv(DEPOSITOS_RETIROS_FILE, encoding='utf-8')
            return jsonify(df.to_dict(orient='records'))
        except Exception as e:
            print(f"Error reading depositos_retiros: {e}")
            return jsonify([])


@app.route('/api/resumen-global')
def api_resumen_global():
    now = time.monotonic()
    if _RG_CACHE['payload'] is not None and now - _RG_CACHE['ts'] < _RG_TTL:
        return jsonify(_RG_CACHE['payload'])

    total_depositado, total_retirado = 0.0, 0.0
    if os.path.exists(DEPOSITOS_RETIROS_FILE):
        try:
            df = pd.read_csv(DEPOSITOS_RETIROS_FILE, encoding='utf-8')
            df['Monto'] = pd.to_numeric(df['Monto'], errors='coerce').fillna(0)
            total_depositado = float(df[df['Tipo'] == 'Deposito']['Monto'].sum())
            total_retirado   = float(df[df['Tipo'] == 'Retiro']['Monto'].sum())
        except Exception as e:
            print(f"[resumen-global] depositos_retiros error: {e}")

    ganancia_realizada = 0.0
    if os.path.exists(HISTORIAL_CERRADO_FILE):
        try:
            df = pd.read_csv(HISTORIAL_CERRADO_FILE, encoding='utf-8')
            df['Ganancia_Perdida'] = pd.to_numeric(df['Ganancia_Perdida'], errors='coerce').fillna(0)
            ganancia_realizada = float(df['Ganancia_Perdida'].sum())
        except Exception as e:
            print(f"[resumen-global] historial_cerrado error: {e}")

    total_comisiones = 0.0
    for fpath, col in [
        (COMPRAS_FILE,           'Comision_USD'),
        (VENTAS_FILE,            'Fee_USD'),
        (DEPOSITS_FILE,          'Fee_USD'),
        (HISTORIAL_CERRADO_FILE, 'Comision'),          # fees on closed positions
    ]:
        if os.path.exists(fpath):
            try:
                df = pd.read_csv(fpath, encoding='utf-8')
                if col in df.columns:
                    df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
                    total_comisiones += float(df[col].sum())
            except Exception:
                pass

    payload = {
        'total_depositado':   total_depositado,
        'total_retirado':     total_retirado,
        'dinero_neto':        total_depositado - total_retirado,
        'ganancia_realizada': ganancia_realizada,
        'total_comisiones':   total_comisiones,
    }
    _RG_CACHE.update({'payload': payload, 'ts': now})
    return jsonify(payload)


@app.route('/api/dashboard-extra')
def api_dashboard_extra():
    """Lightweight extra KPIs — result cached 5 min to avoid CSV reads on every 60s tick."""
    now = time.monotonic()
    if _DASH_EXTRA_CACHE['payload'] is not None and now - _DASH_EXTRA_CACHE['ts'] < _DASH_EXTRA_TTL:
        return jsonify(_DASH_EXTRA_CACHE['payload'])

    neto_posiciones = 0.0
    if os.path.exists(COMPRAS_FILE):
        try:
            df = pd.read_csv(COMPRAS_FILE)
            df['Monto_Bruto_USD'] = pd.to_numeric(df['Monto_Bruto_USD'], errors='coerce').fillna(0)
            df['Comision_USD']    = pd.to_numeric(df['Comision_USD'],    errors='coerce').fillna(0)
            neto_posiciones = float((df['Monto_Bruto_USD'] - df['Comision_USD']).sum())
        except Exception as e:
            print(f"[dashboard-extra] compras error: {e}")

    ganado_cerradas  = 0.0
    perdido_cerradas = 0.0
    if os.path.exists(HISTORIAL_CERRADO_FILE):
        try:
            df = pd.read_csv(HISTORIAL_CERRADO_FILE, encoding='utf-8')
            df['Ganancia_Perdida'] = pd.to_numeric(df['Ganancia_Perdida'], errors='coerce').fillna(0)
            ganado_cerradas  = float(df[df['Ganancia_Perdida'] > 0]['Ganancia_Perdida'].sum())
            perdido_cerradas = float(df[df['Ganancia_Perdida'] < 0]['Ganancia_Perdida'].sum())
        except Exception as e:
            print(f"[dashboard-extra] historial_cerrado error: {e}")

    payload = {
        'neto_posiciones':  neto_posiciones,
        'ganado_cerradas':  ganado_cerradas,
        'perdido_cerradas': perdido_cerradas,
    }
    _DASH_EXTRA_CACHE.update({'payload': payload, 'ts': now})
    return jsonify(payload)


@app.route('/api/movimientos-unificados')
def api_movimientos_unificados():
    rows = []

    if os.path.exists(COMPRAS_FILE):
        try:
            df = pd.read_csv(COMPRAS_FILE)
            for _, r in df.iterrows():
                rows.append({
                    'fecha':    str(r.get('Fecha', '')).split('T')[0],
                    'tipo':     'Compra',
                    'activo':   str(r.get('Activo', '')),
                    'monto':    float(r.get('Monto_Bruto_USD', 0) or 0),
                    'comision': float(r.get('Comision_USD', 0) or 0),
                    'neto':     float(r.get('Monto_Real_USD', 0) or 0),
                    'notas':    str(r.get('Notas', '') or ''),
                })
        except Exception as e:
            print(f"[mov-unificados] compras error: {e}")

    if os.path.exists(VENTAS_FILE):
        try:
            df = pd.read_csv(VENTAS_FILE)
            for _, r in df.iterrows():
                rows.append({
                    'fecha':    str(r.get('Fecha', '')),
                    'tipo':     'Venta',
                    'activo':   str(r.get('Activo', '')),
                    'monto':    float(r.get('Bruto_USD', 0) or 0),
                    'comision': float(r.get('Fee_USD', 0) or 0),
                    'neto':     float(r.get('Neto_USD', 0) or 0),
                    'notas':    f"P&L: {float(r.get('PnL_USD', 0) or 0):.2f}",
                })
        except Exception as e:
            print(f"[mov-unificados] ventas error: {e}")

    if os.path.exists(DEPOSITS_FILE):
        try:
            df = pd.read_csv(DEPOSITS_FILE)
            for _, r in df.iterrows():
                neto = float(r.get('Neto_USD', 0) or 0)
                rows.append({
                    'fecha':    str(r.get('Fecha', '')),
                    'tipo':     'Deposito',
                    'activo':   'USD',
                    'monto':    neto,
                    'comision': float(r.get('Fee_USD', 0) or 0),
                    'neto':     neto,
                    'notas':    f"MXN→Hapi ({r.get('Metodo', '')})",
                })
        except Exception as e:
            print(f"[mov-unificados] deposits error: {e}")

    if os.path.exists(DEPOSITOS_RETIROS_FILE):
        try:
            df = pd.read_csv(DEPOSITOS_RETIROS_FILE, encoding='utf-8')
            for _, r in df.iterrows():
                tipo  = str(r.get('Tipo', 'Deposito'))
                monto = float(r.get('Monto', 0) or 0)
                rows.append({
                    'fecha':    str(r.get('Fecha', '')),
                    'tipo':     tipo,
                    'activo':   'USD',
                    'monto':    monto,
                    'comision': 0.0,
                    'neto':     monto if tipo == 'Deposito' else -monto,
                    'notas':    'Hapi directo',
                })
        except Exception as e:
            print(f"[mov-unificados] depositos_retiros error: {e}")

    rows.sort(key=lambda x: x.get('fecha', ''), reverse=True)
    return jsonify(rows)


def _refresh_indicators():
    """Compute indicators and store in _cache. Runs in a background thread."""
    try:
        t0     = time.time()
        assets = list(BASE_PORTFOLIO.keys())
        dom    = ind_mod.get_btc_dominance()
        fg     = ind_mod.get_fear_greed()
        result = ind_mod.compute_all_indicators(assets)
        ind_payload = {'indicators': result, 'fear_greed': fg, 'btc_dominance': dom}
        with _cache_lock:
            _cache['indicators'] = ind_payload
        prices_now = {a: (result.get(a) or {}).get('price') or 0 for a in assets}
        ind_mod.log_indicators(result, prices_now, fg, dom)
        print(f"[cache] indicators  {(time.time()-t0)*1000:.0f} ms")
    except Exception as e:
        print(f"[cache] indicators ERROR: {e}")


def _refresh_sparklines_bg():
    """Fetch sparklines in background — Binance klines + Finnhub candles."""
    try:
        t0     = time.time()
        sparks = _fetch_sparklines_payload()
        with _cache_lock:
            _cache['sparklines'] = sparks
        print(f"[cache] sparklines  {(time.time()-t0)*1000:.0f} ms")
    except Exception as e:
        print(f"[cache] sparklines ERROR: {e}")


def _refresh_cache(background_slow=False):
    """Populate _cache['data'] — fast (~1-2 s).
    Sparklines + indicators are slow (Binance + Finnhub calls); pass
    background_slow=True to fire them in daemon threads so the caller
    is not blocked.
    """
    global _sparks_thread, _indicators_thread
    print(f"[cache] refresh started  {datetime.now().strftime('%H:%M:%S')}")
    t_total = time.time()

    # ── 1. Prices + portfolio payload (~1-2 s) ────────────────────────────────
    try:
        t0      = time.time()
        payload = _compute_data_payload()
        with _cache_lock:
            _cache['data'] = payload
        print(f"[cache] data  {(time.time()-t0)*1000:.0f} ms")
    except Exception as e:
        print(f"[cache] data ERROR: {e}")

    # ── 2+3. Sparklines + Indicators (slow — background or inline) ────────────
    if background_slow:
        # Guard: skip if the previous thread is still running to prevent pile-up
        if _sparks_thread is None or not _sparks_thread.is_alive():
            _sparks_thread = threading.Thread(target=_refresh_sparklines_bg, daemon=True)
            _sparks_thread.start()
            print("[cache] sparklines -> background thread")
        else:
            print("[cache] sparklines still running — skipping this cycle")

        if _indicators_thread is None or not _indicators_thread.is_alive():
            _indicators_thread = threading.Thread(target=_refresh_indicators, daemon=True)
            _indicators_thread.start()
            print("[cache] indicators -> background thread")
        else:
            print("[cache] indicators still running — skipping this cycle")
    else:
        time.sleep(2)
        _refresh_sparklines_bg()
        time.sleep(2)
        _refresh_indicators()

    print(f"[cache] fast-path done  {(time.time()-t_total):.1f} s")


def _bg_refresh_loop():
    """Daemon thread: refreshes prices every 60 s, sparklines+indicators every 180 s."""
    cycle = 0
    while True:
        time.sleep(60)
        cycle += 1
        run_slow = (cycle % 3 == 0)   # full refresh every ~3 min
        _refresh_cache(background_slow=run_slow)


def _start_scheduler():
    """APScheduler: retrain LSTM every Sunday at 02:00."""
    if not _LSTM_AVAILABLE:
        return
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        def _weekly_retrain():
            print(f"[scheduler] Weekly LSTM retrain started at {datetime.now()}")
            try:
                lstm_mod.train_all()
            except Exception as e:
                print(f"[scheduler] LSTM retrain error: {e}")

        sched = BackgroundScheduler()
        sched.add_job(_weekly_retrain, 'cron', day_of_week='sun', hour=2, minute=0)
        sched.start()
        print("[scheduler] Weekly LSTM retrain scheduled: Sundays 02:00")
    except Exception as e:
        print(f"[scheduler] Could not start APScheduler: {e}")


if __name__ == '__main__':
    # ── Trim log files so they don't grow unbounded ────────────────────────────
    print("[startup] Rotating log files ...")
    _rotate_portfolio_log()
    _rotate_indicators_log()

    # ── Pre-populate prices + sparklines synchronously (~5-8 s) ───────────────
    # Indicators fire in a background thread so Flask starts immediately after.
    print("[startup] Pre-populating prices (sparklines + indicators in background) ...")
    _refresh_cache(background_slow=True)
    print("[startup] Cache ready — starting Flask.")

    # ── Background refresh loop (prices+sparklines every 60 s) ────────────────
    threading.Thread(target=_bg_refresh_loop, daemon=True).start()

    _start_scheduler()

    app.run(host='127.0.0.1', port=5000, debug=False, threaded=True, use_reloader=False)
