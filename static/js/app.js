// Global Instances
let donutChartInst = null;
let barChartInst = null;
let logChartInst = null;
let corrChartInst = null;
let sparklinesInsts = {};
let tableDataCache = [];
let sparklineDataCache = {};
let currentSortCol = -1;
let currentSortAsc = true;
let csvImportRowsCache = [];

// IntersectionObserver for lazy sparkline rendering
let _sparkObserver = null;
(function _initSparkObserver() {
    if (typeof IntersectionObserver === 'undefined') return;
    _sparkObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const canvas = entry.target;
            const asset  = canvas.dataset.asset;
            const pts    = sparklineDataCache[asset];
            if (pts && pts.length > 0) {
                const m = tableDataCache.find(r => r.asset === asset);
                if (m) renderSparkline(canvas, pts, m.pnl_perc >= 0);
                _sparkObserver.unobserve(canvas);
            }
        });
    }, { threshold: 0.1 });
}());

// Technical indicators cache (filled by loadIndicators)
let _indicators = {};
let _fearGreed  = {};
let _btcDom     = {};

// Formats
const fmtUSD  = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const fmtMXN  = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);
const fmtPerc = (n) => new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2 }).format(n / 100);

// UI Nav Logic
document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', function() {
        document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
        this.classList.add('active');
        const target = this.dataset.target;
        document.querySelectorAll('.content-view').forEach(v => v.classList.remove('active'));
        document.getElementById(target).classList.add('active');

        if(target === 'registro-compra') {
            loadCompras();
        } else if(target === 'dashboard') {
            if(donutChartInst) donutChartInst.update();
            if(barChartInst) barChartInst.update();
        } else if(target === 'log-history') {
            if(logChartInst) logChartInst.update();
            loadLogs();
        } else if(target === 'deposito-mx') {
            loadDeposits();
            fetchExchangeRate();
        } else if(target === 'registro-venta') {
            loadVentas();
        } else if(target === 'mis-metas') {
            loadGoals();
        } else if(target === 'resumen-fiscal') {
            initFiscalYears();
        } else if(target === 'correlaciones') {
            loadCorrelations();
        } else if(target === 'centro-predicciones') {
            loadPredCenter();
        } else if(target === 'historial-cerrado') {
            loadHistorialCerrado();
        } else if(target === 'resumen-global') {
            loadResumenGlobal();
        }
    });
});

let _indicatorsLoaded = false;

// Shared cache so Resumen Global stays in sync with the auto-refresh loop
let _lastPortData = null;   // last /api/data response
let _lastRGData   = null;   // last /api/resumen-global response
let _extraData    = null;   // last /api/dashboard-extra response

// Assets that incur Bakkt 1% fee on Hapi; stocks/ETFs have no trading commission
const CRYPTO_ASSETS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']);

async function forceRefresh() {
    const _rfTasks = [loadDashboard()];
    if (document.getElementById('log-history')?.classList.contains('active')) _rfTasks.push(loadLogs());
    await Promise.all(_rfTasks);
    document.getElementById('last-refresh-time').innerText = new Date().toLocaleTimeString('es-ES', {hour12:false});
    if (_indicatorsLoaded) {
        loadIndicators(); // subsequent refreshes load immediately (cache is warm)
    }

    // Keep Resumen Global unrealized P&L in sync if that section is active.
    // Uses the same /api/data result that loadDashboard() just fetched — no extra request.
    const rgSection = document.getElementById('resumen-global');
    if (rgSection?.classList.contains('active') && _lastPortData && _lastRGData) {
        renderRGKPIs(_lastRGData, _lastPortData.Global_PnL_USD || 0);
    }

    // Keep second KPI row in sync when dashboard is active (renderNewKPIs is cheap — no fetch)
    const dashSection = document.getElementById('dashboard');
    if (dashSection?.classList.contains('active') && _extraData && _lastPortData) {
        renderNewKPIs(_extraData, _lastPortData);
    }
}

// Sorting logic
function sortTable(colIndex) {
    if(currentSortCol === colIndex) currentSortAsc = !currentSortAsc;
    else { currentSortCol = colIndex; currentSortAsc = true; }
    renderTable();
}

function showTableSkeleton() {
    const tbody = document.querySelector('#portfolio-table tbody');
    const cell  = '<td><div class="skeleton-line"></div></td>';
    tbody.innerHTML = Array(6).fill(0).map(() =>
        `<tr class="skeleton-row">${Array(12).fill(cell).join('')}</tr>`
    ).join('');
}

// DASHBOARD LOGIC
async function loadDashboard() {
    showTableSkeleton();
    ['kpi-value','kpi-pnl'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.dataset.prev = el.innerText; el.classList.add('skeleton-text'); }
    });

    try {
        // Fetch portfolio data + extra KPIs in parallel
        const [res, resExtra] = await Promise.all([
            fetch('/api/data'),
            fetch('/api/dashboard-extra'),
        ]);
        const data = await res.json();
        _extraData = await resExtra.json();

        if (!data || !data.assets) return;
        _lastPortData = data;

        ['kpi-value','kpi-pnl'].forEach(id => {
            document.getElementById(id)?.classList.remove('skeleton-text');
        });

        // Header time
        document.getElementById('last-refresh-time').innerText = new Date().toLocaleTimeString('es-ES', {hour12:false});

        // KPIs
        document.getElementById('kpi-value').innerText = fmtUSD(data.Global_Value);
        
        const isGlobalGain = data.Global_PnL_USD >= 0;
        document.getElementById('kpi-pnl').innerText = `${fmtUSD(data.Global_PnL_USD)} (${fmtPerc(data.Global_PnL_Perc)})`;
        document.getElementById('kpi-pnl').className = `kpi-value font-mono ${isGlobalGain?'text-ganancia':'text-perdida'}`;

        let bestAsset = ''; let bestPnl = -Infinity;
        let worstAsset = ''; let worstPnl = Infinity;
        
        tableDataCache = [];
        const labels = [];
        const donutData = [];
        const barInvested = [];
        const barValue = [];

        Object.entries(data.assets).forEach(([asset, m]) => {
            if (m.pnl_perc > bestPnl) { bestPnl = m.pnl_perc; bestAsset = asset; }
            if (m.pnl_perc < worstPnl) { worstPnl = m.pnl_perc; worstAsset = asset; }
            
            tableDataCache.push({
                asset,
                price: m.price,
                avg_cost: m.avg_cost,
                invested: m.invested,
                value: m.value,
                pnl_usd: m.pnl_usd,
                pnl_perc: m.pnl_perc,
                dist_be: m.dist_be
            });
            labels.push(asset);
            donutData.push(m.value);
            barInvested.push(m.invested);
            barValue.push(m.value);
        });

        document.getElementById('kpi-best-worst').innerHTML = 
            `↑ <span class="text-ganancia">${bestAsset} (${fmtPerc(bestPnl)})</span><br>` +
            `↓ <span class="text-perdida">${worstAsset} (${fmtPerc(worstPnl)})</span>`;

        // Alerts Banner
        const banner = document.getElementById('alert-banner');
        if (data.alerts && data.alerts.length > 0) {
            banner.innerHTML = data.alerts.map(a => `<span style="margin-right:20px;">■ ${a.msg}</span>`).join('');
            banner.style.display = 'block';
        } else {
            banner.style.display = 'none';
        }

        renderTable();
        renderNewKPIs(_extraData, data);

        renderDonutChart(labels, donutData);
        renderBarChart(labels, barInvested, barValue);

        // Load sparklines separately (non-blocking) — served from bg store, should be fast
        fetch('/api/sparklines')
            .then(r => r.json())
            .then(sparks => {
                sparklineDataCache = sparks;
                // Trigger lazy render for each visible sparkline canvas
                document.querySelectorAll('.sparkline-canvas[data-asset]').forEach(c => {
                    if (_sparkObserver) {
                        _sparkObserver.unobserve(c);
                        _sparkObserver.observe(c);
                    } else {
                        const pts = sparks[c.dataset.asset];
                        const m   = tableDataCache.find(r => r.asset === c.dataset.asset);
                        if (pts && pts.length && m) renderSparkline(c, pts, m.pnl_perc >= 0);
                    }
                });
            })
            .catch(e => console.warn('Sparklines error:', e));

    } catch (e) { console.error("Error loading dashboard", e); }
}

function renderTable() {
    let sortedList = [...tableDataCache];
    
    // Sort logic
    if (currentSortCol !== -1) {
        sortedList.sort((a,b) => {
            let va = a[Object.keys(a)[currentSortCol]];
            let vb = b[Object.keys(b)[currentSortCol]];
            if(typeof va === 'string') return currentSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
            return currentSortAsc ? va - vb : vb - va;
        });
    }

    const tbody = document.querySelector('#portfolio-table tbody');
    tbody.innerHTML = '';
    
    sortedList.forEach(m => {
        const isGain = m.pnl_perc >= 0;
        const colorClass = isGain ? 'text-ganancia' : 'text-perdida';
        const bgClass = isGain ? 'bg-ganancia' : 'bg-perdida';
        const ind = _indicators[m.asset] || {};

        // RSI badge
        const rsiVal = ind.rsi != null ? ind.rsi.toFixed(1) : '--';
        const rsiCls = ind.rsi_label === 'Sobrecomprado' ? 'badge-rsi-over'
                     : ind.rsi_label === 'Sobrevendido'  ? 'badge-rsi-under' : 'badge-rsi-neu';

        // Volume with 7-day average arrow
        const volArrow = (ind.volume_24h != null && ind.vol_7d_avg != null)
            ? (ind.volume_24h > ind.vol_7d_avg
                ? ' <span style="color:#26a69a">▲</span>'
                : ' <span style="color:#ef5350">▼</span>')
            : '';
        const volHtml = _fmtVol(ind.volume_24h) + volArrow;

        // MA Signal badge
        const maSig = ind.ma_signal || '--';
        const maCls = maSig === 'Golden Cross'   ? 'badge-golden'
                    : maSig === 'Death Cross'     ? 'badge-death'
                    : (maSig === 'Alcista fuerte' || maSig === 'Alcista') ? 'badge-ma-bull'
                    : maSig === 'Recuperación'    ? 'badge-ma-rec'
                    : maSig === 'Bajista'          ? 'badge-ma-bear' : 'badge-ma-lat';

        // MACD badge
        const macdTrend = ind.macd_trend || '--';
        const macdCls   = macdTrend === 'Alcista' ? 'badge-macd-bull'
                        : macdTrend === 'Bajista'  ? 'badge-macd-bear' : 'badge-rsi-neu';
        const macdShort = macdTrend === 'Alcista' ? 'M↑' : macdTrend === 'Bajista' ? 'M↓' : 'M–';

        // Bollinger badge
        const bbPos   = ind.bb_position || '--';
        const bbCls   = bbPos.includes('superior') ? 'badge-bb-upper'
                      : bbPos.includes('inferior')  ? 'badge-bb-lower' : 'badge-bb-mid';
        const bbShort = bbPos.includes('superior') ? 'B↑' : bbPos.includes('inferior') ? 'B↓' : 'B–';

        // Sentiment badge
        const sent      = ind.sentiment || {};
        const sentLabel = sent.label || '--';
        const sentCls   = sentLabel === 'Positivo' ? 'badge-sent-pos'
                        : sentLabel === 'Negativo'  ? 'badge-sent-neg' : 'badge-sent-neu';
        const sentShort = sentLabel === 'Positivo' ? 'S+' : sentLabel === 'Negativo' ? 'S–' : 'S·';

        const ventaNeta     = (m.value || 0) * (CRYPTO_ASSETS.has(m.asset) ? 0.99 : 1.00);
        const ventaNetaGain = ventaNeta >= (m.invested || 0);

        const row = `
            <tr>
                <td style="font-weight:600;">${m.asset}</td>
                <td><canvas id="spark-${m.asset}" data-asset="${m.asset}" class="sparkline-canvas"></canvas></td>
                <td class="font-mono">${fmtUSD(m.price)}</td>
                <td class="font-mono">${fmtUSD(m.avg_cost)}</td>
                <td class="font-mono">${fmtUSD(m.invested)}</td>
                <td class="font-mono">${fmtUSD(m.value)}</td>
                <td class="font-mono ${colorClass}">${fmtUSD(m.pnl_usd)}</td>
                <td><span class="badge ${bgClass} font-mono">${fmtPerc(m.pnl_perc)}</span></td>
                <td><span class="${rsiCls}" title="${ind.rsi_label||''}">${rsiVal}</span></td>
                <td class="font-mono" style="font-size:.72rem; white-space:nowrap;">${volHtml}</td>
                <td><span class="${maCls}">${maSig === 'N/D' ? '--' : maSig}</span></td>
                <td style="white-space:nowrap;" title="MACD: ${macdTrend} | BB: ${bbPos} | Sentiment: ${sentLabel}">
                    <span class="${macdCls}" style="margin-right:2px;">${macdShort}</span><span class="${bbCls}" style="margin-right:2px;">${bbShort}</span><span class="${sentCls}">${sentShort}</span>
                </td>
                <td class="font-mono ${ventaNetaGain ? 'text-ganancia' : 'text-perdida'}" title="Lo que recibirías de Hapi si vendes ahora${CRYPTO_ASSETS.has(m.asset) ? ' (−1% Bakkt)' : ' (sin comisión)'}">${fmtUSD(ventaNeta)}</td>
                <td><button class="pred-btn" onclick="openPrediction('${m.asset}')">★ ML Eval</button></td>
            </tr>
        `;
        tbody.insertAdjacentHTML('beforeend', row);
    });

    // Register sparkline canvases with IntersectionObserver for lazy rendering
    document.querySelectorAll('.sparkline-canvas[data-asset]').forEach(canvas => {
        if (_sparkObserver) {
            _sparkObserver.unobserve(canvas);
            if (sparklineDataCache[canvas.dataset.asset]?.length > 0) {
                _sparkObserver.observe(canvas);
            }
        } else {
            // Fallback if IntersectionObserver unavailable
            const pts = sparklineDataCache[canvas.dataset.asset];
            const m   = sortedList.find(r => r.asset === canvas.dataset.asset);
            if (pts && pts.length && m) renderSparkline(canvas, pts, m.pnl_perc >= 0);
        }
    });
}

