"""
lstm_model.py — PyTorch LSTM for portfolio price prediction.
Covers: data prep, model architecture, training, multi-step forecasting,
Monte Carlo Dropout confidence intervals, and ARIMA comparison.
"""

import json
import logging
import math
import os
import pickle
import time
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import requests
import yfinance as yf

log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
_BASE = os.path.dirname(__file__)
MODELS_DIR      = os.path.join(_BASE, "models")
DATA_DIR        = os.path.join(_BASE, "data")
PREDICTIONS_DIR = os.path.join(_BASE, "predictions")
SCALERS_DIR     = os.path.join(_BASE, "scalers")
IND_LOG         = os.path.join(_BASE, "indicators_log.csv")
TRAINING_LOG    = os.path.join(MODELS_DIR, "training_log.json")

for d in (MODELS_DIR, DATA_DIR, PREDICTIONS_DIR, SCALERS_DIR):
    os.makedirs(d, exist_ok=True)

# ── Asset config ──────────────────────────────────────────────────────────────
ASSETS = {
    "BTC":  {"type": "crypto", "cg_id": "bitcoin"},
    "ETH":  {"type": "crypto", "cg_id": "ethereum"},
    "SOL":  {"type": "crypto", "cg_id": "solana"},
    "XRP":  {"type": "crypto", "cg_id": "ripple"},
    "DOGE": {"type": "crypto", "cg_id": "dogecoin"},
    "TTWO": {"type": "stock",  "cg_id": None},
}

SEQ_LEN    = 60   # lookback window (days)
FEATURES   = ["price", "volume_24h", "rsi", "macd", "macd_signal",
               "bb_upper", "bb_lower", "bb_width", "ma50", "ma200",
               "sentiment_score", "fear_greed", "btc_dominance"]
BATCH_SIZE = 32
MAX_EPOCHS = 100
PATIENCE   = 10
LR         = 0.001
MC_PASSES  = 20   # Monte Carlo dropout passes

# ── CoinGecko rate-limited fetch ──────────────────────────────────────────────
_CG_LAST = 0.0

def _cg_get(url, params=None, interval=6.0):
    global _CG_LAST
    wait = interval - (time.monotonic() - _CG_LAST)
    if wait > 0:
        time.sleep(wait)
    _CG_LAST = time.monotonic()
    r = requests.get(url, params=params, timeout=20,
                     headers={"Accept": "application/json"})
    if r.status_code == 429:
        log.warning("CoinGecko 429 — sleeping 30 s")
        time.sleep(30)
        r = requests.get(url, params=params, timeout=20,
                         headers={"Accept": "application/json"})
    return r

# ── RSI / MACD / BB / MA helpers ──────────────────────────────────────────────

def _rsi(s, n=14):
    d = s.diff().dropna()
    g = d.clip(lower=0).ewm(com=n-1, adjust=False).mean()
    l = (-d.clip(upper=0)).ewm(com=n-1, adjust=False).mean()
    rs = g / l.replace(0, 1e-9)
    return 100 - 100 / (1 + rs)

def _macd(s, fast=12, slow=26, sig=9):
    ema_f = s.ewm(span=fast, adjust=False).mean()
    ema_s = s.ewm(span=slow, adjust=False).mean()
    macd  = ema_f - ema_s
    signal = macd.ewm(span=sig, adjust=False).mean()
    return macd, signal

def _bb(s, n=20, k=2):
    rm = s.rolling(n).mean()
    rs = s.rolling(n).std()
    upper = rm + k * rs
    lower = rm - k * rs
    width = (upper - lower) / rm.replace(0, np.nan) * 100
    return upper, lower, width

# ── 1.1 — Fetch historical data ───────────────────────────────────────────────

