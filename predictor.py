"""
predictor.py (portfolio_web) — Predicción ARIMA para la app Flask
Usa CoinGecko (90 días, tier gratuito) para cripto y yfinance para stocks.
Prophet eliminado; ARIMA(5,1,0) como modelo único.
"""

import datetime
import logging
import math
import os
import time
import traceback
import numpy as np

import pandas as pd
import requests
import yfinance as yf
from statsmodels.tsa.arima.model import ARIMA

# Cache ARIMA model results for 30 minutes — fitting is expensive (5-20 s per asset)
_predict_cache: dict = {}
_PREDICT_TTL = 1800.0

logging.getLogger("cmdstanpy").setLevel(logging.WARNING)

# Ruta al CSV del tracker (por si CoinGecko falla, se usa como fallback local)
_LOCAL_LOG = os.path.join(os.path.dirname(__file__), "..", "portfolio_tracker", "portfolio_log.csv")

COINGECKO_ASSETS = {
    "bitcoin", "ethereum", "solana", "ripple", "dogecoin",
}

# ─── Fuentes de datos ─────────────────────────────────────────────────────────


def _get_crypto_history(coin_id: str) -> pd.DataFrame:
    """Descarga hasta 90 días de precios diarios desde CoinGecko (free tier)."""
    # days=max y &interval=daily requieren API key de pago.
    # days=90 sin interval devuelve datos horarios que luego resampleamos a diario.
    url = (
        f"https://api.coingecko.com/api/v3/coins/{coin_id}"
        f"/market_chart?vs_currency=usd&days=90"
    )
    try:
        r = requests.get(url, timeout=12, headers={"Accept": "application/json"})
        if r.status_code == 429:
            raise RuntimeError("CoinGecko rate-limit (429) — intenta en 60 s")
        if r.status_code != 200:
            raise RuntimeError(f"CoinGecko HTTP {r.status_code}")

        body = r.json()
        # En caso de error la API devuelve {"status": {"error_code": ...}}
        if "status" in body and "error_code" in body.get("status", {}):
            raise RuntimeError(body["status"].get("error_message", "CoinGecko error"))
        if "prices" not in body:
            raise RuntimeError("Respuesta inesperada: sin campo 'prices'")

        df = pd.DataFrame(body["prices"], columns=["timestamp", "price"])
        df["ds"] = pd.to_datetime(df["timestamp"], unit="ms")
        df["y"] = df["price"].astype(float)
        # Resamplea a cierre diario (agrupa datos horarios o sub-horarios)
        df = (
            df.set_index("ds")["y"]
            .resample("D").last()
            .dropna()
            .reset_index()
        )
        df.columns = ["ds", "y"]
        df["ds"] = df["ds"].dt.normalize()
        return df

    except Exception as e:
        print(f"[predictor] CoinGecko falló para {coin_id}: {e}")
        return pd.DataFrame()


def _get_stock_history(ticker: str) -> pd.DataFrame:
    """Descarga ~90 días de precios de cierre desde yfinance."""
    try:
        tk = yf.Ticker(ticker)
        hist = tk.history(period="3mo")
        if hist.empty:
            raise RuntimeError(f"yfinance devolvió vacío para {ticker}")
        df = hist[["Close"]].reset_index()
        df.columns = ["ds", "y"]
        df["ds"] = pd.to_datetime(df["ds"]).dt.tz_localize(None).dt.normalize()
        df["y"] = df["y"].astype(float)
        return df.sort_values("ds").reset_index(drop=True)
    except Exception as e:
        print(f"[predictor] yfinance falló para {ticker}: {e}")
        return pd.DataFrame()


def _get_local_history(asset_key: str) -> pd.DataFrame:
    """Fallback: lee el portfolio_log.csv local si las APIs fallan.
    Preserva la resolución original del log (1 min) — no resamplea a diario.
    """
    try:
        if not os.path.exists(_LOCAL_LOG):
            return pd.DataFrame()
        df = pd.read_csv(_LOCAL_LOG, parse_dates=["Timestamp"])
        col = f"{asset_key.upper()}_Price"
        if col not in df.columns:
            return pd.DataFrame()
        sub = df[["Timestamp", col]].dropna().copy()
        sub.columns = ["ds", "y"]
        # Mantiene timestamps completos (minuto a minuto) para que ARIMA tenga datos
        sub = sub.sort_values("ds").reset_index(drop=True)
        sub["y"] = sub["y"].astype(float)
        return sub
    except Exception as e:
        print(f"[predictor] local fallback falló para {asset_key}: {e}")
        return pd.DataFrame()


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _clean_list(lst):
    """Reemplaza NaN/Inf con None para serialización JSON segura."""
    result = []
    for v in lst:
        if v is None:
            result.append(None)
        elif isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            result.append(None)
        else:
            result.append(float(v))
    return result


# ─── Modelo ARIMA ─────────────────────────────────────────────────────────────