// ── KPI Drag-and-Drop ──────────────────────────────────────────────────────────
const KPI_ORDER_KEY = 'portfolio_kpi_order_v1';

function restoreKPIOrder() {
    const container = document.getElementById('kpi-container');
    if (!container) return;
    try {
        const saved = localStorage.getItem(KPI_ORDER_KEY);
        if (!saved) return;
        const ids = JSON.parse(saved);
        ids.forEach(id => {
            const card = container.querySelector(`[data-kpi-id="${id}"]`);
            if (card) container.appendChild(card);
        });
    } catch (_) {}
}

function saveKPIOrder() {
    const container = document.getElementById('kpi-container');
    if (!container) return;
    const ids = [...container.querySelectorAll('.kpi-card[data-kpi-id]')]
        .map(c => c.dataset.kpiId);
    localStorage.setItem(KPI_ORDER_KEY, JSON.stringify(ids));
}

function initKPIDrag() {
    const container = document.getElementById('kpi-container');
    if (!container) return;

    let dragging = null;

    container.addEventListener('dragstart', e => {
        const card = e.target.closest('.kpi-card[draggable]');
        if (!card) return;
        dragging = card;
        // Defer opacity so the drag ghost still looks solid
        requestAnimationFrame(() => card.classList.add('kpi-dragging'));
        e.dataTransfer.effectAllowed = 'move';
    });

    container.addEventListener('dragend', () => {
        if (dragging) dragging.classList.remove('kpi-dragging');
        dragging = null;
        saveKPIOrder();
    });

    container.addEventListener('dragover', e => {
        e.preventDefault();
        if (!dragging) return;
        const target = e.target.closest('.kpi-card[draggable]');
        if (!target || target === dragging) return;
        const rect = target.getBoundingClientRect();
        if (e.clientX < rect.left + rect.width / 2) {
            container.insertBefore(dragging, target);
        } else {
            container.insertBefore(dragging, target.nextSibling);
        }
    });
}

function renderNewKPIs(extraData, portData) {
    const netoPos = (extraData && extraData.neto_posiciones) ? extraData.neto_posiciones : 0;
    const el = document.getElementById('kpi-neto-posiciones');
    if (el) el.innerText = fmtUSD(netoPos);

    let ventaHoy = 0;
    if (portData && portData.assets) {
        Object.entries(portData.assets).forEach(([asset, m]) => {
            ventaHoy += (m.value || 0) * (CRYPTO_ASSETS.has(asset) ? 0.99 : 1.00);
        });
    }
    const ventaHoyEl = document.getElementById('kpi-venta-hoy');
    if (ventaHoyEl) {
        ventaHoyEl.innerText   = fmtUSD(ventaHoy);
        ventaHoyEl.className   = `kpi-value font-mono ${ventaHoy >= netoPos ? 'text-ganancia' : 'text-perdida'}`;
    }

    const feeSPEI = ventaHoy * 0.009;
    const feeEl   = document.getElementById('kpi-fee-spei');
    if (feeEl) feeEl.innerText = '-' + fmtUSD(feeSPEI);

    const netoBanco    = ventaHoy - feeSPEI;
    const netoBancoMXN = netoBanco * _currentFX;
    const netoBancoEl  = document.getElementById('kpi-neto-banco');
    if (netoBancoEl) {
        netoBancoEl.innerText = fmtMXN(netoBancoMXN);
        netoBancoEl.className = `kpi-value font-mono ${netoBanco >= netoPos ? 'text-ganancia' : 'text-perdida'}`;
    }
    const fxBadge = document.getElementById('kpi-neto-banco-fx');
    if (fxBadge) fxBadge.innerText = `$1 USD = $${_currentFX.toFixed(2)} MXN`;

    const ganado = (extraData && extraData.ganado_cerradas)  ? extraData.ganado_cerradas  : 0;
    const perdido = (extraData && extraData.perdido_cerradas) ? extraData.perdido_cerradas : 0;
    const netoCerradas   = ganado + perdido;
    const netoCerradasEl = document.getElementById('kpi-neto-cerradas');
    if (netoCerradasEl) {
        netoCerradasEl.innerText   = (netoCerradas >= 0 ? '+' : '') + fmtUSD(netoCerradas);
        netoCerradasEl.className   = `kpi-value font-mono ${netoCerradas >= 0 ? 'text-ganancia' : 'text-perdida'}`;
    }
    const detailEl = document.getElementById('kpi-neto-cerradas-detail');
    if (detailEl) detailEl.innerText = `+${fmtUSD(ganado)} / ${fmtUSD(perdido)}`;
}

function renderRGRetiros(drData) {
    const retiros = (drData || []).filter(r => r.Tipo === 'Retiro')
                                  .sort((a, b) => (a.Fecha > b.Fecha ? 1 : -1));
    const totalBruto = retiros.reduce((s, r) => s + (parseFloat(r.Monto) || 0), 0);
    const feesSPEI   = retiros.length * 10;
    const neto       = totalBruto - feesSPEI;

    const brutoEl = document.getElementById('rg-retiros-bruto');
    if (brutoEl) brutoEl.innerText = fmtUSD(totalBruto);

    const detailEl = document.getElementById('rg-retiros-detail');
    if (detailEl) {
        detailEl.innerHTML =
            `<span style="color:#F85149;">−${fmtUSD(feesSPEI)}</span> SPEI (${retiros.length}×$10 fijo)<br>` +
            `<span style="font-weight:600; color:var(--text-primary);">≈ ${fmtUSD(neto)} neto a banco</span>`;
    }

    // Static context provided by user — maps retiro date → "vino de" annotation
    const RETIRO_CONTEXT = {
        '2024-12-11': { fuente: 'NU',  gp: '+$9.53'  },
        '2025-05-17': { fuente: 'BTC', gp: '+$2.50'  },
        '2025-09-11': { fuente: 'BTC', gp: '+$3.41'  },
    };

    const rgEl = document.getElementById('rg-retiros-ganancia');
    if (rgEl) {
        let html = retiros.map(r => {
            const fecha = (r.Fecha || '').slice(0, 10);
            const mes   = (() => {
                try { return new Date(fecha + 'T12:00:00').toLocaleDateString('es-MX', { month:'short', year:'numeric' }); }
                catch(_) { return fecha; }
            })();
            const ctx   = RETIRO_CONTEXT[fecha] || {};
            const ctxTxt = ctx.fuente ? `→ vino de ${ctx.fuente} ${ctx.gp}` : '';
            return `<div>
                <span class="font-mono" style="color:var(--text-muted);">${mes}</span>
                <span class="font-mono" style="color:#F85149; margin:0 4px;">−${fmtUSD(parseFloat(r.Monto)||0)}</span>
                <span style="color:var(--text-muted); font-size:0.65rem;">${ctxTxt}</span>
                <span>✅</span>
            </div>`;
        }).join('');
        html += `<div style="margin-top:6px;">
            <span style="background:rgba(63,185,80,0.12); color:#3FB950; border:1px solid #3FB950;
                         padding:2px 8px; border-radius:4px; font-size:0.65rem;">
                ✅ Todos los retiros fueron en ganancia
            </span></div>`;
        rgEl.innerHTML = html;
    }
}

function renderSparkline(canvas, dataPoints, isGain) {
    const ctx = canvas.getContext('2d');
    if (sparklinesInsts[canvas.id]) sparklinesInsts[canvas.id].destroy();
    
    sparklinesInsts[canvas.id] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dataPoints.map((_, i) => i),
            datasets: [{
                data: dataPoints,
                borderColor: isGain ? '#3FB950' : '#F85149',
                borderWidth: 1.5,
                fill: false,
                pointRadius: 0
            }]
        },
        options: {
            animation: false,
            responsive: false,
            maintainAspectRatio: false,
            plugins: { legend: {display:false}, tooltip: {enabled:false} },
            scales: { x: {display:false}, y: {display:false} }
        }
    });
}

// Chart.js Global Init
Chart.defaults.color = '#8B949E';
Chart.defaults.font.family = 'Inter';

function renderDonutChart(labels, data) {
    const ctx = document.getElementById('donutChart').getContext('2d');
    if (donutChartInst) donutChartInst.destroy();
    
    donutChartInst = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: ['#D29922', '#58A6FF', '#3FB950', '#ec4899', '#8b5cf6', '#F85149'],
                borderWidth: 1,
                borderColor: '#161B22'
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            cutout: '75%',
            plugins: {
                legend: { position: 'right', labels: {boxWidth: 10} }
            }
        }
    });
}

function renderBarChart(labels, invested, value) {
    const ctx = document.getElementById('barChart').getContext('2d');
    if (barChartInst) barChartInst.destroy();
    
    barChartInst = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                { label: 'Invertido', data: invested, backgroundColor: '#30363D' },
                { label: 'Valor actual', data: value, backgroundColor: '#58A6FF' }
            ]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { grid: {color: 'rgba(255,255,255,0.05)'}, beginAtZero:true }
            }
        }
    });
}

async function loadLogs() {
    try {
        const [res, movRes] = await Promise.all([
            fetch('/api/log'),
            fetch('/api/movements')
        ]);
        
        const data = await res.json();
        const movData = await movRes.json();
        
        // Log Chart
        if (data && data.timestamps) {
            const ctx = document.getElementById('logChart').getContext('2d');
            if (logChartInst) logChartInst.destroy();
            logChartInst = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: data.timestamps.map(t => t.split(' ')[1]),
                    datasets: [{
                        label: 'Valor Ptf ($)',
                        data: data.global_values,
                        borderColor: '#58A6FF',
                        borderWidth: 2,
                        pointRadius: 0,
                        fill: true,
                        backgroundColor: 'rgba(88, 166, 255, 0.1)'
                    }]
                },
                options: {
                    animation: false,
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: { y: { grid: {color: '#30363D'} }, x: { grid: {display: false} } }
                }
            });
        }
        
        // Movements Table
        const tbody = document.querySelector('#movements-table tbody');
        tbody.innerHTML = '';
        let totalFees = 0;
        movData.forEach(r => {
            const fees = parseFloat(r.Deducciones_USD) || 0;
            totalFees += fees;
            const isImported = r.Origen === 'Importado';
            
            tbody.innerHTML += `
                <tr>
                    <td style="text-align:left;">${r.Fecha}</td>
                    <td style="text-align:left; font-weight:600;">${r.Activo}</td>
                    <td>${r.Tipo}</td>
                    <td class="font-mono">${r.Cantidad}</td>
                    <td class="font-mono">$${r.Precio_USD}</td>
                    <td class="text-perdida font-mono">-$${fees.toFixed(2)}</td>
                    <td class="text-ganancia font-mono">$${parseFloat(r.Monto_Neto_USD).toFixed(2)}</td>
                    <td style="text-align:center;">
                        <span class="badge ${isImported ? 'bg-ganancia' : 'bg-perdida'}">${r.Origen || '-'}</span>
                    </td>
                </tr>
            `;
        });
        document.getElementById('total-fees-paid').innerText = fmtUSD(totalFees);
        
    } catch(e){}
}

