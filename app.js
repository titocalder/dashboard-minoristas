/**
 * Dashboard DTE – Comercios Minoristas · Abril 2026
 * app.js – lógica principal (vanilla JS, sin frameworks)
 */

// ═══════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════

const CSV_PATH = './data.csv';
const PAGE_SIZE = 20;

/** Mapa canónico de nombres de columna */
const C = {
  periodo:    'periodo',
  rubro:      'macro_rubro',
  dir:        'direccion',
  tipo:       'tipo_documento',
  totalCom:   'comercios_total_macro',
  conDoc:     'comercios_con_documento',
  cantDocs:   'cantidad_documentos',
  montoTotal: 'monto_total_documentos',
  docsAvg:    'docs_promedio_por_comercio',
  montoAvg:   'monto_promedio_por_documento',
  soloBoleta: 'comercios_solo_boleta_emitida',
  soloBoletaFC: 'comercios_solo_boleta_con_facturas_recibidas',
};

/** Columnas que deben convertirse a número */
const NUM_COLS = [
  C.totalCom, C.conDoc, C.cantDocs, C.montoTotal,
  C.docsAvg, C.montoAvg, C.soloBoleta, C.soloBoletaFC,
];

/** Colores por posición de rubro (hasta 7) */
const RUBRO_COLORS = [
  '#4361ee', '#7209b7', '#f72585', '#4cc9f0',
  '#f8961e', '#06d6a0', '#ef233c',
];

/** Colores fijos por tipo de documento */
const TIPO_COLORS = {
  boleta:         '#4361ee',
  factura:        '#f72585',
  factura_compra: '#f8961e',
};

// ═══════════════════════════════════════════════════
// ESTADO GLOBAL
// ═══════════════════════════════════════════════════

const state = {
  raw:      [],        // todas las filas parseadas
  filtered: [],        // filas tras aplicar filtros
  rubros:   [],        // rubros únicos (para multi-select)
  sort: { col: null, asc: true },
  page: 1,
  filters: {
    rubrosSelected: new Set(),  // vacío = todos
    direccion: '',
    tipodoc:   '',
    minCom:    '',
    maxCom:    '',
    search:    '',
  },
};

const charts = {};    // instancias Chart.js activas
let msOpen = false;   // estado del dropdown multi-select

// ═══════════════════════════════════════════════════
// CSV PARSER
// ═══════════════════════════════════════════════════

/**
 * Parsea texto CSV y devuelve array de objetos con tipos normalizados.
 * Lanza Error con mensaje legible si faltan columnas requeridas.
 */
function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('El CSV está vacío o no contiene datos.');

  const headers = lines[0].split(',').map(h => h.trim().replace(/\r/g, ''));

  // Validar columnas requeridas
  const required = Object.values(C);
  const missing = required.filter(col => !headers.includes(col));
  if (missing.length > 0) {
    throw new Error(`Columnas faltantes en CSV: ${missing.join(', ')}`);
  }

  return lines.slice(1).map(line => normalizeRow(parseLine(line, headers)));
}

/** Convierte una línea CSV en objeto crudo usando los headers */
function parseLine(line, headers) {
  const vals = line.split(',');
  const row = {};
  headers.forEach((h, i) => {
    row[h] = (vals[i] ?? '').trim().replace(/\r/g, '');
  });
  return row;
}

/** Convierte strings numéricos a number; vacíos/inválidos → null */
function normalizeRow(row) {
  NUM_COLS.forEach(col => {
    const v = row[col];
    row[col] = (v === '' || v == null) ? null : parseFloat(v);
  });
  return row;
}

// ═══════════════════════════════════════════════════
// FILTROS
// ═══════════════════════════════════════════════════

/** Aplica todos los filtros activos sobre state.raw y dispara render */
function applyFilters() {
  const f = state.filters;
  state.filtered = state.raw.filter(r => {
    if (f.rubrosSelected.size > 0 && !f.rubrosSelected.has(r[C.rubro])) return false;
    if (f.direccion && r[C.dir] !== f.direccion) return false;
    if (f.tipodoc   && r[C.tipo] !== f.tipodoc)  return false;
    const com = r[C.totalCom];
    if (f.minCom !== '' && com !== null && com < Number(f.minCom)) return false;
    if (f.maxCom !== '' && com !== null && com > Number(f.maxCom)) return false;
    if (f.search && !r[C.rubro].toLowerCase().includes(f.search.toLowerCase())) return false;
    return true;
  });
  state.page = 1;
  render();
}

