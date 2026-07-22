/**
 * Load consolidated CHR county CSVs (data/county_health_ranking/chr_county_{year}.csv)
 * and expose SQL-friendly county/state tables for the explorer.
 *
 * Tries fetch (HTTP) first, then script bundles in assets/chr_county_data/ (file://).
 */
(function (global) {
  const YEARS = [2020, 2021, 2022, 2023, 2024, 2025];
  const CSV_REL = 'data/county_health_ranking/chr_county_';
  const JS_REL = 'assets/chr_county_data/chr_county_';

  const RANK_COLS_BY_YEAR = {
    2020: [
      'health_outcomes_rank', 'health_factors_rank',
      'length_of_life_rank', 'quality_of_life_rank',
      'health_behaviors_rank', 'clinical_care_rank',
      'social_economic_factors_rank', 'physical_environment_rank',
    ],
    2021: [
      'health_outcomes_rank', 'health_factors_rank',
      'length_of_life_rank', 'quality_of_life_rank',
      'health_behaviors_rank', 'clinical_care_rank',
      'social_economic_factors_rank', 'physical_environment_rank',
    ],
    2022: [
      'health_outcomes_rank', 'health_factors_rank',
      'length_of_life_rank', 'quality_of_life_rank',
      'health_behaviors_rank', 'clinical_care_rank',
      'social_economic_factors_rank', 'physical_environment_rank',
    ],
    2023: [
      'health_outcomes_rank', 'health_factors_rank',
      'length_of_life_rank', 'quality_of_life_rank',
      'health_behaviors_rank', 'clinical_care_rank',
      'social_economic_factors_rank', 'physical_environment_rank',
    ],
    2024: [],
    2025: ['health_group'],
  };

  const RANK_LABELS = {
    health_outcomes_rank: 'Health Outcomes Rank',
    health_factors_rank: 'Health Factors Rank',
    length_of_life_rank: 'Length of Life Rank',
    quality_of_life_rank: 'Quality of Life Rank',
    health_behaviors_rank: 'Health Behaviors Rank',
    clinical_care_rank: 'Clinical Care Rank',
    social_economic_factors_rank: 'Social & Economic Factors Rank',
    physical_environment_rank: 'Physical Environment Rank',
    health_group: 'Health Group',
  };

  const SKIP_MEASURE_COLS = new Set([
    'year', 'fips', 'state_abbr', 'county',
    'n_ranked_counties', 'of_ranked_counties',
    'n_counties_in_health_groups', 'number_of_counties_included_in_health_groups',
    'health_group_range', 'health_group_1',
  ]);

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

  const cache = {};
  const scriptPromises = {};
  let currentYear = null;

  function pageBase() {
    if (!global.location || !global.location.pathname) return '';
    const path = String(global.location.pathname).replace(/\\/g, '/');
    if (path.endsWith('/')) return path;
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(0, slash + 1) : '/';
  }

  function csvUrls(year) {
    const rel = `${CSV_REL}${year}.csv`;
    const base = pageBase();
    const urls = [];
    if (base) urls.push(`${base}${rel}`.replace(/([^:]\/)\/+/g, '$1'));
    urls.push(rel);
    return [...new Set(urls)];
  }

  function jsBundleUrl(year) {
    return `${JS_REL}${year}.js`;
  }

  function loadScriptOnce(src) {
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(el);
    });
    return scriptPromises[src];
  }

  function normalizeStateAbbr(value) {
    if (value == null || value === '') return value;
    const raw = String(value).trim();
    if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
    if (STATE_NAME_TO_ABBR[raw]) return STATE_NAME_TO_ABBR[raw];
    const title = raw.replace(/\b\w/g, (c) => c.toUpperCase());
    if (STATE_NAME_TO_ABBR[title]) return STATE_NAME_TO_ABBR[title];
    return raw.toUpperCase();
  }

  function humanizeColumn(col) {
    if (RANK_LABELS[col]) return RANK_LABELS[col];
    const dict = global.CHR_COLUMN_LABELS;
    if (dict && dict[col]) return dict[col];
    const words = col
      .split('_')
      .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)));
    for (let n = Math.floor(words.length / 2); n >= 1; n -= 1) {
      const first = words.slice(0, n).join(' ');
      const second = words.slice(n, n * 2).join(' ');
      if (words.length === n * 2 && first === second) return first;
    }
    return words
      .join(' ')
      .replace(/ Aian/g, ' (AIAN)')
      .replace(/ Mv /g, ' MV ')
      .replace(/ Hiv /g, ' HIV ')
      .replace(/ Ypll /g, ' YPLL ')
      .replace(/ Lbw /g, ' LBW ');
  }

  function rankColsForYear(year) {
    return RANK_COLS_BY_YEAR[year] || [];
  }

  function measureColsForRow(row, year) {
    const ranks = new Set(rankColsForYear(year));
    return Object.keys(row).filter((k) => {
      if (SKIP_MEASURE_COLS.has(k) || ranks.has(k)) return false;
      if (k.endsWith('_rank')) return false;
      const v = row[k];
      return v !== '' && v != null && Number.isFinite(Number(v));
    });
  }

  function median(vals) {
    if (!vals.length) return null;
    const s = vals.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function aggregateState(rows, field) {
    const byState = {};
    rows.forEach((r) => {
      const st = r.state_abbr;
      if (!st) return;
      const v = Number(r.val);
      if (!Number.isFinite(v)) return;
      if (!byState[st]) byState[st] = [];
      byState[st].push(v);
    });
    return Object.entries(byState).map(([state_abbr, vals]) => {
      const sorted = vals.slice().sort((a, b) => a - b);
      return {
        year: rows[0]?.year,
        state_abbr,
        [field]: rows[0][field],
        median_val: median(vals),
        mean_val: vals.reduce((s, v) => s + v, 0) / vals.length,
        min_val: sorted[0],
        max_val: sorted[sorted.length - 1],
        n_counties: vals.length,
      };
    });
  }

  function rowsToTables(rows, year) {
    const rankCols = rankColsForYear(year);
    const measureSet = new Set();
    rows.forEach((r) => measureColsForRow(r, year).forEach((c) => measureSet.add(c)));
    const measureCols = [...measureSet].sort();

    const counties = {};
    const countyRanks = [];
    const countyMeasures = [];

    rows.forEach((r) => {
      const fips = String(r.fips || '').padStart(5, '0');
      const state_abbr = r.state_abbr;
      const county = r.county;
      counties[fips] = { name: county, state: state_abbr };

      rankCols.forEach((col) => {
        const val = Number(r[col]);
        if (!Number.isFinite(val)) return;
        countyRanks.push({
          year,
          fips,
          state_abbr,
          county,
          metric: RANK_LABELS[col] || humanizeColumn(col),
          val,
        });
      });

      measureCols.forEach((col) => {
        const val = Number(r[col]);
        if (!Number.isFinite(val)) return;
        countyMeasures.push({
          year,
          fips,
          state_abbr,
          county,
          measure: humanizeColumn(col),
          val,
        });
      });
    });

    const rankMetrics = [...new Set(countyRanks.map((r) => r.metric))];
    const measures = [...new Set(countyMeasures.map((r) => r.measure))].sort();

    const stateRanks = [];
    rankMetrics.forEach((metric) => {
      const subset = countyRanks.filter((r) => r.metric === metric);
      aggregateState(subset, 'metric').forEach((s) => {
        stateRanks.push({ ...s, metric });
      });
    });

    const stateMeasures = [];
    measures.forEach((measure) => {
      const subset = countyMeasures.filter((r) => r.measure === measure);
      aggregateState(subset, 'measure').forEach((s) => {
        stateMeasures.push({ ...s, measure });
      });
    });

    return {
      meta: {
        years: YEARS,
        overall_rank_metrics: rankMetrics,
        measures,
        year,
        n_counties: rows.length,
        n_measures: measures.length,
      },
      counties,
      county_ranks: countyRanks,
      county_measures: countyMeasures,
      state_ranks: stateRanks,
      state_measures: stateMeasures,
    };
  }

  function parseCsv(text) {
    if (!global.Papa) throw new Error('PapaParse is required to load CHR CSV files.');
    const parsed = global.Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });
    if (parsed.errors?.length) {
      console.warn('CHR CSV parse warnings', parsed.errors.slice(0, 3));
    }
    return parsed.data.map((row) => {
      const out = { ...row };
      if (out.fips != null) out.fips = String(out.fips).padStart(5, '0');
      if (out.year != null) out.year = Number(out.year);
      if (out.state_abbr != null) out.state_abbr = normalizeStateAbbr(out.state_abbr);
      return out;
    });
  }

  async function loadCsvText(year) {
    const errors = [];
    for (const url of csvUrls(year)) {
      try {
        const resp = await fetch(url);
        if (resp.ok) return await resp.text();
        errors.push(`${url} (HTTP ${resp.status})`);
      } catch (err) {
        errors.push(`${url} (${err.message || err})`);
      }
    }

    const scriptUrl = jsBundleUrl(year);
    const globalKey = `CHR_COUNTY_CSV_${year}`;
    try {
      await loadScriptOnce(scriptUrl);
      if (global[globalKey]) return global[globalKey];
      errors.push(`${scriptUrl} (script loaded but ${globalKey} missing)`);
    } catch (err) {
      errors.push(`${scriptUrl} (${err.message || err})`);
    }

    const hint = global.location?.protocol === 'file:'
      ? ' Rebuild JS bundles with: python3 scripts/build_chr_county_js.py'
      : ' Serve from the repo root (python3 -m http.server) or rebuild JS bundles.';
    throw new Error(`Could not load CHR county data for ${year}.${hint} (${errors.join('; ')})`);
  }

  async function loadYear(year) {
    if (cache[year]) return cache[year];
    const text = await loadCsvText(year);
    const rows = parseCsv(text);
    const data = rowsToTables(rows, year);
    cache[year] = data;
    return data;
  }

  async function load(year) {
    currentYear = year;
    return loadYear(year);
  }

  global.ChrCsvLoader = {
    YEARS,
    CSV_BASE: CSV_REL,
    humanizeColumn,
    load,
    loadYear,
    getCachedYear: () => currentYear,
    getCache: () => cache,
  };
})(typeof window !== 'undefined' ? window : globalThis);