// Prediction Modal Logic
async function openPrediction(asset) {
    document.getElementById('modal-backdrop').style.display = 'block';
    document.getElementById('predict-modal').style.display = 'block';
    document.getElementById('ml-asset-title').innerText = asset;
    document.getElementById('ml-loading').style.display = 'block';
    document.getElementById('ml-content').style.display = 'none';

    try {
        const res = await fetch(`/api/predict/${asset}`);
        const data = await res.json();

        if (data.error) {
            document.getElementById('ml-loading').innerHTML =
                `<span style="color:var(--red-loss);">Error: ${data.error}</span>`;
            return;
        }

        const analy   = data.analysis;
        const preds   = data.predictions_summary || {};
        const trendColor = analy.trend === 'Alcista' ? 'var(--green-gain)'
                         : analy.trend === 'Bajista' ? 'var(--red-loss)'
                         : 'var(--yellow, #D29922)';

        document.getElementById('mb-trend').innerHTML =
            `<span style="color:${trendColor}">${analy.trend}</span>`;
        document.getElementById('mb-be').innerText   = analy.break_even_90d;
        document.getElementById('mb-pct-be').innerHTML =
            `<span style="color:var(--red-loss)">+${analy.pct_to_breakeven}%</span>`;
        document.getElementById('mb-p30').innerText  = preds['30_days'] ? fmtUSD(preds['30_days']) : '--';
        document.getElementById('mb-p60').innerText  = preds['60_days'] ? fmtUSD(preds['60_days']) : '--';
        document.getElementById('mb-p90').innerText  = preds['90_days'] ? fmtUSD(preds['90_days']) : '--';
        document.getElementById('mb-model-label').innerText = `Modelo: ${data.model} · Datos históricos: ${data.actual_y.length} puntos`;

        // ── Separar predichos de nulos ──────────────────────────────────────
        const nForecast     = data.yhat.filter(v => v !== null && !isNaN(v)).length;
        const forecastDates = data.timestamps.slice(-nForecast);
        const forecastVals  = data.yhat.filter(v => v !== null && !isNaN(v));
        const lowerVals     = data.yhat_lower ? data.yhat_lower.filter(v => v !== null && !isNaN(v)) : [];
        const upperVals     = data.yhat_upper ? data.yhat_upper.filter(v => v !== null && !isNaN(v)) : [];

        // ── Conectar último punto histórico con la predicción ──────────────
        const lastActDate = data.actual_timestamps[data.actual_timestamps.length - 1];
        const lastActVal  = data.actual_y[data.actual_y.length - 1];

        const traces = [
            // Histórico
            {
                x: data.actual_timestamps, y: data.actual_y,
                mode: 'lines', name: 'Histórico',
                line: { color: '#58A6FF', width: 1.5 }
            },
            // Banda de confianza (95%)
            ...(lowerVals.length > 0 ? [{
                x: [...forecastDates, ...forecastDates.slice().reverse()],
                y: [...upperVals, ...lowerVals.slice().reverse()],
                fill: 'toself', fillcolor: 'rgba(210,153,34,0.12)',
                line: { color: 'transparent' }, name: 'IC 95%',
                showlegend: true, hoverinfo: 'skip'
            }] : []),
            // Línea de predicción (conectada al último punto real)
            {
                x: [lastActDate, ...forecastDates],
                y: [lastActVal,  ...forecastVals],
                mode: 'lines', name: `Pred. ${data.model}`,
                line: { color: '#D29922', dash: 'dot', width: 2 }
            },
            // Línea de break-even (precio de compra)
            {
                x: [data.actual_timestamps[0], forecastDates[forecastDates.length - 1]],
                y: [analy.buy_price, analy.buy_price],
                mode: 'lines', name: `Break-even $${fmtUSD(analy.buy_price)}`,
                line: { color: '#F85149', dash: 'dash', width: 1 }
            }
        ];

        const layout = {
            paper_bgcolor: '#161B22', plot_bgcolor: '#0D1117',
            font: { color: '#8B949E', size: 11 },
            margin: { l: 55, r: 20, t: 20, b: 40 },
            legend: { orientation: 'h', y: -0.2, font: { size: 10 } },
            xaxis: { gridcolor: '#30363D', tickfont: { size: 10 } },
            yaxis: { gridcolor: '#30363D', tickfont: { size: 10 }, tickprefix: '$' },
            hovermode: 'x unified'
        };

        Plotly.newPlot('plotlyChart', traces, layout, { responsive: true, displayModeBar: false });

        // ── Technical indicators in modal ──────────────────────────────────
        const ind = _indicators[asset] || {};
        const fmtPriceOrND = v => (v != null ? fmtUSD(v) : 'N/D');

        // MA50 / MA200
        document.getElementById('mb-ma50').innerText  = fmtPriceOrND(ind.ma50);
        document.getElementById('mb-ma200').innerText = fmtPriceOrND(ind.ma200);

        // MA Signal
        const maSig = ind.ma_signal || 'N/D';
        const maCls = maSig === 'Golden Cross' ? 'badge-golden'
                    : maSig === 'Death Cross'   ? 'badge-death'
                    : (maSig === 'Alcista fuerte' || maSig === 'Alcista') ? 'badge-ma-bull'
                    : maSig === 'Recuperación' ? 'badge-ma-rec'
                    : maSig === 'Bajista' ? 'badge-ma-bear' : 'badge-ma-lat';
        document.getElementById('mb-masig').innerHTML = `<span class="${maCls}">${maSig}</span>`;

        // RSI
        const rsiVal = ind.rsi != null ? ind.rsi.toFixed(1) : 'N/D';
        const rsiLbl = ind.rsi_label || '';
        const rsiCls = rsiLbl === 'Sobrecomprado' ? 'text-perdida'
                     : rsiLbl === 'Sobrevendido'  ? 'text-ganancia' : '';
        document.getElementById('mb-rsi').innerHTML =
            `<span class="${rsiCls}">${rsiVal}</span><span style="color:var(--text-muted); font-size:.65rem;"> ${rsiLbl}</span>`;

        // MACD trend
        const macdT = ind.macd_trend || 'N/D';
        const macdCl = macdT === 'Alcista' ? 'badge-macd-bull' : macdT === 'Bajista' ? 'badge-macd-bear' : 'badge-rsi-neu';
        document.getElementById('mb-macd-trend').innerHTML = `<span class="${macdCl}">${macdT}</span>`;

        // Bollinger
        document.getElementById('mb-bb-pos').innerText   = ind.bb_position || 'N/D';
        document.getElementById('mb-bb-upper').innerText = ind.bb_upper != null ? fmtUSD(ind.bb_upper) : 'N/D';
        document.getElementById('mb-bb-mid').innerText   = ind.bb_mid   != null ? fmtUSD(ind.bb_mid)   : 'N/D';
        document.getElementById('mb-bb-lower').innerText = ind.bb_lower != null ? fmtUSD(ind.bb_lower)  : 'N/D';

        // Sentiment
        const sent = ind.sentiment || {};
        const sentCl = sent.label === 'Positivo' ? 'badge-sent-pos'
                     : sent.label === 'Negativo'  ? 'badge-sent-neg' : 'badge-sent-neu';
        document.getElementById('mb-sent').innerHTML = `<span class="${sentCl}">${sent.label || 'N/D'}</span>`;

        // News list
        let newsHtml = '';
        if (sent.articles && sent.articles.length) {
            newsHtml = '<div style="margin-top:6px; font-size:0.7rem; color:var(--text-muted);">Noticias recientes:</div>';
            sent.articles.forEach(a => {
                const nc = a.sentiment_label === 'Positivo' ? '#3FB950'
                         : a.sentiment_label === 'Negativo'  ? '#F85149' : '#8B949E';
                newsHtml += `<div style="padding:3px 0; border-bottom:1px solid var(--border-color);">
                    <span style="color:${nc}; font-size:.65rem; margin-right:4px;">[${a.sentiment_label}]</span>
                    <span style="color:var(--text-main);">${a.title}</span>
                    <span style="color:var(--text-muted); font-size:.65rem;"> — ${a.source}</span>
                </div>`;
            });
        }
        document.getElementById('mb-news').innerHTML = newsHtml;

        // MACD mini chart
        if (ind.macd_dates && ind.macd_dates.length > 5) {
            const macdTraces = [
                { x: ind.macd_dates, y: ind.macd_vals,     mode:'lines', name:'MACD',   line:{color:'#58A6FF', width:1.5} },
                { x: ind.macd_dates, y: ind.macd_sig_vals, mode:'lines', name:'Signal', line:{color:'#D29922', width:1.5} },
                { x: ind.macd_dates, y: ind.macd_hist_vals, type:'bar', name:'Hist',
                  marker:{color: ind.macd_hist_vals.map(v => v >= 0 ? 'rgba(63,185,80,.5)' : 'rgba(248,81,73,.5)')} }
            ];
            Plotly.newPlot('macdChart', macdTraces, {
                paper_bgcolor:'#161B22', plot_bgcolor:'#0D1117',
                font:{color:'#8B949E', size:9}, showlegend:false,
                margin:{l:40, r:8, t:4, b:24},
                xaxis:{gridcolor:'#30363D', tickfont:{size:8}},
                yaxis:{gridcolor:'#30363D', tickfont:{size:8}, zeroline:true, zerolinecolor:'#30363D'}
            }, {responsive:true, displayModeBar:false});
            document.getElementById('macd-chart-wrap').style.display = 'block';
        } else {
            document.getElementById('macd-chart-wrap').style.display = 'none';
        }

        document.getElementById('mb-model-label').innerText =
            `Modelo: ${data.model} · Histórico: ${data.actual_y.length} pts`;
        document.getElementById('ml-loading').style.display = 'none';
        document.getElementById('ml-content').style.display = 'block';

    } catch(e) {
        console.error(e);
        document.getElementById('ml-loading').innerHTML =
            `<span style="color:var(--red-loss);">Error inesperado. Revisa la consola.</span>`;
    }
}

function closePrediction() {
    document.getElementById('modal-backdrop').style.display = 'none';
    document.getElementById('predict-modal').style.display = 'none';
}

// Drag & Drop HAPI Parsing
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const previewSection = document.getElementById('preview-section');
const previewTbody = document.querySelector('#preview-table tbody');

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});
function preventDefaults (e) { e.preventDefault(); e.stopPropagation(); }

['dragenter', 'dragover'].forEach(eventName => dropZone.classList.add('dragover'));
['dragleave', 'drop'].forEach(eventName => dropZone.classList.remove('dragover'));

dropZone.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
fileInput.addEventListener('change', e => handleFiles(e.target.files));

function handleFiles(files) {
    if(files.length > 0) parseHapiCSV(files[0]);
}

function parseHapiCSV(file) {
    Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: function(results) {
            csvImportRowsCache = [];
            let r = results.data;
            let previewHTML = '';
            
            // Expected generic Hapi csv row layout. We guess columns dynamically or use assumptions 
            // "fecha, activo, tipo, monto, comision" (Usually Date, Symbol, Transaction Type, Quantity, Price, Fees, Amount)
            r.forEach((row, i) => {
                let fecha = row['Date'] || row['Fecha'] || row['Date/Time'] || new Date().toISOString();
                let activo = row['Symbol'] || row['Asset'] || row['Activo'] || 'USD';
                let tipoRaw = row['Transaction Type'] || row['Type'] || row['Tipo'] || 'Compra';
                
                let tipo = 'Compra';
                if(tipoRaw.toLowerCase().includes('sell') || tipoRaw.toLowerCase().includes('venta')) tipo = 'Venta';
                if(tipoRaw.toLowerCase().includes('dep') || tipoRaw.toLowerCase().includes('fund')) tipo = 'Depósito';

                let cantidad = parseFloat(row['Quantity'] || row['Cantidad']) || 0;
                let precio = parseFloat(row['Price'] || row['Precio']) || 0;
                let fee = parseFloat(row['Fees'] || row['Comision'] || row['Commission']) || 0;
                let neto = parseFloat(row['Amount'] || row['Neto'] || row['Value']) || (cantidad * precio);

                csvImportRowsCache.push({ fecha, activo, tipo, cantidad, precio_usd: precio, deducciones_usd: fee, monto_neto: neto });
                
                if(i < 5) {
                    previewHTML += `<tr>
                        <td>${fecha}</td>
                        <td>${activo}</td>
                        <td>${tipo}</td>
                        <td class="font-mono">${cantidad}</td>
                        <td class="font-mono">${precio}</td>
                        <td class="font-mono text-perdida">${fee}</td>
                        <td class="font-mono">${neto}</td>
                    </tr>`;
                }
            });
            previewTbody.innerHTML = previewHTML;
            previewSection.style.display = 'block';
        }
    });
}

async function confirmImport() {
    if(csvImportRowsCache.length === 0) return;
    try {
        const res = await fetch('/api/import_csv', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({rows: csvImportRowsCache})
        });
        const ans = await res.json();
        
        document.getElementById('last-import-date').innerText = new Date().toLocaleTimeString('es-ES', {hour12:false});
        alert(`Éxito!\nImportados: ${ans.imported}\nDuplicados ignorados: ${ans.ignored}`);
        
        previewSection.style.display = 'none';
        csvImportRowsCache = [];
        
        // Force overall data refresh
        forceRefresh();
        
    } catch(e) {
        alert("Error en la importación: " + e);
    }
}

