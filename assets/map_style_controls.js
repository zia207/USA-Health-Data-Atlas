/**
 * Shared color palettes + map-legend chrome (geography + palette) for choropleth explorers.
 */
(function (global) {
  const PALETTES = [
    { id: 'ylorrd', label: 'Yellow → Red', colors: ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'] },
    { id: 'spectral', label: 'Blue → Red (diverging)', colors: ['#2166ac', '#67a9cf', '#f7d8a8', '#ef8a62', '#b2182b'] },
    { id: 'ylgnbu', label: 'Yellow → Blue-green', colors: ['#ffffcc', '#a1dab4', '#41b6c4', '#2c7fb8', '#253494'] },
    { id: 'blues', label: 'Blues', colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'] },
    { id: 'greens', label: 'Greens', colors: ['#edf8e9', '#bae4b3', '#74c476', '#31a354', '#006d2c'] },
    { id: 'purples', label: 'Purples', colors: ['#f2f0f7', '#cbc9e2', '#9e9ac8', '#756bb1', '#54278f'] },
    { id: 'oranges', label: 'Oranges', colors: ['#feedde', '#fdbe85', '#fd8d3c', '#e6550d', '#a63603'] },
    { id: 'viridis', label: 'Viridis-like', colors: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] },
  ];

  function injectStyles() {
    if (document.getElementById('map-style-controls-css')) return;
    const style = document.createElement('style');
    style.id = 'map-style-controls-css';
    style.textContent = `
      .map-legend .ml-chrome { margin: 0 0 8px; display: grid; gap: 8px; }
      .map-legend .ml-geo {
        display: flex; gap: 0; border: 1px solid #c5d0d6; overflow: hidden;
      }
      .map-legend .ml-geo button {
        flex: 1; border: none; background: #f4f8f8; color: #0b1f2a;
        padding: 5px 6px; font-size: 11px; font-weight: 650; cursor: pointer;
        border-right: 1px solid #c5d0d6;
      }
      .map-legend .ml-geo button:last-child { border-right: none; }
      .map-legend .ml-geo button.active { background: #0e3a4f; color: #fff; }
      .map-legend .ml-geo button:hover:not(.active) { background: #e8eef1; }
      .map-legend .ml-palette-row {
        display: grid; grid-template-columns: auto 1fr; gap: 6px; align-items: center;
      }
      .map-legend .ml-palette-row label {
        font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
        color: #5a6e78; font-family: ui-monospace, Consolas, monospace;
      }
      .map-legend .ml-palette-row select {
        width: 100%; font-size: 11.5px; padding: 3px 4px; border: 1px solid #c5d0d6;
        background: #fff; color: #0b1f2a;
      }
      .map-legend .ml-palette-swatches {
        display: flex; height: 8px; border: 1px solid #c5d0d6; margin-top: 4px; overflow: hidden;
      }
      .map-legend .ml-palette-swatches span { flex: 1; }
    `;
    document.head.appendChild(style);
  }

  function findPalette(id) {
    return PALETTES.find((p) => p.id === id) || PALETTES[0];
  }

  function getColors(id) {
    return findPalette(id).colors.slice();
  }

  function fillPaletteSelect(selectEl, selectedId) {
    if (!selectEl) return;
    const prev = selectedId || selectEl.value || 'ylorrd';
    selectEl.innerHTML = PALETTES.map((p) =>
      `<option value="${p.id}">${p.label}</option>`
    ).join('');
    if ([...selectEl.options].some((o) => o.value === prev)) selectEl.value = prev;
    else selectEl.selectedIndex = 0;
  }

  function chromeHtml(levels, level, paletteId) {
    const geo = (levels || []).map((lv) =>
      `<button type="button" data-level="${lv.value}" class="${lv.value === level ? 'active' : ''}">${lv.label}</button>`
    ).join('');
    const opts = PALETTES.map((p) =>
      `<option value="${p.id}" ${p.id === paletteId ? 'selected' : ''}>${p.label}</option>`
    ).join('');
    const swatches = getColors(paletteId).map((c) => `<span style="background:${c}"></span>`).join('');
    return `<div class="ml-chrome">
      <div class="ml-geo" role="group" aria-label="Map geography">${geo}</div>
      <div class="ml-palette-row">
        <label for="ml-palette">Palette</label>
        <select id="ml-palette">${opts}</select>
      </div>
      <div class="ml-palette-swatches">${swatches}</div>
    </div>`;
  }

  /**
   * Wire geography + palette controls inside a legend div.
   * options: { levels, level, paletteId, onLevelChange, onPaletteChange }
   */
  function bindLegendChrome(div, options) {
    injectStyles();
    const levels = options.levels || [
      { value: 'states', label: 'State' },
      { value: 'counties', label: 'County' },
    ];
    const level = options.level || 'states';
    const paletteId = options.paletteId || 'ylorrd';

    const wrap = document.createElement('div');
    wrap.innerHTML = chromeHtml(levels, level, paletteId);
    const chromeEl = wrap.firstElementChild;
    const titleEl = div.querySelector('strong');
    if (titleEl) titleEl.insertAdjacentElement('afterend', chromeEl);
    else div.insertBefore(chromeEl, div.firstChild);

    const chrome = div.querySelector('.ml-chrome');
    if (!chrome) return;

    chrome.querySelectorAll('button[data-level]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = btn.getAttribute('data-level');
        if (typeof options.onLevelChange === 'function') options.onLevelChange(next);
      });
    });

    const sel = chrome.querySelector('select');
    if (sel) {
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        if (typeof options.onPaletteChange === 'function') options.onPaletteChange(sel.value);
      });
      if (typeof L !== 'undefined' && L.DomEvent) {
        L.DomEvent.disableClickPropagation(sel);
        L.DomEvent.disableScrollPropagation(sel);
      }
    }
    if (typeof L !== 'undefined' && L.DomEvent) {
      L.DomEvent.disableClickPropagation(chrome);
      L.DomEvent.disableScrollPropagation(chrome);
    }
  }

  injectStyles();

  global.MAP_COLOR_PALETTES = PALETTES;
  global.MapStyleControls = {
    palettes: PALETTES,
    getColors,
    findPalette,
    fillPaletteSelect,
    bindLegendChrome,
    injectStyles,
  };
})(window);
