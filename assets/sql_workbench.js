/**
 * Cross-layer SQL workbench for USA-Health Data Atlas.
 * Registers AlaSQL tables from atlas datasets, runs queries, maps & charts results.
 */
(function (global) {
  const USA_BOUNDS = [[24.5, -125], [49.5, -66.5]];
  const DEFAULT_PALETTE = 'ylorrd';
  const SOIL_SERVICE =
    'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Geochem_features/FeatureServer/2';
  const SOIL_MAX = 4000;
  const SOIL_PAGE = 2000;

  const STATE_NAME_TO_ABBR = {
    Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
    Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District Of Columbia': 'DC',
    'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI',
    Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS',
    Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA',
    Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
    Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
    'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND',
    Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
    'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX',
    Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV',
    Wisconsin: 'WI', Wyoming: 'WY', 'Puerto Rico': 'PR',
  };

  /** Alaska, Hawaii, and territories excluded from contiguous-U.S. pipeline filter. */
  const NON_CONUS_STATE_ABBR = new Set(['AK', 'HI', 'PR']);

  function matchesPipelineGeo(st, geo) {
    if (!geo || geo === 'ALL') return true;
    if (geo === 'CONUS') return !!st && !NON_CONUS_STATE_ABBR.has(st);
    return st === geo;
  }

  function pipelineGeoLabel(geo) {
    if (!geo || geo === 'ALL') return 'all counties';
    if (geo === 'CONUS') return 'contiguous U.S.';
    return geo;
  }

  const TABLE_DOCS = [
    { name: 'svi_counties', cols: 'fips, state_abbr, county, indicator, indicator_label, val', note: 'SVI 2022 · long form' },
    { name: 'svi_overall_counties', cols: 'fips, state_abbr, county, val', note: 'Overall SVI shortcut' },
    { name: 'svi_states', cols: 'state_abbr, indicator, indicator_label, val, n_counties', note: 'SVI state ranks' },
    { name: 'places_counties', cols: 'fips, state_abbr, county, measure, measure_label, val', note: 'CDC PLACES · long' },
    { name: 'places_obesity_counties', cols: 'fips, state_abbr, county, val', note: 'Obesity % shortcut' },
    { name: 'places_states', cols: 'state_abbr, measure, measure_label, val, n_counties', note: 'PLACES state means' },
    { name: 'mortality_counties', cols: 'fips, state_abbr, county, cause, cause_label, val, avg_count', note: 'HDPulse 2019–2023' },
    { name: 'mortality_states', cols: 'state_abbr, state_fips, state_name, cause, cause_label, val, avg_count', note: 'Mortality states' },
    { name: 'overdose_counties', cols: 'fips, state_abbr, county, layer, metric, year, val', note: 'CDC/NCHS overdose layers' },
    { name: 'cancer_counties', cols: 'fips, state_abbr, county, layer, site, year, val', note: 'State Cancer Profiles layers' },
    { name: 'superfund_sites', cols: 'id, name, status, state, state_abbr, city, county, lat, lon, score, chem_tags', note: 'EPA NPL points' },
    { name: 'aq_monitors', cols: 'pollutant, aqs_id, state_abbr, state, city, lat, lon, mean_2022…mean_2025, unit', note: 'AQS annual means' },
    { name: 'soil_samples', cols: 'lab_id, state, latitude, longitude, As_ppm, Pb_ppm, …', note: 'Load per state (ArcGIS)' },
    { name: 'chr_county_ranks', cols: 'year, fips, state_abbr, county, metric, val', note: 'Load CHR year(s)' },
    { name: 'chr_county_measures', cols: 'year, fips, state_abbr, county, measure, val', note: 'CHR measures (selected year)' },
    { name: 'chr_state_ranks', cols: 'year, state_abbr, metric, median_val, mean_val, …', note: 'CHR state ranks' },
    { name: 'chr_state_measures', cols: 'year, state_abbr, measure, median_val, …', note: 'CHR state measures' },
    { name: 'model_frame', cols: 'fips, county, state_abbr, state_name, year, y, chr_*, svi_*, places_*, mortality_*, overdose_*, cancer_*, census_*, religion_*, election_*, val', note: 'Built in Data Pipeline' },
  ];

  let map; let baseLayers; let currentBase;
  let choroplethGroup; let pointGroup; let choropleth; let legendCtrl;
  let lastRows = [];
  let chrLoaded = false;
  let chrLoadedYearsKey = '';
  let chrLoadPromise = null;

  function chrYearsKey(years) {
    return (years || []).join(',');
  }
  let soilStateLoaded = null;

  function $(id) { return document.getElementById(id); }

  function fmt(v) {
    if (v == null || v === '') return '—';
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
      if (Math.abs(v) >= 10) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
      return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
    }
    return String(v);
  }

  function setTable(name, rows) {
    alasql(`DROP TABLE IF EXISTS ${name}`);
    alasql(`CREATE TABLE ${name}`);
    alasql.tables[name].data = rows || [];
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  function buildSvi() {
    const data = global.SVI_DATA;
    if (!data) return { counties: 0, states: 0 };
    const inds = data.meta.indicators || [];
    const counties = [];
    (data.county_rows || []).forEach((r) => {
      inds.forEach((ind, i) => {
        const v = r[3][i];
        if (v == null) return;
        counties.push({
          fips: r[0], state_abbr: r[1], county: r[2],
          indicator: ind.code, indicator_label: ind.label, val: v,
        });
      });
    });
    const states = [];
    (data.state_rows || []).forEach((r) => {
      inds.forEach((ind, i) => {
        const v = r[2][i];
        if (v == null) return;
        states.push({
          state_abbr: r[0], n_counties: r[1],
          indicator: ind.code, indicator_label: ind.label, val: v,
        });
      });
    });
    setTable('svi_counties', counties);
    setTable('svi_states', states);
    // Convenience views for common joins (overall SVI)
    setTable('svi_overall_counties', counties.filter((r) => r.indicator === 'RPL_THEMES').map((r) => ({
      fips: r.fips, state_abbr: r.state_abbr, county: r.county, val: r.val,
    })));
    return { counties: counties.length, states: states.length };
  }

  function buildPlaces() {
    const data = global.PLACES_DATA;
    if (!data) return { counties: 0, states: 0 };
    const inds = data.meta.indicators || [];
    const codes = data.meta.codes || inds.map((x) => x.code);
    const byCode = {};
    inds.forEach((ind) => { byCode[ind.code] = ind; });
    const counties = [];
    (data.county_rows || []).forEach((r) => {
      codes.forEach((code, i) => {
        const v = r[3][i];
        if (v == null) return;
        const meta = byCode[code] || { code, label: code };
        counties.push({
          fips: r[0], state_abbr: r[1], county: r[2],
          measure: code, measure_label: meta.label || code, val: v,
        });
      });
    });
    const states = [];
    (data.state_rows || []).forEach((r) => {
      codes.forEach((code, i) => {
        const v = r[2][i];
        if (v == null) return;
        const meta = byCode[code] || { code, label: code };
        states.push({
          state_abbr: r[0], n_counties: r[1],
          measure: code, measure_label: meta.label || code, val: v,
        });
      });
    });
    setTable('places_counties', counties);
    setTable('places_states', states);
    setTable('places_obesity_counties', counties.filter((r) => r.measure === 'OBESITY').map((r) => ({
      fips: r.fips, state_abbr: r.state_abbr, county: r.county, val: r.val,
    })));
    return { counties: counties.length, states: states.length };
  }

  function buildMortality() {
    const data = global.MORTALITY_DATA;
    if (!data) return { counties: 0, states: 0 };
    const causes = data.meta.causes || [];
    const counties = [];
    (data.county_rows || []).forEach((r) => {
      causes.forEach((c, i) => {
        const v = r[3][i];
        if (v == null) return;
        counties.push({
          fips: r[0], state_abbr: r[1], county: r[2],
          cause: c.code, cause_label: c.label, val: v,
          avg_count: r[4] ? r[4][i] : null,
        });
      });
    });
    const states = [];
    (data.state_rows || []).forEach((r) => {
      causes.forEach((c, i) => {
        const v = r[3][i];
        if (v == null) return;
        states.push({
          state_abbr: r[0], state_fips: r[1], state_name: r[2],
          cause: c.code, cause_label: c.label, val: v,
          avg_count: r[4] ? r[4][i] : null,
        });
      });
    });
    setTable('mortality_counties', counties);
    setTable('mortality_states', states);
    return { counties: counties.length, states: states.length };
  }

  const OVERDOSE_LAYERS = {
    model: {
      globalKey: 'OVERDOSE_MODEL_DATA',
      label: 'Drug overdose — model-based',
      window: '2003–2021',
    },
    provisional: {
      globalKey: 'OVERDOSE_PROVISIONAL_DATA',
      label: 'Drug overdose — provisional',
      window: '2020→',
    },
    opioid: {
      globalKey: 'OVERDOSE_OPIOID_DATA',
      label: 'Opioid — VSRR allocated',
      window: '2020→',
    },
  };

  function getOverdosePack(layerKey) {
    const def = OVERDOSE_LAYERS[layerKey];
    if (!def) return null;
    return global[def.globalKey] || null;
  }

  function overdoseLayerYears(layerKey) {
    return getOverdosePack(layerKey)?.meta?.years || [];
  }

  function resolveOverdoseYear(layerKey, pipelineYear) {
    const years = overdoseLayerYears(layerKey);
    if (!years.length) return null;
    const y = Number(pipelineYear);
    if (years.includes(y)) return y;
    return years.reduce((best, cur) => (Math.abs(cur - y) < Math.abs(best - y) ? cur : best));
  }

  function buildOverdose() {
    const counties = [];
    Object.keys(OVERDOSE_LAYERS).forEach((layerKey) => {
      const pack = getOverdosePack(layerKey);
      if (!pack?.cols || !pack.rows) return;
      const { cols, rows } = pack;
      const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
      rows.forEach((r) => {
        if (ix.suppressed != null && r[ix.suppressed]) return;
        const fips = String(r[ix.fips]).padStart(5, '0');
        const st = r[ix.state_abbr];
        const county = r[ix.county_name] || r[ix.county] || fips;
        const yr = Number(r[ix.year]);
        ['crude_rate_per_100k', 'deaths'].forEach((metric) => {
          if (ix[metric] == null) return;
          const v = r[ix[metric]];
          if (v == null || !Number.isFinite(Number(v))) return;
          counties.push({
            fips,
            state_abbr: st,
            county,
            layer: layerKey,
            metric,
            year: yr,
            val: Number(v),
          });
        });
      });
    });
    setTable('overdose_counties', counties);
    return { counties: counties.length };
  }

  const CANCER_LAYERS = {
    incidence_ts: {
      globalKey: 'CANCER_INCIDENCE_TS_DATA',
      label: 'Incidence — annual synthetic',
      window: '2020–2025',
      hasYear: true,
    },
    incidence_5yr: {
      globalKey: 'CANCER_INCIDENCE_5YR_DATA',
      label: 'Incidence — observed pooled',
      window: '2017–2021',
      hasYear: false,
    },
    mortality_ts: {
      globalKey: 'CANCER_MORTALITY_TS_DATA',
      label: 'Mortality — reconstructed annual',
      window: '2019–2023',
      hasYear: true,
    },
  };

  function getCancerPack(layerKey) {
    const def = CANCER_LAYERS[layerKey];
    if (!def) return null;
    return global[def.globalKey] || null;
  }

  function cancerLayerYears(layerKey) {
    return getCancerPack(layerKey)?.meta?.years || [];
  }

  function parseCancerCode(code) {
    const i = code.indexOf(':');
    if (i < 0) throw new Error(`Invalid cancer code: ${code}`);
    return { layerKey: code.slice(0, i), site: code.slice(i + 1) };
  }

  function resolveCancerYear(layerKey, pipelineYear) {
    const def = CANCER_LAYERS[layerKey];
    if (!def?.hasYear) return null;
    const years = cancerLayerYears(layerKey);
    if (!years.length) return null;
    const y = Number(pipelineYear);
    if (years.includes(y)) return y;
    return years.reduce((best, cur) => (Math.abs(cur - y) < Math.abs(best - y) ? cur : best));
  }

  function buildCancer() {
    const counties = [];
    Object.entries(CANCER_LAYERS).forEach(([layerKey, def]) => {
      const pack = getCancerPack(layerKey);
      if (!pack?.cols || !pack.rows) return;
      const { cols, rows } = pack;
      const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
      rows.forEach((r) => {
        if (ix.suppressed != null && r[ix.suppressed]) return;
        const v = r[ix.age_adjusted_rate_per_100k];
        if (v == null || !Number.isFinite(Number(v))) return;
        const fips = String(r[ix.fips]).padStart(5, '0');
        counties.push({
          fips,
          state_abbr: r[ix.state_abbr],
          county: r[ix.county_name] || fips,
          layer: layerKey,
          site: r[ix.cancer_site],
          year: def.hasYear ? Number(r[ix.year]) : null,
          val: Number(v),
        });
      });
    });
    setTable('cancer_counties', counties);
    return { counties: counties.length };
  }

  function buildSuperfund() {
    const pack = global.SUPERFUND_NPL;
    if (!pack) return { sites: 0 };
    const sites = (pack.sites || []).map((s) => ({
      id: s.id || '',
      name: s.name || '',
      epa_id: s.epa_id || s.id || '',
      status: s.status || '',
      state: s.state || '',
      state_abbr: s.state || '',
      state_name: s.state_name || '',
      city: s.city || '',
      county: s.county || '',
      region: s.region,
      score: s.score,
      lat: s.lat,
      lon: s.lon,
      chem_tags: Array.isArray(s.chem_tags) ? s.chem_tags.join('; ') : (s.chem_tags || ''),
      profile_url: s.profile_url || s.epa_url || '',
    }));
    setTable('superfund_sites', sites);
    return { sites: sites.length };
  }

  function buildAir() {
    const pack = global.AIR_QUALITY_AQS;
    if (!pack) return { monitors: 0 };
    const monitors = (pack.sites || []).map((s) => {
      const means = s.means || {};
      const abbr = STATE_NAME_TO_ABBR[s.st] || s.st || '';
      return {
        pollutant: s.p || '',
        aqs_id: s.id || '',
        poc: s.poc,
        name: s.n || '',
        state: s.st || '',
        state_abbr: abbr,
        city: s.city || '',
        lat: s.lat,
        lon: s.lon,
        unit: s.unit || '',
        standard: s.std || '',
        mean_2022: means['2022'] != null ? means['2022'] : null,
        mean_2023: means['2023'] != null ? means['2023'] : null,
        mean_2024: means['2024'] != null ? means['2024'] : null,
        mean_2025: means['2025'] != null ? means['2025'] : null,
      };
    });
    setTable('aq_monitors', monitors);
    return { monitors: monitors.length };
  }

  function buildChr(yearFilter) {
    const data = global.CHR_DATA;
    if (!data) return { ranks: 0, measures: 0 };
    const year = Number(yearFilter) || data.meta.years?.[data.meta.years.length - 1] || 2024;

    const countyRanks = (data.county_ranks || []).filter((r) => r.year === year);
    const countyMeasures = (data.county_measures || []).filter((r) => r.year === year);

    setTable('chr_county_ranks', countyRanks);
    setTable('chr_county_measures', countyMeasures);
    setTable('chr_state_ranks', data.state_ranks || []);
    const stateMeasures = (data.state_measures || []).filter((r) => Number(r.year) === year);
    setTable('chr_state_measures', stateMeasures.length ? stateMeasures : (data.state_measures || []));
    return { ranks: countyRanks.length, measures: countyMeasures.length, year };
  }

  function mergeChrYearPacks(packs) {
    const merged = {
      meta: { years: [], overall_rank_metrics: [], measures: [] },
      counties: {},
      county_ranks: [],
      county_measures: [],
      state_ranks: [],
      state_measures: [],
    };
    packs.forEach((data) => {
      if (!data) return;
      merged.meta.years.push(data.meta.year);
      (data.meta.overall_rank_metrics || []).forEach((m) => {
        if (!merged.meta.overall_rank_metrics.includes(m)) merged.meta.overall_rank_metrics.push(m);
      });
      (data.meta.measures || []).forEach((m) => {
        if (!merged.meta.measures.includes(m)) merged.meta.measures.push(m);
      });
      Object.assign(merged.counties, data.counties || {});
      if (data.county_ranks?.length) merged.county_ranks = merged.county_ranks.concat(data.county_ranks);
      if (data.county_measures?.length) merged.county_measures = merged.county_measures.concat(data.county_measures);
      if (data.state_ranks?.length) merged.state_ranks = merged.state_ranks.concat(data.state_ranks);
      if (data.state_measures?.length) merged.state_measures = merged.state_measures.concat(data.state_measures);
    });
    merged.meta.years = [...new Set(merged.meta.years)].sort((a, b) => a - b);
    merged.meta.measures.sort();
    return merged;
  }

  async function ensureChrScripts() {
    if (!global.Papa) {
      await loadScript('https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js');
    }
    if (!global.ChrCsvLoader) {
      await loadScript('assets/chr_column_dictionary.js');
      await loadScript('assets/chr_csv_loader.js');
    }
    if (!global.ChrCsvLoader) throw new Error('CHR CSV loader failed to load.');
  }

  function normalizeChrYears(yearOverride, yearsOverride) {
    if (yearsOverride && yearsOverride.length) {
      return [...new Set(yearsOverride.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
    }
    const el = $('chr-year');
    const yearBox = typeof document !== 'undefined' ? document.getElementById('pipeline-year-checks') : null;
    if (yearBox) {
      const picked = [...yearBox.querySelectorAll('input[data-year]:checked')]
        .map((inp) => Number(inp.dataset.year))
        .filter(Number.isFinite);
      if (picked.length) return picked.sort((a, b) => a - b);
    }
    if (el?.multiple && el.selectedOptions?.length) {
      const picked = [...el.selectedOptions].map((o) => Number(o.value)).filter(Number.isFinite);
      if (picked.length) return picked.sort((a, b) => a - b);
    }
    const y = Number(yearOverride ?? el?.value) || 2024;
    return [y];
  }

  async function loadSoilForState(stateAbbr) {
    const meta = global.GEOCHEM_SOIL_META;
    if (!meta) throw new Error('Soil manifest not loaded.');
    if (!stateAbbr || stateAbbr === 'ALL' || stateAbbr === 'CONUS') {
      throw new Error('Pick a single state to load soil samples.');
    }
    const elemFields = (meta.meta.elements || []).map((e) => e.code);
    const metaFields = ['OBJECTID', 'lab_id', 'field_id', 'state', 'latitude', 'longitude', 'project_name'];
    const fields = metaFields.concat(elemFields);
    const out = [];
    let offset = 0;
    while (offset < SOIL_MAX) {
      const params = new URLSearchParams({
        where: `state='${stateAbbr}'`,
        outFields: fields.join(','),
        returnGeometry: 'true',
        outSR: '4326',
        resultOffset: String(offset),
        resultRecordCount: String(SOIL_PAGE),
        orderByFields: 'OBJECTID',
        f: 'pjson',
      });
      const res = await fetch(`${SOIL_SERVICE}/query?${params}`);
      if (!res.ok) throw new Error(`Soil query failed (${res.status})`);
      const data = await res.json();
      const feats = data.features || [];
      feats.forEach((f) => {
        const a = f.attributes || {};
        const g = f.geometry || {};
        const lat = a.latitude != null ? a.latitude : g.y;
        const lon = a.longitude != null ? a.longitude : g.x;
        if (lat == null || lon == null) return;
        const row = {
          lab_id: a.lab_id || '',
          field_id: a.field_id || '',
          state: a.state || stateAbbr,
          state_abbr: a.state || stateAbbr,
          latitude: lat,
          longitude: lon,
          lat,
          lon,
          project_name: a.project_name || '',
        };
        elemFields.forEach((code) => { row[code] = a[code]; });
        out.push(row);
      });
      if (feats.length < SOIL_PAGE) break;
      offset += SOIL_PAGE;
    }
    setTable('soil_samples', out);
    soilStateLoaded = stateAbbr;
    return out.length;
  }

  function registerCoreTables() {
    const stats = {};
    stats.svi = buildSvi();
    stats.places = buildPlaces();
    stats.mortality = buildMortality();
    stats.overdose = buildOverdose();
    stats.cancer = buildCancer();
    stats.superfund = buildSuperfund();
    stats.air = buildAir();
    setTable('soil_samples', []);
    setTable('chr_county_ranks', []);
    setTable('chr_county_measures', []);
    setTable('chr_state_ranks', []);
    setTable('chr_state_measures', []);
    return stats;
  }

  async function ensureChr(yearOverride, yearsOverride) {
    const years = normalizeChrYears(yearOverride, yearsOverride);
    const key = chrYearsKey(years);
    if (chrLoaded && global.CHR_DATA && chrLoadedYearsKey === key) {
      return buildChr(years[years.length - 1]);
    }
    if (chrLoadPromise) return chrLoadPromise;

    chrLoadPromise = (async () => {
      const status = $('status');
      if (status && !chrLoaded) {
        status.textContent = `Loading County Health Rankings (${years.join(', ')})…`;
        status.className = 'status';
      }
      try {
        await ensureChrScripts();
        const packs = [];
        for (const y of years) {
          packs.push(await global.ChrCsvLoader.loadYear(y));
        }
        global.CHR_DATA = mergeChrYearPacks(packs);
        chrLoaded = true;
        chrLoadedYearsKey = key;
        const reportYear = years[years.length - 1];
        const built = buildChr(reportYear);
        if (global.dispatchEvent) {
          queueMicrotask(() => {
            global.dispatchEvent(new CustomEvent('atlas-chr-loaded', { detail: { years: years.slice() } }));
          });
        }
        return built;
      } finally {
        chrLoadPromise = null;
      }
    })();

    return chrLoadPromise;
  }

  const ABBR_TO_STATE = Object.fromEntries(
    Object.entries(STATE_NAME_TO_ABBR).map(([name, abbr]) => [abbr, name])
  );

  function slugCol(prefix, label) {
    const core = String(label)
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase();
    return `${prefix}_${core}`.slice(0, 64);
  }

  function fallbackChrCatalog() {
    const dict = global.CHR_COLUMN_LABELS || {};
    const labels = [...new Set(Object.values(dict))].sort((a, b) => a.localeCompare(b));
    return labels.map((m) => ({
      id: `chr:${m}`, source: 'chr', code: m, label: m, group: 'Measure',
      unit: 'CHR (varies; diabetes/obesity as 0–1)',
    }));
  }

  function listPipelineVariables() {
    const placesInd = (global.PLACES_DATA?.meta?.indicators || []).filter((ind, i, arr) =>
      arr.findIndex((x) => x.code === ind.code) === i
    );
    const sviInd = global.SVI_DATA?.meta?.indicators || [];
    const chrRankMetrics = global.CHR_DATA?.meta?.overall_rank_metrics || [];
    const chrMeasures = global.CHR_DATA?.meta?.measures || [];
    const chrMeasureVars = chrMeasures.length
      ? chrMeasures.map((m) => ({
        id: `chr:${m}`, source: 'chr', code: m, label: m, group: 'Measure',
        unit: 'CHR (varies; diabetes/obesity as 0–1)',
      }))
      : fallbackChrCatalog();
    const chrRankVars = chrRankMetrics.map((m) => ({
      id: `chr-rank:${m}`, source: 'chr-rank', code: m, label: m, group: 'Rank',
      unit: 'CHR rank (lower is better)',
    }));
    const mortCauses = global.MORTALITY_DATA?.meta?.causes || [];
    const mortYears = global.MORTALITY_DATA?.meta?.year_group || '2019-2023';
    const censusInd = global.CENSUS_DEMOGRAPHY?.meta?.indicators || [];
    const censusYears = global.CENSUS_DEMOGRAPHY?.meta?.years || [];
    const electionInd = global.PRESIDENTIAL_ELECTION?.meta?.indicators || [];
    const electionYears = global.PRESIDENTIAL_ELECTION?.meta?.years || [];
    const electionVars = electionInd.map((ind) => ({
      id: `election:${ind.code}`,
      source: 'election',
      code: ind.code,
      label: ind.label || ind.code,
      group: ind.group || '',
      unit: ind.unit || '',
    }));
    const religionYears = global.RELIGION_CENSUS?.meta?.years || [];
    const religionMetrics = [
      { code: 'adherents', label: 'Adherents', unit: 'persons' },
      { code: 'congregations', label: 'Congregations', unit: 'count' },
      { code: 'rate', label: 'Adherence rate', unit: 'per 1,000 pop' },
      { code: 'pct_pop', label: '% of population', unit: '%' },
    ];
    const religionGroups = [];
    const relMeta = global.RELIGION_CENSUS?.meta || {};
    const relSlice = global.RELIGION_CENSUS?.by_year?.[String(
      religionYears[religionYears.length - 1] || 2020
    )];
    const relGroupMap = new Map((relSlice?.groups || []).map((g) => [g.code, g]));
    (relMeta.dominant_groups || []).forEach((g) => religionGroups.push({
      code: g.code, label: g.label, category: g.category || 'Dominant groups (10)',
    }));
    const totGroup = relGroupMap.get('tot');
    if (totGroup) {
      religionGroups.push({
        code: totGroup.code,
        label: totGroup.label,
        category: totGroup.category || 'Totals',
      });
    }
    const religionVars = [];
    religionGroups.forEach((g) => {
      religionMetrics.forEach((m) => {
        religionVars.push({
          id: `religion:${g.code}:${m.code}`,
          source: 'religion',
          code: `${g.code}:${m.code}`,
          label: `${g.label} — ${m.label}`,
          group: g.category || '',
          unit: m.unit,
        });
      });
    });
    const overdoseVars = [];
    Object.entries(OVERDOSE_LAYERS).forEach(([key, def]) => {
      const group = def.window || '';
      overdoseVars.push({
        id: `overdose:${key}:crude_rate_per_100k`,
        source: 'overdose',
        code: `${key}:crude_rate_per_100k`,
        label: `${def.label} — rate per 100k`,
        group,
        unit: 'per 100,000',
      });
      overdoseVars.push({
        id: `overdose:${key}:deaths`,
        source: 'overdose',
        code: `${key}:deaths`,
        label: `${def.label} — deaths`,
        group,
        unit: 'count',
      });
    });
    const cancerVars = [];
    Object.entries(CANCER_LAYERS).forEach(([key, def]) => {
      const pack = getCancerPack(key);
      const sites = pack?.meta?.sites || [];
      const group = def.window || '';
      sites.forEach((site) => {
        cancerVars.push({
          id: `cancer:${key}:${site}`,
          source: 'cancer',
          code: `${key}:${site}`,
          label: `${def.label} — ${site}`,
          group,
          unit: 'age-adjusted rate per 100,000',
        });
      });
    });
    const chrYears = global.CHR_DATA?.meta?.years || global.ChrCsvLoader?.YEARS || [2020, 2021, 2022, 2023, 2024, 2025];
    const pipelineYears = [...new Set([
      ...chrYears,
      ...censusYears,
      ...electionYears,
      ...religionYears,
      ...overdoseLayerYears('model'),
      ...overdoseLayerYears('provisional'),
      ...overdoseLayerYears('opioid'),
      ...cancerLayerYears('incidence_ts'),
      ...cancerLayerYears('mortality_ts'),
    ])].sort((a, b) => a - b);
    return {
      years: pipelineYears,
      mortalityYearGroup: mortYears,
      censusYears,
      electionYears,
      religionYears,
      overdoseYearNote: 'Overdose layers use nearest available year per tab (model 2003–2021; provisional/opioid 2020→).',
      religionYearNote: 'Religion Census uses nearest available year (2010 or 2020).',
      electionYearNote: 'Presidential election uses nearest available year (2004, 2008, 2012, 2016, 2020, or 2024).',
      chr: [...chrMeasureVars, ...chrRankVars].sort((a, b) => a.label.localeCompare(b.label)),
      svi: sviInd.map((ind) => ({
        id: `svi:${ind.code}`, source: 'svi', code: ind.code, label: ind.label || ind.code,
        group: ind.group || '', unit: 'percentile 0–1',
      })),
      places: placesInd.map((ind) => ({
        id: `places:${ind.code}`, source: 'places', code: ind.code, label: ind.label || ind.code,
        group: ind.group || '', unit: '%',
      })),
      mortality: mortCauses.map((c) => ({
        id: `mortality:${c.code}`, source: 'mortality', code: c.code, label: c.label || c.code,
        group: mortYears, unit: 'age-adjusted deaths per 100,000',
      })),
      census: censusInd.map((ind) => ({
        id: `census:${ind.code}`, source: 'census', code: ind.code, label: ind.label || ind.code,
        group: ind.group || '', unit: ind.unit || '',
      })),
      election: electionVars,
      religion: religionVars,
      overdose: overdoseVars,
      cancer: cancerVars,
    };
  }

  /** Map pipeline year → nearest Census PEP year available in the demography pack. */
  function resolveCensusYear(pipelineYear) {
    const years = global.CENSUS_DEMOGRAPHY?.meta?.years || [];
    if (!years.length) return null;
    const y = Number(pipelineYear);
    if (years.includes(y)) return y;
    return years.reduce((best, cur) =>
      (Math.abs(cur - y) < Math.abs(best - y) ? cur : best)
    );
  }

  /** Map pipeline year → nearest presidential election year in the returns pack. */
  function resolveElectionYear(pipelineYear) {
    const years = global.PRESIDENTIAL_ELECTION?.meta?.years || [];
    if (!years.length) return null;
    const y = Number(pipelineYear);
    if (years.includes(y)) return y;
    return years.reduce((best, cur) =>
      (Math.abs(cur - y) < Math.abs(best - y) ? cur : best)
    );
  }

  /** Map pipeline year → nearest Religion Census year (2010 or 2020). */
  function resolveReligionYear(pipelineYear) {
    const years = global.RELIGION_CENSUS?.meta?.years || [];
    if (!years.length) return null;
    const y = Number(pipelineYear);
    if (years.includes(y)) return y;
    return years.reduce((best, cur) =>
      (Math.abs(cur - y) < Math.abs(best - y) ? cur : best)
    );
  }

  function religionGroupLabel(groupCode, relYear) {
    const slice = global.RELIGION_CENSUS?.by_year?.[String(relYear)];
    const g = (slice?.groups || []).find((x) => x.code === groupCode);
    return g?.label || groupCode;
  }

  function ringCentroidLonLat(ring) {
    let sx = 0; let sy = 0; let n = 0;
    ring.forEach(([lon, lat]) => { sx += lon; sy += lat; n += 1; });
    return n ? [sy / n, sx / n] : null;
  }

  function geometryCentroidLonLat(geom) {
    if (!geom) return null;
    if (geom.type === 'Polygon') return ringCentroidLonLat(geom.coordinates[0]);
    if (geom.type === 'MultiPolygon') {
      let sx = 0; let sy = 0; let n = 0;
      geom.coordinates.forEach((poly) => {
        const c = ringCentroidLonLat(poly[0]);
        if (c) { sx += c[0]; sy += c[1]; n += 1; }
      });
      return n ? [sx / n, sy / n] : null;
    }
    return null;
  }

  /** NAD83 / Conus Albers (EPSG:5070) — x/y in meters. */
  function projectAlbers5070(latDeg, lonDeg) {
    const R = 6378137.0; // GRS 80 semi-major axis (EPSG:5070)
    const phi = latDeg * Math.PI / 180;
    const lambda = lonDeg * Math.PI / 180;
    const lambda0 = -96 * Math.PI / 180;
    const phi1 = 29.5 * Math.PI / 180;
    const phi2 = 45.5 * Math.PI / 180;
    const phi0 = 23 * Math.PI / 180;
    const n = 0.5 * (Math.sin(phi1) + Math.sin(phi2));
    const c = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
    const rho0 = Math.sqrt(c - 2 * n * Math.sin(phi0)) / n;
    const theta = n * (lambda - lambda0);
    const rho = Math.sqrt(c - 2 * n * Math.sin(phi)) / n;
    return {
      x: R * rho * Math.sin(theta),
      y: R * (rho0 - rho * Math.cos(theta)),
    };
  }

  const countyCentroid5070Cache = {};
  let countyCentroidsBuilt = false;

  function buildCountyCentroidCache() {
    if (countyCentroidsBuilt) return;
    const geo = global.COUNTY_GEO;
    if (!geo?.features) return;
    geo.features.forEach((f) => {
      const fips = featureFips(f);
      if (!fips) return;
      const ll = geometryCentroidLonLat(f.geometry);
      if (!ll) return;
      const proj = projectAlbers5070(ll[0], ll[1]);
      countyCentroid5070Cache[fips] = proj;
    });
    countyCentroidsBuilt = true;
  }

  function getCountyCentroid5070(fips) {
    buildCountyCentroidCache();
    return countyCentroid5070Cache[normalizeFips(fips)] || null;
  }

  function attachCountyCentroids(rows) {
    rows.forEach((r) => {
      const c = getCountyCentroid5070(r.fips);
      if (c) {
        r.centroid_x_m = Math.round(c.x);
        r.centroid_y_m = Math.round(c.y);
      }
    });
  }

  function aggregateFrameMeanByFips(rows) {
    const byFips = new Map();
    rows.forEach((r) => {
      const fips = normalizeFips(r.fips);
      if (!fips) return;
      if (!byFips.has(fips)) {
        byFips.set(fips, { row: { ...r }, sums: {}, counts: {} });
      }
      const bucket = byFips.get(fips);
      Object.keys(r).forEach((k) => {
        const v = r[k];
        if (typeof v === 'number' && Number.isFinite(v)) {
          bucket.sums[k] = (bucket.sums[k] || 0) + v;
          bucket.counts[k] = (bucket.counts[k] || 0) + 1;
        } else if (bucket.row[k] == null || bucket.row[k] === '') {
          bucket.row[k] = v;
        }
      });
    });
    return [...byFips.values()].map(({ row, sums, counts }) => {
      const out = { ...row };
      Object.keys(sums).forEach((k) => {
        out[k] = sums[k] / counts[k];
      });
      out.year = 'mean';
      return out;
    });
  }

  function normalizePipelineYears(opts) {
    if (opts.years && opts.years.length) {
      return [...new Set(opts.years.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
    }
    const y = Number(opts.year);
    return Number.isFinite(y) ? [y] : [2024];
  }

  /**
   * Build a wide county modeling dataframe.
   * opts: { year|years, stateAbbr|'ALL'|'CONUS', outcomeId, featureIds, includeCentroids }
   * outcomeId / featureIds like "places:DIABETES", "chr:Adult Obesity",
   * "svi:RPL_THEMES", "mortality:254", "census:PCT_65PLUS", "religion:dom_cath:adherents", "election:margin_pct"
   */
  async function buildModelingFrame(opts) {
    const years = normalizePipelineYears(opts);
    const yearAggregate = opts.yearAggregate === 'mean' ? 'mean' : 'panel';
    const pipelineGeo = opts.stateAbbr || 'ALL';
    const includeCentroids = !!opts.includeCentroids;
    const outcomeId = opts.outcomeId;
    const featureIds = (opts.featureIds || []).filter((id) => id && id !== outcomeId);
    if (!outcomeId) throw new Error('Select an outcome (Y) variable.');
    if (!featureIds.length) throw new Error('Select at least one feature variable.');

    const needsChr = /^(chr|chr-rank):/.test(outcomeId)
      || featureIds.some((id) => /^(chr|chr-rank):/.test(id));
    if (needsChr) await ensureChr(null, years);

    const parseId = (id) => {
      const i = id.indexOf(':');
      return { source: id.slice(0, i), code: id.slice(i + 1) };
    };
    const outcome = parseId(outcomeId);
    const features = featureIds.map(parseId);

    const byKey = new Map();

    function rowKey(fips, yr) {
      return `${normalizeFips(fips)}|${yr}`;
    }

    function ensureRow(fips, yr, state, county) {
      const fipsNorm = normalizeFips(fips);
      const key = rowKey(fipsNorm, yr);
      let row = byKey.get(key);
      if (!row) {
        row = {
          fips: fipsNorm,
          county: county || fipsNorm,
          state_abbr: state || '',
          state_name: ABBR_TO_STATE[state] || state || '',
          year: yr,
        };
        byKey.set(key, row);
      } else {
        if (!row.county && county) row.county = county;
        if (!row.state_abbr && state) {
          row.state_abbr = state;
          row.state_name = ABBR_TO_STATE[state] || state;
        }
      }
      return row;
    }

    function applyLong(source, code, colName, isY, frameYear) {
      if (source === 'places') {
        const data = global.PLACES_DATA;
        if (!data) throw new Error('PLACES / Health Experience data not loaded.');
        const idx = (data.meta.codes || []).indexOf(code);
        if (idx < 0) throw new Error(`Unknown PLACES measure: ${code}`);
        (data.county_rows || []).forEach((r) => {
          const fips = r[0];
          const st = r[1];
          if (!matchesPipelineGeo(st, pipelineGeo)) return;
          const v = r[3][idx];
          if (v == null || !Number.isFinite(Number(v))) return;
          const row = ensureRow(fips, frameYear, st, r[2]);
          const num = Number(v);
          row[colName] = num;
          if (isY) row.val = num;
        });
        return;
      }
      if (source === 'svi') {
        const data = global.SVI_DATA;
        if (!data) throw new Error('SVI data not loaded.');
        const inds = data.meta.indicators || [];
        const idx = inds.findIndex((ind) => ind.code === code);
        if (idx < 0) throw new Error(`Unknown SVI indicator: ${code}`);
        (data.county_rows || []).forEach((r) => {
          const fips = r[0];
          const st = r[1];
          if (!matchesPipelineGeo(st, pipelineGeo)) return;
          const v = r[3][idx];
          if (v == null || !Number.isFinite(Number(v))) return;
          const row = ensureRow(fips, frameYear, st, r[2]);
          const num = Number(v);
          row[colName] = num;
          if (isY) row.val = num;
        });
        return;
      }
      if (source === 'chr') {
        const data = global.CHR_DATA;
        if (!data) throw new Error('CHR data not loaded.');
        (data.county_measures || []).forEach((r) => {
          if (r.year !== frameYear || r.measure !== code) return;
          const fips = r.fips;
          const st = r.state_abbr;
          if (!matchesPipelineGeo(st, pipelineGeo)) return;
          const v = r.val;
          if (v == null || !Number.isFinite(Number(v))) return;
          const row = ensureRow(fips, frameYear, st, r.county || fips);
          const num = Number(v);
          row[colName] = num;
          if (isY) row.val = num;
        });
        return;
      }
      if (source === 'chr-rank') {
        const data = global.CHR_DATA;
        if (!data) throw new Error('CHR data not loaded.');
        (data.county_ranks || []).forEach((r) => {
          if (r.year !== frameYear || r.metric !== code) return;
          const fips = r.fips;
          const st = r.state_abbr;
          if (!matchesPipelineGeo(st, pipelineGeo)) return;
          const v = r.val;
          if (v == null || !Number.isFinite(Number(v))) return;
          const row = ensureRow(fips, frameYear, st, r.county || fips);
          const num = Number(v);
          row[colName] = num;
          if (isY) row.val = num;
        });
        return;
      }
      if (source === 'mortality') {
        const data = global.MORTALITY_DATA;
        if (!data) throw new Error('USA Mortality data not loaded.');
        const causes = data.meta.causes || [];
        const idx = causes.findIndex((c) => String(c.code) === String(code));
        if (idx < 0) throw new Error(`Unknown mortality cause: ${code}`);
        (data.county_rows || []).forEach((r) => {
          const fips = r[0];
          const st = r[1];
          if (!matchesPipelineGeo(st, pipelineGeo)) return;
          const v = r[3][idx];
          if (v == null || !Number.isFinite(Number(v))) return;
          const row = ensureRow(fips, frameYear, st, r[2]);
          const num = Number(v);
          row[colName] = num;
          if (isY) row.val = num;
        });
        return;
      }
      if (source === 'census') {
        const data = global.CENSUS_DEMOGRAPHY;
        if (!data) throw new Error('Census Demography data not loaded.');
        const codes = data.meta.codes || (data.meta.indicators || []).map((ind) => ind.code);
        const years = data.meta.years || [];
        const indIdx = codes.indexOf(code);
        if (indIdx < 0) throw new Error(`Unknown Census indicator: ${code}`);
        const cy = resolveCensusYear(frameYear);
        const yIdx = years.indexOf(cy);
        if (yIdx < 0) throw new Error(`Census year not available for pipeline year ${frameYear}.`);
        const flatIdx = indIdx * years.length + yIdx;
        (data.county_rows || []).forEach((r) => {
          const fips = r[0];
          const st = r[1];
          if (!matchesPipelineGeo(st, pipelineGeo)) return;
          const v = r[3][flatIdx];
          if (v == null || !Number.isFinite(Number(v))) return;
          const row = ensureRow(fips, frameYear, st, r[2]);
          const num = Number(v);
          row[colName] = num;
          if (isY) row.val = num;
        });
        return;
      }
      if (source === 'election') {
        const data = global.PRESIDENTIAL_ELECTION;
        if (!data) throw new Error('Presidential election data not loaded.');
        const codes = data.meta.codes || (data.meta.indicators || []).map((ind) => ind.code);
        const years = data.meta.years || [];
        const indIdx = codes.indexOf(code);
        if (indIdx < 0) throw new Error(`Unknown election metric: ${code}`);
        const ey = resolveElectionYear(frameYear);
        const yIdx = years.indexOf(ey);
        if (yIdx < 0) throw new Error(`Election year not available for pipeline year ${frameYear}.`);
        const flatIdx = indIdx * years.length + yIdx;
        (data.county_rows || []).forEach((r) => {
          const fips = r[0];
          const st = r[1];
          if (!matchesPipelineGeo(st, pipelineGeo)) return;
          const v = r[3][flatIdx];
          if (v == null || !Number.isFinite(Number(v))) return;
          const row = ensureRow(fips, frameYear, st, r[2]);
          const num = Number(v);
          row[colName] = num;
          if (isY) row.val = num;
        });
        return;
      }
      if (source === 'religion') {
        const data = global.RELIGION_CENSUS;
        if (!data) throw new Error('Religion Census data not loaded.');
        const [groupCode, metric] = code.split(':');
        const ry = resolveReligionYear(frameYear);
        const slice = data.by_year?.[String(ry)];
        if (!slice) throw new Error(`Religion Census year not available for pipeline year ${frameYear}.`);
        const gi = slice.group_codes.indexOf(groupCode);
        if (gi < 0) throw new Error(`Unknown religion group: ${groupCode}`);
        const metricCodes = data.meta.metric_codes || ['adherents', 'congregations', 'rate'];
        const nMet = metricCodes.length;
        const adhIdx = gi * nMet + metricCodes.indexOf('adherents');
        const mi = metric === 'pct_pop' ? -1 : metricCodes.indexOf(metric);
        if (metric !== 'pct_pop' && mi < 0) throw new Error(`Unknown religion metric: ${metric}`);
        (slice.county_rows || []).forEach((r) => {
          const fips = r[0];
          const st = r[1];
          if (!matchesPipelineGeo(st, pipelineGeo)) return;
          let v;
          if (metric === 'pct_pop') {
            const pop = r[3];
            const adh = r[4][adhIdx];
            if (adh == null || !Number.isFinite(Number(adh)) || !pop) return;
            v = 100 * Number(adh) / Number(pop);
          } else {
            const flatIdx = gi * nMet + mi;
            v = r[4][flatIdx];
          }
          if (v == null || !Number.isFinite(Number(v))) return;
          const row = ensureRow(fips, frameYear, st, r[2]);
          const num = Number(v);
          row[colName] = num;
          if (isY) row.val = num;
        });
        return;
      }
      if (source === 'overdose') {
        const [layerKey, metric] = code.split(':');
        const pack = getOverdosePack(layerKey);
        if (!pack) throw new Error('USA Overdose Mortality data not loaded.');
        const oy = resolveOverdoseYear(layerKey, frameYear);
        if (oy == null) throw new Error(`No overdose data for layer: ${layerKey}.`);
        const { cols, rows } = pack;
        const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
        if (ix[metric] == null) throw new Error(`Unknown overdose metric: ${metric}`);
        rows.forEach((r) => {
          if (Number(r[ix.year]) !== oy) return;
          if (ix.suppressed != null && r[ix.suppressed]) return;
          const fips = String(r[ix.fips]).padStart(5, '0');
          const st = r[ix.state_abbr];
          if (!matchesPipelineGeo(st, pipelineGeo)) return;
          const v = r[ix[metric]];
          if (v == null || !Number.isFinite(Number(v))) return;
          const county = r[ix.county_name] || fips;
          const row = ensureRow(fips, frameYear, st, county);
          const num = Number(v);
          row[colName] = num;
          if (isY) row.val = num;
        });
        return;
      }
      if (source === 'cancer') {
        const { layerKey, site } = parseCancerCode(code);
        const pack = getCancerPack(layerKey);
        if (!pack) throw new Error('USA Cancer Atlas data not loaded.');
        const def = CANCER_LAYERS[layerKey];
        const hasYear = def?.hasYear !== false;
        const cy = hasYear ? resolveCancerYear(layerKey, frameYear) : null;
        if (hasYear && cy == null) throw new Error(`No cancer data for layer: ${layerKey}.`);
        const { cols, rows } = pack;
        const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
        rows.forEach((r) => {
          if (r[ix.cancer_site] !== site) return;
          if (hasYear && Number(r[ix.year]) !== cy) return;
          if (ix.suppressed != null && r[ix.suppressed]) return;
          const v = r[ix.age_adjusted_rate_per_100k];
          if (v == null || !Number.isFinite(Number(v))) return;
          const fips = String(r[ix.fips]).padStart(5, '0');
          const st = r[ix.state_abbr];
          if (!matchesPipelineGeo(st, pipelineGeo)) return;
          const county = r[ix.county_name] || fips;
          const row = ensureRow(fips, frameYear, st, county);
          const num = Number(v);
          row[colName] = num;
          if (isY) row.val = num;
        });
        return;
      }
      throw new Error(`Unknown source: ${source}`);
    }

    function colNameFor(source, code) {
      if (source === 'mortality') {
        const cause = (global.MORTALITY_DATA?.meta?.causes || [])
          .find((c) => String(c.code) === String(code));
        return slugCol('mortality', cause?.label || code);
      }
      if (source === 'census') {
        const ind = (global.CENSUS_DEMOGRAPHY?.meta?.indicators || [])
          .find((i) => i.code === code);
        return slugCol('census', ind?.label || code);
      }
      if (source === 'election') {
        const ind = (global.PRESIDENTIAL_ELECTION?.meta?.indicators || [])
          .find((i) => i.code === code);
        return slugCol('election', ind?.label || code);
      }
      if (source === 'religion') {
        const [groupCode, metric] = code.split(':');
        const ry = (global.RELIGION_CENSUS?.meta?.years || [2020]).slice(-1)[0];
        const label = religionGroupLabel(groupCode, ry);
        const metricLabel = metric === 'pct_pop' ? 'pct_pop' : metric;
        return slugCol('religion', `${label}_${metricLabel}`);
      }
      if (source === 'overdose') {
        const [layerKey, metric] = code.split(':');
        const suffix = metric === 'deaths' ? 'deaths' : 'rate';
        return slugCol('overdose', `${layerKey}_${suffix}`);
      }
      if (source === 'cancer') {
        const { layerKey, site } = parseCancerCode(code);
        return slugCol('cancer', `${layerKey}_${site}`);
      }
      if (source === 'chr-rank') return slugCol('chr_rank', code);
      return slugCol(source, code);
    }

    const yCol = outcome.source === 'places' && outcome.code === 'DIABETES'
      ? 'diabetes_prevalence'
      : outcome.source === 'chr' && outcome.code === 'Diabetes Prevalence'
        ? 'diabetes_prevalence'
        : outcome.source === 'mortality' && String(outcome.code) === '254'
          ? 'diabetes_mortality_rate'
          : outcome.source === 'mortality'
            ? colNameFor('mortality', outcome.code).replace(/^mortality_/, 'y_')
            : outcome.source === 'overdose'
              ? colNameFor('overdose', outcome.code)
            : outcome.source === 'cancer'
              ? colNameFor('cancer', outcome.code)
              : outcome.source === 'election'
                ? colNameFor('election', outcome.code)
              : outcome.source === 'religion'
                ? colNameFor('religion', outcome.code)
                : slugCol('y', outcome.code);
    const featureCols = features.map((f) => colNameFor(f.source, f.code));
    if (includeCentroids) {
      featureCols.push('centroid_x_m', 'centroid_y_m');
    }

    years.forEach((yr) => {
      applyLong(outcome.source, outcome.code, yCol, true, yr);
      features.forEach((f) => {
        const col = colNameFor(f.source, f.code);
        applyLong(f.source, f.code, col, false, yr);
      });
    });

    // Keep rows that have Y; drop if all features missing
    let rows = [...byKey.values()].filter((r) => r[yCol] != null && Number.isFinite(r[yCol]));
    if (includeCentroids) attachCountyCentroids(rows);
    rows.sort((a, b) => String(a.fips).localeCompare(String(b.fips)) || (a.year - b.year));

    // Prefer complete cases for modeling convenience
    const complete = rows.filter((r) => featureCols.every((c) => r[c] != null && Number.isFinite(r[c])));
    let used = complete.length >= Math.max(50, rows.length * 0.35) ? complete : rows;
    if (yearAggregate === 'mean') {
      used = aggregateFrameMeanByFips(used);
      used.sort((a, b) => String(a.fips).localeCompare(String(b.fips)));
    }

    setTable('model_frame', used);
    lastRows = used;

    // Table/chart always; map only if Leaflet groups are ready (EDA map may still be hidden).
    let mapNote = 'Frame ready — open EDA to map.';
    try {
      if (mapReady()) mapNote = mapResults(used);
    } catch (err) {
      console.warn('Map update skipped:', err);
      mapNote = 'Frame ready — map update deferred until EDA.';
    }
    setKPIs(used, mapNote);
    renderTable(used);
    renderChart(used);

    const sqlHint = `SELECT * FROM model_frame ORDER BY ${yCol} DESC LIMIT 100`;
    const sqlEl = $('sql');
    if (sqlEl) sqlEl.value = sqlHint;
    const sqlBox = $('sql-used');
    const yearLabel = yearAggregate === 'mean'
      ? `mean of ${years.length === 1 ? years[0] : `${years[0]}–${years[years.length - 1]}`}`
      : (years.length === 1
        ? String(years[0])
        : `${years[0]}–${years[years.length - 1]} (${years.length} yrs)`);
    if (sqlBox) {
      sqlBox.hidden = false;
      sqlBox.textContent = `-- Modeling frame (${yearLabel}, ${pipelineGeoLabel(pipelineGeo)})\n${sqlHint}`;
    }

    return {
      rows: used,
      n: used.length,
      nRaw: rows.length,
      year: years.length === 1 ? years[0] : years,
      years,
      yearAggregate,
      state: pipelineGeo,
      yCol,
      featureCols,
      outcomeId,
      featureIds,
      includeCentroids,
    };
  }

  function applyResultRows(rows, note) {
    lastRows = rows || [];
    const mapNote = mapResults(lastRows);
    setKPIs(lastRows, mapNote);
    renderTable(lastRows);
    renderChart(lastRows);
    const status = $('status');
    if (status) {
      status.textContent = note || `Loaded ${lastRows.length.toLocaleString()} row(s). ${mapNote}`;
      status.className = 'status ok';
    }
  }

  function colorScale(colors, vmin, vmax, v) {
    if (!Number.isFinite(v) || vmax <= vmin) return '#cbd5e1';
    const t = Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin)));
    const idx = Math.min(colors.length - 1, Math.floor(t * (colors.length - 1)));
    return colors[idx];
  }

  function fmtBreak(v) {
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
    if (Math.abs(v) >= 10) return v.toFixed(1);
    if (Math.abs(v) >= 1) return v.toFixed(2);
    return v.toFixed(3);
  }

  function classificationLabel(method) {
    const labels = {
      quantile: 'Quantile',
      equal: 'Equal interval',
      natural: 'Natural breaks',
      stddev: 'Std. deviation',
    };
    return labels[method] || method;
  }

  function getVizMapStyle() {
    const classification = ($('viz-classification') && $('viz-classification').value) || 'quantile';
    const nClasses = Number(($('viz-classes') && $('viz-classes').value) || 5);
    let boundaryColor = ($('viz-boundary-color') && $('viz-boundary-color').value) || '#334155';
    if (boundaryColor === 'custom') {
      boundaryColor = ($('viz-boundary-color-custom') && $('viz-boundary-color-custom').value) || '#334155';
    }
    const boundaryType = ($('viz-boundary-type') && $('viz-boundary-type').value) || 'solid';
    const boundaryWeight = Number(($('viz-boundary-weight') && $('viz-boundary-weight').value) || 0.5);
    return { classification, nClasses, boundaryColor, boundaryType, boundaryWeight };
  }

  function boundaryStrokeStyle(style) {
    if (!style || style.boundaryType === 'none') {
      return { color: 'transparent', weight: 0, dashArray: null };
    }
    const dashArray = style.boundaryType === 'dashed' ? '8 4'
      : style.boundaryType === 'dotted' ? '2 4'
        : null;
    return {
      color: style.boundaryColor || '#334155',
      weight: Number.isFinite(style.boundaryWeight) ? style.boundaryWeight : 0.5,
      dashArray,
    };
  }

  function resizePalette(base, n) {
    const count = Math.max(3, Math.min(9, n || 5));
    if (!base.length) return base;
    if (base.length === count) return base.slice();
    if (base.length > count) {
      const out = [];
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : i / (count - 1);
        out.push(base[Math.min(base.length - 1, Math.round(t * (base.length - 1)))]);
      }
      return out;
    }
    return base.slice();
  }

  function quantileBreaks(sorted, k) {
    if (!sorted.length) return [];
    const breaks = [sorted[0]];
    for (let i = 1; i < k; i++) {
      const idx = Math.min(sorted.length - 1, Math.floor((i / k) * sorted.length));
      breaks.push(sorted[idx]);
    }
    breaks.push(sorted[sorted.length - 1]);
    return [...new Set(breaks)].sort((a, b) => a - b);
  }

  function equalBreaks(vmin, vmax, k) {
    if (!Number.isFinite(vmin) || !Number.isFinite(vmax) || vmax <= vmin) return [vmin, vmax];
    const step = (vmax - vmin) / k;
    return Array.from({ length: k + 1 }, (_, i) => vmin + i * step);
  }

  function jenksBreaks(data, k) {
    const sorted = data.filter(Number.isFinite).sort((a, b) => a - b);
    const n = sorted.length;
    if (n <= k) return [...new Set(sorted)];
    const mat1 = Array.from({ length: n + 1 }, () => Array(k + 1).fill(0));
    const mat2 = Array.from({ length: n + 1 }, () => Array(k + 1).fill(0));
    for (let i = 1; i <= k; i++) {
      mat1[1][i] = 1;
      mat2[1][i] = 0;
      for (let j = 2; j <= n; j++) mat2[j][i] = Infinity;
    }
    for (let l = 2; l <= n; l++) {
      let s1 = 0; let s2 = 0; let w = 0;
      for (let m = 1; m <= l; m++) {
        const i3 = l - m + 1;
        const val = sorted[i3 - 1];
        s1 += val;
        s2 += val * val;
        w += 1;
        const variance = s2 - (s1 * s1) / w;
        const i4 = i3 - 1;
        if (i4 !== 0) {
          for (let j = 2; j <= k; j++) {
            if (mat2[l][j] >= variance + mat2[i4][j - 1]) {
              mat1[l][j] = i3;
              mat2[l][j] = variance + mat2[i4][j - 1];
            }
          }
        }
      }
      mat1[l][1] = 1;
      mat2[l][1] = s2 - (s1 * s1) / w;
    }
    const breaks = [sorted[n - 1]];
    let kclass = n;
    for (let j = k; j >= 2; j--) {
      const idx = mat1[kclass][j] - 2;
      breaks.push(sorted[idx >= 0 ? idx : 0]);
      kclass = mat1[kclass][j] - 1;
    }
    breaks.push(sorted[0]);
    return [...new Set(breaks)].sort((a, b) => a - b);
  }

  function stddevBreaks(vals) {
    const finite = vals.filter(Number.isFinite);
    if (!finite.length) return [];
    const mean = finite.reduce((s, v) => s + v, 0) / finite.length;
    const std = Math.sqrt(finite.reduce((s, v) => s + (v - mean) ** 2, 0) / finite.length) || 1e-9;
    const raw = [finite[0], mean - 2 * std, mean - std, mean, mean + std, mean + 2 * std, finite[finite.length - 1]];
    return [...new Set(raw.filter(Number.isFinite))].sort((a, b) => a - b);
  }

  function computeBreaks(vals, method, nClasses, vmin, vmax) {
    const finite = vals.filter(Number.isFinite);
    if (!finite.length) return [0, 1];
    const lo = vmin != null ? vmin : Math.min(...finite);
    const hi = vmax != null ? vmax : Math.max(...finite);
    const sorted = finite.slice().sort((a, b) => a - b);
    const k = Math.max(3, Math.min(9, nClasses || 5));
    if (method === 'equal') return equalBreaks(lo, hi, k);
    if (method === 'natural') return jenksBreaks(sorted, k);
    if (method === 'stddev') return stddevBreaks(sorted);
    return quantileBreaks(sorted, k);
  }

  function classIndex(v, breaks) {
    if (!Number.isFinite(v) || !breaks.length) return -1;
    for (let i = breaks.length - 2; i >= 0; i--) {
      if (v >= breaks[i]) return i;
    }
    return 0;
  }

  function colorFromBreaks(v, breaks, colors) {
    const idx = classIndex(v, breaks);
    if (idx < 0) return '#cbd5e1';
    return colors[Math.min(colors.length - 1, idx)] || colors[colors.length - 1];
  }

  function buildChoroplethScale(vals, style) {
    const vmin = Math.min(...vals);
    const vmax = Math.max(...vals);
    const colors = resizePalette(paletteColors(), style.nClasses);
    const breaks = computeBreaks(vals, style.classification, style.nClasses, vmin, vmax);
    return { vmin, vmax, colors, breaks };
  }

  function fillColorForValue(v, scale) {
    if (!Number.isFinite(v)) return '#cbd5e1';
    if (scale.breaks && scale.breaks.length > 1) return colorFromBreaks(v, scale.breaks, scale.colors);
    return colorScale(scale.colors, scale.vmin, scale.vmax, v);
  }

  function featureFips(feature) {
    let fid = feature.id;
    if (fid == null && feature.properties) {
      if (feature.properties.GEO_ID != null) fid = feature.properties.GEO_ID;
      else if (feature.properties.STATE != null && feature.properties.COUNTY != null) {
        fid = String(feature.properties.STATE).padStart(2, '0')
          + String(feature.properties.COUNTY).padStart(3, '0');
      }
    }
    return normalizeFips(fid);
  }

  function normalizeFips(v) {
    if (v == null || v === '') return '';
    const digits = String(v).replace(/\D/g, '');
    if (!digits) return '';
    return (digits.length > 5 ? digits.slice(-5) : digits).padStart(5, '0');
  }

  function ensureChoroplethOnMap() {
    if (!map || !choroplethGroup) return;
    if (!map.hasLayer(choroplethGroup)) map.addLayer(choroplethGroup);
    if (pointGroup && !map.hasLayer(pointGroup)) map.addLayer(pointGroup);
  }

  function mapHasSize() {
    const el = map && map.getContainer && map.getContainer();
    return !!(el && el.clientWidth > 40 && el.clientHeight > 40);
  }

  function safeFitBounds(target, opts) {
    if (!map || !mapHasSize() || !target) return;
    try {
      const bounds = typeof target.getBounds === 'function' ? target.getBounds() : target;
      if (!bounds || typeof bounds.isValid !== 'function' || !bounds.isValid()) return;
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      if (!sw || !ne) return;
      if (![sw.lat, sw.lng, ne.lat, ne.lng].every(Number.isFinite)) return;
      map.fitBounds(bounds, opts || {});
    } catch (err) {
      console.warn('fitBounds skipped:', err);
    }
  }

  function mapReady() {
    return !!(map && choroplethGroup && pointGroup);
  }

  function initMap() {
    if (mapReady()) {
      setTimeout(() => { try { if (mapHasSize()) map.invalidateSize(); } catch (_) { /* ignore */ } }, 50);
      return;
    }
    const el = $('map');
    if (!el || !global.L) return;

    map = L.map(el, {
      zoomControl: false,
      worldCopyJump: false,
      maxBounds: L.latLngBounds([-10, -180], [72, -40]),
      maxBoundsViscosity: 0.85,
      minZoom: 3,
    });
    // Hidden EDA tab has 0×0 size — fitBounds would throw Invalid LatLng (NaN, NaN).
    if (el.clientWidth > 40 && el.clientHeight > 40) {
      map.fitBounds(USA_BOUNDS, { padding: [10, 10] });
    } else {
      map.setView([39.5, -98.35], 4);
    }

    baseLayers = {
      esri: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri', maxZoom: 18,
      }),
      osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 19,
      }),
      topo: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri', maxZoom: 18,
      }),
    };
    currentBase = baseLayers.osm.addTo(map);
    choroplethGroup = L.layerGroup().addTo(map);
    pointGroup = L.layerGroup().addTo(map);

    if (global.attachMapZoomControl) attachMapZoomControl(map, { bounds: USA_BOUNDS });
    if (global.attachMapLayersControl) {
      // Keep county choropleth always on the map (not a removable overlay).
      attachMapLayersControl(map, baseLayers, {
        selectId: 'basemap',
        overlays: { 'Point results': pointGroup },
        onChange(key) { currentBase = baseLayers[key] || currentBase; },
      });
    }
    setTimeout(() => {
      try {
        if (mapHasSize()) {
          map.invalidateSize();
          safeFitBounds(L.latLngBounds(USA_BOUNDS), { padding: [10, 10] });
        }
      } catch (_) { /* ignore */ }
    }, 50);
  }

  function setBasemap(key) {
    if (!mapReady() || !baseLayers) return;
    const next = baseLayers[key] || baseLayers.osm;
    if (currentBase === next && map.hasLayer(next)) return;
    if (currentBase) map.removeLayer(currentBase);
    currentBase = next.addTo(map);
  }

  function clearMapLayers() {
    if (choroplethGroup) choroplethGroup.clearLayers();
    if (pointGroup) pointGroup.clearLayers();
    choropleth = null;
    if (legendCtrl && map) {
      map.removeControl(legendCtrl);
      legendCtrl = null;
    }
  }

  function updateLegend(title, vmin, vmax, colors, subtitle, breaks, methodLabel) {
    if (!map) return;
    if (legendCtrl) {
      map.removeControl(legendCtrl);
      legendCtrl = null;
    }
    legendCtrl = L.control({ position: 'topright' });
    legendCtrl.onAdd = function () {
      const classified = breaks && breaks.length > 1;
      const div = L.DomUtil.create('div', classified ? 'map-legend spatial-map-legend' : 'map-legend');
      const ramp = colors.map((c) => `<span style="background:${c}"></span>`).join('');
      let body = `<strong>${title}</strong>`;
      if (methodLabel) body += `<div class="legend-sub">${methodLabel}</div>`;
      body += `<div class="legend-ramp">${ramp}</div>`;
      if (classified) {
        body += `<div class="legend-labels"><span>${fmtBreak(breaks[0])}</span><span>${fmtBreak(breaks[breaks.length - 1])}</span></div>`;
        if (breaks.length > 2) {
          body += '<div class="legend-bins">';
          body += breaks.slice(0, -1).map((lo, i) => {
            const hi = breaks[i + 1];
            const sw = colors[Math.min(colors.length - 1, i)];
            return `<div class="legend-bin"><span class="sw" style="background:${sw}"></span><span>${fmtBreak(lo)} – ${fmtBreak(hi)}</span></div>`;
          }).join('');
          body += '</div>';
        }
      } else {
        body += `<div class="legend-labels"><span>${fmt(vmin)}</span><span>${fmt(vmax)}</span></div>`;
      }
      if (subtitle) body += `<div style="margin-top:6px;color:#5a6e78">${subtitle}</div>`;
      div.innerHTML = body;
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    legendCtrl.addTo(map);
  }

  function paletteColors() {
    const id = ($('palette') && $('palette').value) || DEFAULT_PALETTE;
    if (global.MapStyleControls) return MapStyleControls.getColors(id);
    return ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026'];
  }

  function normalizeRows(rows) {
    return rows.map((r) => {
      const out = { ...r };
      if (out.val === undefined) {
        if (out.median_val !== undefined) out.val = out.median_val;
        else if (out.mean_val !== undefined) out.val = out.mean_val;
        else if (out.avg_val !== undefined) out.val = out.avg_val;
        else if (out.n_sites !== undefined) out.val = out.n_sites;
        else if (out.n !== undefined && out.state_abbr !== undefined) out.val = out.n;
      }
      if (out.state_abbr === undefined && out.state !== undefined && String(out.state).length === 2) {
        out.state_abbr = out.state;
      }
      if (out.lat === undefined && out.latitude !== undefined) out.lat = out.latitude;
      if (out.lon === undefined && out.longitude !== undefined) out.lon = out.longitude;
      return out;
    });
  }

  function renderCountyMap(rows) {
    if (!mapReady()) return;
    const geo = global.COUNTY_GEO;
    if (!geo) return;
    ensureChoroplethOnMap();
    const vizStyle = getVizMapStyle();
    const stroke = boundaryStrokeStyle(vizStyle);
    const byFips = {};
    rows.forEach((r) => {
      if (r.fips == null || r.val == null) return;
      const key = normalizeFips(r.fips);
      if (!key) return;
      byFips[key] = r;
    });
    const vals = Object.values(byFips).map((r) => Number(r.val)).filter(Number.isFinite);
    if (!vals.length) return;
    const scale = buildChoroplethScale(vals, vizStyle);
    const layer = L.geoJSON(geo, {
      filter(f) { return !!byFips[featureFips(f)]; },
      style(f) {
        const r = byFips[featureFips(f)];
        const v = Number(r.val);
        return {
          ...stroke,
          fillColor: fillColorForValue(v, scale),
          fillOpacity: 0.82,
        };
      },
      onEachFeature(f, lyr) {
        const r = byFips[featureFips(f)];
        const name = (f.properties && (f.properties.NAME || f.properties.name)) || r.county || featureFips(f);
        lyr.bindTooltip(`<b>${name}</b><br>val: <b>${fmt(r.val)}</b>`, { sticky: true });
      },
    });
    const matched = layer.getLayers().length;
    choroplethGroup.clearLayers();
    choroplethGroup.addLayer(layer);
    choropleth = layer;
    if (typeof layer.bringToFront === 'function') layer.bringToFront();
    updateLegend(
      'County values',
      scale.vmin,
      scale.vmax,
      scale.colors,
      matched
        ? `${matched.toLocaleString()} counties on map`
        : `${Object.keys(byFips).length.toLocaleString()} rows · 0 matched polygons (FIPS)`,
      scale.breaks,
      classificationLabel(vizStyle.classification)
    );
    if (matched) safeFitBounds(layer, { padding: [20, 20], maxZoom: 8 });
    else console.warn('County choropleth: no FIPS matches. Sample keys:', Object.keys(byFips).slice(0, 5));
  }

  function renderStateMap(rows) {
    if (!mapReady()) return;
    const geo = global.STATE_GEO;
    if (!geo) return;
    ensureChoroplethOnMap();
    const vizStyle = getVizMapStyle();
    const stroke = boundaryStrokeStyle(vizStyle);
    const bySt = {};
    rows.forEach((r) => {
      const k = r.state_abbr || r.state;
      if (!k || r.val == null) return;
      bySt[String(k).toUpperCase()] = r;
    });
    const vals = Object.values(bySt).map((r) => Number(r.val)).filter(Number.isFinite);
    if (!vals.length) return;
    const scale = buildChoroplethScale(vals, vizStyle);
    const layer = L.geoJSON(geo, {
      filter(f) {
        const ab = (f.properties && (f.properties.STUSPS || f.properties.postal_ABBR || f.properties.abbr)) || '';
        return !!bySt[String(ab).toUpperCase()];
      },
      style(f) {
        const ab = (f.properties && (f.properties.STUSPS || f.properties.postal_ABBR || f.properties.abbr)) || '';
        const r = bySt[String(ab).toUpperCase()];
        return {
          ...stroke,
          weight: stroke.weight || 0.8,
          fillColor: fillColorForValue(Number(r.val), scale),
          fillOpacity: 0.75,
        };
      },
      onEachFeature(f, lyr) {
        const ab = (f.properties && (f.properties.STUSPS || f.properties.postal_ABBR)) || '';
        const r = bySt[String(ab).toUpperCase()];
        const name = (f.properties && f.properties.NAME) || ab;
        lyr.bindTooltip(`<b>${name}</b><br>val: <b>${fmt(r.val)}</b>`, { sticky: true });
      },
    });
    choroplethGroup.clearLayers();
    choroplethGroup.addLayer(layer);
    choropleth = layer;
    updateLegend(
      'State values',
      scale.vmin,
      scale.vmax,
      scale.colors,
      `${Object.keys(bySt).length} states`,
      scale.breaks,
      classificationLabel(vizStyle.classification)
    );
    safeFitBounds(layer, { padding: [16, 16] });
  }

  function renderPointMap(rows) {
    if (!mapReady()) return;
    ensureChoroplethOnMap();
    const colors = paletteColors();
    const withCoords = rows.filter((r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)));
    if (!withCoords.length) return;
    const vals = withCoords.map((r) => Number(r.val)).filter(Number.isFinite);
    const vmin = vals.length ? Math.min(...vals) : 0;
    const vmax = vals.length ? Math.max(...vals) : 1;
    const group = L.layerGroup();
    withCoords.forEach((r) => {
      const v = Number(r.val);
      const color = Number.isFinite(v) ? colorScale(colors, vmin, vmax, v) : '#14707e';
      const m = L.circleMarker([Number(r.lat), Number(r.lon)], {
        radius: 6, color: '#0f172a', weight: 0.6, fillColor: color, fillOpacity: 0.85,
      });
      const label = r.name || r.county || r.lab_id || r.aqs_id || r.id || 'Point';
      m.bindTooltip(`<b>${label}</b>${Number.isFinite(v) ? `<br>val: <b>${fmt(v)}</b>` : ''}`, { sticky: true });
      m.addTo(group);
    });
    pointGroup.addLayer(group);
    if (vals.length) updateLegend('Point values', vmin, vmax, colors, `${withCoords.length} points`);
    safeFitBounds(group, { padding: [24, 24], maxZoom: 10 });
  }

  function mapResults(rows) {
    if (!mapReady()) {
      initMap();
      if (!mapReady()) return 'Map not ready yet — open EDA to view the choropleth.';
    }
    ensureChoroplethOnMap();
    clearMapLayers();
    if (!rows.length) return 'No rows to map.';
    const normalized = normalizeRows(rows);
    const r0 = normalized[0];
    const hasVal = r0.val !== undefined && r0.val !== null;
    const hasFips = r0.fips !== undefined && r0.fips !== null && r0.fips !== '';
    const hasState = r0.state_abbr !== undefined || (r0.state !== undefined && String(r0.state).length === 2);
    const hasPoints = r0.lat !== undefined || r0.latitude !== undefined;

    if (hasFips && hasVal) {
      renderCountyMap(normalized);
      const n = (choropleth && choropleth.getLayers) ? choropleth.getLayers().length : 0;
      return n
        ? `Mapped ${n.toLocaleString()} county polygon(s).`
        : `Prepared ${normalized.length.toLocaleString()} county row(s) but no polygons matched FIPS.`;
    }
    if (hasState && hasVal && !hasFips) {
      renderStateMap(normalized);
      return `Mapped ${normalized.length.toLocaleString()} state row(s).`;
    }
    if (hasPoints) {
      renderPointMap(normalized);
      return `Mapped ${normalized.length.toLocaleString()} point(s).`;
    }
    return 'Add fips + val for county choropleth, state_abbr + val for states, or lat/lon for points.';
  }

  function renderTable(rows) {
    const thead = $('thead');
    const tbody = $('tbody');
    if (!rows.length) {
      thead.innerHTML = '';
      tbody.innerHTML = '<tr><td>No rows returned.</td></tr>';
      return;
    }
    const cols = Object.keys(rows[0]);
    thead.innerHTML = '<tr>' + cols.map((c) => `<th>${c}</th>`).join('') + '</tr>';
    const show = rows.slice(0, 500);
    tbody.innerHTML = show.map((row) =>
      '<tr>' + cols.map((c) => `<td>${fmt(row[c])}</td>`).join('') + '</tr>'
    ).join('') + (rows.length > 500
      ? `<tr><td colspan="${cols.length}">Showing first 500 of ${rows.length.toLocaleString()} rows.</td></tr>`
      : '');
  }

  function pickLabelKey(row) {
    const keys = ['county', 'state_abbr', 'state_name', 'name', 'indicator_label', 'measure_label',
      'cause_label', 'pollutant', 'lab_id', 'aqs_id', 'metric', 'measure', 'indicator', 'cause'];
    for (let i = 0; i < keys.length; i++) {
      if (row[keys[i]] != null && row[keys[i]] !== '') return keys[i];
    }
    return Object.keys(row).find((k) => k !== 'val' && typeof row[k] !== 'number') || 'label';
  }

  function renderChart(rows) {
    const el = $('chart');
    if (!el) return;
    if (!rows.length || rows[0].val === undefined) {
      el.innerHTML = '<p class="note">Chart needs a numeric <code>val</code> column (or median_val / mean_val / n_sites).</p>';
      return;
    }
    const labelKey = pickLabelKey(rows[0]);
    const data = rows
      .map((r) => ({ label: String(r[labelKey] ?? ''), val: Number(r.val) }))
      .filter((d) => d.label && Number.isFinite(d.val))
      .slice(0, 30);
    if (!data.length) {
      el.innerHTML = '<p class="note">No chartable rows.</p>';
      return;
    }
    const max = Math.max(...data.map((d) => d.val));
    const min = Math.min(...data.map((d) => d.val));
    const w = Math.max(480, el.clientWidth || 640);
    const barH = 18;
    const gap = 4;
    const left = 140;
    const h = data.length * (barH + gap) + 28;
    const plotW = w - left - 48;
    const bars = data.map((d, i) => {
      const t = max === min ? 1 : (d.val - min) / (max - min);
      const bw = Math.max(2, t * plotW);
      const y = 16 + i * (barH + gap);
      const label = d.label.length > 22 ? d.label.slice(0, 20) + '…' : d.label;
      return `<g>
        <text x="${left - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="11" fill="#5a6e78">${escapeXml(label)}</text>
        <rect x="${left}" y="${y}" width="${bw}" height="${barH}" fill="#14707e" rx="2"/>
        <text x="${left + bw + 6}" y="${y + barH / 2 + 4}" font-size="11" fill="#0b1f2a">${fmt(d.val)}</text>
      </g>`;
    }).join('');
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Bar chart of SQL results">${bars}</svg>`;
  }

  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setKPIs(rows, mapNote) {
    const vals = rows.map((r) => Number(r.val)).filter(Number.isFinite);
    const median = vals.length
      ? vals.slice().sort((a, b) => a - b)[Math.floor(vals.length / 2)]
      : null;
    $('kpis').innerHTML = [
      ['Rows', rows.length.toLocaleString()],
      ['Numeric val', vals.length.toLocaleString()],
      ['Median val', fmt(median)],
      ['Map', mapNote.length > 28 ? mapNote.slice(0, 26) + '…' : mapNote],
    ].map(([lab, num]) =>
      `<div class="kpi"><div class="num">${num}</div><div class="lab">${lab}</div></div>`
    ).join('');
  }

  function downloadCsv(rows) {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `atlas-sql-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function fillTableDocs() {
    const el = $('table-docs');
    if (!el) return;
    el.innerHTML = TABLE_DOCS.map((t) =>
      `<div class="tbl-doc"><code>${t.name}</code><span>${t.note}</span><div class="cols">${t.cols}</div></div>`
    ).join('');
  }

  function fillPresets() {
    const box = $('presets');
    if (!box) return;
    box.innerHTML = '';
    const examples = [
      {
        label: 'SVI × obesity (counties)',
        sql: `SELECT s.fips, s.county, s.state_abbr, s.val AS svi, p.val AS obesity, s.val AS val
FROM svi_overall_counties s
JOIN places_obesity_counties p ON s.fips = p.fips
ORDER BY s.val DESC
LIMIT 100`,
      },
      {
        label: 'Mortality × SVI (TX)',
        sql: `SELECT m.fips, m.county, m.state_abbr, m.val AS mortality, s.val AS svi, m.val AS val
FROM mortality_counties m
JOIN svi_overall_counties s ON m.fips = s.fips
WHERE m.cause = '247' AND m.state_abbr = 'TX'
ORDER BY m.val DESC`,
      },
      {
        label: 'Superfund sites by state',
        sql: `SELECT state_abbr, COUNT(*) AS n_sites, COUNT(*) AS val
FROM superfund_sites
WHERE status = 'NPL Site'
GROUP BY state_abbr
ORDER BY n_sites DESC`,
      },
      {
        label: 'PM2.5 monitors (2024)',
        sql: `SELECT aqs_id, name, state_abbr, city, lat, lon, mean_2024 AS val, unit
FROM aq_monitors
WHERE pollutant = 'PM25' AND mean_2024 IS NOT NULL
ORDER BY mean_2024 DESC
LIMIT 200`,
      },
      {
        label: 'State PM2.5 means',
        sql: `SELECT state_abbr, AVG(mean_2024) AS val, COUNT(*) AS n
FROM aq_monitors
WHERE pollutant = 'PM25' AND mean_2024 IS NOT NULL
GROUP BY state_abbr
ORDER BY val DESC`,
      },
      {
        label: 'Top SVI counties',
        sql: `SELECT fips, county, state_abbr, val
FROM svi_counties
WHERE indicator = 'RPL_THEMES'
ORDER BY val DESC
LIMIT 40`,
      },
    ];
    examples.forEach((ex) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = ex.label;
      b.title = ex.sql;
      b.addEventListener('click', () => {
        $('sql').value = ex.sql;
        runSQL();
      });
      box.appendChild(b);
    });
  }

  function fillStates() {
    const uniq = [...new Set(Object.values(STATE_NAME_TO_ABBR))].sort();
    const soil = $('soil-state');
    if (soil) {
      soil.innerHTML = '<option value="">Select state…</option>'
        + uniq.map((a) => `<option value="${a}">${a}</option>`).join('');
    }
    const pipe = $('pipeline-state');
    if (pipe) {
      pipe.innerHTML = '<option value="CONUS" selected>Contiguous U.S. (48 states + DC)</option>'
        + '<option value="ALL">All U.S. counties (incl. AK, HI, PR)</option>'
        + uniq.map((a) => {
          const name = ABBR_TO_STATE[a] || a;
          return `<option value="${a}">${name} (${a})</option>`;
        }).join('');
    }
    const viz = $('viz-state');
    if (viz) {
      viz.innerHTML = '<option value="ALL" selected>All counties (USA)</option>'
        + uniq.map((a) => {
          const name = ABBR_TO_STATE[a] || a;
          return `<option value="${a}">${name} (${a})</option>`;
        }).join('');
    }
  }

  function getModelFrameRows() {
    const fromTable = alasql.tables.model_frame?.data;
    if (fromTable && fromTable.length) return fromTable.slice();
    return lastRows.slice();
  }

  function numericFrameColumns(rows) {
    if (!rows || !rows.length) return [];
    const skip = new Set(['fips', 'year', 'county', 'state_abbr', 'state_name']);
    return Object.keys(rows[0]).filter((k) => {
      if (skip.has(k) || k === 'val') return false;
      return rows.some((r) => typeof r[k] === 'number' && Number.isFinite(r[k]));
    });
  }

  /** Map a model_frame column as choropleth val (explorer-style). */
  function visualizeFrameColumn(column, stateAbbr) {
    const src = getModelFrameRows();
    if (!src.length) throw new Error('No model_frame yet. Build a dataframe in Data Pipeline.');
    if (!column) throw new Error('Select a variable to map.');
    const geo = stateAbbr || 'ALL';
    const rows = src
      .filter((r) => matchesPipelineGeo(r.state_abbr, geo))
      .map((r) => {
        const v = Number(r[column]);
        return {
          fips: normalizeFips(r.fips),
          county: r.county,
          state_abbr: r.state_abbr,
          state_name: r.state_name,
          year: r.year,
          [column]: r[column],
          val: Number.isFinite(v) ? v : null,
        };
      })
      .filter((r) => r.val != null && r.fips);
    if (!rows.length) throw new Error(`No numeric values for ${column} in the selected geography.`);
    rows.sort((a, b) => b.val - a.val);

    // Ensure map has a real size before building SVG paths (hidden tab → empty polygons).
    if (!mapReady()) initMap();
    if (map && typeof map.invalidateSize === 'function') {
      try { map.invalidateSize(); } catch (_) { /* ignore */ }
    }
    ensureChoroplethOnMap();
    applyResultRows(rows, `Mapped ${column} · ${rows.length.toLocaleString()} counties`);
    const title = $('map-title');
    if (title) title.textContent = `County map · ${column}`;
    return rows;
  }

  function updateLoadBadges(stats) {
    const el = $('load-status');
    if (!el) return;
    const parts = [
      `SVI ${stats.svi.counties.toLocaleString()} county-rows`,
      `PLACES ${stats.places.counties.toLocaleString()}`,
      `Mortality ${stats.mortality.counties.toLocaleString()}`,
      `Overdose ${stats.overdose.counties.toLocaleString()}`,
      `Cancer ${stats.cancer.counties.toLocaleString()}`,
      global.CENSUS_DEMOGRAPHY
        ? `Census ${(global.CENSUS_DEMOGRAPHY.county_rows || []).length.toLocaleString()}`
        : 'Census missing',
      global.RELIGION_CENSUS
        ? `Religion ${(global.RELIGION_CENSUS.by_year?.['2020']?.county_rows || global.RELIGION_CENSUS.by_year?.['2010']?.county_rows || []).length.toLocaleString()}`
        : 'Religion missing',
      `Superfund ${stats.superfund.sites.toLocaleString()}`,
      `Air ${stats.air.monitors.toLocaleString()}`,
      chrLoaded ? 'CHR loaded' : 'CHR not loaded',
      soilStateLoaded ? `Soil ${soilStateLoaded}` : 'Soil empty',
    ];
    el.textContent = parts.join(' · ');
  }

  async function runSQL() {
    const status = $('status');
    const sqlBox = $('sql-used');
    const sql = ($('sql').value || '').trim();
    if (!sql) {
      status.textContent = 'Enter a SQL query.';
      status.className = 'status err';
      return;
    }
    try {
      if (/chr_/i.test(sql) && !chrLoaded) {
        await ensureChr();
        updateLoadBadges(registerCoreTablesSummary());
      }
      if (/soil_samples/i.test(sql) && !soilStateLoaded) {
        status.textContent = 'Load soil samples for a state first (sidebar).';
        status.className = 'status err';
        return;
      }

      if (mapReady()) setBasemap($('basemap')?.value || 'osm');
      let rows = alasql(sql);
      if (!Array.isArray(rows)) rows = [];
      rows = normalizeRows(rows);
      lastRows = rows;

      let mapNote = 'Results ready.';
      try { mapNote = mapResults(rows); } catch (mapErr) {
        console.warn('Map update skipped:', mapErr);
        mapNote = 'Results ready — map update deferred until EDA.';
      }
      setKPIs(rows, mapNote);
      renderTable(rows);
      renderChart(rows);

      try {
        if (sfOverlay) sfOverlay.refresh();
        if (gcOverlay) gcOverlay.refresh();
        if (aqOverlay) aqOverlay.refresh();
      } catch (overlayErr) {
        console.warn('Overlay refresh skipped:', overlayErr);
      }

      status.textContent = `Query OK — ${rows.length.toLocaleString()} row(s). ${mapNote}`;
      status.className = 'status ok';
      if (sqlBox) {
        sqlBox.hidden = false;
        sqlBox.textContent = sql;
      }
    } catch (err) {
      console.error(err);
      status.textContent = `SQL error: ${err.message || err}`;
      status.className = 'status err';
    }
  }

  function registerCoreTablesSummary() {
    return {
      svi: { counties: (alasql.tables.svi_counties?.data || []).length },
      places: { counties: (alasql.tables.places_counties?.data || []).length },
      mortality: { counties: (alasql.tables.mortality_counties?.data || []).length },
      overdose: { counties: (alasql.tables.overdose_counties?.data || []).length },
      cancer: { counties: (alasql.tables.cancer_counties?.data || []).length },
      superfund: { sites: (alasql.tables.superfund_sites?.data || []).length },
      air: { monitors: (alasql.tables.aq_monitors?.data || []).length },
    };
  }

  let sfOverlay; let gcOverlay; let aqOverlay;

  function initOverlays() {
    if (!mapReady()) return;
    if (global.SuperfundOverlay && !sfOverlay) {
      sfOverlay = new SuperfundOverlay({
        map, mount: 'sf-mount', getPageState: () => 'ALL',
      });
    }
    if (global.GeochemSoilOverlay && !gcOverlay) {
      gcOverlay = new GeochemSoilOverlay({
        map, mount: 'gc-mount', getPageState: () => $('soil-state')?.value || 'ALL',
      });
    }
    if (global.AirQualityOverlay && !aqOverlay) {
      aqOverlay = new AirQualityOverlay({
        map, mount: 'aq-mount', getPageState: () => 'ALL',
      });
    }
    if (global.AtlasMapExport) {
      AtlasMapExport.attach({
        map,
        mapEl: '#map',
        buttonId: 'btn-export',
        filenamePrefix: 'eda-model-development',
        getTitle: () => 'USA-Health Data Atlas · EDA & Model Development',
        getSource: () => 'EDA & Model Development workbench',
        getBasemapKey: () => $('basemap')?.value || 'osm',
        setBasemapKey: (k) => setBasemap(k),
        getChoroplethGroup: () => choroplethGroup,
        baseLayers,
        getOverlays: () => ({ sf: sfOverlay, gc: gcOverlay, aq: aqOverlay }),
        overlays: { superfund: true, soil: true, air: true },
      });
    }
  }

  async function init() {
    const status = $('status');
    try {
      if (!global.alasql) throw new Error('AlaSQL failed to load.');
      if (!global.COUNTY_GEO || !global.STATE_GEO) throw new Error('Boundary GeoJSON failed to load.');
      if (!global.SVI_DATA) throw new Error('SVI data failed to load.');
      if (!global.PLACES_DATA) throw new Error('PLACES data failed to load.');
      if (!global.MORTALITY_DATA) throw new Error('Mortality data failed to load.');
      if (!global.CENSUS_DEMOGRAPHY) throw new Error('Census Demography data failed to load.');
      if (!global.RELIGION_CENSUS) throw new Error('Religion Census data failed to load.');

      global.COUNTY_GEO.features.forEach((f) => { f.id = featureFips(f); });

      const stats = registerCoreTables();
      fillTableDocs();
      fillPresets();
      fillStates();
      if (global.MapStyleControls && $('palette')) {
        MapStyleControls.fillPaletteSelect($('palette'), DEFAULT_PALETTE);
      }

      initMap();
      initOverlays();
      updateLoadBadges(stats);

      if ($('btn-sql') && $('sql')) {
        $('btn-sql').addEventListener('click', () => runSQL());
      }
      if ($('btn-csv')) {
        $('btn-csv').addEventListener('click', () => downloadCsv(lastRows));
      }
      if ($('btn-load-chr')) {
        $('btn-load-chr').addEventListener('click', async () => {
          try {
            const years = normalizeChrYears();
            const r = await ensureChr(null, years);
            status.textContent = `CHR loaded — ${r.ranks.toLocaleString()} ranks, ${r.measures.toLocaleString()} measures (${years.join(', ')}).`;
            status.className = 'status ok';
            updateLoadBadges(registerCoreTablesSummary());
          } catch (e) {
            status.textContent = String(e.message || e);
            status.className = 'status err';
          }
        });
      }
      $('chr-year')?.addEventListener('change', async () => {
        if (!chrLoaded) return;
        try {
          const years = normalizeChrYears();
          const r = await ensureChr(null, years);
          status.textContent = `CHR reloaded for ${years.join(', ')} (${r.measures.toLocaleString()} measure rows in ${r.year}).`;
          status.className = 'status ok';
        } catch (e) {
          status.textContent = String(e.message || e);
          status.className = 'status err';
        }
      });
      if ($('btn-load-soil')) {
        $('btn-load-soil').addEventListener('click', async () => {
          const st = $('soil-state').value;
          try {
            status.textContent = `Loading soil samples for ${st}…`;
            status.className = 'status';
            const n = await loadSoilForState(st);
            status.textContent = `Loaded ${n.toLocaleString()} soil samples for ${st} → soil_samples.`;
            status.className = 'status ok';
            updateLoadBadges(registerCoreTablesSummary());
          } catch (e) {
            status.textContent = String(e.message || e);
            status.className = 'status err';
          }
        });
      }
      $('basemap')?.addEventListener('change', () => setBasemap($('basemap').value));
      $('palette')?.addEventListener('change', () => { if (lastRows.length) mapResults(lastRows); });

      status.textContent = 'Tables ready. Build a modeling dataframe in Data Pipeline, then explore in EDA.';
      status.className = 'status ok';
    } catch (err) {
      console.error(err);
      status.textContent = String(err.message || err);
      status.className = 'status err';
    }
  }

  function invalidateMap() {
    if (!mapReady()) {
      initMap();
      initOverlays();
    }
    if (map && typeof map.invalidateSize === 'function') {
      try { map.invalidateSize(); } catch (_) { /* ignore */ }
      ensureChoroplethOnMap();
      // Remap after layout so SVG paths are not stuck at NaN from a 0×0 container.
      setTimeout(() => {
        try {
          if (mapHasSize()) {
            safeFitBounds(L.latLngBounds(USA_BOUNDS), { padding: [10, 10] });
            if (lastRows.length) mapResults(lastRows);
          }
        } catch (err) { console.warn(err); }
      }, 50);
    }
  }

  function refreshChoropleth() {
    if (!lastRows.length) return '';
    return mapResults(lastRows);
  }

  global.SqlWorkbench = {
    init,
    runSQL,
    loadSoilForState,
    ensureChr,
    getLastRows: () => lastRows.slice(),
    getModelFrameRows,
    numericFrameColumns,
    visualizeFrameColumn,
    refreshChoropleth,
    invalidateMap,
    listPipelineVariables,
    resolveCensusYear,
    resolveOverdoseYear,
    resolveCancerYear,
    buildModelingFrame,
    applyResultRows,
    downloadCsv: (rows) => downloadCsv(rows || lastRows),
    isChrLoaded: () => chrLoaded,
    chrLoadedYears: () => chrLoadedYearsKey.split(',').filter(Boolean).map(Number),
  };
  document.addEventListener('DOMContentLoaded', init);
})(window);