// Init run
restoreKPIOrder();   // apply saved KPI order before first render
initKPIDrag();       // enable drag-and-drop on the KPI container
fetchExchangeRate(); // pre-load FX so MXN KPI is accurate on first render
forceRefresh();
loadConfig();
// Indicators: 5 s delay (reduced from 35 s — /api/data & sparklines now served from bg store, no CG contention)
setTimeout(() => { _indicatorsLoaded = true; loadIndicators(); }, 5000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _fmtVol(v) {
    if (v == null) return '<span style="color:var(--text-muted)">--</span>';
    const abs = Math.abs(v);
    let s;
    if (abs >= 1e9)      s = '$' + (v / 1e9).toFixed(1) + 'B';
    else if (abs >= 1e6) s = '$' + (v / 1e6).toFixed(1) + 'M';
    else if (abs >= 1e3) s = '$' + (v / 1e3).toFixed(0) + 'K';
    else                 s = '$' + v.toFixed(0);
    return s;
}

// ─── INDICADORES TÉCNICOS ─────────────────────────────────────────────────────

async function loadIndicators() {
    try {
        const res  = await fetch('/api/indicators');
        const body = await res.json();
        const inds = body.indicators || {};

        // Cache still cold — background thread not done yet. Retry silently in 5s.
        if (Object.keys(inds).length === 0) {
            setTimeout(loadIndicators, 5000);
            return;
        }

        _indicators = inds;
        _fearGreed  = body.fear_greed  || {};
        _btcDom     = body.btc_dominance || {};

        renderFearGreed(_fearGreed);
        renderBtcDominance(_btcDom);
        renderSignalsPanel(_indicators, _fearGreed);
        renderTable();
    } catch(e) {
        console.warn('Indicators load failed:', e);
        setTimeout(loadIndicators, 8000); // retry on network error
    }
}

function renderFearGreed(fg) {
    const val = fg.value;
    const el  = document.getElementById('fg-value');
    const lbl = document.getElementById('fg-label');
    if (!el) return;
    if (val == null) { el.innerText = '--'; lbl.innerText = 'N/D'; return; }

    const color = val <= 25 ? '#F85149'
                : val <= 45 ? '#e09949'
                : val <= 55 ? '#D29922'
                : val <= 75 ? '#7fc97f'
                :             '#3FB950';
    el.innerHTML = `<span style="color:${color}">${val}</span>`;
    lbl.innerText = fg.label || '';
    lbl.style.color = color;
}

let _btcDomRetried = false;
function renderBtcDominance(dom) {
    const el = document.getElementById('dom-value');
    const li = document.getElementById('dom-interp');
    if (!el) return;
    if (dom.dominance == null) {
        el.innerText = '--%'; li.innerText = 'N/D';
        if (!_btcDomRetried) {
            _btcDomRetried = true;
            setTimeout(() => loadIndicators(), 10000);
        }
        return;
    }
    _btcDomRetried = false;
    el.innerText = dom.dominance + '%';
    li.innerText = dom.interpretation || '';
}

function renderSignalsPanel(indicators, fg) {
    const panel = document.getElementById('signals-panel');
    if (!panel) return;
    // If cache is still cold, leave the "Cargando..." spinner intact so forceRefresh can retry
    if (!indicators || Object.keys(indicators).length === 0) return;
    const _sigLoading = document.getElementById('signals-loading');
    if (_sigLoading) _sigLoading.style.display = 'none';

    let bearishCount = 0, bullishCount = 0;
    let chips = '<span style="color:var(--text-muted); font-size:0.68rem; margin-right:6px;">Señales:</span>';

    Object.entries(indicators).forEach(([asset, ind]) => {
        if (ind.error) return;
        const sig  = ind.ma_signal || '--';
        const rsi  = ind.rsi;
        const macd = ind.macd_trend || '--';

        // Count signals
        if (sig === 'Bajista' || sig === 'Death Cross')      bearishCount++;
        if (sig === 'Alcista fuerte' || sig === 'Golden Cross') bullishCount++;

        // RSI sub-label
        const rsiTxt = rsi != null ? `RSI:${rsi.toFixed(0)}` : 'RSI:--';
        const rsiColor = rsi > 70 ? 'var(--red-loss)' : rsi < 30 ? 'var(--green-gain)' : 'var(--text-muted)';

        // Signal color
        const sigColor = sig === 'Golden Cross' ? '#ffd700'
                       : sig === 'Death Cross'   ? '#ff4444'
                       : (sig === 'Alcista fuerte' || sig === 'Alcista') ? 'var(--green-gain)'
                       : sig === 'Bajista' ? 'var(--red-loss)' : 'var(--text-muted)';

        chips += `<span class="signal-chip">
            <span class="chip-asset">${asset}</span>
            <span style="color:${rsiColor}">${rsiTxt}</span>
            <span style="color:${sigColor}; margin-left:2px;">${sig === 'N/D' ? '·' : sig}</span>
            <span style="color:${macd === 'Alcista' ? 'var(--green-gain)' : macd === 'Bajista' ? 'var(--red-loss)' : 'var(--text-muted)'}; margin-left:2px;">${macd === 'N/D' ? '' : 'M:' + macd}</span>
        </span>`;
    });

    panel.innerHTML = chips;

    // Alert banner based on signal counts
    const banner = document.getElementById('alert-banner');
    if (bearishCount >= 3) {
        banner.className  = 'bearish';
        banner.innerHTML  = `&#9651; ALERTA: ${bearishCount} activos muestran señales bajistas simultáneas`;
        banner.style.display = 'block';
    } else if (bullishCount >= 3) {
        banner.className  = 'bullish';
        banner.innerHTML  = `&#9651; ${bullishCount} activos con señales alcistas simultáneas`;
        banner.style.display = 'block';
    }
}

// ─── CORRELACIONES ────────────────────────────────────────────────────────────

async function loadCorrelations() {
    const insightEl = document.getElementById('corr-insights');
    if (insightEl) insightEl.innerHTML = '<li style="color:var(--text-muted)">Calculando...</li>';
    try {
        const res  = await fetch('/api/correlations');
        const data = await res.json();
        if (!data.assets || data.assets.length < 2) {
            if (insightEl) insightEl.innerHTML = '<li>No hay datos suficientes.</li>';
            return;
        }
        renderCorrHeatmap(data);
        if (insightEl) {
            insightEl.innerHTML = data.insights.length
                ? data.insights.map(i => `<li style="margin-bottom:4px;">${i}</li>`).join('')
                : '<li style="color:var(--text-muted)">Sin correlaciones altas detectadas (umbral 70%).</li>';
        }
    } catch(e) {
        if (insightEl) insightEl.innerHTML = '<li style="color:var(--red-loss)">Error cargando datos.</li>';
    }
}

function renderCorrHeatmap(data) {
    const assets = data.assets;
    const n = assets.length;
    const matrix = data.matrix;

    const canvas = document.getElementById('corrChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const wrap = document.getElementById('corr-canvas-wrap');
    // Use explicit fallback size if the element isn't yet painted
    const rawW = wrap.getBoundingClientRect().width || wrap.offsetWidth || 500;
    const size = Math.min(Math.max(rawW, 300), 520);
    canvas.width  = size;
    canvas.height = size;

    const cell = Math.floor(size / (n + 1));
    const labelSize = cell;
    ctx.clearRect(0, 0, size, size);

    // Draw grid
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            const val = (matrix[assets[i]] || {})[assets[j]];
            const x = labelSize + j * cell;
            const y = labelSize + i * cell;

            // Color
            let r, g, b;
            if (val == null) { r = 48; g = 54; b = 61; }
            else if (val >= 0) { r = Math.round(63 * val); g = Math.round(185 * val); b = Math.round(80 * val); }
            else               { r = Math.round(248 * (-val)); g = 30; b = 30; }
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);

            // Value text
            ctx.fillStyle = '#E6EDF3';
            ctx.font = `${Math.max(9, cell * 0.3)}px JetBrains Mono, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (val != null) ctx.fillText(val.toFixed(2), x + cell / 2, y + cell / 2);
        }
    }

    // Axis labels
    ctx.fillStyle = '#8B949E';
    ctx.font = `${Math.max(9, cell * 0.32)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    assets.forEach((a, i) => {
        ctx.fillText(a, labelSize + i * cell + cell / 2, labelSize / 2);   // top
        ctx.textAlign = 'right';
        ctx.fillText(a, labelSize - 4, labelSize + i * cell + cell / 2);   // left
        ctx.textAlign = 'center';
    });
}

// ─── KPI: Disponible en Hapi ─────────────────────────────────────────────────

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const cfg = await res.json();
        const el = document.getElementById('kpi-hapi-balance');
        if (el) el.innerText = fmtUSD(cfg.hapi_balance || 0);
    } catch(e) {}
}

function editHapiBalance() {
    const el = document.getElementById('kpi-hapi-balance');
    const current = parseFloat(el.innerText.replace(/[^0-9.-]/g, '')) || 0;
    const val = prompt('Saldo disponible en Hapi (USD):', current.toFixed(2));
    if (val === null) return;
    const num = parseFloat(val);
    if (isNaN(num)) return;
    el.innerText = fmtUSD(num);
    fetch('/api/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({hapi_balance: num})
    });
}

// ─── DEPÓSITO MX → HAPI ──────────────────────────────────────────────────────

let _currentFX = 17.5;

async function fetchExchangeRate() {
    try {
        const res = await fetch('/api/exchange-rate');
        const d = await res.json();
        _currentFX = d.usd_to_mxn || 17.5;
        const fxInput = document.getElementById('dep-fx');
        if (fxInput && !fxInput.value) fxInput.value = _currentFX.toFixed(2);
        const badge = document.getElementById('dep-fx-live');
        if (badge) {
            const ts = new Date().toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'});
            badge.textContent = `Tiempo real: $${_currentFX.toFixed(2)} · actualizado ${ts}`;
        }
        calcDeposit();
    } catch(e) {
        const badge = document.getElementById('dep-fx-live');
        if (badge) badge.textContent = `⚠️ Valor desactualizado — usando $${_currentFX.toFixed(2)}`;
    }
}

// Refresca el tipo de cambio cada 5 minutos
setInterval(fetchExchangeRate, 5 * 60 * 1000);

function calcDeposit() {
    const mxn = parseFloat(document.getElementById('dep-mxn').value) || 0;
    const fxVal = parseFloat(document.getElementById('dep-fx').value) || _currentFX;
    const metodo = document.getElementById('dep-metodo').value;
    if (mxn <= 0) { document.getElementById('dep-result').style.display = 'none'; return; }

    const brutoUSD = mxn / fxVal;
    let fee = 0;
    if (metodo === 'spei') {
        fee = brutoUSD * 0.009;
    } else {
        fee = Math.max(2.99, brutoUSD * 0.0385);
    }
    const neto = brutoUSD - fee;

    document.getElementById('dep-bruto').innerText = fmtUSD(brutoUSD);
    document.getElementById('dep-fee').innerText   = fmtUSD(fee);
    document.getElementById('dep-neto').innerText  = fmtUSD(neto);
    document.getElementById('dep-result').style.display = 'flex';

    document.getElementById('dep-bruto')._val = brutoUSD;
    document.getElementById('dep-fee')._val   = fee;
    document.getElementById('dep-neto')._val  = neto;
}

async function submitDeposit() {
    const fecha   = document.getElementById('dep-fecha').value;
    const mxn     = parseFloat(document.getElementById('dep-mxn').value) || 0;
    const metodo  = document.getElementById('dep-metodo').value;
    const fx      = parseFloat(document.getElementById('dep-fx').value) || _currentFX;
    const bruto   = document.getElementById('dep-bruto')._val;
    const fee     = document.getElementById('dep-fee')._val;
    const neto    = document.getElementById('dep-neto')._val;

    if (!fecha || mxn <= 0 || !bruto) { alert('Completa todos los campos primero.'); return; }

    await fetch('/api/deposits', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ fecha, monto_mxn: mxn, metodo, fee_usd: fee, neto_usd: neto, tipo_cambio: fx })
    });

    // Update Hapi balance KPI
    const cfgRes = await fetch('/api/config');
    const cfg = await cfgRes.json();
    const newBal = (cfg.hapi_balance || 0) + neto;
    await fetch('/api/config', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({hapi_balance: newBal})
    });
    document.getElementById('kpi-hapi-balance').innerText = fmtUSD(newBal);

    document.getElementById('dep-mxn').value = '';
    document.getElementById('dep-result').style.display = 'none';
    loadDeposits();
}