// ═══════════════════════════════════════════════════
// FORMATO / UTILIDADES
// ═══════════════════════════════════════════════════

/** Número con separador de miles (es-CL), decimales opcionales */
function fmtN(n, dec = 0) {
  if (n === null || n === undefined || (typeof n === 'number' && isNaN(n))) return '-';
  return n.toLocaleString('es-CL', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

/** Monto en CLP con símbolo $ */
function fmtCLP(n) {
  if (n === null || n === undefined || (typeof n === 'number' && isNaN(n))) return '-';
  return '$ ' + Math.round(n).toLocaleString('es-CL');
}

/** Quita prefijo "Minorista – " para etiquetas cortas en gráficos */
function shortRubro(name) {
  return (name || '').replace(/^Minorista\s[–-]\s/, '');
}

/** Suma una columna en un array de filas */
function sumField(rows, col) {
  return rows.reduce((acc, r) => acc + (r[col] || 0), 0);
}

/**
 * Suma comercios_total_macro desduplicando por macro_rubro,
 * ya que ese valor es constante para todas las filas del mismo rubro.
 */
function sumUniqueComercios(rows) {
  const seen = new Map();
  rows.forEach(r => {
    if (!seen.has(r[C.rubro])) seen.set(r[C.rubro], r[C.totalCom] || 0);
  });
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

/** Agrupa por keyCol y suma valCol; devuelve { key: total } ordenado por inserción */
function groupAndSum(rows, keyCol, valCol) {
  const result = {};
  rows.forEach(r => {
    const k = r[keyCol];
    result[k] = (result[k] || 0) + (r[valCol] || 0);
  });
  return result;
}

// ═══════════════════════════════════════════════════
// KPIs
// ═══════════════════════════════════════════════════

function renderKPIs(rows) {
  const totalCom  = sumUniqueComercios(rows);
  const conDoc    = sumField(rows, C.conDoc);
  const cantDocs  = sumField(rows, C.cantDocs);
  const montoTot  = sumField(rows, C.montoTotal);
  // Promedios ponderados
  const docsAvgW  = conDoc   > 0 ? cantDocs / conDoc   : null;
  const montoAvgW = cantDocs > 0 ? montoTot / cantDocs : null;

  const kpis = [
    {
      icon: '🏪', label: 'Total Comercios',
      value: fmtN(totalCom),
      note: 'únicos por rubro (desduplicado)',
    },
    {
      icon: '📄', label: 'Con Documento',
      value: fmtN(conDoc),
      note: 'suma filas visibles',
    },
    {
      icon: '📋', label: 'Cantidad Documentos',
      value: fmtN(cantDocs),
      note: 'suma filas visibles',
    },
    {
      icon: '💰', label: 'Monto Total',
      value: fmtCLP(montoTot),
      note: 'CLP · suma filas visibles',
    },
    {
      icon: '📊', label: 'Docs / Comercio',
      value: fmtN(docsAvgW, 1),
      note: 'ponderado: Σdocs / Σcon_doc',
    },
    {
      icon: '💵', label: 'Monto / Documento',
      value: fmtCLP(montoAvgW),
      note: 'ponderado: Σmonto / Σdocs',
    },
  ];

  document.getElementById('kpis-container').innerHTML = kpis.map(k => `
    <div class="kpi-card">
      <div class="kpi-icon">${k.icon}</div>
      <div class="kpi-body">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-note">${k.note}</div>
      </div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════
// GRÁFICOS
// ═══════════════════════════════════════════════════

function renderCharts(rows) {
  renderChart1(rows);
  renderChart2(rows);
  renderChart3(rows);
}

/** Gráfico 1: Barras horizontales – comercios con documento por macro rubro */
function renderChart1(rows) {
  const grouped = groupAndSum(rows, C.rubro, C.conDoc);
  const labels = Object.keys(grouped).map(shortRubro);
  const data   = Object.values(grouped);
  const colors = Object.keys(grouped).map((_, i) => RUBRO_COLORS[i % RUBRO_COLORS.length]);

  const ctx = document.getElementById('chart1').getContext('2d');
  if (charts.c1) charts.c1.destroy();
  charts.c1 = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Comercios con Documento',
        data,
        backgroundColor: colors,
        borderRadius: 5,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#f0f2f8' }, ticks: { font: { family: 'Poppins', size: 11 } } },
        y: { grid: { display: false },   ticks: { font: { family: 'Poppins', size: 11 } } },
      },
    },
  });
}

/**
 * Gráfico 2: Barras apiladas – cantidad_documentos por tipo (boleta/factura/fc).
 * Forzado a dirección emitido, ignora el filtro tipo_documento para mostrar mix.
 */
function renderChart2(rows) {
  // Aplicar solo filtros de rubro/comercios/search, no de tipo ni dirección
  const base = rows.filter(r =>
    r[C.dir] === 'emitido' && r[C.tipo] !== 'any'
  );

  const rubros = [...new Set(base.map(r => r[C.rubro]))];
  const tipos  = ['boleta', 'factura', 'factura_compra'];

  const datasets = tipos.map(tipo => {
    const byRubro = new Map(
      base.filter(r => r[C.tipo] === tipo).map(r => [r[C.rubro], r[C.cantDocs] || 0])
    );
    return {
      label: tipo.replace('_', ' '),
      data: rubros.map(rub => byRubro.get(rub) || 0),
      backgroundColor: TIPO_COLORS[tipo],
      borderRadius: 3,
    };
  });

  const ctx = document.getElementById('chart2').getContext('2d');
  if (charts.c2) charts.c2.destroy();
  charts.c2 = new Chart(ctx, {
    type: 'bar',
    data: { labels: rubros.map(shortRubro), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { font: { family: 'Poppins', size: 11 } } } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { family: 'Poppins', size: 10 } } },
        y: { stacked: true, grid: { color: '#f0f2f8' }, ticks: { font: { family: 'Poppins', size: 11 } } },
      },
    },
  });
}

/**
 * Gráfico 3: Barras agrupadas – monto emitido vs recibido por macro rubro.
 * Usa filas tipo = 'any'; responde a filtro de rubro pero muestra ambas direcciones.
 */
function renderChart3(rows) {
  // Tomar filas tipo=any del dataset filtrado (sin filtro de dirección ni tipo)
  const anyRows = state.raw.filter(r => {
    const f = state.filters;
    if (f.rubrosSelected.size > 0 && !f.rubrosSelected.has(r[C.rubro])) return false;
    if (f.minCom !== '' && r[C.totalCom] !== null && r[C.totalCom] < Number(f.minCom)) return false;
    if (f.maxCom !== '' && r[C.totalCom] !== null && r[C.totalCom] > Number(f.maxCom)) return false;
    if (f.search && !r[C.rubro].toLowerCase().includes(f.search.toLowerCase())) return false;
    return r[C.tipo] === 'any';
  });

  const rubros = [...new Set(anyRows.map(r => r[C.rubro]))];

  const byDir = (dir) => rubros.map(rub => {
    const row = anyRows.find(r => r[C.rubro] === rub && r[C.dir] === dir);
    return row ? (row[C.montoTotal] || 0) : 0;
  });

  const ctx = document.getElementById('chart3').getContext('2d');
  if (charts.c3) charts.c3.destroy();
  charts.c3 = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rubros.map(shortRubro),
      datasets: [
        { label: 'Emitido',  data: byDir('emitido'),  backgroundColor: '#4361ee', borderRadius: 4 },
        { label: 'Recibido', data: byDir('recibido'), backgroundColor: '#06d6a0', borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { font: { family: 'Poppins', size: 11 } } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Poppins', size: 10 } } },
        y: {
          grid: { color: '#f0f2f8' },
          ticks: {
            font: { family: 'Poppins', size: 11 },
            callback: v => '$ ' + (v / 1e9).toFixed(1) + 'B',
          },
        },
      },
    },
  });
}

// ═══════════════════════════════════════════════════
// AUDITORÍA SOLO BOLETA
// ═══════════════════════════════════════════════════

/**
 * Muestra comercios solo-boleta, cobertura con facturas recibidas,
 * ratio por rubro y ranking visual.
 */
function renderSoloBoleta(rows) {
  // Desduplicar: un registro por macro_rubro (el campo es igual en todas las filas del rubro)
  const seen = new Map();
  rows.forEach(r => {
    if (!seen.has(r[C.rubro])) {
      seen.set(r[C.rubro], {
        rubro:      r[C.rubro],
        soloBoleta: r[C.soloBoleta],
        conFC:      r[C.soloBoletaFC],
      });
    }
  });

  const items = [...seen.values()]
    .map(item => ({
      ...item,
      ratio: (item.soloBoleta > 0) ? item.conFC / item.soloBoleta : null,
    }))
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));

  const container = document.getElementById('boleta-container');

  if (items.length === 0) {
    container.innerHTML = '<p class="empty-state">Sin datos para los filtros actuales.</p>';
    return;
  }

  // Totales globales del conjunto visible
  const totalSB    = items.reduce((a, b) => a + (b.soloBoleta || 0), 0);
  const totalFC    = items.reduce((a, b) => a + (b.conFC || 0),       0);
  const ratioGlobal = totalSB > 0 ? totalFC / totalSB : null;

  const ratioPct = (r) =>
    r !== null ? (r * 100).toFixed(1) + '%' : '-';

  container.innerHTML = `
    <div class="sb-summary">
      <div class="sb-sum-card">
        <div class="sb-sum-label">Solo Boleta</div>
        <div class="sb-sum-value">${fmtN(totalSB)}</div>
      </div>
      <div class="sb-sum-card">
        <div class="sb-sum-label">Con Facturas Recibidas</div>
        <div class="sb-sum-value">${fmtN(totalFC)}</div>
      </div>
      <div class="sb-sum-card highlight">
        <div class="sb-sum-label">Ratio Global</div>
        <div class="sb-sum-value">${ratioPct(ratioGlobal)}</div>
      </div>
    </div>
    <table class="sb-table">
      <thead>
        <tr>
          <th>Macro Rubro</th>
          <th style="text-align:right">Solo Boleta</th>
          <th style="text-align:right">Con Fact. Recibidas</th>
          <th style="text-align:right">Ratio</th>
          <th>Cobertura</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(item => `
          <tr>
            <td>${shortRubro(item.rubro)}</td>
            <td style="text-align:right">${fmtN(item.soloBoleta)}</td>
            <td style="text-align:right">${fmtN(item.conFC)}</td>
            <td style="text-align:right"><strong>${ratioPct(item.ratio)}</strong></td>
            <td>
              <div class="ratio-bar-track">
                <div class="ratio-bar-fill"
                  style="width:${item.ratio !== null ? Math.min(item.ratio * 100, 100).toFixed(1) : 0}%">
                </div>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// ═══════════════════════════════════════════════════
// TABLA PRINCIPAL
// ═══════════════════════════════════════════════════

/** Definición de columnas de la tabla */
const TABLE_COLS = [
  { key: C.periodo,    label: 'Periodo' },
  { key: C.rubro,      label: 'Macro Rubro' },
  { key: C.dir,        label: 'Dirección' },
  { key: C.tipo,       label: 'Tipo Doc.' },
  { key: C.totalCom,   label: 'Total Comercios', num: true },
  { key: C.conDoc,     label: 'Con Documento',   num: true },
  { key: C.cantDocs,   label: 'Cant. Docs',       num: true },
  { key: C.montoTotal, label: 'Monto Total',      clp: true },
  { key: C.docsAvg,    label: 'Docs/Comercio',    dec: 1 },
  { key: C.montoAvg,   label: 'Monto/Doc',        clp: true },
  { key: C.soloBoleta, label: 'Solo Boleta',       num: true },
  { key: C.soloBoletaFC, label: 'SB + Fact. Rec.', num: true },
];

function renderTable() {
  const sorted     = getSortedRows();
  const total      = sorted.length;
  const start      = (state.page - 1) * PAGE_SIZE;
  const pageRows   = sorted.slice(start, start + PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  document.getElementById('row-count').textContent = `${total} filas visibles`;

  // ── Cabecera ──
  document.getElementById('table-head').innerHTML = `<tr>
    ${TABLE_COLS.map(col => `
      <th class="sortable${state.sort.col === col.key ? ' sorted' : ''}"
          data-col="${col.key}"
          title="Ordenar por ${col.label}">
        ${col.label}${state.sort.col === col.key ? (state.sort.asc ? ' ↑' : ' ↓') : ''}
      </th>
    `).join('')}
  </tr>`;

  // ── Cuerpo ──
  const tbody = document.getElementById('table-body');
  if (pageRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${TABLE_COLS.length}" class="empty-state">
      Sin resultados. Ajusta o resetea los filtros.
    </td></tr>`;
  } else {
    tbody.innerHTML = pageRows.map(r => `<tr>${
      TABLE_COLS.map(col => {
        const v = r[col.key];
        let display;
        if      (col.clp)             display = fmtCLP(v);
        else if (col.dec !== undefined) display = fmtN(v, col.dec);
        else if (col.num)             display = fmtN(v);
        else                          display = v ?? '-';
        const cls = (col.num || col.clp || col.dec !== undefined) ? ' class="num"' : '';
        return `<td${cls}>${display}</td>`;
      }).join('')
    }</tr>`).join('');
  }

  // ── Paginación ──
  document.getElementById('pagination').innerHTML = `
    <button onclick="changePage(-1)" ${state.page <= 1 ? 'disabled' : ''}>‹ Anterior</button>
    <span>Página ${state.page} de ${totalPages} · ${total} filas</span>
    <button onclick="changePage(1)"  ${state.page >= totalPages ? 'disabled' : ''}>Siguiente ›</button>
  `;

  // ── Eventos de ordenamiento ──
  document.getElementById('table-head').querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      state.sort.asc = (state.sort.col === col) ? !state.sort.asc : true;
      state.sort.col = col;
      renderTable();
    });
  });
}

