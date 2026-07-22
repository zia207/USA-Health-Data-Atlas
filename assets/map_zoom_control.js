/**
 * Custom map zoom control: -- / - / value / + / ++, slider, Reset view.
 * Usage: attachMapZoomControl(map, { bounds?: LatLngBounds, mount?: string|HTMLElement })
 * If mount is set, the panel is placed in that sidebar element; otherwise top-left on the map.
 */
(function (global) {
  const USA_BOUNDS = L.latLngBounds([24.5, -125], [49.5, -66.5]);

  function injectStyles() {
    if (document.getElementById('map-zoom-control-styles')) return;
    const style = document.createElement('style');
    style.id = 'map-zoom-control-styles';
    style.textContent = `
      .atlas-zoom {
        background: rgba(255,255,255,.96);
        border: 1px solid #c5d0d6;
        padding: 10px 12px;
        min-width: 0;
        width: 100%;
        box-sizing: border-box;
        font-family: ui-monospace, Consolas, Menlo, monospace;
        color: #0b1f2a;
        line-height: 1.2;
      }
      .atlas-zoom.leaflet-bar {
        box-shadow: 0 2px 10px rgba(20,38,46,.18);
        min-width: 210px;
      }
      .atlas-zoom-sidebar {
        margin: 14px 0 0;
        border: 1px solid var(--hair, #c5d0d6);
        background: #f8fbfc;
      }
      .atlas-zoom strong {
        display: block;
        font-size: 11px;
        letter-spacing: .12em;
        text-transform: uppercase;
        margin-bottom: 8px;
        color: #0b1f2a;
      }
      .atlas-zoom-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
      }
      .atlas-zoom-row button {
        width: 28px;
        height: 28px;
        border: 1px solid #0b1f2a;
        background: #fff;
        cursor: pointer;
        font: 650 12px ui-monospace, Consolas, monospace;
        padding: 0;
        color: #0b1f2a;
      }
      .atlas-zoom-row button:hover { background: #e8eef1; }
      .atlas-zoom-val {
        flex: 1;
        text-align: center;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        min-width: 48px;
      }
      .atlas-zoom input[type="range"] {
        width: 100%;
        accent-color: #14707e;
        margin: 0 0 8px;
      }
      .atlas-zoom-reset {
        width: 100%;
        border: 1px dashed #0b1f2a;
        background: #fff;
        padding: 7px 8px;
        cursor: pointer;
        font: 650 11px ui-monospace, Consolas, monospace;
        letter-spacing: .06em;
        text-transform: uppercase;
        color: #0b1f2a;
      }
      .atlas-zoom-reset:hover { background: #e8eef1; }
    `;
    document.head.appendChild(style);
  }

  function resolveMount(mount) {
    if (!mount) return null;
    if (typeof mount === 'string') return document.getElementById(mount);
    return mount;
  }

  function buildZoomPanel(map, resetBounds) {
    const div = document.createElement('div');
    div.className = 'atlas-zoom';
    const minZ = map.getMinZoom();
    const maxZ = map.getMaxZoom();
    div.innerHTML = `
      <strong>Zoom</strong>
      <div class="atlas-zoom-row">
        <button type="button" data-z="-2" title="Zoom out a lot">−−</button>
        <button type="button" data-z="-1" title="Zoom out">−</button>
        <span class="atlas-zoom-val">0.00</span>
        <button type="button" data-z="1" title="Zoom in">+</button>
        <button type="button" data-z="2" title="Zoom in a lot">++</button>
      </div>
      <input type="range" class="atlas-zoom-slider" min="${minZ}" max="${maxZ}" step="0.25" value="${map.getZoom()}"/>
      <button type="button" class="atlas-zoom-reset">Reset view</button>
    `;

    const valEl = div.querySelector('.atlas-zoom-val');
    const slider = div.querySelector('.atlas-zoom-slider');

    function sync() {
      const z = map.getZoom();
      valEl.textContent = z.toFixed(2);
      slider.min = String(map.getMinZoom());
      slider.max = String(map.getMaxZoom());
      slider.value = String(z);
    }

    div.querySelectorAll('button[data-z]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = Number(btn.getAttribute('data-z'));
        map.setZoom(map.getZoom() + d);
      });
    });
    slider.addEventListener('input', () => {
      map.setZoom(Number(slider.value));
    });
    div.querySelector('.atlas-zoom-reset').addEventListener('click', () => {
      map.fitBounds(resetBounds, { padding: [20, 20], maxZoom: 5 });
    });

    map.on('zoom zoomend', sync);
    sync();
    return div;
  }

  function attachMapZoomControl(map, options) {
    if (!map) return null;
    injectStyles();
    const opts = options || {};
    const resetBounds = opts.bounds || USA_BOUNDS;
    const mountEl = resolveMount(opts.mount);

    // Prefer custom control; remove default Leaflet zoom if present
    if (map.zoomControl) map.removeControl(map.zoomControl);

    if (mountEl) {
      mountEl.innerHTML = '';
      const panel = buildZoomPanel(map, resetBounds);
      panel.classList.add('atlas-zoom-sidebar');
      mountEl.appendChild(panel);
      return { el: panel, mount: mountEl };
    }

    const ctrl = L.control({ position: opts.position || 'topleft' });
    ctrl.onAdd = function () {
      const panel = buildZoomPanel(map, resetBounds);
      panel.classList.add('leaflet-bar');
      L.DomEvent.disableClickPropagation(panel);
      L.DomEvent.disableScrollPropagation(panel);
      return panel;
    };
    ctrl.addTo(map);
    return ctrl;
  }

  global.attachMapZoomControl = attachMapZoomControl;
})(window);
