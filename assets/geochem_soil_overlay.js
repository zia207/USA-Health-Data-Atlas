/**
 * USGS Geochemical Portal — soil sample overlay (live Feature Service).
 * Element selection + multiple mapping approaches.
 * Portal: https://alaska.usgs.gov/science/geology/geochem_portal/geochem_portal.html
 */
(function (global) {
  const SERVICE =
    'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Geochem_features/FeatureServer/2';
  const PAGE = 2000;
  const MAX_SAMPLES = 4000;
  const DEFAULT_COLORS = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'];
  const N_CLASSES = 5;

  function exportStyle() {
    return (global.AtlasOverlayExportStyle && global.AtlasOverlayExportStyle.soil) || {};
  }

  function activeColors() {
    const pal = exportStyle().palette;
    if (pal && pal !== 'default' && global.MapStyleControls) {
      return MapStyleControls.getColors(pal);
    }
    return DEFAULT_COLORS.slice();
  }

  function pointSize() {
    const s = Number(exportStyle().size);
    if (Number.isFinite(s)) return Math.max(8, Math.min(18, s));
    return 9;
  }

  const MAP_STYLES = [
    { id: 'points-equal', label: 'Points — equal interval colors' },
    { id: 'points-quantile', label: 'Points — quantile (percentile) colors' },
    { id: 'graduated', label: 'Graduated symbols (size + color)' },
    { id: 'grid-mean', label: 'Grid / hex cells — mean value' },
    { id: 'heatmap-weight', label: 'Heat density (value-weighted)' },
    { id: 'state-mean', label: 'State choropleth — mean value' },
  ];

  const META_FIELDS = [
    'OBJECTID', 'lab_id', 'field_id', 'state', 'latitude', 'longitude',
    'project_name', 'submitter', 'date_submitted', 'date_collect', 'quad',
    'primary_class', 'secondary_class', 'specific_name', 'horizon', 'depth',
    'method_collected', 'sample_source', 'locate_desc', 'sample_comment',
    'mesh_pore_size', 'district_name', 'deposit_name', 'mine_name',
  ];

  function $(id) { return document.getElementById(id); }

  function injectStyles() {
    if (document.getElementById('gc-overlay-styles')) return;
    const style = document.createElement('style');
    style.id = 'gc-overlay-styles';
    style.textContent = `
      .gc-panel { margin-top: 16px; padding-top: 12px; border-top: 1px dashed var(--hair, #c5d0d6); }
      .gc-panel h2 {
        margin-top: 0;
        font-size: 15px;
        letter-spacing: .08em;
        line-height: 1.3;
      }
      .gc-check { display: flex; gap: 8px; align-items: center; font-size: 13px; margin-bottom: 8px; cursor: pointer; }
      .gc-dossier {
        position: fixed; top: 0; right: 0; width: min(440px, 100vw); height: 100vh;
        background: #fff; border-left: 1px solid #c5d0d6; z-index: 5100;
        box-shadow: -8px 0 28px rgba(15,23,42,.18); transform: translateX(105%);
        transition: transform .22s ease; display: flex; flex-direction: column;
      }
      .gc-dossier.open { transform: translateX(0); }
      .gc-dossier-head {
        padding: 14px 16px 12px; background: linear-gradient(90deg,#1a3a2a,#2f6b4f);
        color: #eaf5ee; flex: 0 0 auto;
      }
      .gc-dossier-head .tag {
        font-family: ui-monospace, Consolas, monospace; font-size: 10px;
        letter-spacing: .12em; text-transform: uppercase; color: #a8cbb8;
      }
      .gc-dossier-head h3 { margin: 6px 0 0; font-size: 18px; line-height: 1.25; }
      .gc-dossier-close {
        float: right; background: transparent; border: 1px solid rgba(255,255,255,.35);
        color: #eaf5ee; padding: 4px 10px; cursor: pointer; font-size: 12px;
      }
      .gc-dossier-body { padding: 14px 16px 28px; overflow: auto; flex: 1; font-size: 13.5px; color: #0b1f2a; }
      .gc-meta { display: grid; gap: 8px; margin: 12px 0 14px; }
      .gc-meta div { display: grid; grid-template-columns: 120px 1fr; gap: 8px; }
      .gc-meta .k {
        font-family: ui-monospace, Consolas, monospace; font-size: 10px;
        letter-spacing: .08em; text-transform: uppercase; color: #5a6e78; padding-top: 2px;
      }
      .gc-elem-table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 8px; }
      .gc-elem-table th { text-align: left; background: #1a3a2a; color: #fff; padding: 6px 8px; }
      .gc-elem-table td { padding: 5px 8px; border-bottom: 1px solid #e6eef0; }
      .gc-note { font-size: 11.5px; color: #5a6e78; line-height: 1.45; margin-top: 10px; }
      .gc-legend-row { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 3px 0; }
      .gc-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; border: none; }
      .gc-status { font-size: 12px; color: #5a6e78; margin-top: 8px; min-height: 1.2em; }
      .gc-status.err { color: #b7431c; }
      .gc-status.ok { color: #2f7d4e; }
      .gc-ramp { display: flex; height: 12px; border: 1px solid #c5d0d6; margin: 4px 0; overflow: hidden; }
      .gc-ramp span { flex: 1; }
      .gc-map-legend {
        background: rgba(255,255,255,.96);
        border: 1px solid #c5d0d6;
        padding: 12px 14px;
        font-size: 12px;
        line-height: 1.45;
        min-width: 180px;
        max-width: 260px;
        box-shadow: 0 2px 10px rgba(20,38,46,.18);
        color: #0b1f2a;
      }
      .gc-map-legend strong {
        display: block;
        font-size: 10px;
        letter-spacing: .1em;
        text-transform: uppercase;
        color: #5a6e78;
        font-family: ui-monospace, Consolas, monospace;
        margin-bottom: 8px;
      }
      .gc-map-legend .gc-legend-ends {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: #5a6e78;
        margin-bottom: 8px;
        font-family: ui-monospace, Consolas, monospace;
      }
      .gc-map-legend .gc-legend-items { display: flex; flex-direction: column; gap: 4px; }
      .gc-map-legend .gc-legend-item {
        display: flex; align-items: center; gap: 8px; font-size: 12px; color: #0b1f2a;
      }
      .gc-map-legend .gc-swatch {
        width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; border: none;
      }
      .gc-map-legend .gc-note { margin-top: 8px; font-size: 10.5px; }
    `;
    document.head.appendChild(style);
  }

  function ensureDossier() {
    let el = document.getElementById('gc-dossier');
    if (el) return el;
    el = document.createElement('aside');
    el.id = 'gc-dossier';
    el.className = 'gc-dossier';
    el.innerHTML = `
      <div class="gc-dossier-head">
        <button type="button" class="gc-dossier-close" id="gc-dossier-close">Close</button>
        <div class="tag" id="gc-dossier-tag">USGS GEOCHEM · SOIL</div>
        <h3 id="gc-dossier-title">Sample</h3>
      </div>
      <div class="gc-dossier-body" id="gc-dossier-body"></div>
    `;
    document.body.appendChild(el);
    $('gc-dossier-close').addEventListener('click', () => el.classList.remove('open'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') el.classList.remove('open');
    });
    return el;
  }

  function fmtVal(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'number') {
      if (v < 0) return `< ${Math.abs(v)} (below detection)`;
      return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
    }
    return String(v);
  }

  function positiveVals(samples, element) {
    return samples
      .map((s) => Number(s[element]))
      .filter((v) => Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);
  }

  function equalBreaks(vals, n) {
    if (!vals.length) return [0, 1];
    const lo = vals[0];
    const hi = vals[vals.length - 1];
    if (hi <= lo) return [lo, lo + 1e-9];
    const breaks = [];
    for (let i = 0; i <= n; i++) breaks.push(lo + ((hi - lo) * i) / n);
    return breaks;
  }

  function quantileBreaks(vals, n) {
    if (!vals.length) return [0, 1];
    if (vals.length === 1) return [vals[0], vals[0] + 1e-9];
    const breaks = [vals[0]];
    for (let i = 1; i < n; i++) {
      const idx = Math.min(vals.length - 1, Math.floor((i / n) * vals.length));
      breaks.push(vals[idx]);
    }
    breaks.push(vals[vals.length - 1]);
    // ensure strictly increasing for class lookup
    for (let i = 1; i < breaks.length; i++) {
      if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] + 1e-9;
    }
    return breaks;
  }

  function classIndex(breaks, v) {
    if (!Number.isFinite(v) || v < 0) return -1;
    for (let i = 0; i < breaks.length - 1; i++) {
      if (v <= breaks[i + 1] || i === breaks.length - 2) return i;
    }
    return breaks.length - 2;
  }

  function colorForClass(idx) {
    if (idx < 0) return '#94a3b8';
    const colors = activeColors();
    return colors[Math.min(colors.length - 1, idx)];
  }

  function circleIcon(color, size) {
    const s = Math.max(8, Math.min(18, size || pointSize()));
    return L.divIcon({
      className: '',
      html: `<div style="width:${s}px;height:${s}px;border-radius:50%;background:${color};border:none;box-shadow:none"></div>`,
      iconSize: [s, s],
      iconAnchor: [s / 2, s / 2],
    });
  }

  function countIcon(n, color) {
    const size = Math.max(22, Math.min(40, 16 + Math.sqrt(n) * 5));
    const bg = color || '#2f6b4f';
    const label = n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n));
    return L.divIcon({
      className: '',
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;border:none;box-shadow:none;display:flex;align-items:center;justify-content:center;font:650 10px ui-monospace,Consolas,monospace">${label}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function fmtBreak(v) {
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 100) return v.toFixed(1);
    if (Math.abs(v) >= 10) return v.toFixed(2);
    return v.toFixed(3);
  }

  function legendRamp(title, breaks, subtitle) {
    const colors = activeColors();
    const ramp = colors.map((c) => `<span style="background:${c}"></span>`).join('');
    const items = colors.map((c, i) => {
      const lo = fmtBreak(breaks[i]);
      const hi = fmtBreak(breaks[i + 1]);
      return `<div class="gc-legend-item"><span class="gc-swatch" style="background:${c}"></span>`
        + `<span>${lo} – ${hi}</span></div>`;
    }).join('');
    return `<strong>${title}</strong>
      <div class="gc-ramp">${ramp}</div>
      <div class="gc-legend-ends"><span>Low</span><span>High</span></div>
      <div class="gc-legend-items">${items}</div>
      ${subtitle ? `<div class="gc-note">${subtitle}</div>` : ''}`;
  }

  function openSampleDossier(sample, elements) {
    const el = ensureDossier();
    const title = sample.lab_id || sample.field_id || `OBJECTID ${sample.OBJECTID}`;
    $('gc-dossier-tag').textContent = 'USGS GEOCHEM · SOIL SAMPLE';
    $('gc-dossier-title').textContent = title;
    const loc = [sample.quad, sample.state].filter(Boolean).join(', ');
    const rows = (elements || []).map((e) => {
      const v = sample[e.code];
      return `<tr><td>${e.label}</td><td>${fmtVal(v)}</td><td>${e.unit}</td></tr>`;
    }).join('');
    $('gc-dossier-body').innerHTML = `
      <div class="gc-meta">
        <div><span class="k">Lab ID</span><span>${sample.lab_id || '—'}</span></div>
        <div><span class="k">Field ID</span><span>${sample.field_id || '—'}</span></div>
        <div><span class="k">Location</span><span>${loc || '—'}</span></div>
        <div><span class="k">State</span><span>${sample.state || '—'}</span></div>
        <div><span class="k">Coordinates</span><span>${sample.latitude}, ${sample.longitude}</span></div>
        <div><span class="k">Project</span><span>${sample.project_name || '—'}</span></div>
        <div><span class="k">Submitter</span><span>${sample.submitter || '—'}</span></div>
        <div><span class="k">Date submitted</span><span>${sample.date_submitted || '—'}</span></div>
        <div><span class="k">Date collected</span><span>${sample.date_collect || '—'}</span></div>
        <div><span class="k">Class</span><span>${[sample.primary_class, sample.secondary_class, sample.specific_name].filter(Boolean).join(' · ') || '—'}</span></div>
        <div><span class="k">Horizon / depth</span><span>${[sample.horizon, sample.depth].filter(Boolean).join(' · ') || '—'}</span></div>
        <div><span class="k">Method</span><span>${sample.method_collected || '—'}</span></div>
        <div><span class="k">Mesh</span><span>${sample.mesh_pore_size || '—'}</span></div>
        <div><span class="k">Comment</span><span>${sample.sample_comment || '—'}</span></div>
      </div>
      <strong>Element chemistry</strong>
      <table class="gc-elem-table">
        <thead><tr><th>Element</th><th>Value</th><th>Unit</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3">No element fields loaded</td></tr>'}</tbody>
      </table>
      <p class="gc-note">Negative values mean below the analytical detection limit.</p>
      <div style="margin-top:10px">
        <a href="https://alaska.usgs.gov/science/geology/geochem_portal/geochem_portal.html" target="_blank" rel="noopener">Open USGS Geochemical Data Portal</a>
      </div>
    `;
    el.classList.add('open');
  }

  function createControlsHtml(meta) {
    const states = Object.keys(meta.state_counts || {}).sort();
    const elems = meta.meta.elements || [];
    const metals = elems.filter((e) => e.unit === 'ppm');
    const majors = elems.filter((e) => e.unit === '%');
    return `
      <div class="gc-panel" id="gc-controls">
        <h2>USGS soil geochemistry</h2>
        <label class="gc-check"><input type="checkbox" id="gc-enabled"> Show soil element map</label>
        <div class="field">
          <label for="gc-element">Element (from soil layer)</label>
          <select id="gc-element">
            <optgroup label="Trace metals (ppm)">
              ${metals.map((e) => `<option value="${e.code}" ${e.code === 'As_ppm' ? 'selected' : ''}>${e.label}</option>`).join('')}
            </optgroup>
            <optgroup label="Major elements (%)">
              ${majors.map((e) => `<option value="${e.code}">${e.label}</option>`).join('')}
            </optgroup>
          </select>
        </div>
        <div class="field">
          <label for="gc-style">Mapping approach</label>
          <select id="gc-style">
            ${MAP_STYLES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="gc-state">State focus</label>
          <select id="gc-state">
            <option value="ALL">All states (USA)</option>
            ${states.map((s) => `<option value="${s}">${s} (${(meta.state_counts[s] || 0).toLocaleString()})</option>`).join('')}
          </select>
        </div>
        <div class="field" id="gc-grid-field">
          <label for="gc-grid">Grid cell size (degrees)</label>
          <select id="gc-grid">
            <option value="0.25">0.25°</option>
            <option value="0.5" selected>0.5°</option>
            <option value="1">1.0°</option>
          </select>
        </div>
        <div class="btnrow">
          <button class="btn" type="button" id="gc-apply">Apply soil map</button>
        </div>
        <div class="gc-status" id="gc-status"></div>
        <div id="gc-legend" class="note" style="margin-top:8px"></div>
        <p class="note">
          Pick an <strong>element</strong> and a <strong>mapping approach</strong>.
          Point/grid/heatmap styles need a state (or use state-mean nationwide).
          Source:
          <a href="https://alaska.usgs.gov/science/geology/geochem_portal/geochem_portal.html" target="_blank" rel="noopener">USGS Geochemical Data Portal</a>.
        </p>
      </div>
    `;
  }

  async function querySoil(where, elementCode) {
    const elemFields = (global.GEOCHEM_SOIL_META.meta.elements || []).map((e) => e.code);
    const fields = META_FIELDS.concat(elemFields);
    let w = where;
    if (elementCode) w += ` AND ${elementCode} IS NOT NULL`;
    const out = [];
    let offset = 0;
    while (offset < MAX_SAMPLES) {
      const params = new URLSearchParams({
        where: w,
        outFields: fields.join(','),
        returnGeometry: 'true',
        outSR: '4326',
        resultOffset: String(offset),
        resultRecordCount: String(PAGE),
        orderByFields: 'OBJECTID',
        f: 'pjson',
      });
      const res = await fetch(`${SERVICE}/query?${params}`);
      if (!res.ok) throw new Error(`USGS soil query failed (${res.status})`);
      const data = await res.json();
      const feats = data.features || [];
      feats.forEach((f) => {
        const a = f.attributes || {};
        const g = f.geometry || {};
        const lat = a.latitude != null ? a.latitude : g.y;
        const lon = a.longitude != null ? a.longitude : g.x;
        if (lat == null || lon == null) return;
        out.push({ ...a, latitude: lat, longitude: lon });
      });
      if (feats.length < PAGE) break;
      offset += PAGE;
    }
    return out;
  }

  async function queryStateMeans(elementCode) {
    const params = new URLSearchParams({
      where: `${elementCode} IS NOT NULL AND ${elementCode} >= 0`,
      groupByFieldsForStatistics: 'state',
      outStatistics: JSON.stringify([
        { statisticType: 'avg', onStatisticField: elementCode, outStatisticFieldName: 'avg_val' },
        { statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' },
      ]),
      orderByFields: 'state ASC',
      f: 'pjson',
    });
    const res = await fetch(`${SERVICE}/query?${params}`);
    if (!res.ok) throw new Error(`State mean query failed (${res.status})`);
    const data = await res.json();
    return (data.features || []).map((f) => f.attributes).filter((a) => a.state && a.avg_val != null);
  }

  function buildGrid(samples, element, cellDeg) {
    const cells = {};
    samples.forEach((s) => {
      const v = Number(s[element]);
      if (!Number.isFinite(v) || v < 0) return;
      const i = Math.floor(s.latitude / cellDeg);
      const j = Math.floor(s.longitude / cellDeg);
      const key = `${i},${j}`;
      (cells[key] ||= { sum: 0, n: 0, i, j }).sum += v;
      cells[key].n += 1;
    });
    return Object.values(cells).map((c) => ({
      mean: c.sum / c.n,
      n: c.n,
      south: c.i * cellDeg,
      west: c.j * cellDeg,
      north: (c.i + 1) * cellDeg,
      east: (c.j + 1) * cellDeg,
    }));
  }

  /** Simple value-weighted heat as translucent circles (no external heat plugin). */
  function addHeatLayers(layer, samples, element, breaks) {
    samples.forEach((s) => {
      const v = Number(s[element]);
      if (!Number.isFinite(v) || v < 0) return;
      const idx = classIndex(breaks, v);
      const t = (idx + 1) / N_CLASSES;
      const radius = 8 + t * 22;
      const color = colorForClass(idx);
      L.circleMarker([s.latitude, s.longitude], {
        radius,
        color: color,
        fillColor: color,
        fillOpacity: 0.18 + t * 0.35,
        opacity: 0.15,
        weight: 0,
      }).addTo(layer);
    });
  }

  function GeochemSoilOverlay(options) {
    this.map = options.map;
    this.mount = typeof options.mount === 'string' ? $(options.mount) : options.mount;
    this.getPageState = options.getPageState || (() => 'ALL');
    this.layer = null;
    this.mapLegendCtrl = null;
    this.cache = {};
    this.stateMeanCache = {};
    this.meta = global.GEOCHEM_SOIL_META;
    injectStyles();
    ensureDossier();
    if (this.mount && !document.getElementById('gc-controls')) {
      this.mount.insertAdjacentHTML('beforeend', createControlsHtml(this.meta));
    }
    const apply = () => this.refresh();
    $('gc-apply') && $('gc-apply').addEventListener('click', apply);
    $('gc-enabled') && $('gc-enabled').addEventListener('change', apply);
    $('gc-style') && $('gc-style').addEventListener('change', () => {
      const style = $('gc-style').value;
      const gf = $('gc-grid-field');
      if (gf) gf.style.display = style === 'grid-mean' ? '' : 'none';
    });
    if ($('gc-grid-field')) {
      $('gc-grid-field').style.display = ($('gc-style') && $('gc-style').value === 'grid-mean') ? '' : 'none';
    }
  }

  GeochemSoilOverlay.prototype.clear = function () {
    if (this.layer && this.map) {
      this.map.removeLayer(this.layer);
    }
    this.layer = null;
  };

  GeochemSoilOverlay.prototype.setStatus = function (msg, cls) {
    const el = $('gc-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'gc-status' + (cls ? ' ' + cls : '');
  };

  GeochemSoilOverlay.prototype.setLegend = function (html) {
    const sidebar = $('gc-legend');
    if (sidebar) sidebar.innerHTML = html || '';

    if (this.mapLegendCtrl) {
      this.map.removeControl(this.mapLegendCtrl);
      this.mapLegendCtrl = null;
    }
    if (!html || !this.map) return;

    const ctrl = L.control({ position: 'topright' });
    ctrl.onAdd = function () {
      const div = L.DomUtil.create('div', 'gc-map-legend');
      div.innerHTML = html;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    ctrl.addTo(this.map);
    this.mapLegendCtrl = ctrl;
  };

  GeochemSoilOverlay.prototype.refresh = async function () {
    this.clear();
    if (!$('gc-enabled') || !$('gc-enabled').checked) {
      this.setStatus('Soil element map off.');
      this.setLegend('');
      return;
    }

    const element = $('gc-element') ? $('gc-element').value : '';
    const style = $('gc-style') ? $('gc-style').value : 'points-equal';
    let st = $('gc-state') ? $('gc-state').value : 'ALL';
    const pageState = this.getPageState();
    if (st === 'ALL' && pageState && pageState !== 'ALL') st = pageState;
    if ($('gc-state') && st !== 'ALL') $('gc-state').value = st;

    const elements = this.meta.meta.elements || [];
    const elMeta = elements.find((e) => e.code === element);
    if (!element || !elMeta) {
      this.setStatus('Select an element from the soil layer.', 'err');
      this.setLegend('');
      return;
    }

    if (!this.map) {
      this.setStatus('Map not ready.', 'err');
      this.setLegend('');
      return;
    }
    this.layer = L.layerGroup().addTo(this.map);
    const needsPoints = style !== 'state-mean';

    try {
      // ---- State mean choropleth (nationwide or filtered) ----
      if (style === 'state-mean') {
        this.setStatus(`Computing state means for ${elMeta.label}…`);
        let rows = this.stateMeanCache[element];
        if (!rows) {
          rows = await queryStateMeans(element);
          this.stateMeanCache[element] = rows;
        }
        if (st !== 'ALL') rows = rows.filter((r) => r.state === st);
        if (!rows.length) {
          this.setStatus(`No state means for ${elMeta.label}.`, 'err');
          this.setLegend('');
          return;
        }
        const vals = rows.map((r) => Number(r.avg_val)).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
        const breaks = equalBreaks(vals, N_CLASSES);
        const cents = this.meta.state_centroids || {};
        rows.forEach((r) => {
          const c = cents[r.state];
          if (!c) return;
          const v = Number(r.avg_val);
          const idx = classIndex(breaks, v);
          const m = L.marker([c[0], c[1]], {
            icon: countIcon(r.n || 1, colorForClass(idx)),
            title: `${r.state}: mean ${v}`,
          });
          m.bindTooltip(
            `<b>${r.state}</b><br>Mean ${elMeta.label}: <b>${fmtVal(v)} ${elMeta.unit}</b><br>n = ${(r.n || 0).toLocaleString()}`,
            { sticky: true }
          );
          m.on('click', () => {
            if ($('gc-state')) $('gc-state').value = r.state;
            if ($('gc-style')) $('gc-style').value = 'points-equal';
            this.refresh();
          });
          m.addTo(this.layer);
        });
        this.setStatus(`State means for ${elMeta.label} — ${rows.length} state(s).`, 'ok');
        this.setLegend(legendRamp(
          `${elMeta.label} — state mean (${elMeta.unit})`,
          breaks,
          'Marker color = mean; label ≈ sample count. Click a state to open point map.'
        ));
        return;
      }

      if (st === 'ALL') {
        this.setStatus('Pick a state for point / grid / heatmap mapping (or use “State choropleth”).', 'err');
        this.setLegend('');
        return;
      }

      if (!needsPoints) return;

      const cacheKey = `${st}|${element}`;
      this.setStatus(`Loading ${elMeta.label} soil samples for ${st}…`);
      let samples = this.cache[cacheKey];
      if (!samples) {
        samples = await querySoil(`state='${st}'`, element);
        this.cache[cacheKey] = samples;
      }
      const vals = positiveVals(samples, element);
      if (!vals.length) {
        this.setStatus(`No positive ${elMeta.label} values for ${st}.`, 'err');
        this.setLegend('');
        return;
      }

      const breaks = style === 'points-quantile'
        ? quantileBreaks(vals, N_CLASSES)
        : equalBreaks(vals, N_CLASSES);
      const classLabel = style === 'points-quantile' ? 'quantile' : 'equal interval';

      if (style === 'grid-mean') {
        const cell = Number(($('gc-grid') && $('gc-grid').value) || 0.5);
        const grid = buildGrid(samples, element, cell);
        const gvals = grid.map((g) => g.mean).sort((a, b) => a - b);
        const gbreaks = equalBreaks(gvals, N_CLASSES);
        grid.forEach((g) => {
          const idx = classIndex(gbreaks, g.mean);
          const rect = L.rectangle([[g.south, g.west], [g.north, g.east]], {
            color: '#0f172a',
            weight: 0.4,
            fillColor: colorForClass(idx),
            fillOpacity: 0.72,
          });
          rect.bindTooltip(
            `<b>Grid cell</b><br>Mean ${elMeta.label}: <b>${fmtVal(g.mean)} ${elMeta.unit}</b><br>n = ${g.n}`,
            { sticky: true }
          );
          rect.addTo(this.layer);
        });
        this.setStatus(`Grid mean map — ${grid.length} cells · ${samples.length.toLocaleString()} samples in ${st}.`, 'ok');
        this.setLegend(legendRamp(`${elMeta.label} — grid mean (${cell}°)`, gbreaks, `State ${st} · ${elMeta.unit}`));
        return;
      }

      if (style === 'heatmap-weight') {
        addHeatLayers(this.layer, samples, element, breaks);
        this.setStatus(`Value-weighted heat — ${samples.length.toLocaleString()} samples · ${elMeta.label} in ${st}.`, 'ok');
        this.setLegend(legendRamp(`${elMeta.label} — heat weight (${elMeta.unit})`, breaks, 'Larger / darker blobs = higher values'));
        return;
      }

      // Point styles: equal, quantile, graduated
      samples.forEach((s) => {
        const v = Number(s[element]);
        const idx = classIndex(breaks, v);
        const color = colorForClass(idx);
        const base = pointSize();
        let size = base;
        if (style === 'graduated' && Number.isFinite(v) && v >= 0) {
          const t = Math.max(0, Math.min(1, (v - breaks[0]) / (breaks[breaks.length - 1] - breaks[0] || 1)));
          size = Math.max(8, Math.min(18, base - 2 + t * 6));
        }
        const m = L.marker([s.latitude, s.longitude], {
          icon: circleIcon(color, size),
          title: s.lab_id || s.field_id || 'Soil sample',
        });
        m.bindTooltip(
          `<b>${s.lab_id || s.field_id || 'Sample'}</b><br>${elMeta.label}: <b>${fmtVal(v)} ${elMeta.unit}</b><br>${s.project_name || ''}`,
          { sticky: true }
        );
        m.on('click', () => openSampleDossier(s, elements));
        m.addTo(this.layer);
      });

      const total = (this.meta.state_counts || {})[st] || samples.length;
      const capped = total > samples.length;
      const styleName = MAP_STYLES.find((x) => x.id === style)?.label || style;
      this.setStatus(
        `${styleName} · ${elMeta.label} · ${samples.length.toLocaleString()}/${total.toLocaleString()} samples in ${st}` +
          (capped ? ` (capped at ${MAX_SAMPLES.toLocaleString()})` : ''),
        'ok'
      );
      this.setLegend(legendRamp(
        `${elMeta.label} (${elMeta.unit})`,
        breaks,
        `${classLabel} · ${st}${style === 'graduated' ? ' · size scales with value' : ''} · click point for dossier`
      ));
    } catch (err) {
      this.setStatus(String(err.message || err), 'err');
      this.setLegend('');
    }
  };

  GeochemSoilOverlay.prototype.getCsvRows = function (bounds) {
    if (!$('gc-enabled') || !$('gc-enabled').checked) return [];
    const element = $('gc-element') ? $('gc-element').value : '';
    const elMeta = ((this.meta.meta && this.meta.meta.elements) || []).find((e) => e.code === element);
    const rows = [];
    Object.keys(this.cache || {}).forEach((key) => {
      (this.cache[key] || []).forEach((s) => {
        if (bounds) {
          if (s.latitude < bounds.south || s.latitude > bounds.north
              || s.longitude < bounds.west || s.longitude > bounds.east) return;
        }
        const v = s[element];
        rows.push({
          dataset: 'USGS soil geochemistry',
          lab_id: s.lab_id || '',
          field_id: s.field_id || '',
          state: s.state || '',
          latitude: s.latitude,
          longitude: s.longitude,
          element: elMeta ? elMeta.label : element,
          element_code: element,
          value: v,
          unit: elMeta ? elMeta.unit : '',
          project_name: s.project_name || '',
        });
      });
    });
    return rows;
  };

  global.GeochemSoilOverlay = GeochemSoilOverlay;
})(window);
