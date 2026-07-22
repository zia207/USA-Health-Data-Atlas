/**
 * EPA AirData AQS active monitors overlay (PM2.5, PM10, Ozone, NO2, SO2).
 * Mapping approaches mirror the USGS soil overlay; values are annual Arithmetic Means (2022–2025).
 * Requires: Leaflet map, window.AIR_QUALITY_AQS
 * Source: https://epa.maps.arcgis.com/apps/webappviewer/index.html?id=5f239fd3e72f424f98ef3d5def547eb5
 */
(function (global) {
  const POLL_COLORS = {
    PM25: '#e11d48',
    PM10: '#f59e0b',
    O3: '#2563eb',
    NO2: '#7c3aed',
    SO2: '#0d9488',
  };
  const LABELS = {
    PM25: 'PM2.5',
    PM10: 'PM10',
    O3: 'Ozone',
    NO2: 'NO₂',
    SO2: 'SO₂',
  };
  const DEFAULT_RAMP = ['#1a9850', '#91cf60', '#fee08b', '#fc8d59', '#d73027'];
  const NO_DATA = '#94a3b8';
  const N_CLASSES = 5;
  const YEARS = [2022, 2023, 2024, 2025];

  function exportStyle() {
    return (global.AtlasOverlayExportStyle && global.AtlasOverlayExportStyle.air) || {};
  }

  function activeRamp() {
    const pal = exportStyle().palette;
    if (pal && pal !== 'default' && global.MapStyleControls) {
      return MapStyleControls.getColors(pal);
    }
    return DEFAULT_RAMP.slice();
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

  function $(id) { return document.getElementById(id); }

  function shortUnit(u) {
    if (!u) return '';
    if (/micrograms/i.test(u)) return 'µg/m³';
    if (/Parts per million/i.test(u)) return 'ppm';
    if (/Parts per billion/i.test(u)) return 'ppb';
    return u;
  }

  function fmtMean(v, pollutant) {
    if (v == null || Number.isNaN(v)) return '—';
    if (pollutant === 'O3') return Number(v).toFixed(3);
    if (v >= 100) return Number(v).toFixed(0);
    if (v >= 10) return Number(v).toFixed(1);
    return Number(v).toFixed(2);
  }

  function meanFor(site, year) {
    const m = site.means || {};
    const v = m[String(year)];
    return v == null ? null : Number(v);
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
    for (let i = 1; i < breaks.length; i++) {
      if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] + 1e-9;
    }
    return breaks;
  }

  function classIndex(breaks, v) {
    if (!Number.isFinite(v)) return -1;
    for (let i = 0; i < breaks.length - 1; i++) {
      if (v <= breaks[i + 1] || i === breaks.length - 2) return i;
    }
    return breaks.length - 2;
  }

  function colorForClass(idx) {
    if (idx < 0) return NO_DATA;
    const ramp = activeRamp();
    return ramp[Math.min(ramp.length - 1, idx)];
  }

  function fmtBreak(v, pollutant) {
    return fmtMean(v, pollutant);
  }

  function legendRamp(title, breaks, subtitle, pollutant) {
    const rampColors = activeRamp();
    const ramp = rampColors.map((c) => `<span style="background:${c}"></span>`).join('');
    const items = rampColors.map((c, i) => {
      const lo = fmtBreak(breaks[i], pollutant);
      const hi = fmtBreak(breaks[i + 1], pollutant);
      return `<div class="aq-legend-item"><span class="aq-swatch-lg" style="background:${c}"></span>`
        + `<span>${lo} – ${hi}</span></div>`;
    }).join('');
    return `<strong>${title}</strong>
      <div class="aq-ramp">${ramp}</div>
      <div class="aq-legend-ends"><span>Low</span><span>High</span></div>
      <div class="aq-legend-items">${items}</div>
      ${subtitle ? `<div class="aq-note">${subtitle}</div>` : ''}`;
  }

  function circleIcon(color, size, labelText) {
    const s = Math.max(8, Math.min(18, size || pointSize()));
    const label = labelText
      ? `<span class="aq-marker-label">${labelText}</span>`
      : '';
    return L.divIcon({
      className: '',
      html: `<div style="display:flex;align-items:center">`
        + `<div style="width:${s}px;height:${s}px;border-radius:50%;background:${color};flex-shrink:0"></div>`
        + label
        + `</div>`,
      iconSize: [s + (labelText ? 36 : 0), s],
      iconAnchor: [s / 2, s / 2],
    });
  }

  function countIcon(n, color) {
    const size = Math.max(22, Math.min(40, 16 + Math.sqrt(n) * 5));
    const label = n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n));
    return L.divIcon({
      className: '',
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};color:#fff;border:none;display:flex;align-items:center;justify-content:center;font:650 10px ui-monospace,Consolas,monospace">${label}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function buildGrid(sites, year, cellDeg) {
    const cells = {};
    sites.forEach((s) => {
      const v = meanFor(s, year);
      if (v == null) return;
      const i = Math.floor(s.lat / cellDeg);
      const j = Math.floor(s.lon / cellDeg);
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

  function buildStateMeans(sites, year) {
    const by = {};
    sites.forEach((s) => {
      const v = meanFor(s, year);
      if (v == null || !s.st) return;
      (by[s.st] ||= { sum: 0, n: 0, lat: 0, lon: 0 }).sum += v;
      by[s.st].n += 1;
      by[s.st].lat += s.lat;
      by[s.st].lon += s.lon;
    });
    return Object.keys(by).sort().map((st) => ({
      state: st,
      avg_val: by[st].sum / by[st].n,
      n: by[st].n,
      lat: by[st].lat / by[st].n,
      lon: by[st].lon / by[st].n,
    }));
  }

  /** Value-weighted heat as translucent circles (same approach as soil overlay). */
  function addHeatLayers(layer, sites, year, breaks) {
    sites.forEach((s) => {
      const v = meanFor(s, year);
      if (v == null) return;
      const idx = classIndex(breaks, v);
      const t = (idx + 1) / N_CLASSES;
      const radius = 8 + t * 22;
      const color = colorForClass(idx);
      L.circleMarker([s.lat, s.lon], {
        radius,
        color,
        fillColor: color,
        fillOpacity: 0.18 + t * 0.35,
        opacity: 0.15,
        weight: 0,
      }).addTo(layer);
    });
  }

  function injectStyles() {
    if (document.getElementById('aq-overlay-styles')) return;
    const style = document.createElement('style');
    style.id = 'aq-overlay-styles';
    style.textContent = `
      .aq-panel { margin-top: 16px; padding-top: 12px; border-top: 1px dashed var(--hair, #c5d0d6); }
      .aq-panel h2 {
        margin-top: 0; font-size: 15px; letter-spacing: .08em; line-height: 1.3;
      }
      .aq-check { display: flex; gap: 8px; align-items: center; font-size: 13px; margin-bottom: 8px; cursor: pointer; }
      .aq-poll-grid { display: flex; flex-direction: column; gap: 5px; margin: 6px 0 10px; font-size: 13px; }
      .aq-poll-grid label { display: flex; gap: 8px; align-items: center; cursor: pointer; }
      .aq-swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
      .aq-swatch-lg { width: 12px; height: 12px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
      .aq-dossier {
        position: fixed; top: 0; right: 0; width: min(440px, 100vw); height: 100vh;
        background: #fff; border-left: 1px solid #c5d0d6; z-index: 5200;
        box-shadow: -8px 0 28px rgba(15,23,42,.18); transform: translateX(105%);
        transition: transform .22s ease; display: flex; flex-direction: column;
      }
      .aq-dossier.open { transform: translateX(0); }
      .aq-dossier-head {
        padding: 14px 16px 12px; background: linear-gradient(90deg,#0c4a6e,#0369a1);
        color: #e0f2fe; flex: 0 0 auto;
      }
      .aq-dossier-head .tag {
        font-family: ui-monospace, Consolas, monospace; font-size: 10px;
        letter-spacing: .12em; text-transform: uppercase; color: #7dd3fc;
      }
      .aq-dossier-head h3 { margin: 6px 0 0; font-size: 18px; line-height: 1.25; }
      .aq-dossier-close {
        float: right; background: transparent; border: 1px solid rgba(255,255,255,.35);
        color: #e0f2fe; padding: 4px 10px; cursor: pointer; font-size: 12px;
      }
      .aq-dossier-body { padding: 14px 16px 28px; overflow: auto; flex: 1; font-size: 13.5px; color: #0b1f2a; }
      .aq-meta { display: grid; gap: 8px; margin: 12px 0 14px; }
      .aq-meta div { display: grid; grid-template-columns: 120px 1fr; gap: 8px; }
      .aq-meta .k {
        font-family: ui-monospace, Consolas, monospace; font-size: 10px;
        letter-spacing: .08em; text-transform: uppercase; color: #5a6e78; padding-top: 2px;
      }
      .aq-note { font-size: 11.5px; color: #5a6e78; line-height: 1.45; margin-top: 10px; }
      .aq-links a { display: inline-block; margin: 3px 8px 3px 0; }
      .aq-legend-row { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 3px 0; }
      .aq-status { font-size: 12px; color: #5a6e78; margin-top: 8px; min-height: 1.2em; }
      .aq-status.ok { color: #2f7d4e; }
      .aq-status.err { color: #b7431c; }
      .aq-map-legend {
        background: rgba(255,255,255,.96); border: 1px solid #c5d0d6; padding: 10px 12px;
        font-size: 12px; line-height: 1.4; min-width: 160px; max-width: 260px;
        box-shadow: 0 2px 10px rgba(20,38,46,.18);
      }
      .aq-map-legend strong {
        display: block; font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
        color: #5a6e78; font-family: ui-monospace, Consolas, monospace; margin-bottom: 6px;
      }
      .aq-ramp { display: flex; height: 12px; border: 1px solid #c5d0d6; margin: 4px 0; overflow: hidden; }
      .aq-ramp span { flex: 1; }
      .aq-legend-ends {
        display: flex; justify-content: space-between; font-size: 10px; color: #5a6e78;
        margin-bottom: 8px; font-family: ui-monospace, Consolas, monospace;
      }
      .aq-legend-items { display: flex; flex-direction: column; gap: 4px; }
      .aq-legend-item { display: flex; align-items: center; gap: 8px; font-size: 12px; }
      .aq-means-table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 8px 0 12px; }
      .aq-means-table th, .aq-means-table td {
        border-bottom: 1px solid #e2e8f0; padding: 6px 4px; text-align: left;
      }
      .aq-means-table th {
        font-family: ui-monospace, Consolas, monospace; font-size: 10px;
        letter-spacing: .08em; text-transform: uppercase; color: #5a6e78;
      }
      .aq-marker-label {
        background: transparent; border: none; box-shadow: none;
        font: 600 10px/1 ui-monospace, Consolas, monospace; color: #0f172a;
        text-shadow: 0 0 3px #fff, 0 0 3px #fff, 0 1px 2px #fff;
        margin-left: 6px; white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureDossier() {
    let el = document.getElementById('aq-dossier');
    if (el) return el;
    el = document.createElement('aside');
    el.id = 'aq-dossier';
    el.className = 'aq-dossier';
    el.innerHTML = `
      <div class="aq-dossier-head">
        <button type="button" class="aq-dossier-close" id="aq-dossier-close">Close</button>
        <div class="tag" id="aq-dossier-tag">EPA AIRDATA · AQS</div>
        <h3 id="aq-dossier-title">Monitor</h3>
      </div>
      <div class="aq-dossier-body" id="aq-dossier-body"></div>
    `;
    document.body.appendChild(el);
    el.querySelector('#aq-dossier-close').addEventListener('click', () => el.classList.remove('open'));
    return el;
  }

  function airDataAnnualUrl(siteId, paramName, year) {
    const pol = encodeURIComponent(paramName || '');
    const site = encodeURIComponent(siteId || '');
    return `https://www3.epa.gov/cgi-bin/broker?_service=data&_program=dataprog.Annuals.sas&check=void&polname=${pol}&debug=0&year=${year}&site=${site}`;
  }

  function airDataDailyUrl(siteId, paramName, year) {
    const pol = encodeURIComponent(paramName || '');
    const site = encodeURIComponent(siteId || '');
    return `https://www3.epa.gov/cgi-bin/broker?_service=data&_program=dataprog.Daily.sas&check=void&polname=${pol}&debug=0&year=${year}&site=${site}`;
  }

  function openDossier(site) {
    const el = ensureDossier();
    const label = LABELS[site.p] || site.p;
    const unit = shortUnit(site.unit);
    $('aq-dossier-tag').textContent = `EPA AIRDATA · ${label} · ACTIVE`;
    $('aq-dossier-title').textContent = site.n || site.id || 'Monitor';
    const years = site.yrs || [];
    const means = site.means || {};
    const meanRows = YEARS.map((y) => {
      const v = means[String(y)];
      const cell = v == null ? '—' : `${fmtMean(v, site.p)}${unit ? ` ${unit}` : ''}`;
      return `<tr><td>${y}</td><td>${cell}</td></tr>`;
    }).join('');
    const annual = years.map((y) =>
      `<a href="${airDataAnnualUrl(site.id, site.param, y)}" target="_blank" rel="noopener">${y} annual</a>`
    ).join(' ');
    const daily = years.map((y) =>
      `<a href="${airDataDailyUrl(site.id, site.param, y)}" target="_blank" rel="noopener">${y} daily</a>`
    ).join(' ');
    $('aq-dossier-body').innerHTML = `
      <div class="aq-meta">
        <div><span class="k">Pollutant</span><span>${label} (${site.param || '—'})</span></div>
        <div><span class="k">AQS site ID</span><span>${site.id || '—'}${site.poc != null ? ` · POC ${site.poc}` : ''}</span></div>
        <div><span class="k">Location</span><span>${[site.city, site.st].filter(Boolean).join(', ') || '—'}</span></div>
        <div><span class="k">CBSA</span><span>${site.cbsa || '—'}</span></div>
        <div><span class="k">Address</span><span>${site.addr || '—'}</span></div>
        <div><span class="k">Coordinates</span><span>${site.lat}, ${site.lon}</span></div>
        <div><span class="k">Elevation</span><span>${site.elev != null ? `${site.elev} m` : '—'}</span></div>
        <div><span class="k">Start / last</span><span>${site.start || '—'} → ${site.last || '—'}</span></div>
        <div><span class="k">Scale</span><span>${site.scale || '—'}</span></div>
        <div><span class="k">Duration</span><span>${site.dur || '—'}</span></div>
        <div><span class="k">FRM/FEM</span><span>${site.frm || '—'}</span></div>
        <div><span class="k">Monitor type</span><span>${site.type || '—'}</span></div>
        <div><span class="k">Agency</span><span>${site.agency || '—'}</span></div>
        <div><span class="k">NAAQS metric</span><span>${site.std || '—'} · Arithmetic Mean</span></div>
      </div>
      <strong>Annual means (2022–2025)</strong>
      <table class="aq-means-table"><thead><tr><th>Year</th><th>Mean</th></tr></thead>
      <tbody>${meanRows}</tbody></table>
      <strong>Download AirData summaries</strong>
      <div class="aq-links" style="margin-top:6px">${annual || '—'}</div>
      <div class="aq-links" style="margin-top:4px">${daily || ''}</div>
      <p class="aq-note">
        Active AQS monitors from
        <a href="https://epa.maps.arcgis.com/apps/webappviewer/index.html?id=5f239fd3e72f424f98ef3d5def547eb5" target="_blank" rel="noopener">EPA AirData Interactive Map</a>
        · annual means from
        <a href="https://aqs.epa.gov/aqsweb/airdata/download_files.html" target="_blank" rel="noopener">AirData annual concentration files</a>.
      </p>
    `;
    el.classList.add('open');
  }

  function defaultYear(data) {
    const matched = (data.meta && data.meta.means_matched) || {};
    let best = 2024;
    let n = -1;
    YEARS.forEach((y) => {
      const c = matched[y] || matched[String(y)] || 0;
      if (c >= n) { n = c; best = y; }
    });
    return best;
  }

  function createControlsHtml(data) {
    const polls = (data.meta && data.meta.pollutants) || [];
    const states = [...new Set((data.sites || []).map((s) => s.st).filter(Boolean))].sort();
    const yr0 = defaultYear(data);
    const checks = polls.map((p) =>
      `<label><span class="aq-swatch" style="background:${p.color || POLL_COLORS[p.code]}"></span>`
      + `<input type="checkbox" class="aq-poll" value="${p.code}" ${p.code === 'PM25' ? 'checked' : ''}> ${p.label}`
      + ` <span style="color:#5a6e78">(${(p.n || 0).toLocaleString()})</span></label>`
    ).join('');
    return `
      <div class="aq-panel" id="aq-controls">
        <h2>Air quality (AQS)</h2>
        <label class="aq-check"><input type="checkbox" id="aq-enabled"> Show air quality monitors</label>
        <div class="field">
          <label>Pollutants (active · annual means 2022–2025)</label>
          <div class="aq-poll-grid">${checks}</div>
        </div>
        <div class="field">
          <label for="aq-style">Mapping approach</label>
          <select id="aq-style">
            ${MAP_STYLES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="aq-year">Annual mean year</label>
          <select id="aq-year">
            ${YEARS.map((y) => `<option value="${y}" ${y === yr0 ? 'selected' : ''}>${y}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="aq-state">State focus</label>
          <select id="aq-state">
            <option value="ALL">All states (USA)</option>
            ${states.map((s) => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
        <div class="field" id="aq-grid-field">
          <label for="aq-grid">Grid cell size (degrees)</label>
          <select id="aq-grid">
            <option value="0.25">0.25°</option>
            <option value="0.5" selected>0.5°</option>
            <option value="1">1.0°</option>
          </select>
        </div>
        <label class="aq-check" id="aq-labels-wrap">
          <input type="checkbox" id="aq-labels" checked> Label markers with concentration
        </label>
        <div class="btnrow">
          <button class="btn" type="button" id="aq-apply">Apply air quality</button>
        </div>
        <div id="aq-legend" class="note" style="margin-top:10px"></div>
        <div class="aq-status" id="aq-status"></div>
        <p class="note">
          Pick a <strong>pollutant</strong> and a <strong>mapping approach</strong> (same options as soil geochemistry).
          Colors use annual Arithmetic Mean from AirData ·
          <a href="https://epa.maps.arcgis.com/apps/webappviewer/index.html?id=5f239fd3e72f424f98ef3d5def547eb5" target="_blank" rel="noopener">EPA AirData map</a>.
        </p>
      </div>
    `;
  }

  function syncStyleFields() {
    const style = $('aq-style') ? $('aq-style').value : 'points-equal';
    const gf = $('aq-grid-field');
    if (gf) gf.style.display = style === 'grid-mean' ? '' : 'none';
    const lw = $('aq-labels-wrap');
    if (lw) {
      const showLabels = style === 'points-equal' || style === 'points-quantile' || style === 'graduated';
      lw.style.display = showLabels ? '' : 'none';
    }
  }

  function AirQualityOverlay(options) {
    this.map = options.map;
    this.mount = typeof options.mount === 'string' ? $(options.mount) : options.mount;
    this.getPageState = options.getPageState || (() => 'ALL');
    this.layer = null;
    this.mapLegendCtrl = null;
    this.data = global.AIR_QUALITY_AQS || { meta: {}, sites: [] };
    injectStyles();
    ensureDossier();
    if (this.mount && !document.getElementById('aq-controls')) {
      this.mount.insertAdjacentHTML('beforeend', createControlsHtml(this.data));
    }
    const apply = () => this.refresh();
    $('aq-apply') && $('aq-apply').addEventListener('click', apply);
    $('aq-enabled') && $('aq-enabled').addEventListener('change', apply);
    $('aq-year') && $('aq-year').addEventListener('change', apply);
    $('aq-labels') && $('aq-labels').addEventListener('change', apply);
    $('aq-style') && $('aq-style').addEventListener('change', () => {
      syncStyleFields();
      apply();
    });
    syncStyleFields();
  }

  AirQualityOverlay.prototype.setStatus = function (msg, cls) {
    const el = $('aq-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'aq-status' + (cls ? ' ' + cls : '');
  };

  AirQualityOverlay.prototype.setMapLegend = function (html) {
    if (this.mapLegendCtrl) {
      this.map.removeControl(this.mapLegendCtrl);
      this.mapLegendCtrl = null;
    }
    const side = $('aq-legend');
    if (side) side.innerHTML = html || '';
    if (!html || !this.map) return;
    const ctrl = L.control({ position: 'topright' });
    ctrl.onAdd = function () {
      const div = L.DomUtil.create('div', 'aq-map-legend');
      div.innerHTML = html;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    ctrl.addTo(this.map);
    this.mapLegendCtrl = ctrl;
  };

  AirQualityOverlay.prototype.selectedPollutants = function () {
    return [...document.querySelectorAll('.aq-poll:checked')].map((el) => el.value);
  };

  AirQualityOverlay.prototype.selectedYear = function () {
    const el = $('aq-year');
    return el ? Number(el.value) : defaultYear(this.data);
  };

  AirQualityOverlay.prototype.selectedStyle = function () {
    return $('aq-style') ? $('aq-style').value : 'points-equal';
  };

  AirQualityOverlay.prototype.filtered = function (pollutantFilter) {
    if (!$('aq-enabled') || !$('aq-enabled').checked) return [];
    const polls = new Set(pollutantFilter || this.selectedPollutants());
    if (!polls.size) return [];
    let st = $('aq-state') ? $('aq-state').value : 'ALL';
    const pageState = this.getPageState();
    const abbrMap = STATE_ABBR_TO_NAME;
    let stateName = null;
    if (st !== 'ALL') stateName = st;
    else if (pageState && pageState !== 'ALL' && abbrMap[pageState]) stateName = abbrMap[pageState];

    return (this.data.sites || []).filter((s) => {
      if (!polls.has(s.p)) return false;
      if (stateName && s.st !== stateName) return false;
      return true;
    });
  };

  AirQualityOverlay.prototype.clear = function () {
    if (this.layer && this.map) {
      this.map.removeLayer(this.layer);
    }
    this.layer = null;
  };

  AirQualityOverlay.prototype.refresh = function () {
    this.clear();
    if (!$('aq-enabled') || !$('aq-enabled').checked) {
      this.setStatus('Air quality layer off.');
      this.setMapLegend('');
      return;
    }

    const polls = this.selectedPollutants();
    if (!polls.length) {
      this.setStatus('Select at least one pollutant.', 'err');
      this.setMapLegend('');
      return;
    }

    const style = this.selectedStyle();
    const year = this.selectedYear();
    const styleName = (MAP_STYLES.find((x) => x.id === style) || {}).label || style;
    const singleOnly = style === 'grid-mean' || style === 'heatmap-weight' || style === 'state-mean';
    const activePolls = singleOnly ? [polls[0]] : polls;
    if (singleOnly && polls.length > 1) {
      // keep first checked; note in status later
    }

    const rows = this.filtered(activePolls);
    if (!rows.length) {
      this.setStatus('No monitors for the selected pollutants / state.', 'err');
      this.setMapLegend('');
      return;
    }

    if (!this.map) {
      this.setStatus('Map not ready.', 'err');
      this.setMapLegend('');
      return;
    }
    this.layer = L.layerGroup().addTo(this.map);
    const p0 = activePolls[0];
    const unit = shortUnit(
      (rows.find((s) => s.unit) || {}).unit
      || ((this.data.meta && this.data.meta.standards) || {})[p0]?.unit
      || ''
    );
    const std = ((this.data.meta && this.data.meta.standards) || {})[p0]?.standard || '';
    const withVals = rows.filter((s) => meanFor(s, year) != null);
    const vals = withVals.map((s) => meanFor(s, year)).sort((a, b) => a - b);

    // ---- State mean ----
    if (style === 'state-mean') {
      if (!vals.length) {
        this.setStatus(`No ${year} annual means for ${LABELS[p0] || p0}.`, 'err');
        this.setMapLegend('');
        return;
      }
      const stateRows = buildStateMeans(rows, year);
      const svals = stateRows.map((r) => r.avg_val).sort((a, b) => a - b);
      const breaks = equalBreaks(svals, N_CLASSES);
      stateRows.forEach((r) => {
        const idx = classIndex(breaks, r.avg_val);
        const m = L.marker([r.lat, r.lon], {
          icon: countIcon(r.n, colorForClass(idx)),
          title: `${r.state}: mean ${fmtMean(r.avg_val, p0)}`,
        });
        m.bindTooltip(
          `<b>${r.state}</b><br>Mean ${LABELS[p0] || p0} (${year}): <b>${fmtMean(r.avg_val, p0)}${unit ? ` ${unit}` : ''}</b><br>n = ${r.n.toLocaleString()} monitors`,
          { sticky: true }
        );
        m.on('click', () => {
          if ($('aq-state')) $('aq-state').value = r.state;
          if ($('aq-style')) $('aq-style').value = 'points-equal';
          syncStyleFields();
          this.refresh();
        });
        m.addTo(this.layer);
      });
      const extra = polls.length > 1 ? ` · using ${LABELS[p0]} only` : '';
      this.setStatus(`State means for ${LABELS[p0]} (${year}) — ${stateRows.length} state(s)${extra}.`, 'ok');
      this.setMapLegend(legendRamp(
        `${LABELS[p0]} — state mean (${year})`,
        breaks,
        `${unit}${std ? ` · ${std}` : ''} · marker size ≈ monitor count. Click a state for points.`,
        p0
      ));
      return;
    }

    // ---- Grid mean ----
    if (style === 'grid-mean') {
      if (!vals.length) {
        this.setStatus(`No ${year} annual means for ${LABELS[p0] || p0}.`, 'err');
        this.setMapLegend('');
        return;
      }
      const cell = Number(($('aq-grid') && $('aq-grid').value) || 0.5);
      const grid = buildGrid(rows, year, cell);
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
          `<b>Grid cell</b><br>Mean ${LABELS[p0]} (${year}): <b>${fmtMean(g.mean, p0)}${unit ? ` ${unit}` : ''}</b><br>n = ${g.n}`,
          { sticky: true }
        );
        rect.addTo(this.layer);
      });
      const extra = polls.length > 1 ? ` · using ${LABELS[p0]} only` : '';
      this.setStatus(`Grid mean map — ${grid.length} cells · ${withVals.length.toLocaleString()} monitors (${year})${extra}.`, 'ok');
      this.setMapLegend(legendRamp(
        `${LABELS[p0]} — grid mean (${cell}°)`,
        gbreaks,
        `${year} · ${unit}${std ? ` · ${std}` : ''}`,
        p0
      ));
      return;
    }

    // ---- Heat density ----
    if (style === 'heatmap-weight') {
      if (!vals.length) {
        this.setStatus(`No ${year} annual means for ${LABELS[p0] || p0}.`, 'err');
        this.setMapLegend('');
        return;
      }
      const breaks = equalBreaks(vals, N_CLASSES);
      addHeatLayers(this.layer, rows, year, breaks);
      const extra = polls.length > 1 ? ` · using ${LABELS[p0]} only` : '';
      this.setStatus(`Value-weighted heat — ${withVals.length.toLocaleString()} monitors · ${LABELS[p0]} (${year})${extra}.`, 'ok');
      this.setMapLegend(legendRamp(
        `${LABELS[p0]} — heat weight (${year})`,
        breaks,
        `${unit} · larger / darker blobs = higher concentration`,
        p0
      ));
      return;
    }

    // ---- Point styles (equal / quantile / graduated); multi-pollutant OK ----
    const showLabels = $('aq-labels') ? $('aq-labels').checked : true;
    const breaksByP = {};
    activePolls.forEach((p) => {
      const pvals = rows.filter((s) => s.p === p).map((s) => meanFor(s, year)).filter((v) => v != null).sort((a, b) => a - b);
      breaksByP[p] = style === 'points-quantile'
        ? quantileBreaks(pvals, N_CLASSES)
        : equalBreaks(pvals.length ? pvals : [0, 1], N_CLASSES);
    });

    let withMean = 0;
    rows.forEach((s) => {
      const v = meanFor(s, year);
      if (v != null) withMean += 1;
      const breaks = breaksByP[s.p] || [0, 1];
      const idx = v == null ? -1 : classIndex(breaks, v);
      const color = colorForClass(idx);
      const base = pointSize();
      let size = base;
      if (style === 'graduated' && v != null) {
        const lo = breaks[0];
        const hi = breaks[breaks.length - 1];
        const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
        size = Math.max(8, Math.min(18, base - 2 + t * 6));
      }
      const u = shortUnit(s.unit || unit);
      const labelText = showLabels && v != null ? fmtMean(v, s.p) : '';
      const m = L.marker([s.lat, s.lon], {
        icon: circleIcon(color, size, labelText),
        title: `${LABELS[s.p] || s.p}: ${s.n}${v != null ? ` · ${fmtMean(v, s.p)} ${u}` : ''}`,
      });
      const meanLine = v != null
        ? `<b>${year} mean:</b> ${fmtMean(v, s.p)}${u ? ` ${u}` : ''}`
        : `<b>${year} mean:</b> no data`;
      m.bindTooltip(
        `<b>${s.n}</b><br>${LABELS[s.p] || s.p} · ${s.st || ''}<br>${meanLine}<br>AQS ${s.id || '—'}`,
        { sticky: true }
      );
      m.on('click', () => openDossier(s));
      m.addTo(this.layer);
    });

    // Legend: one ramp if single pollutant, else one ramp per pollutant
    const classLabel = style === 'points-quantile' ? 'quantile' : 'equal interval';
    let legendHtml;
    if (activePolls.length === 1) {
      legendHtml = legendRamp(
        `${LABELS[p0]} · ${year}`,
        breaksByP[p0],
        `${classLabel}${style === 'graduated' ? ' · size scales with value' : ''} · ${unit}${std ? ` · ${std}` : ''}`,
        p0
      );
    } else {
      legendHtml = `<strong>${styleName} · ${year}</strong>`
        + activePolls.map((p) => {
          const pu = shortUnit(((this.data.meta.standards || {})[p] || {}).unit || '');
          return `<div style="margin-top:8px">${legendRamp(
            LABELS[p] || p,
            breaksByP[p],
            pu,
            p
          )}</div>`;
        }).join('');
    }

    this.setMapLegend(legendHtml);
    this.setStatus(
      `${styleName} · ${rows.length.toLocaleString()} monitor(s) · ${withMean.toLocaleString()} with ${year} mean.`,
      withMean ? 'ok' : 'err'
    );
  };

  const STATE_ABBR_TO_NAME = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District Of Columbia',
    FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
    PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
    TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
    WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
  };

  AirQualityOverlay.prototype.getCsvRows = function (bounds) {
    if (!$('aq-enabled') || !$('aq-enabled').checked) return [];
    const year = this.selectedYear ? this.selectedYear() : 2024;
    return this.filtered().filter((s) => {
      if (!bounds) return true;
      return s.lat >= bounds.south && s.lat <= bounds.north
        && s.lon >= bounds.west && s.lon <= bounds.east;
    }).map((s) => {
      const means = s.means || {};
      return {
        dataset: 'EPA Air Quality AQS',
        pollutant: LABELS[s.p] || s.p,
        pollutant_code: s.p,
        aqs_id: s.id || '',
        poc: s.poc,
        name: s.n || '',
        state: s.st || '',
        city: s.city || '',
        lat: s.lat,
        lon: s.lon,
        unit: s.unit || '',
        standard: s.std || '',
        mean_2022: means['2022'] != null ? means['2022'] : '',
        mean_2023: means['2023'] != null ? means['2023'] : '',
        mean_2024: means['2024'] != null ? means['2024'] : '',
        mean_2025: means['2025'] != null ? means['2025'] : '',
        selected_year: year,
        selected_mean: means[String(year)] != null ? means[String(year)] : '',
      };
    });
  };

  global.AirQualityOverlay = AirQualityOverlay;
})(window);