async function loadDeposits() {
    try {
        const res = await fetch('/api/deposits');
        const rows = await res.json();
        const tbody = document.querySelector('#deposits-table tbody');
        tbody.innerHTML = '';
        let totalFees = 0;
        rows.forEach(r => {
            const fee = parseFloat(r.Fee_USD) || 0;
            totalFees += fee;
            tbody.innerHTML += `<tr>
                <td style="text-align:left;">${r.Fecha || '-'}</td>
                <td class="font-mono">${parseFloat(r.Monto_MXN || 0).toFixed(2)}</td>
                <td>${r.Metodo || '-'}</td>
                <td class="font-mono text-perdida">${fmtUSD(fee)}</td>
                <td class="font-mono text-ganancia">${fmtUSD(parseFloat(r.Neto_USD) || 0)}</td>
                <td class="font-mono">${parseFloat(r.Tipo_Cambio || 0).toFixed(2)}</td>
            </tr>`;
        });
        document.getElementById('dep-total-fees').innerText = fmtUSD(totalFees);
    } catch(e) {}
}

// ─── REGISTRO DE VENTA ────────────────────────────────────────────────────────

// Average buy prices from BASE_PORTFOLIO (kept in sync via data API)
const _buyPrices = { BTC: 0, ETH: 0, SOL: 0, XRP: 0, DOGE: 0, TTWO: 0 };

function onVentaAssetChange() {
    const asset = document.getElementById('venta-activo').value;
    const bp = _buyPrices[asset] || 0;
    document.getElementById('venta-compra').value = bp > 0 ? bp.toFixed(2) : '';
    calcSale();
}

function calcSale() {
    const qty   = parseFloat(document.getElementById('venta-qty').value) || 0;
    const price = parseFloat(document.getElementById('venta-precio').value) || 0;
    const buyP  = parseFloat(document.getElementById('venta-compra').value) || 0;
    const tipo  = document.getElementById('venta-comision').value;
    if (qty <= 0 || price <= 0) { document.getElementById('venta-result').style.display = 'none'; return; }

    const bruto = qty * price;
    let fee = 0;
    if (tipo === 'crypto')         fee = bruto * 0.01;
    else if (tipo === 'accion_entera') fee = 0.10;
    else                            fee = 0.15;
    const neto = bruto - fee;
    const cost = qty * buyP;
    const pnl  = neto - cost;

    document.getElementById('venta-bruto').innerText = fmtUSD(bruto);
    document.getElementById('venta-fee').innerText   = fmtUSD(fee);
    document.getElementById('venta-neto').innerText  = fmtUSD(neto);
    const pnlEl = document.getElementById('venta-pnl');
    pnlEl.innerText = fmtUSD(pnl);
    pnlEl.className = pnl >= 0 ? 'text-ganancia' : 'text-perdida';
    document.getElementById('venta-result').style.display = 'flex';

    document.getElementById('venta-bruto')._val = bruto;
    document.getElementById('venta-fee')._val   = fee;
    document.getElementById('venta-neto')._val  = neto;
    document.getElementById('venta-pnl')._val   = pnl;
}

async function submitSale() {
    const fecha   = document.getElementById('venta-fecha').value;
    const activo  = document.getElementById('venta-activo').value;
    const qty     = parseFloat(document.getElementById('venta-qty').value) || 0;
    const precio  = parseFloat(document.getElementById('venta-precio').value) || 0;
    const compra  = parseFloat(document.getElementById('venta-compra').value) || 0;
    const tipo    = document.getElementById('venta-comision').value;
    const bruto   = document.getElementById('venta-bruto')._val;
    const fee     = document.getElementById('venta-fee')._val;
    const neto    = document.getElementById('venta-neto')._val;
    const pnl     = document.getElementById('venta-pnl')._val;

    if (!fecha || qty <= 0 || precio <= 0) { alert('Completa todos los campos primero.'); return; }

    await fetch('/api/ventas', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            fecha, activo, cantidad: qty, precio_venta: precio, precio_compra: compra,
            tipo_comision: tipo, fee_usd: fee, bruto_usd: bruto, neto_usd: neto, pnl_usd: pnl
        })
    });

    document.getElementById('venta-qty').value = '';
    document.getElementById('venta-precio').value = '';
    document.getElementById('venta-result').style.display = 'none';
    loadVentas();
}

async function loadVentas() {
    try {
        // Populate buy prices from latest dashboard data
        const dataRes = await fetch('/api/data');
        const data = await dataRes.json();
        if (data && data.assets) {
            Object.entries(data.assets).forEach(([k, v]) => {
                if (v.avg_cost) _buyPrices[k] = v.avg_cost;
            });
        }
        onVentaAssetChange();

        const res = await fetch('/api/ventas');
        const rows = await res.json();
        const tbody = document.querySelector('#ventas-table tbody');
        tbody.innerHTML = '';
        rows.forEach(r => {
            const pnl = parseFloat(r.PnL_USD) || 0;
            tbody.innerHTML += `<tr>
                <td style="text-align:left;">${r.Fecha || '-'}</td>
                <td style="text-align:left; font-weight:600;">${r.Activo}</td>
                <td class="font-mono">${parseFloat(r.Cantidad || 0).toFixed(6)}</td>
                <td class="font-mono">${fmtUSD(parseFloat(r.Precio_Venta) || 0)}</td>
                <td class="font-mono">${fmtUSD(parseFloat(r.Precio_Compra) || 0)}</td>
                <td class="font-mono text-perdida">${fmtUSD(parseFloat(r.Fee_USD) || 0)}</td>
                <td class="font-mono">${fmtUSD(parseFloat(r.Neto_USD) || 0)}</td>
                <td class="font-mono ${pnl >= 0 ? 'text-ganancia' : 'text-perdida'}">${fmtUSD(pnl)}</td>
            </tr>`;
        });
    } catch(e) {}
}

// ─── MIS METAS ────────────────────────────────────────────────────────────────

let _metasPrices   = {};
let _metasAvgCost  = {};
let _metasCurrentGoals = {};

async function loadGoals() {
    try {
        const [dataRes, goalsRes] = await Promise.all([fetch('/api/data'), fetch('/api/goals')]);
        const data  = await dataRes.json();
        const goals = await goalsRes.json();

        if (data && data.assets) {
            Object.entries(data.assets).forEach(([k, v]) => {
                _metasPrices[k]  = v.price;
                _metasAvgCost[k] = v.avg_cost || 0;
            });
        }

        _metasCurrentGoals = goals;
        renderGoals(goals);
    } catch(e) {}
}

function renderGoals(goals) {
    const tbody = document.getElementById('metas-tbody');
    tbody.innerHTML = '';
    Object.entries(goals).forEach(([asset, g]) => {
        const currentPrice = _metasPrices[asset] || 0;
        const avgCost      = _metasAvgCost[asset] || 0;
        const tp = parseFloat(g.take_profit) || 0;
        const sl = parseFloat(g.stop_loss) || 0;

        // Progress baseline: avg_cost → take_profit
        let pct = 0;
        if (tp > 0 && currentPrice > 0 && avgCost > 0 && tp > avgCost) {
            pct = Math.min(100, Math.max(0, ((currentPrice - avgCost) / (tp - avgCost)) * 100));
        } else if (tp > 0 && currentPrice > 0) {
            const baseline = sl > 0 ? sl : 0;
            pct = Math.min(100, Math.max(0, ((currentPrice - baseline) / (tp - baseline)) * 100));
        }

        // Status badge
        let badge = '', badgeClass = '';
        if (tp > 0 && currentPrice >= tp) {
            badge = 'En objetivo'; badgeClass = 'badge badge-objetivo';
        } else if (sl > 0 && currentPrice <= sl) {
            badge = 'Stop-loss!'; badgeClass = 'badge badge-stoploss';
        } else {
            badge = 'Lejos'; badgeClass = 'badge badge-lejos';
        }

        const barColor = badgeClass.includes('stoploss') ? 'var(--red-loss)'
                       : badgeClass.includes('objetivo') ? 'var(--green-gain)'
                       : 'var(--blue-accent)';

        const sugTP = avgCost > 0 ? `<button class="btn-sugerir" onclick="sugerirMeta('${asset}','take_profit',${avgCost.toFixed(2)})" title="Sugerir: precio promedio de compra">Sugerir</button>` : '';
        const sugSL = currentPrice > 0 ? `<button class="btn-sugerir" onclick="sugerirMeta('${asset}','stop_loss',${(currentPrice * 0.85).toFixed(2)})" title="Sugerir: precio actual × 0.85">Sugerir</button>` : '';

        tbody.innerHTML += `<tr>
            <td style="text-align:left; font-weight:600;">${asset}</td>
            <td class="font-mono">${currentPrice > 0 ? fmtUSD(currentPrice) : '--'}</td>
            <td>
                <input class="meta-input font-mono" type="number" step="any" value="${tp || ''}"
                    data-asset="${asset}" data-field="take_profit" placeholder="0">
                ${sugTP}
            </td>
            <td>
                <input class="meta-input font-mono" type="number" step="any" value="${sl || ''}"
                    data-asset="${asset}" data-field="stop_loss" placeholder="0">
                ${sugSL}
            </td>
            <td><input class="meta-input font-mono" type="number" min="0" max="100" value="${g.sell_pct || 50}"
                    data-asset="${asset}" data-field="sell_pct" placeholder="50">%</td>
            <td style="min-width:100px;">
                <div class="progress-bar-outer">
                    <div class="progress-bar-inner" style="width:${pct.toFixed(1)}%; background:${barColor};"></div>
                </div>
                <span style="font-size:0.65rem; color:var(--text-muted);">${pct.toFixed(0)}%</span>
            </td>
            <td><span class="${badgeClass}">${badge}</span></td>
        </tr>`;
    });
}

