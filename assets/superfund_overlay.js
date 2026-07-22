/**
 * Shared USA Superfund (NPL) overlay for Atlas explorers.
 * Requires: Leaflet map, window.SUPERFUND_NPL
 * Sources: EPA CIMC / NPL Status Feature Service
 */
(function (global) {
  const STATUS_COLORS = {
    'NPL Site': '#e11d48',
    'Proposed NPL Site': '#f59e0b',
    'Deleted NPL Site': '#64748b',
  };
  const STATUS_ORDER = ['NPL Site', 'Proposed NPL Site', 'Deleted NPL Site'];

  function $(id) { return document.getElementById(id); }

  function exportStyle() {
    return (global.AtlasOverlayExportStyle && global.AtlasOverlayExportStyle.superfund) || {};
  }

  function statusColor(status) {
    const st = exportStyle();
    if (st.palette && st.palette !== 'default' && global.MapStyleControls) {
      const colors = MapStyleControls.getColors(st.palette);
      const idx = Math.max(0, STATUS_ORDER.indexOf(status));
      return colors[Math.min(colors.length - 1, idx)] || STATUS_COLORS[status] || '#334155';
    }
    return STATUS_COLORS[status] || '#334155';
  }

  function pointSize() {
    const s = Number(exportStyle().size);
    if (Number.isFinite(s)) return Math.max(8, Math.min(18, s));
    return 9;
  }

  function injectStyles() {
    if (document.getElementById('sf-overlay-styles')) return;
    const style = document.createElement('style');
    style.id = 'sf-overlay-styles';
    style.textContent = `
      .sf-panel { margin-top: 16px; padding-top: 12px; border-top: 1px dashed var(--hair, #c5d0d6); }
      .sf-panel h2 {
        margin-top: 0;
        font-size: 15px;
        letter-spacing: .08em;
        line-height: 1.3;
      }
      .sf-check { display: flex; gap: 8px; align-items: center; font-size: 13px; margin-bottom: 8px; cursor: pointer; }
      .sf-dossier {
        position: fixed; top: 0; right: 0; width: min(420px, 100vw); height: 100vh;
        background: #fff; border-left: 1px solid #c5d0d6; z-index: 5000;
        box-shadow: -8px 0 28px rgba(15,23,42,.18); transform: translateX(105%);
        transition: transform .22s ease; display: flex; flex-direction: column;
      }
      .sf-dossier.open { transform: translateX(0); }
      .sf-dossier-head {
        padding: 14px 16px 12px; background: linear-gradient(90deg,#071821,#0e3a4f);
        color: #e8f2f5; flex: 0 0 auto;
      }
      .sf-dossier-head .tag {
        font-family: ui-monospace, Consolas, monospace; font-size: 10px;
        letter-spacing: .12em; text-transform: uppercase; color: #8fb6bd;
      }
      .sf-dossier-head h3 { margin: 6px 0 0; font-size: 20px; line-height: 1.2; }
      .sf-dossier-close {
        float: right; background: transparent; border: 1px solid rgba(255,255,255,.35);
        color: #e8f2f5; padding: 4px 10px; cursor: pointer; font-size: 12px;
      }
      .sf-dossier-body { padding: 14px 16px 28px; overflow: auto; flex: 1; font-size: 13.5px; color: #0b1f2a; }
      .sf-meta { display: grid; gap: 8px; margin: 12px 0 14px; }
      .sf-meta div { display: grid; grid-template-columns: 110px 1fr; gap: 8px; }
      .sf-meta dt, .sf-meta .k {
        font-family: ui-monospace, Consolas, monospace; font-size: 10px;
        letter-spacing: .08em; text-transform: uppercase; color: #5a6e78; padding-top: 2px;
      }
      .sf-badge {
        display: inline-block; padding: 2px 8px; border-radius: 999px; color: #fff;
        font-size: 11.5px; font-weight: 650;
      }
      .sf-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
      .sf-tag {
        background: #f1f7f8; border: 1px solid #14707e; color: #0e3a4f;
        padding: 3px 9px; font-size: 11.5px; border-radius: 999px;
      }
      .sf-tag.chem { background: #f5f0ff; border-color: #7c3aed; color: #5b21b6; }
      .sf-links a { display: inline-block; margin: 4px 8px 4px 0; }
      .sf-note { font-size: 11.5px; color: #5a6e78; line-height: 1.45; margin-top: 10px; }
      .sf-legend-row { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 3px 0; }
      .sf-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; border: none; box-sizing: border-box; }
      .sf-state-list { list-style: none; padding: 0; margin: 8px 0 0; }
      .sf-state-list li { border-bottom: 1px solid #e6eef0; padding: 8px 0; cursor: pointer; }
      .sf-state-list li:hover { color: #14707e; }
    `;
    document.head.appendChild(style);
  }

  function ensureDossier() {
    let el = document.getElementById('sf-dossier');
    if (el) return el;
    el = document.createElement('aside');
    el.id = 'sf-dossier';
    el.className = 'sf-dossier';
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `
      <div class="sf-dossier-head">
        <button type="button" class="sf-dossier-close" id="sf-dossier-close">Close</button>
        <div class="tag" id="sf-dossier-tag">EPA SUPERFUND</div>
        <h3 id="sf-dossier-title">Site</h3>
      </div>
      <div class="sf-dossier-body" id="sf-dossier-body"></div>
    `;
    document.body.appendChild(el);
    $('sf-dossier-close').addEventListener('click', () => el.classList.remove('open'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') el.classList.remove('open');
    });
    return el;
  }

  function statusBadge(status) {
    const c = STATUS_COLORS[status] || '#334155';
    return `<span class="sf-badge" style="background:${c}">${status || 'Unknown'}</span>`;
  }

  function openSiteDossier(site) {
    const el = ensureDossier();
    $('sf-dossier-tag').textContent = 'EPA SUPERFUND · NPL';
    $('sf-dossier-title').textContent = site.name || 'Unknown site';
    const chem = (site.chem_tags || []).map((t) => `<span class="sf-tag chem">${t}</span>`).join('')
      || '<span class="sf-tag">No name-based chemical tags</span>';
    const loc = [site.city, site.county ? `${site.county} County` : null, site.state_name || site.state, site.epa_id ? null : null]
      .filter(Boolean).join(', ');
    $('sf-dossier-body').innerHTML = `
      <div class="sf-meta">
        <div><span class="k">Location</span><span>${loc || '—'}</span></div>
        <div><span class="k">Status</span><span>${statusBadge(site.status)}</span></div>
        <div><span class="k">EPA ID</span><span>${site.epa_id || '—'}</span></div>
        <div><span class="k">SEMS ID</span><span>${site.sems_id ?? '—'}</span></div>
        <div><span class="k">EPA region</span><span>${site.region ?? '—'}</span></div>
        <div><span class="k">HRS score</span><span>${site.score != null ? site.score : '—'}</span></div>
        <div><span class="k">Proposed</span><span>${site.proposed || '—'}</span></div>
        <div><span class="k">Listed</span><span>${site.listed || '—'}</span></div>
        <div><span class="k">Construction complete</span><span>${site.construction_complete || '—'}</span></div>
        <div><span class="k">Deleted</span><span>${site.deleted || '—'}</span></div>
        <div><span class="k">Partial deletion</span><span>${site.partial_deletion || '—'}</span></div>
        <div><span class="k">Coordinates</span><span>${site.lat}, ${site.lon}</span></div>
      </div>
      <strong>Chemical information</strong>
      <div class="sf-tags">${chem}</div>
      <p class="sf-note">${(global.SUPERFUND_NPL && SUPERFUND_NPL.meta && SUPERFUND_NPL.meta.chemical_note) || ''}</p>
      <div class="sf-links" style="margin-top:12px">
        ${site.profile_url ? `<a href="${site.profile_url}" target="_blank" rel="noopener">EPA site progress profile</a>` : ''}
        ${site.narrative_url ? `<a href="${site.narrative_url}" target="_blank" rel="noopener">Listing narrative (PDF)</a>` : ''}
        ${site.final_fr ? `<a href="${site.final_fr}" target="_blank" rel="noopener">Final FR notice</a>` : ''}
        ${site.proposed_fr ? `<a href="${site.proposed_fr}" target="_blank" rel="noopener">Proposed FR notice</a>` : ''}
        ${site.deletion_fr ? `<a href="${site.deletion_fr}" target="_blank" rel="noopener">Deletion FR notice</a>` : ''}
        <a href="https://map22.epa.gov/cimc/superfund" target="_blank" rel="noopener">EPA CIMC Superfund map</a>
      </div>
    `;
    el.classList.add('open');
  }

  function openStateDossier(stateAbbr, sites) {
    const el = ensureDossier();
    $('sf-dossier-tag').textContent = 'EPA SUPERFUND · GROUPED BY STATE';
    $('sf-dossier-title').textContent = `${stateAbbr} — ${sites.length} site(s)`;
    const list = sites.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    $('sf-dossier-body').innerHTML = `
      <p class="sf-note">Click a site name for the full dossier (status, dates, chemical tags, EPA links).</p>
      <ul class="sf-state-list">
        ${list.map((s, i) => `
          <li data-idx="${i}">
            <strong>${s.name}</strong><br>
            ${statusBadge(s.status)}
            <span style="color:#5a6e78"> · ${s.city || s.county || ''}</span>
          </li>`).join('')}
      </ul>
    `;
    el.classList.add('open');
    el.querySelectorAll('.sf-state-list li').forEach((li) => {
      li.addEventListener('click', () => openSiteDossier(list[Number(li.dataset.idx)]));
    });
  }

  function markerIcon(status, groupCount) {
    if (groupCount != null) {
      const size = Math.max(22, Math.min(40, 16 + Math.sqrt(groupCount) * 5));
      return L.divIcon({
        className: '',
        html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#0e3a4f;color:#fff;border:none;box-shadow:none;display:flex;align-items:center;justify-content:center;font:650 10px ui-monospace,Consolas,monospace">${groupCount}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
    }
    const color = statusColor(status);
    const size = pointSize();
    return L.divIcon({
      className: '',
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:none;box-shadow:none"></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function createControlsHtml() {
    const data = global.SUPERFUND_NPL || { meta: {}, sites: [] };
    const statuses = (data.meta && data.meta.statuses) || [];
    const chems = (data.meta && data.meta.chemical_categories) || [];
    const states = [...new Set((data.sites || []).map((s) => s.state).filter(Boolean))].sort();
    return `
      <div class="sf-panel" id="sf-controls">
        <h2>USA Superfund (NPL)</h2>
        <label class="sf-check"><input type="checkbox" id="sf-enabled"> Show Superfund sites on map</label>
        <div class="field">
          <label for="sf-status">Site status</label>
          <select id="sf-status">
            <option value="ALL">All statuses</option>
            ${statuses.map((s) => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="sf-chem">Chemical information</label>
          <select id="sf-chem">
            <option value="ALL">All sites</option>
            <option value="ANY_TAG">Has chemical tag (from site name)</option>
            ${chems.map((c) => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="sf-state">Group / filter by state</label>
          <select id="sf-state">
            <option value="ALL">All states (USA)</option>
            ${states.map((s) => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Map grouping</label>
          <div class="mode">
            <label><input type="radio" name="sf-group" value="sites" checked> Individual sites</label>
            <label><input type="radio" name="sf-group" value="state"> Group by state (counts)</label>
          </div>
        </div>
        <div class="btnrow">
          <button class="btn" type="button" id="sf-apply">Apply Superfund</button>
        </div>
        <div id="sf-legend" class="note" style="margin-top:10px"></div>
        <p class="note">
          Sources:
          <a href="https://map22.epa.gov/cimc/superfund" target="_blank" rel="noopener">EPA CIMC Superfund</a>
          ·
          <a href="https://epa.maps.arcgis.com/apps/webappviewer/index.html?id=33cebcdfdd1b4c3a8b51d416956c41f1" target="_blank" rel="noopener">EPA EJ web map</a>.
          Click a symbol for the full site dossier.
        </p>
      </div>
    `;
  }

  function SuperfundOverlay(options) {
    this.map = options.map;
    this.mount = typeof options.mount === 'string' ? $(options.mount) : options.mount;
    this.getPageState = options.getPageState || (() => 'ALL');
    this.layer = null;
    this.sites = (global.SUPERFUND_NPL && global.SUPERFUND_NPL.sites) || [];
    injectStyles();
    ensureDossier();
    if (this.mount && !document.getElementById('sf-controls')) {
      this.mount.insertAdjacentHTML('beforeend', createControlsHtml());
    }
    const bind = () => {
      const apply = () => this.refresh();
      $('sf-apply') && $('sf-apply').addEventListener('click', apply);
      $('sf-enabled') && $('sf-enabled').addEventListener('change', apply);
    };
    bind();
  }

  SuperfundOverlay.prototype.filtered = function () {
    const enabled = $('sf-enabled') && $('sf-enabled').checked;
    if (!enabled) return [];
    const status = $('sf-status') ? $('sf-status').value : 'ALL';
    const chem = $('sf-chem') ? $('sf-chem').value : 'ALL';
    let st = $('sf-state') ? $('sf-state').value : 'ALL';
    // Prefer page state focus when Superfund state is ALL
    const pageState = this.getPageState();
    if (st === 'ALL' && pageState && pageState !== 'ALL') st = pageState;

    return this.sites.filter((s) => {
      if (status !== 'ALL' && s.status !== status) return false;
      if (st !== 'ALL' && s.state !== st) return false;
      if (chem === 'ANY_TAG' && !(s.chem_tags && s.chem_tags.length)) return false;
      if (chem !== 'ALL' && chem !== 'ANY_TAG' && !(s.chem_tags || []).includes(chem)) return false;
      return true;
    });
  };

  SuperfundOverlay.prototype.clear = function () {
    if (this.layer && this.map) {
      this.map.removeLayer(this.layer);
      this.layer = null;
    } else {
      this.layer = null;
    }
  };

  SuperfundOverlay.prototype.refresh = function () {
    this.clear();
    const rows = this.filtered();
    const legend = $('sf-legend');
    if (!$('sf-enabled') || !$('sf-enabled').checked) {
      if (legend) legend.innerHTML = 'Superfund layer off.';
      return;
    }
    if (!this.map) {
      if (legend) legend.innerHTML = 'Map not ready.';
      return;
    }
    const group = (document.querySelector('input[name="sf-group"]:checked') || {}).value || 'sites';
    this.layer = L.layerGroup().addTo(this.map);

    if (group === 'state') {
      const by = {};
      rows.forEach((s) => {
        (by[s.state] ||= []).push(s);
      });
      Object.keys(by).forEach((st) => {
        const list = by[st];
        const lat = list.reduce((a, s) => a + s.lat, 0) / list.length;
        const lon = list.reduce((a, s) => a + s.lon, 0) / list.length;
        const m = L.marker([lat, lon], { icon: markerIcon(null, list.length), title: `${st}: ${list.length} sites` });
        m.bindTooltip(`<b>${st}</b><br>${list.length} Superfund site(s)<br>Click for list`, { sticky: true });
        m.on('click', () => openStateDossier(st, list));
        m.addTo(this.layer);
      });
      if (legend) {
        legend.innerHTML = `<strong>${rows.length}</strong> sites in <strong>${Object.keys(by).length}</strong> states (grouped).`;
      }
    } else {
      rows.forEach((s) => {
        const m = L.marker([s.lat, s.lon], { icon: markerIcon(s.status), title: s.name });
        m.bindTooltip(`<b>${s.name}</b><br>${s.status}<br>${s.city || ''}, ${s.state}`, { sticky: true });
        m.on('click', () => openSiteDossier(s));
        m.addTo(this.layer);
      });
      if (legend) {
        const parts = STATUS_ORDER.map((k) =>
          `<div class="sf-legend-row"><span class="sf-dot" style="background:${statusColor(k)}"></span>${k}</div>`
        ).join('');
        legend.innerHTML = `<strong>${rows.length}</strong> sites shown.` + parts;
      }
    }
  };

  SuperfundOverlay.prototype.syncStateSelect = function (stateAbbr) {
    if (!$('sf-state') || !stateAbbr) return;
    // keep Superfund state aligned optionally — do not override user ALL
  };

  SuperfundOverlay.prototype.getCsvRows = function (bounds) {
    const rows = this.filtered();
    return rows.filter((s) => {
      if (!bounds) return true;
      return s.lat >= bounds.south && s.lat <= bounds.north
        && s.lon >= bounds.west && s.lon <= bounds.east;
    }).map((s) => ({
      dataset: 'Superfund NPL',
      id: s.id || '',
      name: s.name || '',
      status: s.status || '',
      state: s.state || '',
      city: s.city || '',
      county: s.county || '',
      lat: s.lat,
      lon: s.lon,
      chem_tags: (s.chem_tags || []).join('; '),
      epa_url: s.epa_url || s.url || '',
    }));
  };

  global.SuperfundOverlay = SuperfundOverlay;
  global.openSuperfundDossier = openSiteDossier;
})(window);
