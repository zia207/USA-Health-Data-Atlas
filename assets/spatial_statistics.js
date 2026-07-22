/**
 * Browser-side spatial statistics for model_frame + COUNTY_GEO.
 * Moran's I, LISA, EB smoothing, scan statistic, OLS/SLX, geographically weighted models.
 */
(function (global) {
  const USA_BOUNDS = [[24.5, -125], [49.5, -66.5]];
  const USA_FIT_OPTS = { padding: [14, 14], maxZoom: 5, animate: false };
  const CLUSTER_COLORS = { HH: '#D65F5F', LL: '#4878CF', HL: '#F4A582', LH: '#92C5DE', NS: '#d0d8dc' };
  const BV_CLUSTER_COLORS = { HH: '#d73027', LL: '#4575b4', HL: '#fdae61', LH: '#abd9e9', NS: '#ffffbf' };
  const maps = {};
  const legendControls = {};
  const lastChoropleths = new Map();

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function ringCentroid(ring) {
    let sx = 0; let sy = 0; let n = 0;
    ring.forEach(([lon, lat]) => { sx += lon; sy += lat; n += 1; });
    return n ? [sy / n, sx / n] : [0, 0];
  }

  function geometryCentroid(geom) {
    if (!geom) return null;
    if (geom.type === 'Polygon') return ringCentroid(geom.coordinates[0]);
    if (geom.type === 'MultiPolygon') {
      let sx = 0; let sy = 0; let n = 0;
      geom.coordinates.forEach((poly) => {
        const c = ringCentroid(poly[0]);
        sx += c[0]; sy += c[1]; n += 1;
      });
      return n ? [sx / n, sy / n] : null;
    }
    return null;
  }

  const centroidCache = {};
  function fipsFromFeature(f) {
    const id = f.id || f.properties?.GEOID || f.properties?.geo_id || '';
    return String(id).replace(/\D/g, '').slice(-5).padStart(5, '0');
  }

  function getCentroid(fips) {
    if (centroidCache[fips]) return centroidCache[fips];
    const geo = global.COUNTY_GEO;
    if (!geo) return null;
    const feat = geo.features.find((f) => fipsFromFeature(f) === fips);
    if (!feat) return null;
    const c = geometryCentroid(feat.geometry);
    if (c) centroidCache[fips] = c;
    return c;
  }

  function prepareData(rows, yCol, popCol) {
    if (!rows.length) throw new Error('No rows in model_frame. Build a dataframe first.');
    const out = [];
    rows.forEach((r) => {
      const fips = String(r.fips).padStart(5, '0');
      const c = getCentroid(fips);
      if (!c) return;
      const y = Number(r[yCol]);
      if (!Number.isFinite(y)) return;
      const pop = popCol ? Number(r[popCol]) : null;
      out.push({
        fips,
        y,
        lat: c[0],
        lon: c[1],
        pop: Number.isFinite(pop) ? pop : 1,
        row: r,
      });
    });
    if (out.length < 20) throw new Error(`Too few counties with valid ${yCol} and geometry (n=${out.length}).`);
    return out;
  }

  function prepareBivariateData(rows, xCol, yCol) {
    if (!rows.length) throw new Error('No rows in model_frame. Build a dataframe first.');
    const out = [];
    rows.forEach((r) => {
      const fips = String(r.fips).padStart(5, '0');
      const c = getCentroid(fips);
      if (!c) return;
      const x = Number(r[xCol]);
      const y = Number(r[yCol]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      out.push({ fips, x, y, lat: c[0], lon: c[1], row: r });
    });
    if (out.length < 20) {
      throw new Error(`Too few counties with valid ${xCol}, ${yCol} and geometry (n=${out.length}).`);
    }
    return out;
  }

  function buildWeights(data, type) {
    const n = data.length;
    const coords = data.map((d) => [d.lat, d.lon]);
    const W = Array.from({ length: n }, () => Array(n).fill(0));

    if (type === 'distance') {
      const dists = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          dists.push(haversineKm(coords[i][0], coords[i][1], coords[j][0], coords[j][1]));
        }
      }
      dists.sort((a, b) => a - b);
      const thresh = dists[Math.floor(dists.length * 0.02)] || 80;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const d = haversineKm(coords[i][0], coords[i][1], coords[j][0], coords[j][1]);
          if (d <= thresh) W[i][j] = 1;
        }
        const rs = W[i].reduce((s, v) => s + v, 0) || 1;
        for (let j = 0; j < n; j++) W[i][j] /= rs;
      }
      return W;
    }

    const k = type === 'rook' ? 4 : type === 'knn' ? 6 : 8;
    for (let i = 0; i < n; i++) {
      const neighbors = coords
        .map((c, j) => ({
          j,
          d: i === j ? Infinity : haversineKm(coords[i][0], coords[i][1], c[0], c[1]),
        }))
        .sort((a, b) => a.d - b.d)
        .slice(0, k);
      neighbors.forEach(({ j }) => { W[i][j] = 1; });
      const rs = W[i].reduce((s, v) => s + v, 0) || 1;
      for (let j = 0; j < n; j++) W[i][j] /= rs;
    }
    return W;
  }

  function matVec(W, v) {
    return W.map((row) => row.reduce((s, w, j) => s + w * v[j], 0));
  }

  function moransI(y, W, nPerm, seed) {
    const n = y.length;
    const mean = y.reduce((s, v) => s + v, 0) / n;
    const z = y.map((v) => v - mean);
    const zz = z.reduce((s, v) => s + v * v, 0);
    const S0 = W.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);
    const Wz = matVec(W, z);
    const Iobs = (n / S0) * z.reduce((s, v, i) => s + v * Wz[i], 0) / zz;
    const EI = -1 / (n - 1);
    const rng = mulberry32(seed || 42);
    const Iperm = [];
    for (let b = 0; b < nPerm; b++) {
      const zp = shuffle(z, rng);
      const Wzp = matVec(W, zp);
      const zzp = zp.reduce((s, v) => s + v * v, 0);
      Iperm.push((n / S0) * zp.reduce((s, v, i) => s + v * Wzp[i], 0) / zzp);
    }
    const sd = Math.sqrt(Iperm.reduce((s, v) => s + (v - EI) ** 2, 0) / nPerm) || 1e-9;
    const p = Iperm.filter((v) => Math.abs(v) >= Math.abs(Iobs)).length / nPerm;
    return { I: Iobs, EI, zScore: (Iobs - EI) / sd, pValue: p, Iperm, Wz, z, mean };
  }

  function localMoransI(y, W, nPerm, seed) {
    const n = y.length;
    const mean = y.reduce((s, v) => s + v, 0) / n;
    const z = y.map((v) => v - mean);
    const varZ = z.reduce((s, v) => s + v * v, 0) / n;
    const Wz = matVec(W, z);
    const Ilocal = z.map((v, i) => v * Wz[i] / varZ);
    const rng = mulberry32(seed || 42);
    const pvals = new Array(n).fill(0);
    for (let b = 0; b < nPerm; b++) {
      const zp = shuffle(z, rng);
      const Wzp = matVec(W, zp);
      const Il = zp.map((v, i) => v * Wzp[i] / varZ);
      for (let i = 0; i < n; i++) {
        if (Math.abs(Il[i]) >= Math.abs(Ilocal[i])) pvals[i] += 1;
      }
    }
    pvals.forEach((_, i) => { pvals[i] /= nPerm; });
    const zStd = z.map((v) => v / Math.sqrt(varZ));
    const zLag = Wz.map((v) => v / Math.sqrt(varZ));
    const cluster = zStd.map((zs, i) => {
      if (pvals[i] >= 0.05) return 'NS';
      if (zs > 0 && zLag[i] > 0) return 'HH';
      if (zs < 0 && zLag[i] < 0) return 'LL';
      if (zs > 0 && zLag[i] < 0) return 'HL';
      return 'LH';
    });
    return { Ilocal, pvals, cluster };
  }

  function localMoransBV(x, y, W, nPerm, seed) {
    const n = x.length;
    const meanX = x.reduce((s, v) => s + v, 0) / n;
    const meanY = y.reduce((s, v) => s + v, 0) / n;
    const zX = x.map((v) => v - meanX);
    const zY = y.map((v) => v - meanY);
    const varX = zX.reduce((s, v) => s + v * v, 0) / n;
    const varY = zY.reduce((s, v) => s + v * v, 0) / n;
    const Wy = matVec(W, zY);
    const Ilocal = zX.map((v, i) => v * Wy[i]);
    const rng = mulberry32(seed || 42);
    const pvals = new Array(n).fill(0);
    for (let b = 0; b < nPerm; b++) {
      const zyp = shuffle(zY, rng);
      const Wzyp = matVec(W, zyp);
      const Il = zX.map((v, i) => v * Wzyp[i]);
      for (let i = 0; i < n; i++) {
        if (Math.abs(Il[i]) >= Math.abs(Ilocal[i])) pvals[i] += 1;
      }
    }
    pvals.forEach((_, i) => { pvals[i] /= nPerm; });
    const zXStd = zX.map((v) => v / Math.sqrt(varX));
    const zYLag = Wy.map((v) => v / Math.sqrt(varY));
    const cluster = zXStd.map((zs, i) => {
      if (pvals[i] >= 0.05) return 'NS';
      if (zs > 0 && zYLag[i] > 0) return 'HH';
      if (zs < 0 && zYLag[i] > 0) return 'LH';
      if (zs < 0 && zYLag[i] < 0) return 'LL';
      return 'HL';
    });
    return { Ilocal, pvals, cluster, zXStd, zYLag };
  }

  function empiricalBayes(observed, expected) {
    const rates = observed.map((o, i) => o / Math.max(expected[i], 1e-6));
    const m = rates.reduce((s, v) => s + v, 0) / rates.length;
    const v = rates.reduce((s, r) => s + (r - m) ** 2, 0) / Math.max(rates.length - 1, 1);
    const alpha = Math.max(0, (v / Math.max(m, 1e-6) - 1) / Math.max(m, 1e-6));
    const beta = alpha * m;
    const eb = observed.map((o, i) => (o + beta) / (expected[i] + beta));
    const shrink = expected.map((e) => 1 - e / (e + beta));
    return { eb, shrink, beta };
  }

  function bymApprox(eb, W) {
    return eb.map((v, i) => {
      const neigh = W[i].reduce((s, w, j) => s + w * eb[j], 0);
      return 0.55 * v + 0.45 * neigh;
    });
  }

  function scanStatistic(data, nPerm, seed) {
    const n = data.length;
    const O = data.map((d) => d.observed);
    const E = data.map((d) => d.expected);
    const pop = data.map((d) => d.pop);
    const Otot = O.reduce((s, v) => s + v, 0);
    const Etot = E.reduce((s, v) => s + v, 0);
    const maxPop = pop.reduce((s, v) => s + v, 0) * 0.4;

    function llr(Oz, Ez) {
      if (Oz <= 0 || Ez <= 0) return 0;
      const Oout = Otot - Oz;
      const Eout = Etot - Ez;
      if (Oout <= 0 || Eout <= 0) return 0;
      return Math.max(0, Oz * Math.log(Oz / Ez) + Oout * Math.log(Oout / Eout));
    }

    const distOrder = data.map((_, i) => {
      const dists = data.map((d, j) => ({
        j,
        d: i === j ? 0 : haversineKm(data[i].lat, data[i].lon, d.lat, d.lon),
      })).sort((a, b) => a.d - b.d);
      return dists;
    });

    function bestWindow(obs) {
      let best = { llr: 0, center: 0, inside: [], radius: 0 };
      for (let c = 0; c < n; c++) {
        let Oz = 0; let Ez = 0; let pz = 0; const inside = [];
        for (let k = 0; k < n; k++) {
          const j = distOrder[c][k].j;
          pz += pop[j];
          if (pz > maxPop) break;
          Oz += obs[j];
          Ez += E[j];
          inside.push(j);
          const l = llr(Oz, Ez);
          if (l > best.llr) best = { llr: l, center: c, inside: inside.slice(), radius: distOrder[c][k].d };
        }
      }
      return best;
    }

    const Oarr = data.map((d) => d.observed);
    const observedBest = bestWindow(Oarr);
    const rng = mulberry32(seed || 42);
    let exceed = 0;
    for (let b = 0; b < nPerm; b++) {
      const perm = shuffle(Oarr, rng);
      if (bestWindow(perm).llr >= observedBest.llr) exceed += 1;
    }
    return {
      ...observedBest,
      pValue: exceed / nPerm,
      inCluster: new Set(observedBest.inside),
    };
  }

  function fitOLSMatrix(y, X) {
    const n = y.length;
    const p = X[0].length;
    const XtX = Array.from({ length: p }, () => Array(p).fill(0));
    const Xty = Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < p; a++) {
        Xty[a] += X[i][a] * y[i];
        for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
      }
    }
    const beta = solveLinear(XtX, Xty);
    const yhat = y.map((_, i) => X[i].reduce((s, v, j) => s + v * beta[j], 0));
    const resid = y.map((v, i) => v - yhat[i]);
    const ybar = y.reduce((s, v) => s + v, 0) / n;
    const sse = resid.reduce((s, v) => s + v * v, 0);
    const sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
    return {
      beta,
      resid,
      sse,
      r2: sst > 0 ? 1 - sse / sst : 0,
      rmse: Math.sqrt(sse / n),
      yhat,
      aic: n * Math.log(Math.max(sse / n, 1e-12)) + 2 * p,
      llf: -n / 2 * (Math.log(2 * Math.PI) + 1 + Math.log(Math.max(sse / n, 1e-12))),
      n,
      k: p,
    };
  }

  function lagColumns(W, matrix) {
    return matrix.map((_, i) => matrix[0].map((_, j) => (
      W[i].reduce((s, w, k) => s + w * matrix[k][j], 0)
    )));
  }

  function buildDesignMatrix(data, xCols) {
    return data.map((d) => [1, ...xCols.map((c) => Number(d.row[c]))]);
  }

  function buildSLXDesign(data, xCols, W) {
    const Xraw = data.map((d) => xCols.map((c) => Number(d.row[c])));
    const WX = lagColumns(W, Xraw);
    return {
      X: data.map((_, i) => [1, ...Xraw[i], ...WX[i]]),
      names: ['const', ...xCols, ...xCols.map((c) => `W_${c}`)],
    };
  }

  function solveLinear(A, b) {
    const n = b.length;
    const aug = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
      }
      [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
      const div = aug[col][col] || 1e-12;
      for (let j = 0; j <= n; j++) aug[col][j] /= div;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = aug[r][col];
        for (let j = 0; j <= n; j++) aug[r][j] -= f * aug[col][j];
      }
    }
    return aug.map((row) => row[n]);
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function multinomial(total, probs, rng) {
    const out = new Array(probs.length).fill(0);
    let rem = total;
    const cum = probs.reduce((acc, p, i) => {
      acc.push((acc[i - 1] || 0) + p);
      return acc;
    }, []);
    for (let k = 0; k < total - 1; k++) {
      const u = rng();
      const idx = cum.findIndex((c) => u <= c);
      out[idx >= 0 ? idx : probs.length - 1] += 1;
      rem -= 1;
    }
    out[out.length - 1] += rem;
    return out;
  }

  let mapStyle = {
    classification: 'quantile',
    palette: 'ylorrd',
    divergingPalette: 'spectral',
    nClasses: 5,
  };

  function getMapStyle() {
    return { ...mapStyle };
  }

  function setMapStyle(partial) {
    if (!partial || typeof partial !== 'object') return getMapStyle();
    Object.assign(mapStyle, partial);
    return getMapStyle();
  }

  function fmtBreak(v) {
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
    if (Math.abs(v) >= 10) return v.toFixed(1);
    if (Math.abs(v) >= 1) return v.toFixed(2);
    return v.toFixed(3);
  }

  function palette(id) {
    const colors = (global.MapStyleControls && global.MapStyleControls.getColors(id))
      || ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'];
    return colors;
  }

  function paletteForOpts(opts) {
    if (opts.categorical) return null;
    const id = opts.diverging
      ? (opts.palette || mapStyle.divergingPalette || 'spectral')
      : (opts.palette || mapStyle.palette || 'ylorrd');
    const base = palette(id);
    const n = Math.max(3, Math.min(9, opts.nClasses || mapStyle.nClasses || 5));
    if (base.length === n) return base;
    if (base.length > n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1);
        out.push(base[Math.min(base.length - 1, Math.round(t * (base.length - 1)))]);
      }
      return out;
    }
    return base;
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

  function computeBreaks(vals, method, nClasses, vmin, vmax, diverging) {
    const finite = vals.filter(Number.isFinite);
    if (!finite.length) return [0, 1];
    const lo = vmin != null ? vmin : Math.min(...finite);
    const hi = vmax != null ? vmax : Math.max(...finite);
    const sorted = finite.slice().sort((a, b) => a - b);
    const k = Math.max(3, Math.min(9, nClasses || 5));
    if (diverging && vmin != null && vmax != null && vmin < 0 && vmax > 0) {
      const neg = sorted.filter((v) => v <= 0);
      const pos = sorted.filter((v) => v >= 0);
      const half = Math.max(2, Math.floor(k / 2));
      const left = neg.length ? quantileBreaks(neg, half) : [vmin, 0];
      const right = pos.length ? quantileBreaks(pos, half) : [0, vmax];
      return [...new Set([...left, ...right])].sort((a, b) => a - b);
    }
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

  function colorScale(vmin, vmax, v, colors) {
    if (!Number.isFinite(v) || vmax <= vmin) return '#cbd5e1';
    const t = Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin)));
    const idx = Math.min(colors.length - 1, Math.floor(t * (colors.length - 1) + 1e-9));
    return colors[idx];
  }

  function destroyMap(id) {
    const el = typeof id === 'string' ? document.getElementById(id) : null;
    const key = typeof id === 'string' ? id : el?.id;

    if (key && legendControls[key]) {
      try { legendControls[key].remove(); } catch (_) { /* ignore */ }
      delete legendControls[key];
    }

    if (key && maps[key]) {
      try {
        maps[key].off();
        maps[key].remove();
      } catch (_) { /* ignore */ }
      delete maps[key];
    } else if (el && el._atlasMap) {
      try {
        el._atlasMap.off();
        el._atlasMap.remove();
      } catch (_) { /* ignore */ }
      delete el._atlasMap;
    }

    if (el) {
      if (el._leaflet_id != null) delete el._leaflet_id;
      el.innerHTML = '';
      if (el.dataset.mapBaseClass) {
        el.className = el.dataset.mapBaseClass;
      } else {
        el.classList.remove(
          'leaflet-container', 'leaflet-touch', 'leaflet-retina', 'leaflet-fade-anim',
          'leaflet-grab', 'leaflet-touch-drag', 'leaflet-touch-zoom',
        );
      }
      el.removeAttribute('tabindex');
    }
  }

  function fitConus(map) {
    if (!map) return;
    try {
      map.fitBounds(USA_BOUNDS, USA_FIT_OPTS);
    } catch (_) { /* ignore */ }
  }

  function divergingColor(t) {
    const x = Math.max(-1, Math.min(1, t));
    if (x < 0) {
      const u = (x + 1);
      return `rgb(${Math.round(69 + 178 * u)},${Math.round(117 + 58 * u)},${Math.round(180 + 15 * u)})`;
    }
    const u = x;
    return `rgb(${Math.round(247 - 8 * u)},${Math.round(175 - 118 * u)},${Math.round(195 - 162 * u)})`;
  }

  function mergeRenderOpts(opts) {
    const o = { ...(opts || {}) };
    if (!o.categorical) {
      o.classification = o.classification || mapStyle.classification || 'quantile';
      o.nClasses = o.nClasses || mapStyle.nClasses || 5;
      if (!o.palette) {
        o.palette = o.diverging
          ? (mapStyle.divergingPalette || 'spectral')
          : (mapStyle.palette || 'ylorrd');
      }
    }
    return o;
  }

  function attachClassificationLegend(map, containerId, title, breaks, colors, subtitle) {
    if (legendControls[containerId]) {
      try { legendControls[containerId].remove(); } catch (_) { /* ignore */ }
    }
    const ctrl = L.control({ position: 'bottomright' });
    ctrl.onAdd = function () {
      const div = L.DomUtil.create('div', 'map-legend spatial-map-legend');
      const ramp = colors.map((c) => `<span style="background:${c}"></span>`).join('');
      const labels = breaks.length > 1
        ? `<div class="legend-labels"><span>${fmtBreak(breaks[0])}</span><span>${fmtBreak(breaks[breaks.length - 1])}</span></div>`
        : '';
      const bins = breaks.length > 2
        ? breaks.slice(0, -1).map((lo, i) => {
          const hi = breaks[i + 1];
          const sw = colors[Math.min(colors.length - 1, i)];
          return `<div class="legend-bin"><span class="sw" style="background:${sw}"></span><span>${fmtBreak(lo)} – ${fmtBreak(hi)}</span></div>`;
        }).join('')
        : '';
      div.innerHTML = `<strong>${title || 'Map'}</strong>`
        + (subtitle ? `<div class="legend-sub">${subtitle}</div>` : '')
        + `<div class="legend-ramp">${ramp}</div>${labels}`
        + (bins ? `<div class="legend-bins">${bins}</div>` : '');
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    ctrl.addTo(map);
    legendControls[containerId] = ctrl;
  }

  function renderChoropleth(containerId, fipsToVal, opts) {
    const el = document.getElementById(containerId);
    if (!el || !global.COUNTY_GEO || !global.L) return null;
    const refreshOnly = !!(opts && opts._refreshOnly);
    const merged = mergeRenderOpts(opts || {});
    if (!refreshOnly) {
      const store = { ...merged };
      delete store._refreshOnly;
      lastChoropleths.set(containerId, {
        fipsToVal: { ...fipsToVal },
        opts: store,
        title: store.title || '',
      });
    }

    destroyMap(containerId);
    const vals = Object.values(fipsToVal).filter(Number.isFinite);
    if (!vals.length && !merged.categorical) return null;

    if (!el.dataset.mapBaseClass) el.dataset.mapBaseClass = el.className || 'spatial-map';

    const colors = paletteForOpts(merged);
    const vmin = merged.vmin != null ? merged.vmin : Math.min(...vals);
    const vmax = merged.vmax != null ? merged.vmax : Math.max(...vals);
    const diverging = !!merged.diverging
      || merged.palette === 'RdBu'
      || merged.palette === 'spectral'
      || (vmin < 0 && vmax > 0 && !merged.categorical);
    const breaks = merged.categorical
      ? null
      : computeBreaks(vals, merged.classification, merged.nClasses, vmin, vmax, diverging);

    const map = L.map(containerId, {
      scrollWheelZoom: true,
      minZoom: 3,
      maxZoom: 10,
      zoomControl: false,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    if (global.attachMapZoomControl) {
      attachMapZoomControl(map, { bounds: L.latLngBounds(USA_BOUNDS) });
    }

    const layer = L.geoJSON(global.COUNTY_GEO, {
      style(f) {
        const fips = fipsFromFeature(f);
        const v = fipsToVal[fips];
        let fill = '#e8eef1';
        if (merged.categorical) {
          fill = merged.categorical[v] || '#e0e0e0';
        } else if (!Number.isFinite(v)) {
          fill = '#e8eef1';
        } else if (breaks && breaks.length > 1) {
          fill = colorFromBreaks(v, breaks, colors);
        } else if (diverging) {
          const mid = (vmin + vmax) / 2;
          const span = Math.max(vmax - mid, mid - vmin, 1e-9);
          fill = divergingColor((v - mid) / span);
        } else {
          fill = colorScale(vmin, vmax, v, colors);
        }
        return { fillColor: fill, weight: 0.25, color: '#fff', fillOpacity: 0.88 };
      },
      onEachFeature(f, lyr) {
        const fips = fipsFromFeature(f);
        const v = fipsToVal[fips];
        if (Number.isFinite(v)) {
          lyr.bindTooltip(`FIPS ${fips}<br>${merged.title || 'Value'}: <b>${fmtBreak(v)}</b>`, { sticky: true });
        }
      },
    }).addTo(map);

    maps[containerId] = map;
    el._atlasMap = map;
    fitConus(map);
    if (!merged.categorical && colors && breaks) {
      const classLabel = {
        quantile: 'Quantile',
        equal: 'Equal interval',
        natural: 'Natural breaks',
        stddev: 'Std dev',
      }[merged.classification] || merged.classification;
      attachClassificationLegend(
        map,
        containerId,
        merged.title || 'Spatial map',
        breaks,
        colors,
        `${classLabel} · CONUS extent`
      );
    }
    setTimeout(() => {
      map.invalidateSize();
      fitConus(map);
    }, 140);
    return { map, layer, vmin, vmax, breaks, colors };
  }

  function refreshChoropleths() {
    lastChoropleths.forEach((entry, id) => {
      renderChoropleth(id, entry.fipsToVal, { ...entry.opts, _refreshOnly: true });
    });
  }

  function drawMoranScatter(el, y, Wz, I, title) {
    if (!el) return;
    const w = Math.max(320, el.clientWidth || 400);
    const h = Math.max(200, el.clientHeight || 260);
    const pad = 40;
    const xs = y; const ys = Wz;
    const xmin = Math.min(...xs); const xmax = Math.max(...xs);
    const ymin = Math.min(...ys); const ymax = Math.max(...ys);
    const sx = (v) => pad + ((v - xmin) / ((xmax - xmin) || 1)) * (w - pad - 12);
    const sy = (v) => h - pad - ((v - ymin) / ((ymax - ymin) || 1)) * (h - pad - 12);
    const dots = xs.map((v, i) => `<circle cx="${sx(v)}" cy="${sy(ys[i])}" r="2.5" fill="#14707e" fill-opacity="0.45"/>`).join('');
    const m = Number.isFinite(I) ? I : 0;
    const iLabel = Number.isFinite(I) ? I.toFixed(3) : '—';
    const x0 = xmin; const x1 = xmax;
    const y0 = m * x0; const y1 = m * x1;
    const line = `<line x1="${sx(x0)}" y1="${sy(y0)}" x2="${sx(x1)}" y2="${sy(y1)}" stroke="#0b1f2a" stroke-width="2"/>`;
    el.innerHTML = `<svg width="${w}" height="${h}" role="img"><text x="${pad}" y="16" font-size="12">${title} (R²=${iLabel})</text>${dots}${line}</svg>`;
  }

  function drawHist(el, values, title) {
    if (!el || !values.length) return;
    const w = Math.max(420, el.clientWidth || 480);
    const h = Math.max(200, el.clientHeight || 220);
    const min = Math.min(...values); const max = Math.max(...values);
    const bins = 24;
    const counts = Array(bins).fill(0);
    values.forEach((v) => {
      let i = Math.floor(((v - min) / ((max - min) || 1)) * bins);
      if (i >= bins) i = bins - 1;
      counts[i] += 1;
    });
    const cmax = Math.max(...counts);
    const bw = (w - 50) / bins;
    const bars = counts.map((c, i) => {
      const bh = (c / cmax) * (h - 50);
      return `<rect x="${40 + i * bw}" y="${h - 30 - bh}" width="${Math.max(1, bw - 1)}" height="${bh}" fill="#14707e"/>`;
    }).join('');
    el.innerHTML = `<svg width="${w}" height="${h}"><text x="40" y="16" font-size="12">${title}</text>${bars}</svg>`;
  }

  function drawBarChart(el, rows, title) {
    if (!el || !rows.length) return;
    const w = Math.max(280, el.clientWidth || 360);
    const minH = Math.max(200, el.clientHeight || 220);
    const h = minH;
    const padL = 120;
    const padR = 20;
    const padT = 24;
    const padB = 16;
    const maxV = Math.max(...rows.map((r) => r[1]), 1e-9);
    const barH = (h - padT - padB) / rows.length;
    const bars = rows.map((r, i) => {
      const val = Number(r[1]);
      const safeVal = Number.isFinite(val) ? val : 0;
      const bw = ((safeVal / maxV) * (w - padL - padR));
      const y = padT + i * barH + 4;
      return `<text x="${padL - 6}" y="${y + barH / 2}" font-size="11" text-anchor="end" dominant-baseline="middle">${r[0]}</text>`
        + `<rect x="${padL}" y="${y}" width="${Math.max(1, bw)}" height="${Math.max(8, barH - 8)}" fill="#F18F01"/>`
        + `<text x="${padL + bw + 4}" y="${y + barH / 2}" font-size="10" dominant-baseline="middle">${safeVal.toFixed(3)}</text>`;
    }).join('');
    el.innerHTML = `<svg width="${w}" height="${h}"><text x="${padL}" y="14" font-size="12">${title}</text>${bars}</svg>`;
  }

  function distanceMatrixKm(coords) {
    const n = coords.length;
    const dists = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = haversineKm(coords[i][0], coords[i][1], coords[j][0], coords[j][1]);
        dists[i][j] = d;
        dists[j][i] = d;
      }
    }
    return dists;
  }

  function autoBandwidthKm(dists, pct) {
    const flat = [];
    for (let i = 0; i < dists.length; i++) {
      for (let j = 0; j < dists.length; j++) {
        if (i !== j && dists[i][j] > 0) flat.push(dists[i][j]);
      }
    }
    flat.sort((a, b) => a - b);
    const p = Math.max(0, Math.min(100, pct == null ? 30 : pct));
    return flat[Math.floor(flat.length * (p / 100))] || 80;
  }

  function prepareGwData(rows, yCol, xCols, y2Col) {
    if (!rows.length) throw new Error('No rows in model_frame. Build a dataframe first.');
    const out = [];
    rows.forEach((r) => {
      const fips = String(r.fips).padStart(5, '0');
      const c = getCentroid(fips);
      if (!c) return;
      const y = Number(r[yCol]);
      if (!Number.isFinite(y)) return;
      const item = { fips, y, lat: c[0], lon: c[1], row: r };
      if (y2Col) {
        const y2 = Number(r[y2Col]);
        if (!Number.isFinite(y2)) return;
        item.y2 = y2;
      }
      if (xCols && xCols.length) {
        const xs = xCols.map((col) => Number(r[col]));
        if (xs.some((v) => !Number.isFinite(v))) return;
        item.x = xs;
      }
      out.push(item);
    });
    if (out.length < 20) throw new Error(`Too few counties with valid data (n=${out.length}).`);
    return out;
  }

  function gwCorr(y1, y2, dists, bandwidthKm) {
    const n = y1.length;
    const bw = bandwidthKm || autoBandwidthKm(dists);
    const localR = new Array(n);
    for (let i = 0; i < n; i++) {
      const w = dists[i].map((d) => Math.exp(-(d * d) / (2 * bw * bw)));
      const wsum = w.reduce((s, v) => s + v, 0) || 1;
      const mu1 = w.reduce((s, wi, j) => s + wi * y1[j], 0) / wsum;
      const mu2 = w.reduce((s, wi, j) => s + wi * y2[j], 0) / wsum;
      let num = 0; let den1 = 0; let den2 = 0;
      for (let j = 0; j < n; j++) {
        const d1 = y1[j] - mu1;
        const d2 = y2[j] - mu2;
        num += w[j] * d1 * d2;
        den1 += w[j] * d1 * d1;
        den2 += w[j] * d2 * d2;
      }
      const den = Math.sqrt(den1 * den2);
      localR[i] = den > 0 ? num / den : NaN;
    }
    return { localR, bandwidth: bw };
  }

  function gwOLS(data, xCols, bandwidthKm) {
    const coords = data.map((d) => [d.lat, d.lon]);
    const dists = distanceMatrixKm(coords);
    const bw = bandwidthKm || autoBandwidthKm(dists);
    const n = data.length;
    const y = data.map((d) => d.y);
    const X = data.map((d) => [1, ...xCols.map((c) => Number(d.row[c]))]);
    const p = X[0].length;
    const betas = Array.from({ length: n }, () => Array(p).fill(0));
    const pred = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const weights = dists[i].map((d) => Math.exp(-0.5 * (d / bw) ** 2));
      const XtWX = Array.from({ length: p }, () => Array(p).fill(0));
      const XtWy = Array(p).fill(0);
      for (let r = 0; r < n; r++) {
        const w = weights[r];
        for (let a = 0; a < p; a++) {
          XtWy[a] += X[r][a] * w * y[r];
          for (let b = 0; b < p; b++) XtWX[a][b] += X[r][a] * w * X[r][b];
        }
      }
      try {
        const b = solveLinear(XtWX, XtWy);
        betas[i] = b;
        pred[i] = X[i].reduce((s, v, j) => s + v * b[j], 0);
      } catch (_) {
        betas[i] = betas[Math.max(0, i - 1)];
        pred[i] = y[i];
      }
    }
    const ybar = y.reduce((s, v) => s + v, 0) / n;
    const sse = pred.reduce((s, v, i) => s + (y[i] - v) ** 2, 0);
    const sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
    return { betas, pred, bandwidth: bw, r2: sst > 0 ? 1 - sse / sst : 0 };
  }

  function localWeightedImportance(X, y, w) {
    const n = X.length;
    const p = X[0].length;
    const wsum = w.reduce((s, v) => s + v, 0) || 1;
    const yMean = y.reduce((s, v, i) => s + w[i] * v, 0) / wsum;
    const imp = Array(p).fill(0);
    for (let j = 0; j < p; j++) {
      const xMean = X.reduce((s, row, i) => s + w[i] * row[j], 0) / wsum;
      let cov = 0; let vx = 0; let vy = 0;
      for (let k = 0; k < n; k++) {
        const dx = X[k][j] - xMean;
        const dy = y[k] - yMean;
        cov += w[k] * dx * dy;
        vx += w[k] * dx * dx;
        vy += w[k] * dy * dy;
      }
      imp[j] = Math.abs(cov / Math.sqrt((vx * vy) || 1e-12));
    }
    const s = imp.reduce((a, b) => a + b, 0) || 1;
    return imp.map((v) => v / s);
  }

  function weightedLinearPred(X, y, w, x0) {
    const n = X.length;
    const p = x0.length;
    const XtWX = Array.from({ length: p }, () => Array(p).fill(0));
    const XtWy = Array(p).fill(0);
    for (let r = 0; r < n; r++) {
      const wt = w[r];
      for (let a = 0; a < p; a++) {
        XtWy[a] += X[r][a] * wt * y[r];
        for (let b = 0; b < p; b++) XtWX[a][b] += X[r][a] * wt * X[r][b];
      }
    }
    try {
      const beta = solveLinear(XtWX, XtWy);
      return x0.reduce((s, v, j) => s + v * beta[j], 0);
    } catch (_) {
      return y[0];
    }
  }

  function gwRF(data, xCols, bandwidthKm, seed) {
    const coords = data.map((d) => [d.lat, d.lon]);
    const dists = distanceMatrixKm(coords);
    const bw = bandwidthKm || autoBandwidthKm(dists);
    const n = data.length;
    const y = data.map((d) => d.y);
    const X = data.map((d) => xCols.map((c) => Number(d.row[c])));
    const localImp = Array.from({ length: n }, () => Array(xCols.length).fill(0));
    const localPred = new Array(n).fill(0);
    const rng = mulberry32(seed || 42);
    for (let i = 0; i < n; i++) {
      const w = dists[i].map((d) => Math.exp(-(d * d) / (2 * bw * bw)));
      const maxW = Math.max(...w) || 1;
      const wn = w.map((v) => v / maxW);
      localImp[i] = localWeightedImportance(X, y, wn);
      localPred[i] = weightedLinearPred(
        X.map((row) => [1, ...row]),
        y,
        wn,
        [1, ...X[i]]
      );
      rng();
    }
    const globalImp = xCols.map((name, j) => {
      const col = X.map((row) => row[j]);
      const mx = col.reduce((s, v) => s + v, 0) / n;
      const my = y.reduce((s, v) => s + v, 0) / n;
      let cov = 0; let vx = 0; let vy = 0;
      for (let k = 0; k < n; k++) {
        const dx = col[k] - mx;
        const dy = y[k] - my;
        cov += dx * dy;
        vx += dx * dx;
        vy += dy * dy;
      }
      return [name, Math.abs(cov / Math.sqrt((vx * vy) || 1e-12))];
    }).sort((a, b) => b[1] - a[1]);
    const yvar = y.reduce((s, v) => s + (v - y.reduce((a, b) => a + b, 0) / n) ** 2, 0) / n;
    const r2proxy = 1 - localPred.reduce((s, v, i) => s + (y[i] - v) ** 2, 0) / (n * (yvar || 1));
    return { localImp, localPred, bandwidth: bw, globalImp, r2proxy };
  }

  function runGeographicallyWeighted(rows, modelType, yCol, y2Col, xCols, bandwidthKm) {
    if (modelType === 'gwcorr') {
      const data = prepareGwData(rows, yCol, null, y2Col);
      const y1 = data.map((d) => d.y);
      const y2 = data.map((d) => d.y2);
      const dists = distanceMatrixKm(data.map((d) => [d.lat, d.lon]));
      const res = gwCorr(y1, y2, dists, bandwidthKm || null);
      const fipsMap = {};
      data.forEach((d, i) => { fipsMap[d.fips] = res.localR[i]; });
      renderChoropleth('spatial-map-gw', fipsMap, {
        diverging: true, title: `GWCORR · ${yCol} × ${y2Col}`, vmin: -1, vmax: 1,
      });
      const chartEl = document.getElementById('spatial-chart-gw');
      if (chartEl) {
        chartEl.innerHTML = '<p class="note" style="padding:12px;margin:0;height:100%;display:flex;align-items:center;justify-content:center;text-align:center">Local Pearson r at each county (blue = negative, red = positive).</p>';
      }
      const valid = res.localR.filter(Number.isFinite);
      return {
        summary: [
          `GWCORR: local Pearson r between ${yCol} and ${y2Col}`,
          `Counties: ${data.length}  ·  bandwidth ≈ ${res.bandwidth.toFixed(0)} km`,
          `Mean local r = ${(valid.reduce((s, v) => s + v, 0) / valid.length).toFixed(3)}`,
          `Range: [${Math.min(...valid).toFixed(3)}, ${Math.max(...valid).toFixed(3)}]`,
        ].join('\n'),
        kpis: { main: (valid.reduce((s, v) => s + v, 0) / valid.length).toFixed(3), bw: res.bandwidth.toFixed(0), n: data.length },
        betaOptions: null,
      };
    }

    if (!xCols || !xCols.length) throw new Error('Select at least one predictor.');
    const data = prepareGwData(rows, yCol, xCols);

    if (modelType === 'gwols') {
      const res = gwOLS(data, xCols, bandwidthKm || null);
      const mapCol = xCols[0];
      const colIdx = xCols.indexOf(mapCol) + 1;
      const fipsMap = {};
      data.forEach((d, i) => { fipsMap[d.fips] = res.betas[i][colIdx]; });
      renderChoropleth('spatial-map-gw', fipsMap, { diverging: true, title: `GW-OLS β · ${mapCol}` });
      drawMoranScatter(
        document.getElementById('spatial-chart-gw'),
        data.map((d) => d.y),
        res.pred,
        res.r2,
        `Observed vs GW-OLS fitted`
      );
      return {
        summary: [
          `GW-OLS: ${yCol} ~ ${xCols.join(' + ')}`,
          `Counties: ${data.length}  ·  bandwidth ≈ ${res.bandwidth.toFixed(0)} km`,
          `Global R² (GW-OLS): ${res.r2.toFixed(3)}`,
          `Map shows local β for ${mapCol} (change via dropdown after run).`,
        ].join('\n'),
        kpis: { main: res.r2.toFixed(3), bw: res.bandwidth.toFixed(0), n: data.length },
        betaOptions: xCols,
        gwResult: { type: 'gwols', data, res, xCols },
      };
    }

    const res = gwRF(data, xCols, bandwidthKm || null, 42);
    const mapCol = xCols[0];
    const j = xCols.indexOf(mapCol);
    const fipsMap = {};
    data.forEach((d, i) => { fipsMap[d.fips] = res.localImp[i][j]; });
    renderChoropleth('spatial-map-gw', fipsMap, { title: `GW-RF importance · ${mapCol}` });
    drawBarChart(
      document.getElementById('spatial-chart-gw'),
      res.globalImp,
      'Global feature importance (browser proxy)'
    );
    return {
      summary: [
        `GW-RF: local feature importance for ${yCol}`,
        `Counties: ${data.length}  ·  bandwidth ≈ ${res.bandwidth.toFixed(0)} km`,
        `Local R² proxy: ${res.r2proxy.toFixed(3)}`,
        'Browser uses weighted local association; full GW-RF in Python export.',
        '',
        'Global importance:',
        ...res.globalImp.map(([name, val]) => `  ${name}: ${val.toFixed(3)}`),
      ].join('\n'),
      kpis: { main: res.r2proxy.toFixed(3), bw: res.bandwidth.toFixed(0), n: data.length },
      betaOptions: xCols,
      gwResult: { type: 'gwrf', data, res, xCols },
    };
  }

  function renderGwBetaMap(gwResult, mapCol) {
    if (!gwResult) return;
    const { data, res, xCols } = gwResult;
    if (gwResult.type === 'gwols') {
      const colIdx = xCols.indexOf(mapCol) + 1;
      const fipsMap = {};
      data.forEach((d, i) => { fipsMap[d.fips] = res.betas[i][colIdx]; });
      renderChoropleth('spatial-map-gw', fipsMap, { diverging: true, title: `GW-OLS β · ${mapCol}` });
    } else if (gwResult.type === 'gwrf') {
      const j = xCols.indexOf(mapCol);
      const fipsMap = {};
      data.forEach((d, i) => { fipsMap[d.fips] = res.localImp[i][j]; });
      renderChoropleth('spatial-map-gw', fipsMap, { title: `GW-RF importance · ${mapCol}` });
    }
  }

  function renderResultsTable(tbodyId, headers, rows) {
    const thead = document.querySelector(`#${tbodyId}`)?.closest('table')?.querySelector('thead');
    const tbody = document.getElementById(tbodyId);
    if (!thead || !tbody) return;
    thead.innerHTML = '<tr>' + headers.map((h) => `<th>${h}</th>`).join('') + '</tr>';
    tbody.innerHTML = rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('');
  }

  function runBivariateMoran(rows, xCol, yCol, weightsType, nPerm) {
    const data = prepareBivariateData(rows, xCol, yCol);
    const x = data.map((d) => d.x);
    const y = data.map((d) => d.y);
    const W = buildWeights(data, weightsType);
    const perm = Math.min(Math.max(nPerm, 99), 499);
    const localRes = localMoransBV(x, y, W, Math.min(perm, 199));
    const fipsCluster = {};
    data.forEach((d, i) => { fipsCluster[d.fips] = localRes.cluster[i]; });
    renderChoropleth('spatial-map-bivar', fipsCluster, { categorical: BV_CLUSTER_COLORS, title: 'Bivariate LISA clusters' });
    const meanI = localRes.Ilocal.reduce((s, v) => s + v, 0) / localRes.Ilocal.length;
    drawMoranScatter(
      document.getElementById('spatial-chart-bivar-moran'),
      localRes.zXStd,
      localRes.zYLag,
      meanI,
      `Bivariate Moran · ${xCol} (i) × lag(${yCol})`
    );
    const counts = { HH: 0, LL: 0, HL: 0, LH: 0, NS: 0 };
    localRes.cluster.forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
    const sig = localRes.pvals.filter((p) => p < 0.05).length;
    return {
      summary: [
        `Bivariate Local Moran's I: ${xCol} at county i × spatial lag of ${yCol} in neighbours`,
        `Counties analyzed: ${data.length}  ·  weights: ${weightsType}  ·  permutations: ${perm}`,
        `Significant locations (p < 0.05): ${sig}`,
        '',
        'Bivariate LISA clusters (p < 0.05):',
        `  HH (high ${xCol}, high neighbour ${yCol}): ${counts.HH}`,
        `  LL (low ${xCol}, low neighbour ${yCol}): ${counts.LL}`,
        `  HL / LH (discordant): ${counts.HL + counts.LH}   Not significant: ${counts.NS}`,
      ].join('\n'),
      table: Object.entries(counts).map(([k, v]) => [k, v, (100 * v / data.length).toFixed(1) + '%']),
      kpis: { hh: counts.HH, sig, n: data.length },
    };
  }

  function runAutocorrelation(rows, yCol, weightsType, nPerm) {
    const data = prepareData(rows, yCol);
    const y = data.map((d) => d.y);
    const W = buildWeights(data, weightsType);
    const perm = Math.min(Math.max(nPerm, 99), 499);
    const globalRes = moransI(y, W, perm);
    const localRes = localMoransI(y, W, Math.min(perm, 199));
    const fipsCluster = {};
    data.forEach((d, i) => { fipsCluster[d.fips] = localRes.cluster[i]; });
    const fipsLisa = {};
    data.forEach((d, i) => { fipsLisa[d.fips] = localRes.Ilocal[i]; });
    renderChoropleth('spatial-map-autocorr', fipsCluster, { categorical: CLUSTER_COLORS, title: 'LISA clusters' });
    drawMoranScatter(
      document.getElementById('spatial-chart-autocorr-moran'),
      globalRes.z,
      globalRes.Wz,
      globalRes.I,
      `Moran scatter · ${yCol}`
    );
    drawHist(
      document.getElementById('spatial-chart-autocorr-perm'),
      globalRes.Iperm,
      "Permuted Moran's I"
    );
    const counts = { HH: 0, LL: 0, HL: 0, LH: 0, NS: 0 };
    localRes.cluster.forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
    return {
      summary: [
        `Global Moran's I = ${globalRes.I.toFixed(4)}  (E[I] = ${globalRes.EI.toFixed(4)})`,
        `z-score = ${globalRes.zScore.toFixed(2)}  ·  p-value = ${globalRes.pValue.toFixed(4)}`,
        `Counties analyzed: ${data.length}  ·  weights: ${weightsType}  ·  permutations: ${perm}`,
        '',
        'LISA clusters (p < 0.05):',
        `  HH (hot spots): ${counts.HH}   LL (cold spots): ${counts.LL}`,
        `  HL / LH outliers: ${counts.HL + counts.LH}   Not significant: ${counts.NS}`,
      ].join('\n'),
      table: Object.entries(counts).map(([k, v]) => [k, v, (100 * v / data.length).toFixed(1) + '%']),
      kpis: { I: globalRes.I.toFixed(3), p: globalRes.pValue.toFixed(4), n: data.length },
    };
  }

  function runRegression(rows, yCol, xCols, modelType) {
    const data = prepareData(rows, yCol);
    const y = data.map((d) => d.y);
    const W = buildWeights(data, 'queen');
    const X = buildDesignMatrix(data, xCols);
    const ols = fitOLSMatrix(y, X);
    const slxDesign = buildSLXDesign(data, xCols, W);
    const slx = fitOLSMatrix(y, slxDesign.X);
    const residMoran = moransI(ols.resid, W, 199);
    const slxResidMoran = moransI(slx.resid, W, 199);

    let active = ols;
    let activeLabel = 'OLS';
    let extra = '';
    let mapVals = {};
    let coeffLines = [];
    let compareTable = null;

    if (modelType === 'slx') {
      active = slx;
      activeLabel = 'SLX';
      data.forEach((d, i) => { mapVals[d.fips] = slx.resid[i]; });
      renderChoropleth('spatial-map-reg', mapVals, { diverging: true, title: 'SLX residuals' });
      drawMoranScatter(
        document.getElementById('spatial-chart-reg-scatter'),
        y,
        slx.yhat,
        slx.r2,
        'Observed vs SLX fitted'
      );
      coeffLines = slxDesign.names.map((name, i) => (
        `  ${name.padEnd(14)}: ${slx.beta[i].toFixed(3)}`
      ));
      extra = [
        'SLX: Y = Xβ + WXθ + ε (neighbours’ covariates included)',
        `R² = ${slx.r2.toFixed(4)}  ·  AIC = ${slx.aic.toFixed(2)}  ·  LogLik = ${slx.llf.toFixed(2)}`,
        `Moran's I (SLX residuals) = ${slxResidMoran.I.toFixed(4)}  ·  p = ${slxResidMoran.pValue.toFixed(4)}`,
        '',
        'SLX coefficients (p-values in Python export):',
        ...coeffLines,
      ];
    } else if (modelType === 'compare') {
      compareTable = [
        ['OLS', ols.aic.toFixed(2), ols.llf.toFixed(2), ols.r2.toFixed(4)],
        ['SLX', slx.aic.toFixed(2), slx.llf.toFixed(2), slx.r2.toFixed(4)],
        ['SAR', '—', '—', 'fit in Python'],
        ['SEM', '—', '—', 'fit in Python'],
      ];
      const best = slx.aic < ols.aic ? 'SLX' : 'OLS';
      extra = [
        'Model comparison (lower AIC preferred; SAR/SEM via Python export):',
        `  Best among OLS/SLX: ${best}`,
        `  OLS  AIC=${ols.aic.toFixed(2)}  R²=${ols.r2.toFixed(4)}`,
        `  SLX  AIC=${slx.aic.toFixed(2)}  R²=${slx.r2.toFixed(4)}`,
        '',
        'SLX coefficients (browser preview):',
        ...slxDesign.names.map((name, i) => `  ${name.padEnd(14)}: ${slx.beta[i].toFixed(3)}`),
      ];
      active = slx.aic < ols.aic ? slx : ols;
      activeLabel = slx.aic < ols.aic ? 'SLX' : 'OLS';
    } else {
      data.forEach((d, i) => { mapVals[d.fips] = active.resid[i]; });
      renderChoropleth('spatial-map-reg', mapVals, { diverging: true, title: 'Regression residuals' });
      drawMoranScatter(
        document.getElementById('spatial-chart-reg-scatter'),
        y,
        active.yhat,
        active.r2,
        `Observed vs ${activeLabel} fitted`
      );
    }
    drawHist(document.getElementById('spatial-chart-reg-resid'), active.resid, `${activeLabel} residuals`);
    const modelNotes = {
      slm: 'Spatial lag (SAR): Y = ρWY + Xβ + ε — full ML fit in Python export.',
      sem: 'Spatial error (SEM): u = λWu + ε — full ML fit in Python export.',
    };
    if (!extra) {
      extra = modelNotes[modelType] || '';
    }
    return {
      summary: [
        `OLS: ${yCol} ~ ${xCols.join(' + ')}`,
        `n = ${data.length}  ·  R² = ${ols.r2.toFixed(4)}  ·  AIC = ${ols.aic.toFixed(2)}  ·  RMSE = ${ols.rmse.toFixed(4)}`,
        `Moran's I (OLS residuals) = ${residMoran.I.toFixed(4)}  ·  p = ${residMoran.pValue.toFixed(4)}`,
        residMoran.pValue < 0.05 ? '→ Residual spatial autocorrelation detected; try SLX, SAR, or SEM.' : '',
        extra,
        modelType !== 'ols_diag' && modelType !== 'slx' && modelType !== 'compare'
          ? `Model type selected: ${modelType} (full fit in Python export).` : '',
      ].filter(Boolean).join('\n'),
      compareTable,
      coeffTable: modelType === 'slx' || modelType === 'compare'
        ? slxDesign.names.map((name, i) => [name, slx.beta[i].toFixed(3)])
        : null,
      kpis: {
        r2: active.r2.toFixed(3),
        moran: (modelType === 'slx' ? slxResidMoran : residMoran).I.toFixed(3),
        n: data.length,
        aic: active.aic.toFixed(1),
      },
    };
  }

  function runBayes(rows, rateCol, popCol, method) {
    const data = prepareData(rows, rateCol, popCol);
    const rateMean = data.reduce((s, d) => s + d.y, 0) / data.length;
    const observed = data.map((d) => {
      if (popCol) return Math.max(0, Math.round((d.y / 100000) * d.pop));
      return Math.max(0, d.y);
    });
    const expected = data.map((d) => {
      if (popCol) return Math.max(1, (rateMean / 100000) * d.pop);
      return Math.max(1, rateMean);
    });
    const smr = observed.map((o, i) => o / expected[i]);
    const eb = empiricalBayes(observed, expected);
    const W = buildWeights(data, 'queen');
    const smoothed = method === 'bym' ? bymApprox(eb.eb, W) : eb.eb;
    const fipsRaw = {}; const fipsSmooth = {};
    data.forEach((d, i) => {
      fipsRaw[d.fips] = smr[i];
      fipsSmooth[d.fips] = smoothed[i];
    });
    renderChoropleth('spatial-map-bayes-raw', fipsRaw, { diverging: true, title: 'Raw SMR' });
    renderChoropleth('spatial-map-bayes-smooth', fipsSmooth, { diverging: true, title: 'Smoothed rate' });
    drawHist(document.getElementById('spatial-chart-bayes-shrink'), eb.shrink, 'Shrinkage factor');
    return {
      summary: [
        `Disease mapping · ${rateCol}${popCol ? ` · pop=${popCol}` : ''}`,
        `Smoothing: ${method === 'bym' ? 'BYM approximate' : 'Empirical Bayes (gamma-Poisson)'}`,
        `n = ${data.length} counties`,
        `Raw SMR/rate  mean=${(smr.reduce((s, v) => s + v, 0) / smr.length).toFixed(3)}  SD=${Math.sqrt(smr.reduce((s, v) => s + (v - rateMean) ** 2, 0) / smr.length).toFixed(3)}`,
        `Smoothed     mean=${(smoothed.reduce((s, v) => s + v, 0) / smoothed.length).toFixed(3)}`,
        `Mean shrinkage: ${(100 * eb.shrink.reduce((s, v) => s + v, 0) / eb.shrink.length).toFixed(1)}%`,
      ].join('\n'),
      kpis: { shrink: (100 * eb.shrink.reduce((s, v) => s + v, 0) / eb.shrink.length).toFixed(1) + '%', n: data.length },
    };
  }

  function runCluster(rows, yCol, popCol, nPerm) {
    const data = prepareData(rows, yCol, popCol);
    const rateMean = data.reduce((s, d) => s + d.y, 0) / data.length;
    data.forEach((d) => {
      d.observed = popCol
        ? Math.max(0, Math.round((d.y / 100000) * d.pop))
        : Math.max(1, Math.round(d.y));
      d.expected = popCol
        ? Math.max(1, (rateMean / 100000) * d.pop)
        : Math.max(1, rateMean);
    });
    const perm = Math.min(Math.max(nPerm, 99), 299);
    const scan = scanStatistic(data, perm);
    const W = buildWeights(data, 'queen');
    const lisa = localMoransI(data.map((d) => d.y), W, 199);
    const fipsScan = {};
    const fipsLisa = {};
    data.forEach((d, i) => {
      fipsScan[d.fips] = scan.inCluster.has(i) ? 1 : 0;
      fipsLisa[d.fips] = lisa.cluster[i];
    });
    renderChoropleth('spatial-map-cluster-scan', fipsScan, {
      categorical: { 0: '#e0e0e0', 1: '#D65F5F' },
      title: 'Scan statistic cluster',
    });
    renderChoropleth('spatial-map-cluster-lisa', fipsLisa, { categorical: CLUSTER_COLORS, title: 'LISA High-High' });
    const nLISA = lisa.cluster.filter((c) => c === 'HH').length;
    return {
      summary: [
        `Kulldorff spatial scan (Poisson, circular windows)`,
        `Best cluster LLR = ${scan.llr.toFixed(3)}  ·  p-value = ${scan.pValue.toFixed(4)}`,
        `Cluster size: ${scan.inside.length} counties  ·  radius ≈ ${(scan.radius || 0).toFixed(0)} km`,
        `Permutations: ${perm}`,
        '',
        `LISA High-High counties: ${nLISA} (compare with scan map)`,
      ].join('\n'),
      kpis: { llr: scan.llr.toFixed(2), p: scan.pValue.toFixed(4), n: scan.inside.length },
    };
  }

  function invalidateMaps() {
    Object.values(maps).forEach((m) => {
      try {
        m.invalidateSize();
        fitConus(m);
      } catch (_) { /* ignore */ }
    });
  }

  global.SpatialStatistics = {
    runAutocorrelation,
    runBivariateMoran,
    runRegression,
    runGeographicallyWeighted,
    renderGwBetaMap,
    runBayes,
    runCluster,
    renderChoropleth,
    refreshChoropleths,
    getMapStyle,
    setMapStyle,
    invalidateMaps,
    destroyMap,
  };
})(typeof window !== 'undefined' ? window : globalThis);