def fetch_history(asset: str, days: int = 365) -> pd.DataFrame:
    info = ASSETS[asset]
    if info["type"] == "crypto":
        url = (f"https://api.coingecko.com/api/v3/coins/{info['cg_id']}"
               f"/market_chart?vs_currency=usd&days={days}")
        # Retry up to 4 times with escalating backoff on 429
        r = None
        for attempt in range(4):
            r = _cg_get(url, interval=30.0)
            if r.status_code == 200:
                break
            if r.status_code == 429:
                wait = 60 * (attempt + 1)
                log.warning("CG 429 for %s — sleeping %ds (attempt %d/4)", asset, wait, attempt+1)
                print(f"  [{asset}] CoinGecko 429 — waiting {wait}s...")
                time.sleep(wait)
            else:
                break
        if r is None or r.status_code != 200:
            log.error("CG fetch failed %s: %s", asset, r.status_code if r else "no response")
            return pd.DataFrame()
        body = r.json()
        prices = pd.DataFrame(body["prices"], columns=["ts", "price"])
        prices["ds"] = pd.to_datetime(prices["ts"], unit="ms")
        prices = prices.set_index("ds")["price"].resample("D").last().dropna()

        vols = pd.DataFrame(body.get("total_volumes", []), columns=["ts", "vol"])
        if not vols.empty:
            vols["ds"] = pd.to_datetime(vols["ts"], unit="ms")
            vols = vols.set_index("ds")["vol"].resample("D").last().dropna()
        else:
            vols = pd.Series(dtype=float, name="vol")

        df = pd.DataFrame({"price": prices, "volume_24h": vols})
        df.index.name = "ds"
    else:
        ticker = info.get("cg_id") or asset
        hist = yf.Ticker(ticker).history(period="1y")
        if hist.empty:
            return pd.DataFrame()
        # Convert tz-aware index safely (tz_convert→None strips tz; tz_localize→None only valid for tz-naive)
        idx = hist.index
        if hasattr(idx, 'tz') and idx.tz is not None:
            idx = idx.tz_convert(None)
        idx = pd.DatetimeIndex(idx).normalize()
        df = pd.DataFrame({
            "price": hist["Close"].values,
            "volume_24h": hist["Volume"].values,
        }, index=idx)
        df.index.name = "ds"

    df = df.sort_index()
    # Compute technical indicators
    p = df["price"]
    df["rsi"]      = _rsi(p)
    df["macd"], df["macd_signal"] = _macd(p)
    df["bb_upper"], df["bb_lower"], df["bb_width"] = _bb(p)
    df["ma50"]     = p.rolling(50).mean()
    df["ma200"]    = p.rolling(200).mean()

    # Merge indicators_log sentiment / fear_greed if available
    if os.path.exists(IND_LOG):
        try:
            ilog = pd.read_csv(IND_LOG, parse_dates=["timestamp"])
            ilog = ilog[ilog["asset"] == asset].copy()
            ilog = ilog.set_index(ilog["timestamp"].dt.normalize())
            ilog = ilog[~ilog.index.duplicated(keep="last")]
            for col in ["sentiment_score", "fear_greed", "btc_dominance"]:
                if col in ilog.columns:
                    df[col] = ilog[col]
        except Exception as e:
            log.warning("ilog merge %s: %s", asset, e)

    for col in ["sentiment_score", "fear_greed", "btc_dominance"]:
        if col not in df.columns:
            df[col] = np.nan

    # Always keep ds as the index (named), reset only at return
    df = df.reset_index()   # moves named "ds" index to column
    if "ds" not in df.columns:
        df = df.rename(columns={df.columns[0]: "ds"})
    return df

# ── 1.2 — Clean and normalize ─────────────────────────────────────────────────

