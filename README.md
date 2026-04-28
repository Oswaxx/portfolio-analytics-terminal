<div align="center">

# Terminal de Análisis de Portafolio

**Un dashboard de portafolio en tiempo real, autoalojado, con predicciones ML, indicadores técnicos y contabilidad completa para cripto y acciones.**

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-2.x-000000?style=for-the-badge&logo=flask&logoColor=white)](https://flask.palletsprojects.com)
[![PyTorch](https://img.shields.io/badge/PyTorch-LSTM-EE4C2C?style=for-the-badge&logo=pytorch&logoColor=white)](https://pytorch.org)
[![Chart.js](https://img.shields.io/badge/Chart.js-Plotly-FF6384?style=for-the-badge&logo=chartdotjs&logoColor=white)](https://www.chartjs.org)
[![Licencia](https://img.shields.io/badge/Licencia-MIT-22c55e?style=for-the-badge)](LICENSE)
[![Estado](https://img.shields.io/badge/Estado-Activo-22c55e?style=for-the-badge)]()

</div>

---

> Un dashboard web estilo terminal que convierte tus tenencias de cripto y acciones en un hub de análisis completamente instrumentado — con predicciones mediante redes neuronales LSTM, pronósticos ARIMA, más de 14 indicadores técnicos y reportes fiscales listos para declarar. Corre completamente en tu máquina.

---

## Capturas de Pantalla

| Dashboard | Predicciones ML | Indicadores Técnicos |
|-----------|-----------------|----------------------|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Predicciones](docs/screenshots/predicciones.png) | ![Indicadores](docs/screenshots/Indicadores.png) |

| Matriz de Correlaciones | Historial de Operaciones | Reporte Fiscal |
|-------------------------|--------------------------|----------------|
| ![Correlaciones](docs/screenshots/correlaciones.png) | ![Operaciones](docs/screenshots/historial_cerrado.png) | ![Fiscal](docs/screenshots/fiscal.png) |

---

## Funcionalidades

### Predicciones ML
- **Red Neuronal LSTM** — Modelo PyTorch de 3 capas (128→64→32 unidades ocultas) entrenado con 13 características: precio, volumen, RSI, MACD, Bandas de Bollinger, MA50/200, puntuación de sentimiento, Índice de Miedo & Codicia y dominancia de BTC
- **Pronóstico ARIMA** — Selección automática de órdenes con proyecciones de precio a 90 días e intervalos de confianza al 95%
- **Monte Carlo Dropout** — 20 pasadas hacia adelante para generar bandas de incertidumbre (±1.96σ) alrededor de las predicciones LSTM
- **Señal Híbrida COMPRA/MANTENER/VENTA** — Puntuación ponderada que combina dirección LSTM, RSI, momentum MACD, sentimiento y miedo del mercado; cada señal incluye razonamiento legible
- **Horizontes de 30 / 60 / 90 días** — Gráficas de pronóstico interactivas con Plotly y bandas de confianza
- **Puntuación de fiabilidad** — Métrica MAPE + precisión direccional por modelo, visible en la interfaz
- **Re-entrenamiento automático** — APScheduler lanza el entrenamiento LSTM cada domingo a las 2 AM

### Indicadores Técnicos
- RSI (período 14) con zonas de sobrecompra/sobreventa
- MACD (12/26/9) señal de tendencia por histograma
- Bandas de Bollinger (período 20, k=2) con clasificación por posición de banda
- Cruces MA50/MA200 — detección de Cruz Dorada / Cruz de la Muerte
- Etiquetas de estado de tendencia: _Alcista fuerte_, _Recuperación_, _Lateral_, _Bajista_
- Volumen de operaciones en 24h (Binance para cripto, Yahoo Finance para acciones)
- Puntuación de sentimiento de noticias desde CryptoPanic + RSS de CoinDesk
- Índice de Miedo & Codicia (CoinGecko) y Dominancia de BTC (CoinPaprika)

### KPIs del Portafolio en Tiempo Real
- Valor total del portafolio, P&L global (USD y %)
- Por activo: precio, cantidad, costo promedio, capital invertido, valor actual, P&L, distancia al punto de equilibrio
- Mejor / peor desempeño por porcentaje
- Saldo neto después de comisiones (Hapi, Bakkt, SPEI)
- Conversión en vivo USD→MXN para cálculos de retiros
- 10 tarjetas KPI arrastrables con persistencia en `localStorage`
- Alertas de punto de equilibrio, avisos de caída adicional del 10% y notificaciones de ruptura de stop-loss

### Secciones del Dashboard
| Sección | Descripción |
|---------|-------------|
| **Dashboard** | Tarjetas KPI en vivo, barra de mercado, insignias de señales, tabla de portafolio con sparklines de 7 días |
| **Centro de Predicciones** | Gráficas de pronóstico ARIMA + LSTM con razonamiento de señales |
| **Correlaciones** | Mapa de calor de correlación de Pearson entre todos los activos |
| **Registro de Compra / Venta** | Registrar compras y ventas con P&L considerando comisiones |
| **Importar HAPI CSV** | Importación masiva de historial de operaciones desde exportación del exchange |
| **Mis Metas** | Configuración de stop-loss / take-profit por activo |
| **Resumen Fiscal** | Ganancias/pérdidas realizadas año a año para declaración de impuestos |
| **Resumen Global** | Total depositado, retirado, P&L realizado y comisiones |
| **Historial Cerrado** | Registro de auditoría completo de todas las posiciones cerradas |
| **Log Histórico** | Gráfica del historial de valor del portafolio (ventana deslizante de 48h) |
| **Depósito MX → Hapi** | Registrar depósitos en MXN con tipo de cambio en tiempo real |

---

## Stack Tecnológico

### Backend
| Librería | Propósito |
|----------|-----------|
| **Flask** | Servidor HTTP, enrutamiento de la REST API |
| **PyTorch** | Entrenamiento e inferencia del modelo LSTM |
| **scikit-learn** | MinMaxScaler, pipelines de preprocesamiento |
| **statsmodels** | Modelado de series de tiempo con ARIMA |
| **pandas / numpy** | Manipulación de datos y cálculo de indicadores |
| **APScheduler** | Tarea cron semanal de re-entrenamiento LSTM |
| **requests** | Cliente HTTP para todas las APIs externas |

### APIs Externas
| API | Datos |
|-----|-------|
| **Binance REST** | Precios cripto en tiempo real, velas OHLCV de 1h |
| **Finnhub** | Cotizaciones y fundamentos de acciones |
| **CoinGecko** | OHLCV histórico de cripto (entrenamiento LSTM) |
| **CryptoPanic** | Feed de noticias para análisis de sentimiento |
| **ExchangeRate-API** | Conversión en vivo USD→MXN |
| **CoinPaprika** | Dominancia de BTC |

### Frontend
| Librería | Propósito |
|----------|-----------|
| **Vanilla JS** | Sin dependencia de framework |
| **Chart.js** | Gráficas donut/barra para KPIs, sparklines |
| **Plotly** | Gráficas de pronóstico interactivas con bandas de confianza |
| **PapaParse** | Parseo de CSV para importación de operaciones |
| **IntersectionObserver** | Carga diferida de sparklines |

---

## Instalación

### Requisitos previos
- Python 3.10+
- pip
- Cuenta de Binance (gratuita) para precios de cripto
- API key de Finnhub (nivel gratuito) para cotizaciones de acciones

### 1. Clonar el repositorio

```bash
git clone https://github.com/your-username/portfolio-analytics-terminal.git
cd portfolio-analytics-terminal
```

### 2. Crear un entorno virtual

```bash
python -m venv .venv

# Linux / macOS
source .venv/bin/activate

# Windows
.venv\Scripts\activate
```

### 3. Instalar dependencias

```bash
pip install flask torch scikit-learn statsmodels pandas numpy \
            apscheduler requests plotly
```

> **Soporte GPU (opcional):** Instala la versión de PyTorch con CUDA desde [pytorch.org](https://pytorch.org/get-started/locally/) para un entrenamiento LSTM más rápido.

### 4. Configurar las API keys

Crea el archivo `api_keys.json` en la raíz del proyecto:

```json
{
  "finnhub_key": "TU_CLAVE_FINNHUB",
  "coingecko_key": ""
}
```

> CoinGecko funciona sin clave en el nivel público (con límite de tasa de 30 segundos). Una API key gratuita elimina la mayoría de los límites.

### 5. Configurar tu portafolio

Crea `metas.json` con tus objetivos de trading por activo:

```json
{
  "BTC": { "stop_loss": 55000, "take_profit": 120000 },
  "ETH": { "stop_loss": 2800, "take_profit": 6000 }
}
```

### 6. Ejecutar la aplicación

```bash
python app.py
```

Abre [http://127.0.0.1:5000](http://127.0.0.1:5000) en tu navegador.

---

## Ejecutar como Servicio de Windows (opcional)

Usa [NSSM](https://nssm.cc) para ejecutar la app como un servicio de Windows persistente en segundo plano:

```powershell
# Instalar (ejecutar como Administrador)
.\install_service.ps1

# Desinstalar
.\uninstall_service.ps1
```

O usa el lanzador por lotes:

```bat
run_flask.bat
```

---

## Referencia de la API

Todos los endpoints devuelven JSON. El frontend los consulta automáticamente, pero también puedes llamarlos directamente.

| Método | Endpoint | Descripción | TTL de caché |
|--------|----------|-------------|--------------|
| `GET` | `/api/data` | Snapshot del portafolio — precios, valores, P&L, alertas | 60s |
| `GET` | `/api/sparklines` | Velas de 168 horas para mini-gráficas | 180s |
| `GET` | `/api/indicators` | Indicadores técnicos de todos los activos | 180s |
| `GET` | `/api/correlations` | Matriz de correlación de Pearson | — |
| `GET` | `/api/fear-greed` | Índice de sentimiento del mercado | 300s |
| `GET` | `/api/exchange-rate` | Tipo de cambio en vivo USD → MXN | 3600s |
| `GET` | `/api/predict/<activo>` | Pronóstico ARIMA a 90 días | 30 min |
| `GET` | `/api/lstm/predictions/<activo>` | Pronóstico LSTM a 30/60/90 días | — |
| `GET` | `/api/lstm/signal/<activo>` | Señal híbrida COMPRA / MANTENER / VENTA | — |
| `GET` | `/api/fiscal` | Reporte fiscal (ganancias realizadas por año) | — |
| `GET` | `/api/resumen-global` | Resumen contable agregado | — |
| `POST` | `/api/compras` | Registrar una nueva operación de compra | — |
| `POST` | `/api/ventas` | Registrar una nueva venta con P&L | — |
| `GET/POST` | `/api/goals` | Configuración de objetivos de trading por activo | — |

---

## Estructura del Proyecto

```
portfolio-analytics-terminal/
├── app.py                  # Servidor Flask, todas las rutas API, caché, hilos
├── lstm_model.py           # Arquitectura LSTM en PyTorch, entrenamiento, inferencia Monte Carlo
├── predictor.py            # Motor de pronóstico ARIMA
├── indicators.py           # Cálculo de indicadores técnicos, sentimiento, Miedo & Codicia
├── templates/
│   └── index.html          # UI del dashboard de una sola página
├── static/
│   ├── css/style.css       # Tema oscuro estilo terminal
│   └── js/app.js           # Lógica frontend, Chart.js, Plotly, carga diferida
├── models/                 # Pesos guardados del LSTM (.pt)
├── scalers/                # Objetos MinMaxScaler ajustados (.pkl)
├── predictions/            # Archivos JSON de predicciones LSTM en caché
├── data/                   # Secuencias de entrenamiento LSTM preprocesadas (.npy)
├── api_keys.json           # Credenciales de API (ignorado por git)
├── metas.json              # Objetivos de trading por activo
├── compras.csv             # Registro de operaciones de compra
├── ventas.csv              # Registro de operaciones de venta
├── movimientos.csv         # Registro unificado de movimientos
├── portfolio_log.csv       # Historial de valor del portafolio (ventana de 48h)
├── indicators_log.csv      # Historial de indicadores técnicos (5760 filas)
├── install_service.ps1     # Instalador del servicio NSSM para Windows
├── uninstall_service.ps1   # Desinstalador del servicio NSSM para Windows
└── run_flask.bat           # Lanzador por lotes para Windows
```

---

## Detalles del Modelo LSTM

```
Entrada:  Secuencias de 60 días × 13 características
           └─ precio, volumen, RSI, MACD, Bandas de Bollinger,
              MA50, MA200, sentimiento, miedo/codicia, dominancia BTC

Arquitectura:
  LSTM(128) → Dropout(0.2)
  LSTM(64)  → Dropout(0.2)
  LSTM(32)  → Dropout(0.2)
  FC(16)    → FC(1)

Entrenamiento:   Adam · pérdida MSE · Early stopping (paciencia=10) · Máx 100 épocas
Inferencia:      Monte Carlo Dropout · 20 pasadas · bandas de confianza ±1.96σ
Re-entrenamiento: Cada domingo a las 02:00 vía APScheduler
```

---

## Contribuciones

Las contribuciones son bienvenidas. Por favor abre un issue primero para discutir los cambios que deseas realizar.

1. Haz un fork del repositorio
2. Crea una rama para tu funcionalidad: `git checkout -b feature/tu-funcionalidad`
3. Confirma tus cambios: `git commit -m 'feat: agregar tu funcionalidad'`
4. Sube la rama: `git push origin feature/tu-funcionalidad`
5. Abre un Pull Request

---

## Hoja de Ruta

- [ ] Configuración con Docker / docker-compose
- [ ] Backend con PostgreSQL (reemplazar archivos CSV)
- [ ] Modelo de predicción de precios basado en Transformer
- [ ] Alertas por correo / Telegram al romper stop-loss
- [ ] Autenticación multi-usuario
- [ ] Exportar reporte del portafolio a PDF

---

## Licencia

[MIT](LICENSE) © Oswaldo Ramírez

---

<div align="center">
Construido con Flask · PyTorch · Chart.js · Plotly
</div>
