/**
 * Leaflet basemap (and optional overlay) control on the map window.
 * Usage:
 *   attachMapLayersControl(map, baseLayers, {
 *     defaultKey: 'osm',
 *     selectId: 'basemap',           // sync with sidebar <select>
 *     overlays: { 'USA Superfund (NPL)': layerGroup, ... },
 *     position: 'bottomright',
 *   })
 */
(function (global) {
  const LABELS = {
    osm: 'Street map (OpenStreetMap)',
    esri: 'Satellite (Esri)',
    gsat: 'Satellite (Google)',
    ghybrid: 'Satellite + labels (Google)',
    topo: 'Topographic (Esri)',
  };

  function injectStyles() {
    if (document.getElementById('map-layers-control-styles')) return;
    const style = document.createElement('style');
    style.id = 'map-layers-control-styles';
    style.textContent = `
      .leaflet-control-layers {
        border: 1px solid #c5d0d6 !important;
        border-radius: 0 !important;
        box-shadow: 0 2px 10px rgba(20,38,46,.18) !important;
        font: 12.5px "Segoe UI", system-ui, sans-serif;
        color: #0b1f2a;
      }
      .leaflet-control-layers-toggle {
        width: 36px !important;
        height: 36px !important;
      }
      .leaflet-control-layers-expanded {
        padding: 10px 12px !important;
        min-width: 200px;
      }
      .leaflet-control-layers-base label,
      .leaflet-control-layers-overlays label {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 4px 0;
        font-weight: 500;
        cursor: pointer;
      }
      .leaflet-control-layers-separator {
        border-top-color: #c5d0d6 !important;
        margin: 8px 0 !important;
      }
      .atlas-layers-title {
        font: 650 10px ui-monospace, Consolas, monospace;
        letter-spacing: .12em;
        text-transform: uppercase;
        color: #5a6e78;
        margin: 0 0 6px;
      }
    `;
    document.head.appendChild(style);
  }

  function attachMapLayersControl(map, baseLayers, options) {
    if (!map || !baseLayers) return null;
    injectStyles();
    const opts = options || {};
    const named = {};
    Object.keys(baseLayers).forEach((key) => {
      named[LABELS[key] || key] = baseLayers[key];
    });
    const overlays = opts.overlays || {};
    const ctrl = L.control.layers(named, overlays, {
      position: opts.position || 'bottomright',
      collapsed: opts.collapsed !== false,
    });
    ctrl.addTo(map);

    // Label the expanded panel
    const container = ctrl.getContainer();
    if (container) {
      const form = container.querySelector('form') || container;
      if (form && !form.querySelector('.atlas-layers-title')) {
        const title = document.createElement('div');
        title.className = 'atlas-layers-title';
        title.textContent = 'Map layers';
        form.insertBefore(title, form.firstChild);
      }
      // Hint that overlay checkboxes can be unchecked
      if (form && Object.keys(overlays).length && !form.querySelector('.atlas-layers-hint')) {
        const hint = document.createElement('div');
        hint.className = 'atlas-layers-hint';
        hint.style.cssText = 'font-size:10.5px;color:#5a6e78;margin:6px 0 0;line-height:1.35';
        hint.textContent = 'Uncheck overlays to hide them on the map.';
        form.appendChild(hint);
      }
    }

    const selectId = opts.selectId || 'basemap';
    const select = document.getElementById(selectId);
    const keyByLayer = new Map();
    Object.keys(baseLayers).forEach((key) => keyByLayer.set(baseLayers[key], key));

    // Map layers control → sidebar basemap select
    map.on('baselayerchange', (e) => {
      const key = keyByLayer.get(e.layer);
      if (key && select && select.value !== key) {
        select.value = key;
        if (typeof opts.onChange === 'function') opts.onChange(key);
      }
    });

    return ctrl;
  }

  global.attachMapLayersControl = attachMapLayersControl;
})(window);