async function guardarTodasMetas() {
    const inputs = document.querySelectorAll('#metas-tbody .meta-input');
    const payload = {};
    inputs.forEach(inp => {
        const asset = inp.dataset.asset;
        const field = inp.dataset.field;
        if (!asset || !field) return;
        if (!payload[asset]) payload[asset] = {};
        payload[asset][field] = parseFloat(inp.value) || 0;
    });
    const btn    = document.getElementById('btn-guardar-metas');
    const status = document.getElementById('metas-save-status');
    btn.disabled = true;
    status.style.color = 'var(--text-muted)';
    status.innerText = 'Guardando…';
    try {
        await fetch('/api/goals', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        status.style.color = 'var(--green-gain)';
        status.innerText = '✓ Metas guardadas';
        setTimeout(() => { status.innerText = ''; }, 3000);
        loadGoals();
    } catch(e) {
        status.style.color = 'var(--red-loss)';
        status.innerText = '✗ Error al guardar';
    } finally {
        btn.disabled = false;
    }
}

function sugerirMeta(asset, field, value) {
    const inp = document.querySelector(`#metas-tbody input[data-asset="${asset}"][data-field="${field}"]`);
    if (inp) inp.value = parseFloat(value).toFixed(2);
}

// ─── RESUMEN FISCAL ───────────────────────────────────────────────────────────

let _fiscalYear = new Date().getFullYear();
let _fiscalRows = [];

async function initFiscalYears() {
    const currentYear = new Date().getFullYear();
    const tabs = document.getElementById('fiscal-year-tabs');
    tabs.innerHTML = '';
    for (let y = currentYear; y >= currentYear - 3; y--) {
        const btn = document.createElement('button');
        btn.className = 'year-tab' + (y === _fiscalYear ? ' active' : '');
        btn.innerText = y;
        btn.onclick = () => {
            _fiscalYear = y;
            document.querySelectorAll('.year-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadFiscal(y);
        };
        tabs.appendChild(btn);
    }
    loadFiscal(_fiscalYear);
}

async function loadFiscal(year) {
    try {
        const res = await fetch(`/api/fiscal?year=${year}`);
        const d = await res.json();
        _fiscalRows = d.rows || [];

        document.getElementById('fiscal-gains').innerText  = fmtUSD(d.total_gains || 0);
        document.getElementById('fiscal-losses').innerText = fmtUSD(d.total_losses || 0);
        const net = d.net || 0;
        const netEl = document.getElementById('fiscal-net');
        netEl.innerText = fmtUSD(net);
        netEl.className = `kpi-value font-mono ${net >= 0 ? 'text-ganancia' : 'text-perdida'}`;

        const tbody = document.getElementById('fiscal-tbody');
        tbody.innerHTML = '';
        _fiscalRows.forEach(r => {
            const pnl = parseFloat(r.PnL_USD) || 0;
            tbody.innerHTML += `<tr>
                <td style="text-align:left;">${r.Fecha || '-'}</td>
                <td style="text-align:left; font-weight:600;">${r.Activo}</td>
                <td class="font-mono">${parseFloat(r.Cantidad || 0).toFixed(6)}</td>
                <td class="font-mono">${fmtUSD(parseFloat(r.Precio_Venta) || 0)}</td>
                <td class="font-mono">${fmtUSD(parseFloat(r.Precio_Compra) || 0)}</td>
                <td class="font-mono">${fmtUSD(parseFloat(r.Neto_USD) || 0)}</td>
                <td class="font-mono ${pnl >= 0 ? 'text-ganancia' : 'text-perdida'}">${fmtUSD(pnl)}</td>
            </tr>`;
        });
    } catch(e) {}
}

function exportFiscalCSV() {
    if (_fiscalRows.length === 0) { alert('No hay datos para exportar.'); return; }
    const headers = ['Fecha','Activo','Cantidad','Precio_Venta','Precio_Compra','Neto_USD','PnL_USD'];
    const lines = [headers.join(',')];
    _fiscalRows.forEach(r => {
        lines.push(headers.map(h => `"${r[h] ?? ''}"`).join(','));
    });
    const blob = new Blob([lines.join('\n')], {type: 'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `resumen_fiscal_${_fiscalYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ─── REGISTRO DE COMPRA ───────────────────────────────────────────────────────

async function onCompraAssetChange() {
    const asset      = document.getElementById('compra-activo').value;
    const tipoSel    = document.getElementById('compra-comision-tipo');
    const priceField = document.getElementById('compra-precio');
    const hint       = document.getElementById('compra-precio-hint');

    if (tipoSel) tipoSel.value = asset === 'TTWO' ? 'accion_frac' : 'crypto';

    // Show loading state immediately
    priceField.value = '';
    if (hint) hint.textContent = 'Obteniendo precio…';

    // Always fetch fresh from /api/data — do not rely on tableDataCache
    let price = 0;
    try {
        const res = await fetch('/api/data');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const info = data && data.assets && data.assets[asset];
        price = info ? (Number(info.price) || 0) : 0;
    } catch (err) {
        console.error('[compra] fetch /api/data falló:', err);
        if (hint) hint.textContent = '⚠ No se pudo obtener el precio';
        calcCompra();
        return;
    }

    if (price > 0) {
        priceField.value = price.toFixed(2);
        if (hint) hint.textContent = `Precio actual de mercado: ${fmtUSD(price)}`;
    } else {
        priceField.value = '';
        if (hint) hint.textContent = 'Precio no disponible aún — intenta de nuevo';
    }
    calcCompra();
}

function calcCompra() {
    const qty   = parseFloat(document.getElementById('compra-cantidad').value) || 0;
    const price = parseFloat(document.getElementById('compra-precio').value) || 0;
    const tipo  = document.getElementById('compra-comision-tipo').value;

    const total = qty * price;
    document.getElementById('compra-total').value = total > 0 ? total.toFixed(2) : '';

    if (qty <= 0 || price <= 0) {
        document.getElementById('compra-result').style.display = 'none';
        return;
    }

    let fee = 0;
    if (tipo === 'crypto')          fee = total * 0.01;
    else if (tipo === 'accion_entera') fee = 0.10;
    else                             fee = 0.15;

    const neto = total - fee;
    document.getElementById('compra-bruto').innerText = fmtUSD(total);
    document.getElementById('compra-fee').innerText   = fmtUSD(fee);
    document.getElementById('compra-neto').innerText  = fmtUSD(neto);
    document.getElementById('compra-result').style.display = 'flex';

    document.getElementById('compra-bruto')._val = total;
    document.getElementById('compra-fee')._val   = fee;
    document.getElementById('compra-neto')._val  = neto;
}

async function submitCompra() {
    const fecha   = document.getElementById('compra-fecha').value;
    const activo  = document.getElementById('compra-activo').value;
    const cantidad = parseFloat(document.getElementById('compra-cantidad').value) || 0;
    const precio  = parseFloat(document.getElementById('compra-precio').value) || 0;
    const metodo  = document.getElementById('compra-metodo').value;
    const tipo    = document.getElementById('compra-comision-tipo').value;
    const notas   = document.getElementById('compra-notas').value;
    const bruto   = document.getElementById('compra-bruto')._val;
    const fee     = document.getElementById('compra-fee')._val;
    const neto    = document.getElementById('compra-neto')._val;

    if (!fecha || cantidad <= 0 || precio <= 0) {
        alert('Completa Fecha, Cantidad y Precio antes de registrar.');
        return;
    }

    const res = await fetch('/api/compras', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            fecha, activo, cantidad, precio_usd: precio,
            monto_bruto_usd: bruto, metodo_fondeo: metodo,
            comision_tipo: tipo, comision_usd: fee,
            monto_real_usd: neto, notas,
        })
    });
    if ((await res.json()).status === 'ok') {
        document.getElementById('compra-cantidad').value = '';
        document.getElementById('compra-precio').value = '';
        document.getElementById('compra-total').value = '';
        document.getElementById('compra-notas').value = '';
        document.getElementById('compra-result').style.display = 'none';
        loadCompras();
        alert(`Compra de ${activo} registrada correctamente.`);
    }
}

async function loadCompras() {
    try {
        const [rowsRes, summaryRes] = await Promise.all([
            fetch('/api/compras'),
            fetch('/api/compras/summary')
        ]);
        const rows    = await rowsRes.json();
        const summary = await summaryRes.json();

        // Historial table
        const tbody = document.querySelector('#compras-table tbody');
        tbody.innerHTML = '';
        rows.forEach(r => {
            tbody.innerHTML += `<tr>
                <td style="text-align:left; font-size:.75rem;">${r.Fecha || '-'}</td>
                <td style="text-align:left; font-weight:600;">${r.Activo}</td>
                <td class="font-mono">${parseFloat(r.Cantidad || 0).toFixed(6)}</td>
                <td class="font-mono">${fmtUSD(parseFloat(r.Precio_USD) || 0)}</td>
                <td class="font-mono">${fmtUSD(parseFloat(r.Monto_Bruto_USD) || 0)}</td>
                <td style="font-size:.72rem;">${r.Metodo_Fondeo || '-'}</td>
                <td class="font-mono text-perdida">${fmtUSD(parseFloat(r.Comision_USD) || 0)}</td>
                <td class="font-mono text-ganancia">${fmtUSD(parseFloat(r.Monto_Real_USD) || 0)}</td>
                <td style="font-size:.72rem; color:var(--text-muted);">${r.Notas || ''}</td>
            </tr>`;
        });

        // Summary table
        const stbody = document.querySelector('#compras-summary-table tbody');
        stbody.innerHTML = '';
        Object.entries(summary).forEach(([asset, s]) => {
            if (s.quantity <= 0) return;
            stbody.innerHTML += `<tr>
                <td style="text-align:left; font-weight:600;">${asset}</td>
                <td class="font-mono">${s.quantity.toFixed(6)}</td>
                <td class="font-mono text-ganancia">${fmtUSD(s.amount_invested)}</td>
                <td class="font-mono">${fmtUSD(s.avg_cost)}</td>
                <td class="font-mono text-perdida">${fmtUSD(s.total_commissions)}</td>
            </tr>`;
        });
    } catch(e) { console.error('loadCompras error', e); }
}

// ─── LSTM MODAL TAB ──────────────────────────────────────────────────────────

let _currentPredAsset = null;

function switchModelTab(tab) {
    document.getElementById('tab-arima').classList.toggle('active', tab === 'arima');
    document.getElementById('tab-lstm').classList.toggle('active', tab === 'lstm');
    document.getElementById('ml-content').style.display    = tab === 'arima' ? 'block' : 'none';
    document.getElementById('lstm-content').style.display  = tab === 'lstm'  ? 'block' : 'none';
    document.getElementById('lstm-no-model').style.display = 'none';

    if (tab === 'lstm' && _currentPredAsset) loadLSTMTab(_currentPredAsset);
}

async function loadLSTMTab(asset) {
    document.getElementById('lstm-content').style.display  = 'none';
    document.getElementById('lstm-no-model').style.display = 'none';

    try {
        const res  = await fetch(`/api/lstm/predictions/${asset}`);
        if (!res.ok) {
            document.getElementById('lstm-no-model').style.display = 'block';
            document.getElementById('lstm-train-status').innerText = '';
            return;
        }
        const data = await res.json();
        if (data.error) {
            document.getElementById('lstm-no-model').style.display = 'block';
            return;
        }

        const rel = data.reliability || {};
        const score = rel.reliability_score ?? '--';
        const mape  = rel.mape ?? '--';
        const dir   = rel.direction_accuracy ?? '--';
        const scoreColor = score >= 70 ? 'var(--green-gain)' : score >= 40 ? 'var(--yellow,#D29922)' : 'var(--red-loss)';

        document.getElementById('lstm-p30').innerText  = data['30d'] ? fmtUSD(data['30d']) : '--';
        document.getElementById('lstm-p60').innerText  = data['60d'] ? fmtUSD(data['60d']) : '--';
        document.getElementById('lstm-p90').innerText  = data['90d'] ? fmtUSD(data['90d']) : '--';
        document.getElementById('lstm-score').innerHTML = `<span style="color:${scoreColor}">${score}/100</span>`;
        document.getElementById('lstm-mape').innerText  = mape !== '--' ? `${mape}%` : '--';
        document.getElementById('lstm-dir').innerText   = dir  !== '--' ? `${dir}%`  : '--';

        // Badge: LSTM better / ARIMA better
        let badgeHtml = '';
        if (score >= 60) badgeHtml += '<span class="badge-signal-buy" style="margin-right:6px;">★ LSTM confiable</span>';
        else             badgeHtml += '<span class="badge-signal-none" style="margin-right:6px;">ARIMA recomendado</span>';
        document.getElementById('lstm-badge-row').innerHTML = badgeHtml +
            '<span style="color:var(--text-muted); font-size:0.65rem;">Señal informativa — no consejo financiero</span>';

        document.getElementById('lstm-warning').style.display = rel.low_confidence ? 'block' : 'none';

        // Plotly chart
        const ind = _indicators[asset] || {};
        const curPrice = ind.price || tableDataCache.find(d => d.asset === asset)?.price || 0;
        const avgCost  = tableDataCache.find(d => d.asset === asset)?.avg_cost || 0;

        const traces = [
            {
                x: data.forecast_dates,
                y: data.prices_mean,
                mode: 'lines', name: 'LSTM pred.',
                line: {color: '#D29922', dash: 'dot', width: 2}
            },
            ...(data.prices_lower && data.prices_upper ? [{
                x: [...data.forecast_dates, ...data.forecast_dates.slice().reverse()],
                y: [...data.prices_upper, ...data.prices_lower.slice().reverse()],
                fill: 'toself', fillcolor: 'rgba(210,153,34,0.10)',
                line: {color: 'transparent'}, name: 'IC 95%', hoverinfo: 'skip'
            }] : []),
        ];
        if (avgCost > 0) {
            traces.push({
                x: [data.forecast_dates[0], data.forecast_dates[data.forecast_dates.length - 1]],
                y: [avgCost, avgCost],
                mode: 'lines', name: `Break-even ${fmtUSD(avgCost)}`,
                line: {color: '#F85149', dash: 'dash', width: 1}
            });
        }
        Plotly.newPlot('lstm-plotly', traces, {
            paper_bgcolor: '#161B22', plot_bgcolor: '#0D1117',
            font: {color: '#8B949E', size: 11},
            margin: {l:55, r:20, t:20, b:40},
            legend: {orientation:'h', y:-0.2, font:{size:10}},
            xaxis: {gridcolor:'#30363D', tickfont:{size:10}},
            yaxis: {gridcolor:'#30363D', tickfont:{size:10}, tickprefix:'$'},
            hovermode: 'x unified'
        }, {responsive: true, displayModeBar: false});

        document.getElementById('lstm-content').style.display = 'block';

    } catch(e) {
        console.error('LSTM tab error', e);
        document.getElementById('lstm-no-model').style.display = 'block';
    }
}

// Override openPrediction to track current asset
const _origOpenPrediction = openPrediction;
openPrediction = async function(asset) {
    _currentPredAsset = asset;
    // Reset tabs to ARIMA by default
    document.getElementById('tab-arima').classList.add('active');
    document.getElementById('tab-lstm').classList.remove('active');
    document.getElementById('lstm-content').style.display  = 'none';
    document.getElementById('lstm-no-model').style.display = 'none';
    await _origOpenPrediction(asset);
};

// Polls /api/lstm/status every `intervalMs` until all `assets` leave 'training'.
// Calls onDone(statusMap) when complete or after 10 min timeout.
function _pollTraining(assets, onDone, intervalMs = 5000) {
    const deadline = Date.now() + 10 * 60 * 1000;
    function tick() {
        if (Date.now() > deadline) { onDone(null, 'timeout'); return; }
        fetch('/api/lstm/status')
            .then(r => r.json())
            .then(s => {
                const ts = s.training_status || {};
                const allDone = assets.every(a => ts[a] && ts[a] !== 'training');
                if (allDone) { onDone(ts, 'done'); }
                else         { setTimeout(tick, intervalMs); }
            })
            .catch(() => setTimeout(tick, intervalMs));
    }
    setTimeout(tick, intervalMs);
}

async function trainAssetLSTM() {
    const statusEl = document.getElementById('lstm-train-status');
    statusEl.innerText = 'Iniciando entrenamiento...';
    const res = await fetch('/api/lstm/train', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({assets: [_currentPredAsset]})
    });
    if (!res.ok) { statusEl.innerText = 'Error al iniciar entrenamiento.'; return; }
    statusEl.innerText = `Entrenando ${_currentPredAsset}…`;
    _pollTraining([_currentPredAsset], (ts, reason) => {
        if (reason === 'timeout') {
            statusEl.innerText = 'Timeout esperando entrenamiento.';
        } else {
            const s = (ts || {})[_currentPredAsset];
            statusEl.innerText = s === 'ok' ? `✓ ${_currentPredAsset} listo. Cargando resultados…` : `Error entrenando ${_currentPredAsset}.`;
            if (s === 'ok') loadLSTMTab(_currentPredAsset);
        }
    });
}

// ─── CENTRO DE PREDICCIONES ───────────────────────────────────────────────────

const _ASSETS = ['BTC','ETH','SOL','XRP','DOGE','TTWO'];

async function loadPredCenter() {
    const statusEl = document.getElementById('pred-center-status');
    statusEl.innerText = 'Cargando estado de modelos...';

    const [statusRes, dataRes] = await Promise.all([
        fetch('/api/lstm/status'),
        fetch('/api/data')
    ]);
    const lstmStatus = await statusRes.json();
    const portData   = await dataRes.json();
    const prices     = portData.assets || {};

    const completeRun = lstmStatus.last_complete_run;
    const lastRun     = lstmStatus.last_run;
    statusEl.innerText = completeRun
        ? `Último entrenamiento completo: ${completeRun}${lastRun !== completeRun ? `  (última actividad: ${lastRun})` : ''}`
        : lastRun
            ? `Última actividad: ${lastRun} (entrenamiento parcial)`
            : 'Modelos LSTM no entrenados aún.';

    const tbody = document.getElementById('pred-center-tbody');
    tbody.innerHTML = '';

    await Promise.all(_ASSETS.map(async asset => {
        const predRes = await fetch(`/api/lstm/predictions/${asset}`);
        const preds   = predRes.ok ? await predRes.json() : {};
        const cur     = prices[asset]?.price || 0;
        const assetStatus = (lstmStatus.assets || {})[asset] || {};
        const rel     = preds.reliability || {};
        const score   = rel.reliability_score ?? null;
        const scoreBar = score != null
            ? `<div class="rel-bar-outer"><div class="rel-bar-inner" style="width:${score}%;
               background:${score>=70?'var(--green-gain)':score>=40?'#D29922':'var(--red-loss)'};"></div></div>
               <span style="font-size:.65rem; margin-left:4px;">${score}/100</span>`
            : '<span style="color:var(--text-muted)">--</span>';

        const model = score != null && score >= 60 ? 'LSTM' : 'ARIMA';
        const modelCls = model === 'LSTM' ? 'badge-signal-buy' : 'badge-rsi-neu';

        const trainedAt = assetStatus.trained_at
            ? new Date(assetStatus.trained_at).toLocaleDateString('es-MX')
            : '—';

        tbody.innerHTML += `<tr>
            <td style="text-align:left; font-weight:600;">${asset}</td>
            <td class="font-mono">${cur > 0 ? fmtUSD(cur) : '--'}</td>
            <td class="font-mono">${preds['30d'] ? fmtUSD(preds['30d']) : '--'}</td>
            <td class="font-mono">${preds['60d'] ? fmtUSD(preds['60d']) : '--'}</td>
            <td class="font-mono">${preds['90d'] ? fmtUSD(preds['90d']) : '--'}</td>
            <td>${scoreBar}</td>
            <td><span class="${modelCls}">${model}</span></td>
            <td style="font-size:.72rem; color:var(--text-muted);">${trainedAt}</td>
            <td><button class="pred-btn" onclick="retrainAsset('${asset}', this)">↺</button></td>
        </tr>`;
    }));
}

async function retrainAsset(asset, btn) {
    const statusEl = document.getElementById('pred-center-status');
    btn.disabled = true;
    btn.innerText = '⏳';
    statusEl.innerText = `Entrenando ${asset}…`;

    const res = await fetch('/api/lstm/train', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({assets: [asset]})
    });
    if (!res.ok) {
        statusEl.innerText = `Error al iniciar entrenamiento de ${asset}.`;
        btn.disabled = false; btn.innerText = '↺'; return;
    }

    _pollTraining([asset], (ts, reason) => {
        btn.disabled = false; btn.innerText = '↺';
        if (reason === 'timeout') {
            statusEl.innerText = `Timeout esperando ${asset}.`;
        } else {
            const s = (ts || {})[asset];
            if (s === 'ok') {
                statusEl.innerText = `✓ ${asset} entrenado correctamente. Recargando…`;
                loadPredCenter();
            } else {
                statusEl.innerText = `⚠ Error entrenando ${asset}: ${s}`;
            }
        }
    });
}