def _run_arima(df: pd.DataFrame, periods: list[int] = (30, 60, 90)) -> dict:
    """Ajusta ARIMA y devuelve el payload completo para Plotly."""
    y = df["y"].values
    max_p = max(periods)

    # Prueba órdenes de mayor a menor complejidad
    fitted = None
    for order in [(5, 1, 0), (2, 1, 2), (1, 1, 1), (1, 1, 0)]:
        try:
            m = ARIMA(y, order=order)
            fitted = m.fit()
            used_order = order
            break
        except Exception:
            continue

    if fitted is None:
        raise RuntimeError("No se pudo ajustar ningún modelo ARIMA")

    fc = fitted.get_forecast(steps=max_p)
    pred_mean = fc.predicted_mean
    _ci = fc.conf_int(alpha=0.05)  # IC 95 %
    ci = np.array(_ci) if not isinstance(_ci, np.ndarray) else _ci

    last_date = df["ds"].max()
    future_dates = [last_date + pd.Timedelta(days=i) for i in range(1, max_p + 1)]

    predictions: dict[str, float] = {}
    for p in periods:
        if p <= len(pred_mean):
            predictions[f"{p}_days"] = float(pred_mean[p - 1])

    payload = {
        "model": f"ARIMA{used_order}",
        "timestamps": (
            df["ds"].dt.strftime("%Y-%m-%d").tolist()
            + [d.strftime("%Y-%m-%d") for d in future_dates]
        ),
        "yhat": [None] * len(y) + _clean_list(pred_mean.tolist()),
        "yhat_lower": [None] * len(y) + _clean_list(ci[:, 0].tolist()),
        "yhat_upper": [None] * len(y) + _clean_list(ci[:, 1].tolist()),
        "actual_timestamps": df["ds"].dt.strftime("%Y-%m-%d").tolist(),
        "actual_y": df["y"].tolist(),
        "predictions_summary": predictions,
    }
    return payload


# ─── Punto de entrada público ─────────────────────────────────────────────────


def predict_asset(asset_id: str, buy_price: float, ticker: str = "") -> dict:
    """
    Parámetros
    ----------
    asset_id  : CoinGecko id ('bitcoin') para cripto, o ticker ('TTWO') para stocks
    buy_price : precio promedio de compra del usuario
    ticker    : símbolo corto del activo ('BTC', 'ETH', 'TTWO'…) — usado para
                el fallback local al CSV del tracker
    """
    cache_key = asset_id.lower()
    now = time.monotonic()
    cached = _predict_cache.get(cache_key)

    if cached and now - cached["ts"] < _PREDICT_TTL:
        # Cache hit — reuse ARIMA result, recompute buy_price analysis
        arima_result = cached["result"]
        last_price = cached["last_price"]
    else:
        # 1. Obtener serie histórica
        df = pd.DataFrame()

        if asset_id.lower() in COINGECKO_ASSETS:
            df = _get_crypto_history(asset_id.lower())

        if df.empty and len(asset_id) <= 5 and asset_id.upper() == asset_id:
            df = _get_stock_history(asset_id.upper())

        if df.empty:
            key = ticker.upper() if ticker else asset_id
            df = _get_local_history(key)

        if df.empty or len(df) < 10:
            return {
                "error": (
                    "No hay suficientes datos históricos para este activo. "
                    "Verifica tu conexión o espera 60 s si CoinGecko aplicó rate-limit."
                )
            }

        # 2. Ajustar ARIMA
        try:
            arima_result = _run_arima(df)
            last_price = float(df["y"].iloc[-1])
            _predict_cache[cache_key] = {"ts": now, "result": arima_result, "last_price": last_price}
        except Exception as e:
            traceback.print_exc()
            return {"error": f"Error en el modelo: {e}"}

    # 3. Análisis de break-even y tendencia (always recomputed with current buy_price)
    result = dict(arima_result)
    preds = result.get("predictions_summary", {})
    max_pred = max(preds.values()) if preds else 0
    p30 = preds.get("30_days", 0)
    p90 = preds.get("90_days", 0)

    if p30 > 0 and p90 / p30 > 1.01:
        trend = "Alcista"
    elif p30 > 0 and p90 / p30 < 0.99:
        trend = "Bajista"
    else:
        trend = "Lateral"

    if max_pred >= buy_price:
        be_eval = "Si"
    elif max_pred >= buy_price * 0.90:
        be_eval = "Probable (>90%)"
    else:
        pct = (max_pred / buy_price * 100) if buy_price else 0
        be_eval = f"No ({pct:.0f}% del BE)"

    result["analysis"] = {
        "break_even_90d": be_eval,
        "trend": trend,
        "buy_price": buy_price,
        "last_price": last_price,
        "pct_to_breakeven": round(((buy_price - last_price) / last_price) * 100, 2) if buy_price else 0,
    }
    return result