/** Devuelve las filas filtradas ordenadas según state.sort */
function getSortedRows() {
  if (!state.sort.col) return state.filtered;
  return [...state.filtered].sort((a, b) => {
    const va = a[state.sort.col];
    const vb = b[state.sort.col];
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'number')
      return state.sort.asc ? va - vb : vb - va;
    return state.sort.asc
      ? String(va).localeCompare(String(vb), 'es')
      : String(vb).localeCompare(String(va), 'es');
  });
}

/** Cambia de página (delta = ±1) */
function changePage(delta) {
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
  state.page = Math.max(1, Math.min(totalPages, state.page + delta));
  renderTable();
}

// ═══════════════════════════════════════════════════
// EXPORTAR CSV
// ═══════════════════════════════════════════════════

/** Descarga las filas filtradas (ordenadas) como archivo CSV */
function exportCSV() {
  const rows    = getSortedRows();
  const headers = TABLE_COLS.map(c => c.key).join(',');
  const body    = rows.map(r =>
    TABLE_COLS.map(c => {
      const v = r[c.key];
      if (v === null || v === undefined) return '';
      // Envolver en comillas si el valor contiene coma
      return (typeof v === 'string' && v.includes(',')) ? `"${v}"` : v;
    }).join(',')
  ).join('\n');

  const blob = new Blob(['﻿' + headers + '\n' + body], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = 'dashboard_minoristas_abril2026.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════
// RENDER COMPLETO
// ═══════════════════════════════════════════════════

function render() {
  renderKPIs(state.filtered);
  renderCharts(state.filtered);
  renderSoloBoleta(state.filtered);
  renderTable();
}

// ═══════════════════════════════════════════════════
// CONFIGURACIÓN DE FILTROS (UI)
// ═══════════════════════════════════════════════════

/** Construye el multi-select de rubros a partir de state.rubros */
function setupFilters() {
  const msDropdown = document.getElementById('ms-dropdown');

  // Inyectar opciones de rubro
  state.rubros.forEach(rub => {
    const label = document.createElement('label');
    label.className = 'ms-option';
    label.innerHTML = `<input type="checkbox" value="${rub}" class="ms-cb" /> ${shortRubro(rub)}`;
    msDropdown.appendChild(label);
  });

  // Toggle dropdown
  document.getElementById('ms-toggle').addEventListener('click', e => {
    e.stopPropagation();
    msOpen = !msOpen;
    msDropdown.style.display = msOpen ? 'block' : 'none';
  });

  // Cerrar al hacer clic fuera
  document.addEventListener('click', () => {
    if (msOpen) {
      msOpen = false;
      msDropdown.style.display = 'none';
    }
  });
  msDropdown.addEventListener('click', e => e.stopPropagation());

  // Checkbox "Todos"
  document.getElementById('ms-todos').addEventListener('change', e => {
    if (e.target.checked) {
      state.filters.rubrosSelected.clear();
      document.querySelectorAll('.ms-cb').forEach(cb => (cb.checked = false));
    }
    updateMSLabel();
    applyFilters();
  });

  // Checkboxes individuales de rubro
  msDropdown.addEventListener('change', e => {
    if (!e.target.classList.contains('ms-cb')) return;
    if (e.target.checked) {
      state.filters.rubrosSelected.add(e.target.value);
      document.getElementById('ms-todos').checked = false;
    } else {
      state.filters.rubrosSelected.delete(e.target.value);
      if (state.filters.rubrosSelected.size === 0) {
        document.getElementById('ms-todos').checked = true;
      }
    }
    updateMSLabel();
    applyFilters();
  });

  // Selects y inputs
  document.getElementById('f-direccion').addEventListener('change', e => {
    state.filters.direccion = e.target.value; applyFilters();
  });
  document.getElementById('f-tipo').addEventListener('change', e => {
    state.filters.tipodoc = e.target.value; applyFilters();
  });
  document.getElementById('f-min-com').addEventListener('input', e => {
    state.filters.minCom = e.target.value; applyFilters();
  });
  document.getElementById('f-max-com').addEventListener('input', e => {
    state.filters.maxCom = e.target.value; applyFilters();
  });
  document.getElementById('f-search').addEventListener('input', e => {
    state.filters.search = e.target.value; applyFilters();
  });

  // Botones
  document.getElementById('btn-reset').addEventListener('click',  resetFilters);
  document.getElementById('btn-export').addEventListener('click', exportCSV);
}

/** Actualiza la etiqueta del botón del multi-select */
function updateMSLabel() {
  const n   = state.filters.rubrosSelected.size;
  const btn = document.getElementById('ms-toggle');
  btn.textContent = n === 0 ? 'Todos los rubros ▾' : `${n} rubro(s) selec. ▾`;
}

/** Resetea todos los filtros al estado inicial */
function resetFilters() {
  state.filters.rubrosSelected.clear();
  state.filters.direccion = '';
  state.filters.tipodoc   = '';
  state.filters.minCom    = '';
  state.filters.maxCom    = '';
  state.filters.search    = '';
  state.sort = { col: null, asc: true };

  document.getElementById('ms-todos').checked = true;
  document.querySelectorAll('.ms-cb').forEach(cb => (cb.checked = false));
  updateMSLabel();
  document.getElementById('f-direccion').value = '';
  document.getElementById('f-tipo').value      = '';
  document.getElementById('f-min-com').value   = '';
  document.getElementById('f-max-com').value   = '';
  document.getElementById('f-search').value    = '';

  applyFilters();
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════

async function init() {
  try {
    const resp = await fetch(CSV_PATH);
    if (!resp.ok) throw new Error(
      `No se pudo cargar ${CSV_PATH} (HTTP ${resp.status}). ` +
      `Asegúrate de servir los archivos con un servidor local (ej: python -m http.server 8080).`
    );

    const text = await resp.text();
    state.raw    = parseCSV(text);
    state.rubros = [...new Set(state.raw.map(r => r[C.rubro]))].sort();
    state.filtered = state.raw;

    setupFilters();
    render();

    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display     = 'block';
  } catch (err) {
    const errEl = document.getElementById('error-msg');
    errEl.textContent = `⚠ ${err.message}`;
    errEl.style.display = 'block';
    document.getElementById('loading').style.display = 'none';
  }
}

init();