def prepare_dataset(asset: str) -> tuple:
    """Returns (X_train, y_train, X_val, y_val, scaler_dict, df_clean)."""
    from sklearn.preprocessing import MinMaxScaler

    df = fetch_history(asset, days=365)
    if df.empty or len(df) < SEQ_LEN + 10:
        raise ValueError(f"Not enough data for {asset}: {len(df)} rows")

    # Forward-fill then interpolate
    df = df.set_index("ds")
    df = df[FEATURES].copy()
    df = df.replace([np.inf, -np.inf], np.nan)
    df = df.interpolate(method="linear", limit_direction="both")
    df = df.ffill().bfill()
    # Fill any columns that are entirely NaN (e.g. sentiment/fear_greed for stocks)
    # with 0 so they don't cause all rows to be dropped
    for col in df.columns:
        if df[col].isna().all():
            df[col] = 0.0
        elif df[col].isna().any():
            df[col] = df[col].fillna(df[col].median())
    df = df.dropna()

    if len(df) < SEQ_LEN + 10:
        raise ValueError(f"After cleaning, not enough data for {asset}: {len(df)} rows")

    # Fit one scaler per feature
    scalers = {}
    scaled = np.zeros_like(df.values, dtype=np.float32)
    for i, col in enumerate(FEATURES):
        sc = MinMaxScaler(feature_range=(0, 1))
        scaled[:, i] = sc.fit_transform(df[[col]].values).flatten()
        scalers[col] = sc

    # Save scalers
    with open(os.path.join(SCALERS_DIR, f"{asset}_scalers.pkl"), "wb") as f:
        pickle.dump(scalers, f)

    # Build sequences
    X, y = [], []
    for i in range(SEQ_LEN, len(scaled)):
        X.append(scaled[i - SEQ_LEN:i])
        y.append(scaled[i, 0])  # predict scaled price

    X = np.array(X, dtype=np.float32)
    y = np.array(y, dtype=np.float32)

    split = int(len(X) * 0.8)
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]

    np.save(os.path.join(DATA_DIR, f"{asset}_train.npy"), np.column_stack([X_train.reshape(len(X_train), -1), y_train]))
    np.save(os.path.join(DATA_DIR, f"{asset}_val.npy"),   np.column_stack([X_val.reshape(len(X_val), -1),   y_val]))

    return X_train, y_train, X_val, y_val, scalers, df

# ── 2 — LSTM Model (PyTorch) ──────────────────────────────────────────────────

def _get_torch():
    import torch
    import torch.nn as nn
    return torch, nn