async function trainAllLSTM() {
    const btn = document.getElementById('btn-train-all');
    const statusEl = document.getElementById('pred-center-status');
    btn.disabled = true;
    btn.innerText = '⏳ Entrenando…';

    const res = await fetch('/api/lstm/train', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({})
    });
    if (!res.ok) {
        statusEl.innerText = 'Error al iniciar entrenamiento masivo.';
        btn.disabled = false; btn.innerText = '⚙ Entrenar todos'; return;
    }
    statusEl.innerText = 'Entrenando todos los modelos… (polling cada 5s)';

    _pollTraining(['BTC','ETH','SOL','XRP','DOGE','TTWO'], (ts, reason) => {
        btn.disabled = false; btn.innerText = '⚙ Entrenar todos';
        if (reason === 'timeout') {
            statusEl.innerText = 'Timeout esperando entrenamiento masivo.';
        } else {
            const errs = Object.entries(ts || {}).filter(([,v]) => v !== 'ok').map(([k]) => k);
            statusEl.innerText = errs.length
                ? `Completado con errores en: ${errs.join(', ')}`
                : '✓ Todos los modelos entrenados.';
            loadPredCenter();
        }
    }, 8000); // 8s interval for full-batch training
}

// ─── HISTORIAL CERRADO ────────────────────────────────────────────────────────

let _hcData       = [];
let _hcSortCol    = 5;   // default: G/P USD
let _hcSortAsc    = false;

async function loadHistorialCerrado() {
    try {
        const res = await fetch('/api/historial-cerrado');
        _hcData = await res.json();
        renderHCSummary(_hcData);
        renderHCBarChart(_hcData);
        renderHCTable(_hcData);
    } catch(e) { console.error('loadHistorialCerrado error', e); }
}

function renderHCSummary(data) {
    let totalGanado = 0, totalPerdido = 0, winners = 0;
    let bestOp  = { activo: '--', gp: -Infinity };
    let worstOp = { activo: '--', gp:  Infinity };

    data.forEach(r => {
        const gp = parseFloat(r.Ganancia_Perdida) || 0;
        if (gp >= 0) { totalGanado += gp; winners++; }
        else          { totalPerdido += gp; }
        if (gp > bestOp.gp)  bestOp  = { activo: r.Activo, gp };
        if (gp < worstOp.gp) worstOp = { activo: r.Activo, gp };
    });

    const neta  = totalGanado + totalPerdido;
    const total = data.length;

    document.getElementById('hc-total-ganado').innerText  = `+${fmtUSD(totalGanado)}`;
    document.getElementById('hc-total-perdido').innerText = fmtUSD(totalPerdido);

    const netaEl = document.getElementById('hc-neta');
    netaEl.innerText   = (neta >= 0 ? '+' : '') + fmtUSD(neta);
    netaEl.className   = `kpi-value font-mono ${neta >= 0 ? 'text-ganancia' : 'text-perdida'}`;

    document.getElementById('hc-best').innerHTML =
        `<span class="text-ganancia">${bestOp.activo !== '--' ? bestOp.activo : '--'}</span>` +
        (bestOp.gp !== -Infinity ? `<br><span style="font-size:.75rem;">+${fmtUSD(bestOp.gp)}</span>` : '');

    document.getElementById('hc-worst').innerHTML =
        `<span class="text-perdida">${worstOp.activo !== '--' ? worstOp.activo : '--'}</span>` +
        (worstOp.gp !== Infinity ? `<br><span style="font-size:.75rem;">${fmtUSD(worstOp.gp)}</span>` : '');

    document.getElementById('hc-success-rate').innerText = total > 0 ? `${winners}/${total}` : '--';
    document.getElementById('hc-success-label').innerText =
        total > 0 ? `(${((winners/total)*100).toFixed(0)}% exitosas)` : '';
}

function _calcDurationDays(fechaCompra, fechaVenta) {
    try {
        const t1   = new Date(fechaCompra);
        const t2   = new Date(fechaVenta);
        const diff = Math.round((t2 - t1) / 86400000);
        return diff >= 0 ? diff : null;
    } catch(e) { return null; }
}

function renderHCTable(data) {
    const colKeys = [
        'Activo', 'Fecha_Compra', 'Costo_Total', 'Fecha_Venta',
        'Ingreso_Total', 'Ganancia_Perdida', '_gp_pct', 'Tipo', '_duration'
    ];

    let sorted = [...data];
    if (_hcSortCol >= 0) {
        sorted.sort((a, b) => {
            const col = colKeys[_hcSortCol];
            let va, vb;
            if (col === '_gp_pct') {
                va = parseFloat(a.Costo_Total) > 0 ? (parseFloat(a.Ganancia_Perdida)/parseFloat(a.Costo_Total))*100 : 0;
                vb = parseFloat(b.Costo_Total) > 0 ? (parseFloat(b.Ganancia_Perdida)/parseFloat(b.Costo_Total))*100 : 0;
            } else if (col === '_duration') {
                va = _calcDurationDays(a.Fecha_Compra, a.Fecha_Venta) ?? 0;
                vb = _calcDurationDays(b.Fecha_Compra, b.Fecha_Venta) ?? 0;
            } else {
                va = a[col]; vb = b[col];
            }
            if (typeof va === 'string' && typeof vb === 'string')
                return _hcSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
            return _hcSortAsc ? (parseFloat(va)||0) - (parseFloat(vb)||0) : (parseFloat(vb)||0) - (parseFloat(va)||0);
        });
    }

    const tbody = document.getElementById('hc-tbody');
    tbody.innerHTML = '';
    sorted.forEach(r => {
        const gp     = parseFloat(r.Ganancia_Perdida) || 0;
        const cost   = parseFloat(r.Costo_Total) || 0;
        const gpPct  = cost > 0 ? (gp / cost * 100) : 0;
        const dur    = _calcDurationDays(r.Fecha_Compra, r.Fecha_Venta);
        const isGain = gp >= 0;
        const tipoCls = r.Tipo === 'Crypto' ? 'badge-tipo-crypto' : 'badge-tipo-accion';

        tbody.innerHTML += `<tr>
            <td style="text-align:left; font-weight:600;">${r.Activo}</td>
            <td style="font-size:.75rem;">${r.Fecha_Compra || '--'}</td>
            <td class="font-mono">${fmtUSD(cost)}</td>
            <td style="font-size:.75rem;">${r.Fecha_Venta || '--'}</td>
            <td class="font-mono">${fmtUSD(parseFloat(r.Ingreso_Total) || 0)}</td>
            <td><span class="badge ${isGain ? 'bg-ganancia' : 'bg-perdida'} font-mono">${(isGain?'+':'')}${fmtUSD(gp)}</span></td>
            <td class="font-mono ${isGain ? 'text-ganancia' : 'text-perdida'}">${(isGain?'+':'')}${gpPct.toFixed(2)}%</td>
            <td><span class="${tipoCls}">${r.Tipo || '--'}</span></td>
            <td class="font-mono">${dur !== null ? dur + 'd' : '--'}</td>
        </tr>`;
    });
}

function sortHC(colIndex) {
    if (_hcSortCol === colIndex) _hcSortAsc = !_hcSortAsc;
    else { _hcSortCol = colIndex; _hcSortAsc = false; }
    renderHCTable(_hcData);
}

