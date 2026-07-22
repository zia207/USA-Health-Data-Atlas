/**
 * Export map as PNG / PDF for USA-Health Data Atlas explorers.
 * UI patterned after dashboard.html “Export map” (basemap + layers + AOI + figure options).
 *
 * AOI options: Current map view · Full Cont. USA · State · User-defined bounding box
 */
(function (global) {
  const USA_BOUNDS = { west: -125, east: -66.5, south: 24.5, north: 49.5 };

  const BASEMAP_OPTIONS = [
    { value: 'current', label: 'Match current map view' },
    { value: 'esri', label: 'Satellite (Esri World Imagery)' },
    { value: 'gsat', label: 'Satellite (Google)' },
    { value: 'ghybrid', label: 'Satellite + labels (Google)' },
    { value: 'osm', label: 'OpenStreetMap (street)' },
    { value: 'topo', label: 'Topographic (Esri)' },
    { value: 'none', label: 'None (boundaries & markers only)' },
  ];

  const PNG_SIZES = [
    { value: '1280', label: 'Small — 1280 px wide' },
    { value: '1920', label: 'Medium — 1920 px wide' },
    { value: '2400', label: 'Large — 2400 px wide', selected: true },
    { value: '3600', label: 'Extra large — 3600 px wide' },
  ];

  const PDF_SIZES = [
    { value: 'small', label: 'Small — 5 × 3.2 in', w: 360, h: 230 },
    { value: 'medium', label: 'Medium — 6.5 × 4 in', w: 468, h: 288, selected: true },
    { value: 'large', label: 'Large — 7.5 × 4.6 in', w: 540, h: 331 },
  ];

  const US_STATES = [
    ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
    ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
    ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
    ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
    ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
    ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
    ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
    ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
    ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
    ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
    ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'],
    ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
    ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'], ['PR', 'Puerto Rico'],
  ];

  let cfg = null;
  let libsPromise = null;
  let bboxPreviewLayer = null;
  let bboxDrawActive = false;
  let bboxDrawStart = null;
  let bboxDrawRect = null;
  let bboxDrawHandlers = null;
  let stateBoundsCache = {};

  function $(sel, root) {
    if (typeof sel !== 'string') return sel;
    return (root || document).querySelector(sel);
  }

  function injectStyles() {
    if (document.getElementById('atlas-map-export-css')) return;
    const style = document.createElement('style');
    style.id = 'atlas-map-export-css';
    style.textContent = `
      .export-pdf-btn {
        background: #14707e; color: #fff; border: none; padding: 8px 12px;
        cursor: pointer; font-size: 13px; font-weight: 650;
      }
      .export-pdf-btn:hover { background: #0e5a66; }
      .export-pdf-btn:disabled { opacity: .55; cursor: wait; }
      .atlas-pdf-modal {
        position: fixed; inset: 0; z-index: 6000; display: none;
        align-items: center; justify-content: center; padding: 20px;
      }
      .atlas-pdf-modal.open { display: flex; }
      .atlas-pdf-backdrop { position: absolute; inset: 0; background: rgba(20,38,46,.55); }
      .atlas-pdf-panel {
        position: relative; background: #fff; border: 1px solid #c5d0d6;
        max-width: 560px; width: 100%; max-height: min(92vh, 900px);
        overflow: auto; padding: 18px 20px 16px; box-shadow: 0 12px 40px rgba(15,23,42,.28);
      }
      .atlas-pdf-panel h3 {
        font-size: 18px; margin: 0 0 14px; padding-bottom: 8px;
        border-bottom: 1px solid #c5d0d6; color: #0b1f2a;
      }
      .atlas-pdf-panel fieldset {
        border: 1px solid #c5d0d6; padding: 12px 14px 10px; margin: 0 0 12px;
      }
      .atlas-pdf-panel legend {
        font-family: ui-monospace, Consolas, monospace; font-size: 10.5px;
        letter-spacing: .1em; text-transform: uppercase; color: #5a6e78; padding: 0 6px;
      }
      .atlas-pdf-opt {
        display: flex; align-items: center; gap: 8px; margin: 6px 0;
        font-size: 14px; cursor: pointer; color: #0b1f2a;
      }
      .atlas-pdf-opt input { accent-color: #14707e; }
      .atlas-pdf-field { margin-top: 8px; }
      .atlas-pdf-field label {
        display: block; font-family: ui-monospace, Consolas, monospace;
        font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase;
        color: #5a6e78; margin-bottom: 4px;
      }
      .atlas-pdf-field select,
      .atlas-pdf-field input[type=text],
      .atlas-pdf-field input[type=number] {
        width: 100%; border: 1px solid #c5d0d6; background: #f7fafa;
        padding: 7px 9px; font-size: 13px; color: #0b1f2a; box-sizing: border-box;
      }
      .atlas-pdf-field select:disabled,
      .atlas-pdf-field input:disabled { opacity: .45; }
      .atlas-pdf-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin-top: 6px;
      }
      @media (max-width: 520px) { .atlas-pdf-grid { grid-template-columns: 1fr; } }
      .atlas-pdf-note { font-size: 12px; color: #5a6e78; line-height: 1.45; margin: 6px 0 0; }
      .atlas-pdf-sub { margin: 6px 0 0 26px; }
      .atlas-pdf-sub.dim { opacity: .45; pointer-events: none; }
      .atlas-pdf-actions {
        display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px;
        margin-top: 14px; padding-top: 12px; border-top: 1px solid #c5d0d6;
      }
      .atlas-pdf-cancel, .atlas-pdf-ghost {
        background: none; border: 1px dashed #5a6e78; color: #5a6e78;
        padding: 8px 14px; cursor: pointer; font-size: 13px;
      }
      .atlas-pdf-cancel:hover, .atlas-pdf-ghost:hover { color: #0b1f2a; border-color: #0b1f2a; }
      .atlas-pdf-ghost:disabled { opacity: .45; cursor: default; }
      .atlas-pdf-go {
        background: #14707e; color: #fff; border: none; padding: 8px 14px;
        cursor: pointer; font-size: 13px; font-weight: 650;
      }
      .atlas-pdf-go:hover { background: #0e5a66; }
      .atlas-pdf-go:disabled { opacity: .55; cursor: wait; }
      .atlas-pdf-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      .atlas-pdf-poll-grid {
        display: flex; flex-direction: column; gap: 4px; margin-top: 4px;
        max-height: 160px; overflow: auto; padding: 6px 8px;
        border: 1px solid #c5d0d6; background: #f7fafa;
      }
      .atlas-pdf-poll-grid label {
        display: flex; align-items: center; gap: 8px; margin: 0;
        font-family: inherit; font-size: 13px; letter-spacing: 0;
        text-transform: none; color: #0b1f2a; cursor: pointer;
      }
      .atlas-pdf-poll-grid input { accent-color: #14707e; }
      body.atlas-bbox-drawing #map { cursor: crosshair !important; }
      .atlas-bbox-banner {
        position: absolute; left: 50%; transform: translateX(-50%); bottom: 14px; z-index: 1100;
        background: rgba(20,38,46,.92); color: #e8eef1; padding: 8px 14px; font-size: 13px;
        pointer-events: none; white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  }

  function stateOptionsHtml() {
    return US_STATES.map(([abbr, name]) =>
      `<option value="${abbr}">${name} (${abbr})</option>`
    ).join('');
  }

  function sizeOptionsHtml(selected) {
    selected = selected || 12;
    let html = '';
    for (let i = 8; i <= 18; i++) {
      html += `<option value="${i}"${i === selected ? ' selected' : ''}>${i} px</option>`;
    }
    return html;
  }

  function paletteOptionsHtml(includeDefault) {
    const pals = (global.MAP_COLOR_PALETTES || (global.MapStyleControls && MapStyleControls.palettes) || []);
    let html = includeDefault ? '<option value="default">Dashboard default</option>' : '';
    pals.forEach((p) => {
      html += `<option value="${p.id}">${p.label}</option>`;
    });
    return html || '<option value="default">Dashboard default</option>';
  }

  function symbolBlock(id, title, extraHtml) {
    return `
      <div class="atlas-pdf-symbol-block" id="atlas-pdf-sym-${id}">
        <strong style="display:block;font-size:12px;margin:8px 0 4px;color:#0b1f2a">${title}</strong>
        <div class="atlas-pdf-grid">
          <div class="atlas-pdf-field">
            <label for="atlas-pdf-${id}-size">Symbol size</label>
            <select id="atlas-pdf-${id}-size">${sizeOptionsHtml(12)}</select>
          </div>
          <div class="atlas-pdf-field">
            <label for="atlas-pdf-${id}-palette">Color palette</label>
            <select id="atlas-pdf-${id}-palette">${paletteOptionsHtml(true)}</select>
          </div>
        </div>
        ${extraHtml || ''}
      </div>`;
  }

  function soilElementExtraHtml() {
    return `
      <div class="atlas-pdf-field">
        <label for="atlas-pdf-gc-element">Soil element</label>
        <select id="atlas-pdf-gc-element"></select>
        <p class="atlas-pdf-note">Used for PNG / PDF / CSV when soil is checked.</p>
      </div>`;
  }

  function airPollutantExtraHtml() {
    return `
      <div class="atlas-pdf-field">
        <label>Air pollutants</label>
        <div class="atlas-pdf-poll-grid" id="atlas-pdf-aq-polls"></div>
        <p class="atlas-pdf-note">Used for PNG / PDF / CSV when air quality is checked.</p>
      </div>`;
  }

  function soilElementsList() {
    const meta = global.GEOCHEM_SOIL_META;
    return (meta && meta.meta && meta.meta.elements) || [];
  }

  function airPollutantsList() {
    const data = global.AIR_QUALITY_AQS;
    return (data && data.meta && data.meta.pollutants) || [];
  }

  function fillVariableControls() {
    const elemSel = $('#atlas-pdf-gc-element');
    if (elemSel) {
      const elems = soilElementsList();
      const metals = elems.filter((e) => e.unit === 'ppm');
      const majors = elems.filter((e) => e.unit === '%');
      const curPage = document.getElementById('gc-element')?.value || 'As_ppm';
      const prev = elemSel.value || curPage;
      let html = '';
      if (metals.length) {
        html += '<optgroup label="Trace metals (ppm)">';
        metals.forEach((e) => {
          html += `<option value="${e.code}">${e.label}</option>`;
        });
        html += '</optgroup>';
      }
      if (majors.length) {
        html += '<optgroup label="Major elements (%)">';
        majors.forEach((e) => {
          html += `<option value="${e.code}">${e.label}</option>`;
        });
        html += '</optgroup>';
      }
      if (!html) html = '<option value="">(soil metadata not loaded)</option>';
      elemSel.innerHTML = html;
      if ([...elemSel.options].some((o) => o.value === prev)) elemSel.value = prev;
      else if ([...elemSel.options].some((o) => o.value === curPage)) elemSel.value = curPage;
    }

    const pollBox = $('#atlas-pdf-aq-polls');
    if (pollBox) {
      const polls = airPollutantsList();
      const pageChecked = new Set(
        [...document.querySelectorAll('.aq-poll:checked')].map((el) => el.value)
      );
      const existing = new Set(
        [...pollBox.querySelectorAll('input.atlas-pdf-aq-poll:checked')].map((el) => el.value)
      );
      const prefer = existing.size ? existing : pageChecked;
      if (!polls.length) {
        pollBox.innerHTML = '<span style="font-size:12px;color:#5a6e78">(air data not loaded)</span>';
      } else {
        pollBox.innerHTML = polls.map((p) => {
          const on = prefer.size ? prefer.has(p.code) : p.code === 'PM25';
          return `<label><input type="checkbox" class="atlas-pdf-aq-poll" value="${p.code}"${on ? ' checked' : ''}> ${p.label}</label>`;
        }).join('');
      }
    }
  }

  function ensureModal() {
    if (document.getElementById('atlas-pdf-modal')) return;
    injectStyles();
    const basemapHtml = BASEMAP_OPTIONS.map((o, i) =>
      `<label class="atlas-pdf-opt"><input type="radio" name="atlas-pdf-basemap" value="${o.value}"${i === 0 ? ' checked' : ''}> ${o.label}</label>`
    ).join('');
    const pngHtml = PNG_SIZES.map((o) =>
      `<option value="${o.value}"${o.selected ? ' selected' : ''}>${o.label}</option>`
    ).join('');
    const pdfHtml = PDF_SIZES.map((o) =>
      `<option value="${o.value}"${o.selected ? ' selected' : ''}>${o.label}</option>`
    ).join('');

    const wrap = document.createElement('div');
    wrap.id = 'atlas-pdf-modal';
    wrap.className = 'atlas-pdf-modal';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = `
      <div class="atlas-pdf-backdrop" id="atlas-pdf-backdrop"></div>
      <div class="atlas-pdf-panel" role="dialog" aria-modal="true" aria-labelledby="atlas-pdf-title">
        <h3 id="atlas-pdf-title">Export map</h3>

        <fieldset>
          <legend>Basemap</legend>
          ${basemapHtml}
        </fieldset>

        <fieldset>
          <legend>Datasets (current filters apply)</legend>
          <label class="atlas-pdf-opt"><input type="checkbox" id="atlas-pdf-choropleth" checked> Choropleth data layer</label>
          <label class="atlas-pdf-opt" id="atlas-pdf-sf-wrap"><input type="checkbox" id="atlas-pdf-sf"> Federal Superfund (NPL)</label>
          <label class="atlas-pdf-opt" id="atlas-pdf-gc-wrap"><input type="checkbox" id="atlas-pdf-gc"> USGS soil geochemistry</label>
          <label class="atlas-pdf-opt" id="atlas-pdf-aq-wrap"><input type="checkbox" id="atlas-pdf-aq"> Air quality (AQS) monitors</label>
          <p class="atlas-pdf-note">Unchecked layers are hidden for the export only, then restored.</p>
        </fieldset>

        <fieldset id="atlas-pdf-symbol-fieldset">
          <legend>Overlay symbols (PNG / PDF)</legend>
          <p class="atlas-pdf-note" style="margin-top:0">Applies while exporting; map restores afterward. Size range 8–18 px.</p>
          ${symbolBlock('sf', 'Superfund (NPL)')}
          ${symbolBlock('gc', 'Soil geochemistry', soilElementExtraHtml())}
          ${symbolBlock('aq', 'Air pollution (AQS)', airPollutantExtraHtml())}
        </fieldset>

        <fieldset>
          <legend>Legend &amp; chrome</legend>
          <label class="atlas-pdf-opt"><input type="checkbox" id="atlas-pdf-legend" checked> Include map legend</label>
          <label class="atlas-pdf-opt"><input type="checkbox" id="atlas-pdf-controls"> Include zoom / layer controls</label>
        </fieldset>

        <fieldset>
          <legend>Figure appearance</legend>
          <div class="atlas-pdf-field">
            <label for="atlas-pdf-fig-title">Figure title</label>
            <input type="text" id="atlas-pdf-fig-title" value="">
          </div>
          <div class="atlas-pdf-field">
            <label for="atlas-pdf-source">Data source</label>
            <input type="text" id="atlas-pdf-source" value="">
          </div>
          <div class="atlas-pdf-field">
            <label for="atlas-pdf-pdf-size">PDF figure size (on page)</label>
            <select id="atlas-pdf-pdf-size">${pdfHtml}</select>
          </div>
        </fieldset>

        <fieldset>
          <legend>Area of interest (AOI)</legend>
          <label class="atlas-pdf-opt"><input type="radio" name="atlas-pdf-extent" value="view" checked> Current map view (matches zoom &amp; pan on screen)</label>
          <label class="atlas-pdf-opt"><input type="radio" name="atlas-pdf-extent" value="usa"> Full Cont. USA</label>
          <label class="atlas-pdf-opt"><input type="radio" name="atlas-pdf-extent" value="state"> State</label>
          <div id="atlas-pdf-state-panel" class="atlas-pdf-sub dim">
            <div class="atlas-pdf-field">
              <label for="atlas-pdf-state">Select state</label>
              <select id="atlas-pdf-state" disabled>${stateOptionsHtml()}</select>
            </div>
          </div>
          <label class="atlas-pdf-opt"><input type="radio" name="atlas-pdf-extent" value="bbox"> User-defined bounding box</label>
          <div id="atlas-pdf-bbox-panel" class="atlas-pdf-sub dim">
            <div class="atlas-pdf-grid">
              <div class="atlas-pdf-field"><label for="atlas-pdf-bbox-west">West (lng)</label>
                <input type="number" id="atlas-pdf-bbox-west" step="0.0001" placeholder="-125" disabled></div>
              <div class="atlas-pdf-field"><label for="atlas-pdf-bbox-east">East (lng)</label>
                <input type="number" id="atlas-pdf-bbox-east" step="0.0001" placeholder="-66.5" disabled></div>
              <div class="atlas-pdf-field"><label for="atlas-pdf-bbox-south">South (lat)</label>
                <input type="number" id="atlas-pdf-bbox-south" step="0.0001" placeholder="24.5" disabled></div>
              <div class="atlas-pdf-field"><label for="atlas-pdf-bbox-north">North (lat)</label>
                <input type="number" id="atlas-pdf-bbox-north" step="0.0001" placeholder="49.5" disabled></div>
            </div>
            <div class="atlas-pdf-row">
              <button type="button" class="atlas-pdf-ghost" id="atlas-pdf-bbox-from-view" disabled>Use current map view</button>
              <button type="button" class="atlas-pdf-ghost" id="atlas-pdf-bbox-draw" disabled>Draw box on map</button>
              <button type="button" class="atlas-pdf-ghost" id="atlas-pdf-bbox-clear" disabled>Clear box</button>
            </div>
            <p id="atlas-pdf-bbox-status" class="atlas-pdf-note">Enter W/E/S/N in decimal degrees, fill from the map view, or draw a box on the map.</p>
          </div>
          <p class="atlas-pdf-note">
            <strong>Full Cont. USA</strong> and <strong>State</strong> zoom the figure to that extent.
            <strong>User-defined bounding box</strong> crops the PNG/PDF to your coordinates and outlines the box on the map preview.
          </p>
        </fieldset>

        <fieldset>
          <legend>PNG figure size</legend>
          <div class="atlas-pdf-field">
            <label for="atlas-pdf-png-size">Output size</label>
            <select id="atlas-pdf-png-size">${pngHtml}</select>
          </div>
          <p class="atlas-pdf-note">Height follows the map panel aspect ratio.</p>
        </fieldset>

        <div class="atlas-pdf-actions">
          <button type="button" class="atlas-pdf-cancel" id="atlas-pdf-cancel">Cancel</button>
          <button type="button" class="atlas-pdf-go" id="atlas-pdf-csv" style="background:#0e3a4f">Export CSV</button>
          <button type="button" class="atlas-pdf-go" id="atlas-pdf-png">Export PNG</button>
          <button type="button" class="atlas-pdf-go" id="atlas-pdf-pdf">Export PDF</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    $('#atlas-pdf-backdrop').addEventListener('click', closeModal);
    $('#atlas-pdf-cancel').addEventListener('click', closeModal);
    $('#atlas-pdf-png').addEventListener('click', () => runExport('png'));
    $('#atlas-pdf-pdf').addEventListener('click', () => runExport('pdf'));
    $('#atlas-pdf-csv').addEventListener('click', () => runCsvExport());
    document.querySelectorAll('input[name="atlas-pdf-extent"]').forEach((el) => {
      el.addEventListener('change', toggleAoiPanels);
    });
    ['atlas-pdf-sf', 'atlas-pdf-gc', 'atlas-pdf-aq'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', syncSymbolPanels);
    });
    $('#atlas-pdf-bbox-from-view').addEventListener('click', fillBboxFromMapView);
    $('#atlas-pdf-bbox-draw').addEventListener('click', startBboxDraw);
    $('#atlas-pdf-bbox-clear').addEventListener('click', clearCustomBbox);
    ['atlas-pdf-bbox-west', 'atlas-pdf-bbox-east', 'atlas-pdf-bbox-south', 'atlas-pdf-bbox-north'].forEach((id) => {
      $(`#${id}`).addEventListener('input', () => {
        updateBboxStatus();
        const n = normalizeBbox(readBboxFromForm());
        if (n) updateBboxPreview(n);
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (bboxDrawActive) { stopBboxDraw({ reopenModal: true }); return; }
        if ($('#atlas-pdf-modal')?.classList.contains('open')) closeModal();
      }
    });
    toggleAoiPanels();
  }

  function toggleAoiPanels() {
    const extent = document.querySelector('input[name="atlas-pdf-extent"]:checked')?.value || 'view';
    const statePanel = $('#atlas-pdf-state-panel');
    const bboxPanel = $('#atlas-pdf-bbox-panel');
    const stateSel = $('#atlas-pdf-state');
    const bboxOn = extent === 'bbox';
    const stateOn = extent === 'state';

    if (statePanel) statePanel.classList.toggle('dim', !stateOn);
    if (bboxPanel) bboxPanel.classList.toggle('dim', !bboxOn);
    if (stateSel) stateSel.disabled = !stateOn;

    ['atlas-pdf-bbox-west', 'atlas-pdf-bbox-east', 'atlas-pdf-bbox-south', 'atlas-pdf-bbox-north',
      'atlas-pdf-bbox-from-view', 'atlas-pdf-bbox-draw', 'atlas-pdf-bbox-clear'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = !bboxOn;
    });

    if (!bboxOn && bboxPreviewLayer && cfg?.map) {
      cfg.map.removeLayer(bboxPreviewLayer);
      bboxPreviewLayer = null;
    } else if (bboxOn) {
      const n = normalizeBbox(readBboxFromForm());
      if (n) updateBboxPreview(n);
    }
    updateBboxStatus();
  }

  /* ---- bounding box helpers ---- */
  function readBboxFromForm() {
    const west = parseFloat($('#atlas-pdf-bbox-west')?.value);
    const east = parseFloat($('#atlas-pdf-bbox-east')?.value);
    const south = parseFloat($('#atlas-pdf-bbox-south')?.value);
    const north = parseFloat($('#atlas-pdf-bbox-north')?.value);
    if ([west, east, south, north].some((v) => Number.isNaN(v))) return null;
    return { west, east, south, north };
  }

  function normalizeBbox(b) {
    if (!b) return null;
    const west = Math.min(b.west, b.east);
    const east = Math.max(b.west, b.east);
    const south = Math.min(b.south, b.north);
    const north = Math.max(b.south, b.north);
    if (!(east > west) || !(north > south)) return null;
    if (east - west < 0.0005 || north - south < 0.0005) return null;
    return { west, east, south, north };
  }

  function validateCustomBbox(b) {
    const n = normalizeBbox(b);
    if (!n) return { ok: false, message: 'Enter a valid bounding box (west < east, south < north, non-zero size).' };
    if (n.west < -180 || n.east > 180 || n.south < -90 || n.north > 90) {
      return { ok: false, message: 'Coordinates must be in decimal degrees (lng −180…180, lat −90…90).' };
    }
    return { ok: true, bbox: n };
  }

  function setBboxForm(b, opts = {}) {
    const n = normalizeBbox(b);
    if (!n) return;
    const fmt = (v) => (Math.round(v * 1e5) / 1e5).toFixed(5);
    $('#atlas-pdf-bbox-west').value = fmt(n.west);
    $('#atlas-pdf-bbox-east').value = fmt(n.east);
    $('#atlas-pdf-bbox-south').value = fmt(n.south);
    $('#atlas-pdf-bbox-north').value = fmt(n.north);
    updateBboxStatus();
    if (opts.preview !== false) updateBboxPreview(n);
    if (opts.selectRadio) {
      const r = document.querySelector('input[name="atlas-pdf-extent"][value="bbox"]');
      if (r) { r.checked = true; toggleAoiPanels(); }
    }
  }

  function updateBboxStatus() {
    const el = $('#atlas-pdf-bbox-status');
    if (!el) return;
    const v = validateCustomBbox(readBboxFromForm());
    if (!v.ok) {
      el.textContent = bboxDrawActive
        ? 'Click and drag on the map to draw a bounding box…'
        : 'Enter W/E/S/N in decimal degrees, fill from the map view, or draw a box on the map.';
      el.style.color = '#5a6e78';
      return;
    }
    const b = v.bbox;
    const wKm = Math.abs(b.east - b.west) * 111 * Math.cos(((b.north + b.south) / 2) * Math.PI / 180);
    const hKm = Math.abs(b.north - b.south) * 111;
    el.textContent = `AOI ready · ~${wKm.toFixed(0)} × ${hKm.toFixed(0)} km · export zooms to this box.`;
    el.style.color = '#2f7d4e';
  }

  function updateBboxPreview(b) {
    if (!cfg?.map) return;
    if (bboxPreviewLayer) { cfg.map.removeLayer(bboxPreviewLayer); bboxPreviewLayer = null; }
    const n = normalizeBbox(b);
    if (!n) return;
    bboxPreviewLayer = L.rectangle([[n.south, n.west], [n.north, n.east]], {
      color: '#B7431C', weight: 2, dashArray: '6 4', fillColor: '#B7431C', fillOpacity: 0.08,
      interactive: false,
    }).addTo(cfg.map);
  }

  function clearCustomBbox() {
    ['atlas-pdf-bbox-west', 'atlas-pdf-bbox-east', 'atlas-pdf-bbox-south', 'atlas-pdf-bbox-north'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    if (bboxPreviewLayer && cfg?.map) { cfg.map.removeLayer(bboxPreviewLayer); bboxPreviewLayer = null; }
    updateBboxStatus();
  }

  function fillBboxFromMapView() {
    if (!cfg?.map) return;
    const b = cfg.map.getBounds();
    setBboxForm({
      west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth(),
    }, { selectRadio: true, preview: true });
  }

  function stopBboxDraw(opts = {}) {
    bboxDrawActive = false;
    document.body.classList.remove('atlas-bbox-drawing');
    const banner = document.getElementById('atlas-bbox-banner');
    if (banner) banner.remove();
    if (bboxDrawHandlers && cfg?.map) {
      cfg.map.off('mousedown', bboxDrawHandlers.down);
      cfg.map.off('mousemove', bboxDrawHandlers.move);
      cfg.map.off('mouseup', bboxDrawHandlers.up);
      bboxDrawHandlers = null;
    }
    if (bboxDrawRect && cfg?.map) { cfg.map.removeLayer(bboxDrawRect); bboxDrawRect = null; }
    bboxDrawStart = null;
    if (cfg?.map) {
      cfg.map.dragging.enable();
      cfg.map.doubleClickZoom.enable();
      if (cfg.map.boxZoom) cfg.map.boxZoom.enable();
    }
    if (opts.reopenModal) openModal();
  }

  function startBboxDraw() {
    if (bboxDrawActive || !cfg?.map) return;
    closeModal();
    document.querySelector('input[name="atlas-pdf-extent"][value="bbox"]').checked = true;
    bboxDrawActive = true;
    document.body.classList.add('atlas-bbox-drawing');
    cfg.map.dragging.disable();
    cfg.map.doubleClickZoom.disable();
    if (cfg.map.boxZoom) cfg.map.boxZoom.disable();

    const mapEl = typeof cfg.mapEl === 'string' ? $(cfg.mapEl) : cfg.mapEl;
    const host = mapEl?.parentElement || document.body;
    let banner = document.getElementById('atlas-bbox-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'atlas-bbox-banner';
      banner.className = 'atlas-bbox-banner';
      host.appendChild(banner);
    }
    banner.textContent = 'Draw AOI: click and drag a box on the map · Esc to cancel';

    const finish = (bounds) => {
      if (!bounds) { stopBboxDraw({ reopenModal: true }); return; }
      setBboxForm({
        west: bounds.getWest(), east: bounds.getEast(),
        south: bounds.getSouth(), north: bounds.getNorth(),
      }, { selectRadio: true, preview: true });
      stopBboxDraw({ reopenModal: true });
    };

    const onDown = (e) => {
      if (!bboxDrawActive) return;
      L.DomEvent.preventDefault(e.originalEvent);
      bboxDrawStart = e.latlng;
      if (bboxDrawRect) { cfg.map.removeLayer(bboxDrawRect); bboxDrawRect = null; }
      bboxDrawRect = L.rectangle([bboxDrawStart, bboxDrawStart], {
        color: '#B7431C', weight: 2, dashArray: '4 3', fillColor: '#B7431C', fillOpacity: 0.12,
      }).addTo(cfg.map);
    };
    const onMove = (e) => {
      if (!bboxDrawActive || !bboxDrawStart || !bboxDrawRect) return;
      bboxDrawRect.setBounds(L.latLngBounds(bboxDrawStart, e.latlng));
    };
    const onUp = (e) => {
      if (!bboxDrawActive || !bboxDrawStart) return;
      const end = e.latlng || (bboxDrawRect && bboxDrawRect.getBounds().getNorthEast());
      if (!end) { finish(null); return; }
      const bounds = L.latLngBounds(bboxDrawStart, end);
      if (Math.abs(bounds.getWest() - bounds.getEast()) < 0.0003
          || Math.abs(bounds.getNorth() - bounds.getSouth()) < 0.0003) {
        alert('Bounding box is too small — drag a larger area.');
        if (bboxDrawRect) { cfg.map.removeLayer(bboxDrawRect); bboxDrawRect = null; }
        bboxDrawStart = null;
        return;
      }
      finish(bounds);
    };

    bboxDrawHandlers = { down: onDown, move: onMove, up: onUp };
    cfg.map.on('mousedown', onDown);
    cfg.map.on('mousemove', onMove);
    cfg.map.on('mouseup', onUp);
  }

  /* ---- state / USA bounds ---- */
  function getStateLeafletBounds(abbr) {
    if (!abbr) return null;
    if (stateBoundsCache[abbr]) return stateBoundsCache[abbr];
    const geo = global.STATE_GEO;
    if (geo && geo.features) {
      const f = geo.features.find((feat) => {
        const a = (feat.properties && (feat.properties.abbr || feat.properties.STUSPS)) || feat.id;
        return String(a).toUpperCase() === abbr.toUpperCase();
      });
      if (f) {
        const b = L.geoJSON(f).getBounds();
        if (b.isValid()) {
          stateBoundsCache[abbr] = b;
          return b;
        }
      }
    }
    return null;
  }

  function boundsFromBox(box) {
    return L.latLngBounds([box.south, box.west], [box.north, box.east]);
  }

  function resolveExportBounds(opts) {
    if (opts.extent === 'usa') return boundsFromBox(USA_BOUNDS);
    if (opts.extent === 'state') {
      const b = getStateLeafletBounds(opts.state);
      if (!b) throw new Error(`Could not resolve bounds for state ${opts.state || '(none)'}.`);
      return b;
    }
    if (opts.extent === 'bbox') {
      const v = validateCustomBbox(opts.bbox);
      if (!v.ok) throw new Error(v.message);
      return boundsFromBox(v.bbox);
    }
    return cfg.map.getBounds();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src === src)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  function ensureLibs() {
    if (libsPromise) return libsPromise;
    libsPromise = (async () => {
      if (!global.html2canvas) {
        await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
      }
      if (!global.jspdf) {
        await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js');
      }
      if (!global.html2canvas) throw new Error('html2canvas failed to load');
      if (!global.jspdf || !global.jspdf.jsPDF) throw new Error('jsPDF failed to load');
    })();
    return libsPromise;
  }

  function openModal() {
    if (!cfg) return;
    ensureModal();
    syncFormFromMap();
    toggleAoiPanels();
    const modal = $('#atlas-pdf-modal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    const modal = $('#atlas-pdf-modal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  function syncSymbolPanels() {
    const sfOn = $('#atlas-pdf-sf')?.checked;
    const gcOn = $('#atlas-pdf-gc')?.checked;
    const aqOn = $('#atlas-pdf-aq')?.checked;
    const sfBlock = $('#atlas-pdf-sym-sf');
    const gcBlock = $('#atlas-pdf-sym-gc');
    const aqBlock = $('#atlas-pdf-sym-aq');
    if (sfBlock) sfBlock.style.display = sfOn ? '' : 'none';
    if (gcBlock) gcBlock.style.display = gcOn ? '' : 'none';
    if (aqBlock) aqBlock.style.display = aqOn ? '' : 'none';
    const fieldset = $('#atlas-pdf-symbol-fieldset');
    if (fieldset) fieldset.style.display = (sfOn || gcOn || aqOn) ? '' : 'none';
  }

  function syncFormFromMap() {
    const title = (cfg.getTitle && cfg.getTitle()) || document.title || 'Map';
    const source = (cfg.getSource && cfg.getSource()) || '';
    $('#atlas-pdf-fig-title').value = title;
    $('#atlas-pdf-source').value = source;

    const ch = cfg.getChoroplethGroup ? cfg.getChoroplethGroup() : null;
    const chOn = ch && cfg.map && cfg.map.hasLayer(ch);
    $('#atlas-pdf-choropleth').checked = !!chOn;

    const showSf = cfg.overlays?.superfund !== false && document.getElementById('sf-enabled');
    const showGc = cfg.overlays?.soil !== false && document.getElementById('gc-enabled');
    const showAq = cfg.overlays?.air !== false && document.getElementById('aq-enabled');
    $('#atlas-pdf-sf-wrap').style.display = showSf ? '' : 'none';
    $('#atlas-pdf-gc-wrap').style.display = showGc ? '' : 'none';
    $('#atlas-pdf-aq-wrap').style.display = showAq ? '' : 'none';
    if (showSf) $('#atlas-pdf-sf').checked = !!document.getElementById('sf-enabled')?.checked;
    if (showGc) $('#atlas-pdf-gc').checked = !!document.getElementById('gc-enabled')?.checked;
    if (showAq) $('#atlas-pdf-aq').checked = !!document.getElementById('aq-enabled')?.checked;
    fillVariableControls();
    syncSymbolPanels();

    // Prefer page state focus if set
    const pageState = document.getElementById('state')?.value;
    if (pageState && pageState !== 'ALL' && $('#atlas-pdf-state')) {
      const opt = [...$('#atlas-pdf-state').options].find((o) => o.value === pageState || o.textContent.includes(`(${pageState})`));
      if (opt) $('#atlas-pdf-state').value = opt.value;
      else if ([...$('#atlas-pdf-state').options].some((o) => o.value === pageState)) {
        $('#atlas-pdf-state').value = pageState;
      }
    }
  }

  function readSymbolStyle(prefix) {
    const size = Number($(`#atlas-pdf-${prefix}-size`)?.value) || 12;
    const palette = $(`#atlas-pdf-${prefix}-palette`)?.value || 'default';
    return { size: Math.max(8, Math.min(18, size)), palette };
  }

  function readAirPollutantsFromForm() {
    const checked = [...document.querySelectorAll('#atlas-pdf-aq-polls input.atlas-pdf-aq-poll:checked')]
      .map((el) => el.value);
    if (checked.length) return checked;
    // Fallback to page selection / PM25
    const page = [...document.querySelectorAll('.aq-poll:checked')].map((el) => el.value);
    return page.length ? page : ['PM25'];
  }

  function readForm() {
    const basemap = document.querySelector('input[name="atlas-pdf-basemap"]:checked')?.value || 'current';
    const extent = document.querySelector('input[name="atlas-pdf-extent"]:checked')?.value || 'view';
    const pdfSize = $('#atlas-pdf-pdf-size').value;
    const pdfPreset = PDF_SIZES.find((p) => p.value === pdfSize) || PDF_SIZES[1];
    return {
      basemap,
      extent,
      state: $('#atlas-pdf-state')?.value || '',
      bbox: readBboxFromForm(),
      choropleth: $('#atlas-pdf-choropleth').checked,
      superfund: $('#atlas-pdf-sf').checked,
      soil: $('#atlas-pdf-gc').checked,
      air: $('#atlas-pdf-aq').checked,
      soilElement: $('#atlas-pdf-gc-element')?.value
        || document.getElementById('gc-element')?.value
        || '',
      airPollutants: readAirPollutantsFromForm(),
      sfStyle: readSymbolStyle('sf'),
      gcStyle: readSymbolStyle('gc'),
      aqStyle: readSymbolStyle('aq'),
      legend: $('#atlas-pdf-legend').checked,
      controls: $('#atlas-pdf-controls').checked,
      title: $('#atlas-pdf-fig-title').value.trim(),
      source: $('#atlas-pdf-source').value.trim(),
      pngWidth: Number($('#atlas-pdf-png-size').value) || 2400,
      pdfW: pdfPreset.w,
      pdfH: pdfPreset.h,
    };
  }

  function getOverlayHandles() {
    if (typeof cfg.getOverlays === 'function') return cfg.getOverlays() || {};
    return {};
  }

  function applyOverlayVariables(opts) {
    if (opts.soil && opts.soilElement) {
      const el = document.getElementById('gc-element');
      if (el && [...el.options].some((o) => o.value === opts.soilElement)) {
        el.value = opts.soilElement;
      }
    }
    if (opts.air && opts.airPollutants && opts.airPollutants.length) {
      const want = new Set(opts.airPollutants);
      document.querySelectorAll('.aq-poll').forEach((cb) => {
        cb.checked = want.has(cb.value);
      });
    }
  }

  async function refreshOverlays(which) {
    const ov = getOverlayHandles();
    const waits = [];
    const want = which || { sf: true, gc: true, aq: true };
    if (want.sf && ov.sf && typeof ov.sf.refresh === 'function') {
      waits.push(Promise.resolve(ov.sf.refresh()));
    }
    if (want.gc && ov.gc && typeof ov.gc.refresh === 'function') {
      waits.push(Promise.resolve(ov.gc.refresh()));
    }
    if (want.aq && ov.aq && typeof ov.aq.refresh === 'function') {
      waits.push(Promise.resolve(ov.aq.refresh()));
    }
    await Promise.all(waits);
  }

  async function applySymbolStyles(opts) {
    global.AtlasOverlayExportStyle = {
      superfund: opts.superfund ? opts.sfStyle : undefined,
      soil: opts.soil ? opts.gcStyle : undefined,
      air: opts.air ? opts.aqStyle : undefined,
    };
    await refreshOverlays({
      sf: !!opts.superfund,
      gc: !!opts.soil,
      aq: !!opts.air,
    });
  }

  function clearSymbolStyles() {
    global.AtlasOverlayExportStyle = null;
  }

  function boundsToBox(llb) {
    return {
      west: llb.getWest(),
      east: llb.getEast(),
      south: llb.getSouth(),
      north: llb.getNorth(),
    };
  }

  function csvEscape(v) {
    const s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function rowsToCsv(rows) {
    if (!rows.length) return '';
    const cols = [...rows.reduce((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set())];
    const lines = [cols.join(',')];
    rows.forEach((r) => {
      lines.push(cols.map((c) => csvEscape(r[c])).join(','));
    });
    return lines.join('\n');
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function runCsvExport() {
    if (!cfg?.map) return;
    const opts = readForm();
    if (opts.soil && !opts.soilElement) {
      alert('Select a soil element for CSV export.');
      return;
    }
    if (opts.air && !(opts.airPollutants && opts.airPollutants.length)) {
      alert('Select at least one air pollutant for CSV export.');
      return;
    }
    const btn = $('#atlas-pdf-csv');
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Building CSV…';
    const snap = {
      sf: !!document.getElementById('sf-enabled')?.checked,
      gc: !!document.getElementById('gc-enabled')?.checked,
      aq: !!document.getElementById('aq-enabled')?.checked,
      soilElement: document.getElementById('gc-element')?.value || '',
      airPollutants: [...document.querySelectorAll('.aq-poll:checked')].map((el) => el.value),
    };
    try {
      // Ensure selected overlays are on so filtered() / cache are current
      if (opts.superfund) setCheckbox('sf-enabled', true);
      if (opts.soil) setCheckbox('gc-enabled', true);
      if (opts.air) setCheckbox('aq-enabled', true);
      applyOverlayVariables(opts);
      await refreshOverlays({
        sf: !!opts.superfund,
        gc: !!opts.soil,
        aq: !!opts.air,
      });
      await waitFrames(2);
      await new Promise((r) => setTimeout(r, 200));

      const bounds = boundsToBox(resolveExportBounds(opts));
      const ov = getOverlayHandles();
      let rows = [];
      if (opts.superfund && ov.sf?.getCsvRows) rows = rows.concat(ov.sf.getCsvRows(bounds));
      if (opts.soil && ov.gc?.getCsvRows) rows = rows.concat(ov.gc.getCsvRows(bounds));
      if (opts.air && ov.aq?.getCsvRows) rows = rows.concat(ov.aq.getCsvRows(bounds));

      if (!rows.length) {
        throw new Error('No overlay rows to export. Enable Superfund, soil, and/or air quality (and load soil for a state), then try again.');
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const prefix = cfg.filenamePrefix || 'usa-health-map';
      downloadText(`${prefix}-overlays-${stamp}.csv`, rowsToCsv(rows));
      closeModal();
    } catch (err) {
      console.error(err);
      alert('CSV export failed.' + (err && err.message ? `\n\n(${err.message})` : ''));
    } finally {
      try {
        if (document.getElementById('sf-enabled')) setCheckbox('sf-enabled', snap.sf);
        if (document.getElementById('gc-enabled')) setCheckbox('gc-enabled', snap.gc);
        if (document.getElementById('aq-enabled')) setCheckbox('aq-enabled', snap.aq);
        applyOverlayVariables({
          soil: true,
          air: true,
          soilElement: snap.soilElement,
          airPollutants: snap.airPollutants,
        });
        await refreshOverlays({ sf: true, gc: true, aq: true });
      } catch (_) { /* ignore */ }
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  function snapshotState() {
    const b = cfg.map.getBounds();
    return {
      basemap: cfg.getBasemapKey ? cfg.getBasemapKey() : 'osm',
      choroplethOn: !!(cfg.getChoroplethGroup?.() && cfg.map.hasLayer(cfg.getChoroplethGroup())),
      sf: !!document.getElementById('sf-enabled')?.checked,
      gc: !!document.getElementById('gc-enabled')?.checked,
      aq: !!document.getElementById('aq-enabled')?.checked,
      soilElement: document.getElementById('gc-element')?.value || '',
      airPollutants: [...document.querySelectorAll('.aq-poll:checked')].map((el) => el.value),
      view: {
        west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth(),
        zoom: cfg.map.getZoom(),
      },
    };
  }

  function setCheckbox(id, on) {
    const el = document.getElementById(id);
    if (!el || el.checked === on) return;
    el.checked = on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applyExportState(opts) {
    const ch = cfg.getChoroplethGroup?.();
    if (ch && cfg.map) {
      if (opts.choropleth && !cfg.map.hasLayer(ch)) cfg.map.addLayer(ch);
      if (!opts.choropleth && cfg.map.hasLayer(ch)) cfg.map.removeLayer(ch);
    }
    if (document.getElementById('sf-enabled')) setCheckbox('sf-enabled', opts.superfund);
    if (document.getElementById('gc-enabled')) setCheckbox('gc-enabled', opts.soil);
    if (document.getElementById('aq-enabled')) setCheckbox('aq-enabled', opts.air);
    applyOverlayVariables(opts);

    if (opts.basemap === 'none') {
      Object.values(cfg.baseLayers || {}).forEach((lyr) => {
        if (cfg.map.hasLayer(lyr)) cfg.map.removeLayer(lyr);
      });
    } else if (opts.basemap !== 'current' && cfg.setBasemapKey) {
      cfg.setBasemapKey(opts.basemap);
    }
  }

  async function restoreState(snap) {
    if (cfg.setBasemapKey) cfg.setBasemapKey(snap.basemap);
    const ch = cfg.getChoroplethGroup?.();
    if (ch && cfg.map) {
      if (snap.choroplethOn && !cfg.map.hasLayer(ch)) cfg.map.addLayer(ch);
      if (!snap.choroplethOn && cfg.map.hasLayer(ch)) cfg.map.removeLayer(ch);
    }
    if (document.getElementById('sf-enabled')) setCheckbox('sf-enabled', snap.sf);
    if (document.getElementById('gc-enabled')) setCheckbox('gc-enabled', snap.gc);
    if (document.getElementById('aq-enabled')) setCheckbox('aq-enabled', snap.aq);
    applyOverlayVariables({
      soil: true,
      air: true,
      soilElement: snap.soilElement,
      airPollutants: snap.airPollutants || [],
    });
    if (snap.view) {
      try {
        cfg.map.fitBounds(boundsFromBox(snap.view), { animate: false, padding: [12, 12] });
      } catch (_) { /* ignore */ }
    }
    await refreshOverlays({ sf: true, gc: true, aq: true });
  }

  function waitFrames(n) {
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        i += 1;
        if (i >= n) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  async function fitMapForExport(opts) {
    if (opts.extent === 'view') return;
    const bounds = resolveExportBounds(opts);
    cfg.map.fitBounds(bounds, {
      animate: false,
      padding: [18, 18],
      maxZoom: opts.extent === 'state' ? 8 : 6,
    });
    cfg.map.invalidateSize();
    await waitFrames(2);
    await new Promise((r) => setTimeout(r, 350));
  }

  async function captureCanvas(opts) {
    const mapEl = typeof cfg.mapEl === 'string' ? $(cfg.mapEl) : cfg.mapEl;
    if (!mapEl) throw new Error('Map element not found');
    cfg.map.invalidateSize();
    await waitFrames(2);
    await new Promise((r) => setTimeout(r, opts.basemap === 'current' || opts.basemap === 'none' ? 200 : 700));

    const controlBox = mapEl.querySelector('.leaflet-control-container');
    const legendBoxes = mapEl.querySelectorAll('.map-legend, .gc-map-legend, .aq-map-legend, .sf-map-legend');
    const prevControl = controlBox ? controlBox.style.visibility : '';
    const prevLegends = [...legendBoxes].map((el) => el.style.visibility);

    if (controlBox && !opts.controls) controlBox.style.visibility = 'hidden';
    legendBoxes.forEach((el) => {
      if (!opts.legend) el.style.visibility = 'hidden';
    });

    try {
      const mapW = mapEl.clientWidth || 800;
      const scale = Math.max(1, opts.pngWidth / mapW);
      const canvas = await global.html2canvas(mapEl, {
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#ffffff',
        scale,
        logging: false,
        imageTimeout: 15000,
        removeContainer: true,
      });
      return canvas;
    } finally {
      if (controlBox) controlBox.style.visibility = prevControl;
      legendBoxes.forEach((el, i) => { el.style.visibility = prevLegends[i] || ''; });
    }
  }

  function downloadCanvasPng(canvas, filename) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('PNG encoding failed (basemap tiles may block capture — try “None” basemap)'));
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        resolve();
      }, 'image/png');
    });
  }

  function buildPdf(canvas, opts) {
    const { jsPDF } = global.jspdf;
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
    const pageW = pdf.internal.pageSize.getWidth();
    const margin = 40;
    const imgData = canvas.toDataURL('image/jpeg', 0.92);

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    pdf.setTextColor(20, 38, 46);
    const titleLines = pdf.splitTextToSize(opts.title || 'Map', pageW - margin * 2);
    let y = margin;
    titleLines.forEach((line) => {
      const tw = pdf.getTextWidth(line);
      pdf.text(line, (pageW - tw) / 2, y);
      y += 16;
    });
    y += 6;

    pdf.addImage(imgData, 'JPEG', (pageW - opts.pdfW) / 2, y, opts.pdfW, opts.pdfH);
    y += opts.pdfH + 12;

    if (opts.source) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(90, 110, 120);
      const srcLines = pdf.splitTextToSize(`Data source: ${opts.source}`, pageW - margin * 2);
      srcLines.forEach((line) => {
        const tw = pdf.getTextWidth(line);
        pdf.text(line, (pageW - tw) / 2, y);
        y += 11;
      });
    }
    return pdf;
  }

  async function runExport(kind) {
    if (!cfg?.map) return;
    const opts = readForm();
    const btnPng = $('#atlas-pdf-png');
    const btnPdf = $('#atlas-pdf-pdf');
    const label = kind === 'png' ? btnPng : btnPdf;
    const prev = label.textContent;
    btnPng.disabled = true;
    btnPdf.disabled = true;
    label.textContent = kind === 'png' ? 'Generating PNG…' : 'Generating PDF…';

    if (opts.soil && !opts.soilElement) {
      alert('Select a soil element for export.');
      return;
    }
    if (opts.air && !(opts.airPollutants && opts.airPollutants.length)) {
      alert('Select at least one air pollutant for export.');
      return;
    }

    const snap = snapshotState();
    const hadPreview = !!bboxPreviewLayer;
    const btnCsv = $('#atlas-pdf-csv');
    if (btnCsv) btnCsv.disabled = true;
    try {
      await ensureLibs();
      // Hide preview rectangle during capture
      if (bboxPreviewLayer) { cfg.map.removeLayer(bboxPreviewLayer); bboxPreviewLayer = null; }
      applyExportState(opts);
      await applySymbolStyles(opts);
      await fitMapForExport(opts);
      await waitFrames(3);
      await new Promise((r) => setTimeout(r, 250));
      const canvas = await captureCanvas(opts);
      const stamp = new Date().toISOString().slice(0, 10);
      const prefix = cfg.filenamePrefix || 'usa-health-map';
      if (kind === 'png') {
        await downloadCanvasPng(canvas, `${prefix}-${stamp}.png`);
      } else {
        const pdf = buildPdf(canvas, opts);
        pdf.save(`${prefix}-${stamp}.pdf`);
      }
      closeModal();
    } catch (err) {
      console.error(err);
      alert((kind === 'png' ? 'PNG' : 'PDF') + ' export failed.'
        + (err && err.message ? `\n\n(${err.message})` : '')
        + '\n\nTip: try Basemap → “None (boundaries & markers only)” if tiles block capture.');
    } finally {
      try { clearSymbolStyles(); } catch (_) { /* ignore */ }
      try { await restoreState(snap); } catch (_) { /* ignore */ }
      if (hadPreview && opts.extent === 'bbox') {
        const n = normalizeBbox(opts.bbox);
        if (n) updateBboxPreview(n);
      }
      btnPng.disabled = false;
      btnPdf.disabled = false;
      if (btnCsv) btnCsv.disabled = false;
      label.textContent = prev;
    }
  }

  function attach(options) {
    cfg = options || {};
    ensureModal();
    if (cfg.buttonId) {
      const b = document.getElementById(cfg.buttonId);
      if (b) b.addEventListener('click', (e) => { e.preventDefault(); openModal(); });
    } else if (cfg.buttonMount) {
      const mount = typeof cfg.buttonMount === 'string' ? $(cfg.buttonMount) : cfg.buttonMount;
      if (mount && mount.tagName === 'BUTTON') {
        mount.addEventListener('click', (e) => { e.preventDefault(); openModal(); });
      }
    }
    return { open: openModal, close: closeModal };
  }

  global.AtlasMapExport = { attach, open: openModal, close: closeModal };
})(window);