class LSTMModel:
    """Wrapper around PyTorch LSTM to match sklearn-style interface."""

    def __init__(self, input_size, hidden1=128, hidden2=64, hidden3=32, dropout=0.2):
        torch, nn = _get_torch()

        class _Net(nn.Module):
            def __init__(self):
                super().__init__()
                self.lstm1 = nn.LSTM(input_size, hidden1, batch_first=True)
                self.drop1 = nn.Dropout(dropout)
                self.lstm2 = nn.LSTM(hidden1, hidden2, batch_first=True)
                self.drop2 = nn.Dropout(dropout)
                self.lstm3 = nn.LSTM(hidden2, hidden3, batch_first=True)
                self.drop3 = nn.Dropout(dropout)
                self.fc1   = nn.Linear(hidden3, 16)
                self.relu  = nn.ReLU()
                self.out   = nn.Linear(16, 1)

            def forward(self, x):
                x, _ = self.lstm1(x)
                x = self.drop1(x)
                x, _ = self.lstm2(x)
                x = self.drop2(x)
                x, _ = self.lstm3(x)
                x = self.drop3(x)
                x = x[:, -1, :]   # last time-step
                x = self.relu(self.fc1(x))
                return self.out(x).squeeze(1)

        self.net = _Net()
        self.torch = torch
        self.nn = nn

    def train_model(self, X_train, y_train, X_val, y_val, asset=""):
        torch, nn = self.torch, self.nn
        opt  = torch.optim.Adam(self.net.parameters(), lr=LR)
        loss_fn = nn.MSELoss()

        Xt = torch.tensor(X_train)
        yt = torch.tensor(y_train)
        Xv = torch.tensor(X_val)
        yv = torch.tensor(y_val)

        best_val_loss = float("inf")
        best_epoch    = 0
        best_state    = None
        no_improve    = 0
        history       = {"train_loss": [], "val_loss": [], "val_mae": []}

        t0 = time.time()
        for epoch in range(MAX_EPOCHS):
            self.net.train()
            perm = torch.randperm(len(Xt))
            train_loss = 0.0
            for start in range(0, len(Xt), BATCH_SIZE):
                idx = perm[start:start + BATCH_SIZE]
                xb, yb = Xt[idx], yt[idx]
                opt.zero_grad()
                pred = self.net(xb)
                loss = loss_fn(pred, yb)
                loss.backward()
                opt.step()
                train_loss += loss.item() * len(xb)
            train_loss /= len(Xt)

            self.net.eval()
            with torch.no_grad():
                val_pred = self.net(Xv)
                val_loss = loss_fn(val_pred, yv).item()
                val_mae  = torch.mean(torch.abs(val_pred - yv)).item()

            history["train_loss"].append(round(train_loss, 6))
            history["val_loss"].append(round(val_loss, 6))
            history["val_mae"].append(round(val_mae, 6))

            print(f"  [{asset}] Epoch {epoch+1:3d}/{MAX_EPOCHS} | "
                  f"train_loss={train_loss:.5f} | val_loss={val_loss:.5f} | val_mae={val_mae:.5f}")

            if val_loss < best_val_loss - 1e-6:
                best_val_loss = val_loss
                best_epoch    = epoch + 1
                best_state    = {k: v.clone() for k, v in self.net.state_dict().items()}
                no_improve    = 0
            else:
                no_improve += 1
                if no_improve >= PATIENCE:
                    print(f"  [{asset}] Early stopping at epoch {epoch+1} (best={best_epoch})")
                    break

        elapsed = time.time() - t0
        if best_state:
            self.net.load_state_dict(best_state)

        # Final val metrics
        self.net.eval()
        with torch.no_grad():
            final_pred = self.net(Xv).numpy()
        rmse = float(np.sqrt(np.mean((final_pred - y_val) ** 2)))
        mae  = float(np.mean(np.abs(final_pred - y_val)))

        print(f"\n  [{asset}] Training complete — best epoch: {best_epoch} | "
              f"MAE: {mae:.5f} | RMSE: {rmse:.5f} | time: {elapsed:.0f}s\n")

        return history, best_epoch, mae, rmse, elapsed

    def save(self, path):
        self.torch.save(self.net.state_dict(), path)

    def load(self, path, input_size):
        self.net.load_state_dict(self.torch.load(path, map_location="cpu"))
        self.net.eval()

# ── 3 — Predict with Monte Carlo Dropout ─────────────────────────────────────

def _mc_predict(net, X_seq, n_passes=MC_PASSES):
    """Run n_passes forward passes with dropout active; return mean + std."""
    import torch

    net.train()  # keep dropout active
    preds = []
    x = torch.tensor(X_seq.reshape(1, SEQ_LEN, -1))
    with torch.no_grad():
        for _ in range(n_passes):
            preds.append(net(x).item())
    net.eval()
    return float(np.mean(preds)), float(np.std(preds))