function renderHCBarChart(data) {
    const sorted = [...data].sort((a, b) =>
        (parseFloat(b.Ganancia_Perdida)||0) - (parseFloat(a.Ganancia_Perdida)||0)
    );
    const labels = sorted.map(r => r.Activo);
    const values = sorted.map(r => parseFloat(r.Ganancia_Perdida) || 0);
    const colors = values.map(v => v >= 0 ? 'rgba(63,185,80,0.85)' : 'rgba(248,81,73,0.85)');
    const texts  = values.map(v => (v >= 0 ? '+' : '') + fmtUSD(v));

    Plotly.newPlot('hc-bar-chart', [{
        type: 'bar',
        orientation: 'h',
        x: values,
        y: labels,
        marker: { color: colors, line: { color: colors.map(c => c.replace('0.85','1')), width: 1 } },
        text: texts,
        textposition: 'outside',
        cliponaxis: false,
        hovertemplate: '<b>%{y}</b>: %{x:.2f}<extra></extra>',
        textfont: { size: 11, color: '#E6EDF3' },
    }], {
        paper_bgcolor: '#161B22',
        plot_bgcolor:  '#0D1117',
        font: { color: '#8B949E', size: 11 },
        margin: { l: 80, r: 90, t: 10, b: 30 },
        xaxis: {
            gridcolor: '#30363D',
            tickprefix: '$',
            zeroline: true, zerolinecolor: '#58A6FF', zerolinewidth: 1,
            tickfont: { size: 10 }
        },
        yaxis: { tickfont: { size: 11 }, autorange: 'reversed' },
        showlegend: false,
    }, { responsive: true, displayModeBar: false });
}

function toggleHCForm() {
    const card = document.getElementById('hc-form-card');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
}

function calcHCForm() {
    const costo   = parseFloat(document.getElementById('hc-costo').value)   || 0;
    const ingreso = parseFloat(document.getElementById('hc-ingreso').value) || 0;
    const resEl   = document.getElementById('hc-calc-result');
    if (costo > 0 && ingreso > 0) {
        const gp    = ingreso - costo;
        const gpPct = (gp / costo) * 100;
        const isG   = gp >= 0;
        resEl.style.display = 'flex';
        const gpEl  = document.getElementById('hc-calc-gp');
        gpEl.innerText   = (isG ? '+' : '') + fmtUSD(gp);
        gpEl.className   = isG ? 'text-ganancia' : 'text-perdida';
        gpEl._val        = gp;
        const pctEl = document.getElementById('hc-calc-pct');
        pctEl.innerText  = (isG ? '+' : '') + gpPct.toFixed(2) + '%';
        pctEl.className  = isG ? 'text-ganancia' : 'text-perdida';
    } else {
        resEl.style.display = 'none';
    }
}

async function submitHCForm() {
    const activo   = (document.getElementById('hc-activo').value || '').trim().toUpperCase();
    const fcompra  = document.getElementById('hc-fecha-compra').value;
    const costo    = parseFloat(document.getElementById('hc-costo').value)   || 0;
    const fventa   = document.getElementById('hc-fecha-venta').value;
    const ingreso  = parseFloat(document.getElementById('hc-ingreso').value) || 0;
    const tipo     = document.getElementById('hc-tipo').value;
    const notas    = document.getElementById('hc-notas').value || '';
    const gpEl     = document.getElementById('hc-calc-gp');
    const gp       = gpEl._val !== undefined ? gpEl._val : (ingreso - costo);

    if (!activo || !fcompra || costo <= 0 || !fventa || ingreso <= 0) {
        alert('Completa: Activo, Fecha Compra, Costo, Fecha Venta e Ingreso.'); return;
    }

    const res = await fetch('/api/historial-cerrado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activo, fecha_compra: fcompra, costo_total: costo,
            fecha_venta: fventa, ingreso_total: ingreso, ganancia_perdida: gp, tipo, notas })
    });

    if ((await res.json()).status === 'ok') {
        ['hc-activo','hc-fecha-compra','hc-costo','hc-fecha-venta','hc-ingreso','hc-notas']
            .forEach(id => { document.getElementById(id).value = ''; });
        document.getElementById('hc-calc-result').style.display = 'none';
        toggleHCForm();
        loadHistorialCerrado();
    }
}

// ─── RESUMEN GLOBAL ───────────────────────────────────────────────────────────

let _drData              = [];
let _movUnificados       = [];
let _movUnificadosFilt   = [];

async function loadResumenGlobal() {
    try {
        const [resG, resDR, resData] = await Promise.all([
            fetch('/api/resumen-global'),
            fetch('/api/depositos-retiros'),
            fetch('/api/data'),
        ]);
        const globalData = await resG.json();
        _drData          = await resDR.json();
        const portData   = await resData.json();

        _lastRGData   = globalData;
        _lastPortData = portData;

        const unrealizedPnl = portData.Global_PnL_USD || 0;
        renderRGKPIs(globalData, unrealizedPnl);
        renderRGRetiros(_drData);
        renderTimelineChart(_drData);
        renderDRTable(_drData);
        await loadMovimientosUnificados();
    } catch(e) { console.error('loadResumenGlobal error', e); }
}

function renderRGKPIs(data, unrealizedPnl) {
    document.getElementById('rg-depositado').innerText = fmtUSD(data.total_depositado || 0);
    document.getElementById('rg-retirado').innerText   = fmtUSD(data.total_retirado   || 0);
    document.getElementById('rg-neto').innerText       = fmtUSD(data.dinero_neto      || 0);
    document.getElementById('rg-comisiones').innerText = fmtUSD(data.total_comisiones || 0);

    const realizada = data.ganancia_realizada || 0;
    const rgREl = document.getElementById('rg-realizada');
    rgREl.innerText = (realizada >= 0 ? '+' : '') + fmtUSD(realizada);
    rgREl.className = `kpi-value font-mono ${realizada >= 0 ? 'text-ganancia' : 'text-perdida'}`;

    const rgUEl = document.getElementById('rg-no-realizado');
    rgUEl.innerText = (unrealizedPnl >= 0 ? '+' : '') + fmtUSD(unrealizedPnl);
    rgUEl.className = `kpi-value font-mono ${unrealizedPnl >= 0 ? 'text-ganancia' : 'text-perdida'}`;

    const resultado = realizada + unrealizedPnl - (data.total_comisiones || 0);
    const rgResEl = document.getElementById('rg-resultado');
    rgResEl.innerText = (resultado >= 0 ? '+' : '') + fmtUSD(resultado);
    rgResEl.className = `kpi-value font-mono ${resultado >= 0 ? 'text-ganancia' : 'text-perdida'}`;
}

function renderTimelineChart(drData) {
    if (!drData || drData.length === 0) return;
    const sorted = [...drData].sort((a, b) => (a.Fecha > b.Fecha ? 1 : -1));

    let acc = 0;
    const dates = [], values = [], mktColors = [], texts = [];
    sorted.forEach(r => {
        const m    = parseFloat(r.Monto) || 0;
        const isDep = r.Tipo === 'Deposito';
        if (isDep) acc += m; else acc -= m;
        dates.push(r.Fecha);
        values.push(parseFloat(acc.toFixed(2)));
        mktColors.push(isDep ? '#3FB950' : '#F85149');
        texts.push(`${isDep ? 'Depósito' : 'Retiro'}: ${fmtUSD(m)}<br>Acumulado: ${fmtUSD(acc)}`);
    });

    Plotly.newPlot('rg-timeline-chart', [
        {
            x: dates, y: values,
            mode: 'lines',
            name: 'Capital en Hapi',
            line: { color: '#58A6FF', width: 2 },
            fill: 'tozeroy', fillcolor: 'rgba(88,166,255,0.07)',
            hoverinfo: 'skip',
        },
        {
            x: dates, y: values,
            mode: 'markers',
            name: 'Movimientos',
            marker: { color: mktColors, size: 8, line: { color: '#161B22', width: 1 } },
            text: texts,
            hovertemplate: '%{text}<extra></extra>',
        }
    ], {
        paper_bgcolor: '#161B22', plot_bgcolor: '#0D1117',
        font: { color: '#8B949E', size: 11 },
        margin: { l: 60, r: 20, t: 10, b: 40 },
        xaxis: { gridcolor: '#30363D', tickfont: { size: 10 } },
        yaxis: { gridcolor: '#30363D', tickfont: { size: 10 }, tickprefix: '$' },
        hovermode: 'closest',
        showlegend: false,
    }, { responsive: true, displayModeBar: false });
}

function renderDRTable(data) {
    const sorted = [...data].sort((a, b) => (a.Fecha > b.Fecha ? -1 : 1));
    let totalDep = 0, totalRet = 0;
    const tbody = document.getElementById('dr-tbody');
    tbody.innerHTML = '';

    sorted.forEach(r => {
        const monto  = parseFloat(r.Monto) || 0;
        const isDep  = r.Tipo === 'Deposito';
        if (isDep) totalDep += monto; else totalRet += monto;
        tbody.innerHTML += `<tr>
            <td style="text-align:left; font-size:.75rem;">${r.Fecha}</td>
            <td><span class="badge ${isDep ? 'badge-dep' : 'badge-ret'}">${isDep ? 'Depósito' : 'Retiro'}</span></td>
            <td class="font-mono ${isDep ? 'text-ganancia' : 'text-perdida'}">${isDep ? '+' : '-'}${fmtUSD(monto)}</td>
        </tr>`;
    });

    const totEl = document.getElementById('dr-totals');
    if (totEl) {
        totEl.innerHTML =
            `<span class="text-ganancia">+${fmtUSD(totalDep)}</span>&nbsp;` +
            `<span class="text-perdida">-${fmtUSD(totalRet)}</span>&nbsp;` +
            `<strong>Neto: ${fmtUSD(totalDep - totalRet)}</strong>`;
    }
}

function toggleDRForm() {
    const f = document.getElementById('dr-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

async function submitDR() {
    const fecha = document.getElementById('dr-fecha').value;
    const tipo  = document.getElementById('dr-tipo').value;
    const monto = parseFloat(document.getElementById('dr-monto').value) || 0;
    if (!fecha || monto <= 0) { alert('Completa fecha y monto.'); return; }

    await fetch('/api/depositos-retiros', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fecha, tipo, monto })
    });

    document.getElementById('dr-fecha').value  = '';
    document.getElementById('dr-monto').value  = '';
    toggleDRForm();
    loadResumenGlobal();
}

async function loadMovimientosUnificados() {
    try {
        const res        = await fetch('/api/movimientos-unificados');
        _movUnificados   = await res.json();
        _movUnificadosFilt = [..._movUnificados];
        renderMovUnificados(_movUnificadosFilt);
    } catch(e) { console.error('loadMovimientosUnificados error', e); }
}

function filterMovimientos() {
    const tipoF   = document.getElementById('mov-filter-tipo').value;
    const activoF = (document.getElementById('mov-filter-activo').value || '').trim().toUpperCase();
    _movUnificadosFilt = _movUnificados.filter(r => {
        const tipoOk   = !tipoF   || r.tipo === tipoF;
        const activoOk = !activoF || (r.activo || '').toUpperCase().includes(activoF);
        return tipoOk && activoOk;
    });
    renderMovUnificados(_movUnificadosFilt);
}

function renderMovUnificados(data) {
    const tbody = document.getElementById('mov-unified-tbody');
    tbody.innerHTML = '';
    data.forEach(r => {
        const isOut = r.tipo === 'Compra' || r.tipo === 'Retiro';
        const badgeCls = isOut ? 'bg-perdida' : 'bg-ganancia';
        const tipoLabel = r.tipo === 'Deposito' ? 'Depósito' : r.tipo;

        tbody.innerHTML += `<tr>
            <td style="text-align:left; font-size:.75rem;">${r.fecha || '--'}</td>
            <td><span class="badge ${badgeCls}">${tipoLabel}</span></td>
            <td style="text-align:left; font-weight:600;">${r.activo || '--'}</td>
            <td class="font-mono ${isOut ? 'text-perdida' : 'text-ganancia'}">${r.monto ? fmtUSD(parseFloat(r.monto)) : '--'}</td>
            <td class="font-mono text-perdida">${r.comision ? fmtUSD(parseFloat(r.comision)) : '--'}</td>
            <td class="font-mono">${r.neto !== undefined ? fmtUSD(parseFloat(r.neto)) : '--'}</td>
            <td style="font-size:.72rem; color:var(--text-muted);">${r.notas || '--'}</td>
        </tr>`;
    });
}

function exportMovimientosCSV() {
    if (!_movUnificadosFilt.length) { alert('No hay datos para exportar.'); return; }
    const headers = ['Fecha','Tipo','Activo','Monto','Comision','Neto','Notas'];
    const lines   = [headers.join(',')];
    _movUnificadosFilt.forEach(r => {
        lines.push(headers.map(h => `"${r[h.toLowerCase()] ?? ''}"`).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `movimientos_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