def generate_predictions(asset: str, model: LSTMModel,
                          scalers: dict, df: pd.DataFrame) -> dict:
    """Multi-step rolling forecast for 30/60/90 days with MC confidence bands."""
    import torch

    price_scaler = scalers["price"]

    # Build seed sequence (last SEQ_LEN days)
    from sklearn.preprocessing import MinMaxScaler
    scaled_df = np.zeros((len(df), len(FEATURES)), dtype=np.float32)
    for i, col in enumerate(FEATURES):
        if col in df.columns:
            vals = df[col].values.reshape(-1, 1)
            scaled_df[:, i] = scalers[col].transform(vals).flatten()

    seed = scaled_df[-SEQ_LEN:].copy()  # (SEQ_LEN, n_features)

    preds_mean, preds_lower, preds_upper = [], [], []
    current_seq = seed.copy()

    for step in range(90):
        mean, std = _mc_predict(model.net, current_seq)
        preds_mean.append(mean)
        preds_lower.append(mean - 1.96 * std)
        preds_upper.append(mean + 1.96 * std)

        # Roll: append new row, drop oldest
        new_row = current_seq[-1].copy()
        new_row[0] = mean  # update price feature
        current_seq = np.vstack([current_seq[1:], new_row])

    def _inv(arr):
        arr = np.array(arr, dtype=np.float32).reshape(-1, 1)
        return price_scaler.inverse_transform(arr).flatten().tolist()

    prices_mean  = _inv(preds_mean)
    prices_lower = _inv(preds_lower)
    prices_upper = _inv(preds_upper)

    # df is indexed by ds at this point (prepare_dataset does set_index("ds"))
    last_date = pd.to_datetime(df.index[-1])
    fut_dates = [(last_date + timedelta(days=i + 1)).strftime("%Y-%m-%d") for i in range(90)]

    return {
        "asset": asset,
        "forecast_dates": fut_dates,
        "prices_mean":  prices_mean,
        "prices_lower": prices_lower,
        "prices_upper": prices_upper,
        "30d": round(prices_mean[29], 4) if len(prices_mean) >= 30 else None,
        "60d": round(prices_mean[59], 4) if len(prices_mean) >= 60 else None,
        "90d": round(prices_mean[89], 4) if len(prices_mean) >= 90 else None,
    }


def compute_reliability(y_true, y_pred_scaled, price_scaler):
    """MAPE, direction accuracy, and 0-100 reliability score."""
    y_true = np.array(y_true, dtype=float)
    y_pred = price_scaler.inverse_transform(
        np.array(y_pred_scaled, dtype=np.float32).reshape(-1, 1)
    ).flatten()

    mape = float(np.mean(np.abs((y_true - y_pred) / (np.abs(y_true) + 1e-9))) * 100)
    dir_acc = float(np.mean(np.sign(np.diff(y_true)) == np.sign(np.diff(y_pred))) * 100)

    # Score: penalize MAPE, reward direction accuracy
    score = max(0, min(100, 100 - mape * 2 + (dir_acc - 50) * 0.5))
    return {
        "mape": round(mape, 2),
        "direction_accuracy": round(dir_acc, 1),
        "reliability_score": round(score, 1),
        "low_confidence": mape > 15,
    }

# ── Train all assets ──────────────────────────────────────────────────────────

def train_all(assets=None):
    assets = assets or list(ASSETS.keys())
    training_log = {}
    if os.path.exists(TRAINING_LOG):
        try:
            with open(TRAINING_LOG) as f:
                training_log = json.load(f)
        except Exception:
            training_log = {}

    summary = {}
    for asset_idx, asset in enumerate(assets):
        if asset_idx > 0:
            # Wait 45s between crypto assets to respect CoinGecko free tier
            info = ASSETS.get(asset, {})
            if info.get("type") == "crypto":
                print(f"\n  Waiting 45s before {asset} (CoinGecko rate limit)...")
                time.sleep(45)

        print(f"\n{'='*60}")
        print(f"  Training LSTM for {asset}")
        print(f"{'='*60}")
        t_start = time.time()

        try:
            # 1. Prepare data
            X_train, y_train, X_val, y_val, scalers, df = prepare_dataset(asset)
            print(f"  Data: {len(X_train)} train / {len(X_val)} val sequences")

            # 2. Build model
            model = LSTMModel(input_size=len(FEATURES))

            # 3. Train
            history, best_epoch, mae, rmse, elapsed = model.train_model(
                X_train, y_train, X_val, y_val, asset=asset
            )

            # 4. Compute reliability on val set
            import torch
            model.net.eval()
            with torch.no_grad():
                Xv = torch.tensor(X_val)
                y_pred_scaled = model.net(Xv).numpy()

            price_scaler = scalers["price"]
            # Inverse-transform y_val (it was scaled by price_scaler)
            y_val_true = price_scaler.inverse_transform(
                y_val.reshape(-1, 1)
            ).flatten()
            reliability = compute_reliability(y_val_true, y_pred_scaled, price_scaler)
            print(f"  Reliability — MAPE: {reliability['mape']}% | "
                  f"Dir: {reliability['direction_accuracy']}% | "
                  f"Score: {reliability['reliability_score']}/100")

            # 5. Save model
            model_path = os.path.join(MODELS_DIR, f"{asset}_lstm.pt")
            model.save(model_path)

            # 6. Save training history
            hist_path = os.path.join(MODELS_DIR, f"{asset}_history.json")
            with open(hist_path, "w") as f:
                json.dump(history, f)

            # 7. Generate predictions
            preds = generate_predictions(asset, model, scalers, df)
            preds["reliability"] = reliability
            pred_path = os.path.join(PREDICTIONS_DIR, f"{asset}_pred.json")
            with open(pred_path, "w") as f:
                json.dump(preds, f)

            summary[asset] = {
                "status": "ok",
                "best_epoch": best_epoch,
                "mae": round(mae, 5),
                "rmse": round(rmse, 5),
                "mape": reliability["mape"],
                "direction_accuracy": reliability["direction_accuracy"],
                "reliability_score": reliability["reliability_score"],
                "trained_at": datetime.now().isoformat(),
                "elapsed_s": round(elapsed, 1),
            }

        except Exception as e:
            import traceback
            traceback.print_exc()
            summary[asset] = {"status": "error", "error": str(e)}

        total_time = time.time() - t_start
        print(f"  [{asset}] total time: {total_time:.0f}s")

    # Print final summary
    print(f"\n{'='*60}")
    print("  TRAINING SUMMARY")
    print(f"{'='*60}")
    for asset, s in summary.items():
        if s["status"] == "ok":
            print(f"  {asset:6s} — MAE: {s['mae']:.5f} | MAPE: {s['mape']}% | "
                  f"Score: {s['reliability_score']}/100 | Epoch: {s['best_epoch']}")
        else:
            print(f"  {asset:6s} — ERROR: {s['error']}")

    training_log[datetime.now().strftime("%Y-%m-%d %H:%M")] = summary
    with open(TRAINING_LOG, "w") as f:
        json.dump(training_log, f, indent=2)

    return summary

# ── Load saved model for inference ───────────────────────────────────────────

def load_model(asset: str):
    """Returns (model, scalers) or raises if not trained yet."""
    model_path  = os.path.join(MODELS_DIR, f"{asset}_lstm.pt")
    scaler_path = os.path.join(SCALERS_DIR, f"{asset}_scalers.pkl")
    if not os.path.exists(model_path) or not os.path.exists(scaler_path):
        raise FileNotFoundError(f"LSTM model for {asset} not trained yet")
    with open(scaler_path, "rb") as f:
        scalers = pickle.load(f)
    model = LSTMModel(input_size=len(FEATURES))
    model.load(model_path, len(FEATURES))
    return model, scalers

def get_predictions(asset: str) -> dict:
    """Return cached predictions JSON or empty dict if not available."""
    path = os.path.join(PREDICTIONS_DIR, f"{asset}_pred.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

def get_training_status() -> dict:
    """Return the most recent successful result per asset across all runs."""
    if not os.path.exists(TRAINING_LOG):
        return {}
    try:
        with open(TRAINING_LOG) as f:
            log_data = json.load(f)
        if not log_data:
            return {}
        # Walk runs in chronological order; overwrite per-asset entry on each ok result
        per_asset = {}
        last_complete_run = None
        for run_key in sorted(log_data.keys()):
            run = log_data[run_key]
            for asset, result in run.items():
                if result.get("status") == "ok":
                    per_asset[asset] = result
            # Track last run where every known asset succeeded
            if all(run.get(a, {}).get("status") == "ok" for a in run):
                last_complete_run = run_key
        last_run = sorted(log_data.keys())[-1]
        return {
            "last_run": last_run,
            "last_complete_run": last_complete_run,
            "assets": per_asset,
        }
    except Exception:
        return {}


if __name__ == "__main__":
    import sys
    assets = sys.argv[1:] or list(ASSETS.keys())
    train_all(assets)
