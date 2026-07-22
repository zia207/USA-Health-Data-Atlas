/**
 * Browser ML dashboard for model_frame regression workflows.
 */
(function (global) {
  const SEED = 42;
  const MODEL_BADGES = {
    OLS: 'Fast', Ridge: 'Fast', Lasso: 'Fast', ElasticNet: 'Fast',
    'Random Forest': 'Med', 'Gradient Boosting': 'Slow', XGBoost: 'Slow',
    LightGBM: 'Slow', 'k-NN': 'Med', MLP: 'Slow',
  };

  function factorial(n) {
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function shuffleIdx(n, rng) {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx;
  }

  function prepareMatrix(rows, target, features) {
    const X = []; const y = []; const meta = [];
    for (const r of rows) {
      const yi = r[target];
      if (typeof yi !== 'number' || !Number.isFinite(yi)) continue;
      const xi = [];
      let ok = true;
      for (const f of features) {
        const v = r[f];
        if (typeof v !== 'number' || !Number.isFinite(v)) { ok = false; break; }
        xi.push(v);
      }
      if (!ok) continue;
      X.push(xi);
      y.push(yi);
      meta.push({ fips: r.fips, year: r.year });
    }
    if (X.length < 10) throw new Error('Need at least 10 complete rows.');
    return { X, y, meta, n: X.length, p: features.length, features };
  }

  function splitIndices(meta, strategy, trainF, valF, rng) {
    const n = meta.length;
    const testF = Math.max(0, 1 - trainF - valF);
    const nTr = Math.floor(n * trainF);
    const nVa = Math.floor(n * valF);
    const nTe = n - nTr - nVa;

    if (strategy === 'Temporal') {
      const years = meta.map((m) => Number(m.year) || 0);
      const order = years.map((yr, i) => ({ yr, i })).sort((a, b) => a.yr - b.yr);
      const sorted = order.map((o) => o.i);
      const uniq = [...new Set(years.filter((y) => y > 0))].sort((a, b) => a - b);
      if (uniq.length >= 3) {
        const trCut = uniq[Math.floor(uniq.length * trainF)] || uniq[0];
        const vaCut = uniq[Math.floor(uniq.length * (trainF + valF))] || uniq[uniq.length - 1];
        const train = []; const val = []; const test = [];
        meta.forEach((m, i) => {
          const yr = Number(m.year) || 0;
          if (yr < trCut) train.push(i);
          else if (yr < vaCut) val.push(i);
          else test.push(i);
        });
        if (train.length && val.length && test.length) {
          return { train, val, test, nTr: train.length, nVa: val.length, nTe: test.length, testF };
        }
      }
      const tr = sorted.slice(0, nTr);
      const va = sorted.slice(nTr, nTr + nVa);
      const te = sorted.slice(nTr + nVa);
      return { train: tr, val: va, test: te, nTr: tr.length, nVa: va.length, nTe: te.length, testF };
    }

    if (strategy === 'Spatial') {
      const fipsList = [...new Set(meta.map((m) => String(m.fips || '')))].filter(Boolean);
      const fShuf = shuffleIdx(fipsList.length, rng).map((i) => fipsList[i]);
      const nF = fipsList.length;
      const nFtr = Math.floor(nF * trainF);
      const nFva = Math.floor(nF * valF);
      const trF = new Set(fShuf.slice(0, nFtr));
      const vaF = new Set(fShuf.slice(nFtr, nFtr + nFva));
      const train = []; const val = []; const test = [];
      meta.forEach((m, i) => {
        const f = String(m.fips || '');
        if (trF.has(f)) train.push(i);
        else if (vaF.has(f)) val.push(i);
        else test.push(i);
      });
      return { train, val, test, nTr: train.length, nVa: val.length, nTe: test.length, testF };
    }

    const shuf = shuffleIdx(n, rng);
    const train = shuf.slice(0, nTr);
    const val = shuf.slice(nTr, nTr + nVa);
    const test = shuf.slice(nTr + nVa);
    return { train, val, test, nTr, nVa, nTe: test.length, testF };
  }

  function subsetXY(X, y, idx) {
    return {
      X: idx.map((i) => X[i].slice()),
      y: idx.map((i) => y[i]),
    };
  }

  function fitScaler(X) {
    const p = X[0].length;
    const n = X.length;
    const mean = Array(p).fill(0);
    const std = Array(p).fill(1);
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X[i][j];
      mean[j] = s / n;
      let v = 0;
      for (let i = 0; i < n; i++) v += (X[i][j] - mean[j]) ** 2;
      std[j] = Math.sqrt(v / n) || 1;
    }
    return {
      mean, std, enabled: true,
      transform(mat) {
        return mat.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
      },
      inverseRow(row) {
        return row.map((v, j) => v * std[j] + mean[j]);
      },
    };
  }

  function identityScaler(p) {
    return {
      mean: Array(p).fill(0), std: Array(p).fill(1), enabled: false,
      transform(mat) { return mat.map((row) => row.slice()); },
      inverseRow(row) { return row.slice(); },
    };
  }

  function fitYScaler(y) {
    const mean = y.reduce((s, v) => s + v, 0) / y.length;
    const std = Math.sqrt(y.reduce((s, v) => s + (v - mean) ** 2, 0) / y.length) || 1;
    return {
      mean, std, enabled: true,
      transform(arr) { return arr.map((v) => (v - mean) / std); },
      inverse(arr) { return arr.map((v) => v * std + mean); },
    };
  }

  function identityYScaler() {
    return { mean: 0, std: 1, enabled: false, transform(a) { return a.slice(); }, inverse(a) { return a.slice(); } };
  }

  function wrapPredict(model, xScaler, yScaler) {
    const inner = model.predict.bind(model);
    return (mat) => yScaler.inverse(inner(xScaler.transform(mat)));
  }

  function addIntercept(X) {
    return X.map((row) => [1, ...row]);
  }

  function solveLinear(A, b) {
    const n = b.length;
    const aug = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
      }
      const div = aug[pivot][col] || 1e-12;
      if (Math.abs(div) < 1e-12) throw new Error('Singular matrix.');
      [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
      for (let j = 0; j <= n; j++) aug[col][j] /= div;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = aug[r][col];
        for (let j = 0; j <= n; j++) aug[r][j] -= f * aug[col][j];
      }
    }
    return aug.map((row) => row[n]);
  }

  function matMul(A, B) {
    const n = A.length; const m = B[0].length; const k = B.length;
    const C = Array.from({ length: n }, () => Array(m).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        let s = 0;
        for (let t = 0; t < k; t++) s += A[i][t] * B[t][j];
        C[i][j] = s;
      }
    }
    return C;
  }

  function transpose(A) {
    return A[0].map((_, j) => A.map((row) => row[j]));
  }

  function ridgeFit(X, y, alpha) {
    const Xt = transpose(X);
    const XtX = matMul(Xt, X);
    for (let i = 0; i < XtX.length; i++) XtX[i][i] += alpha;
    const Xty = matMul(Xt, y.map((v) => [v])).map((r) => r[0]);
    const beta = solveLinear(XtX, Xty);
    return beta;
  }

  function predictLinear(X, beta) {
    return X.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  }

  function lassoFit(X, y, alpha, maxIter) {
    const n = X.length; const m = X[0].length;
    const beta = Array(m).fill(0);
    for (let it = 0; it < maxIter; it++) {
      for (let j = 0; j < m; j++) {
        let r = 0; let z = 0;
        for (let i = 0; i < n; i++) {
          const pred = X[i].reduce((s, v, k) => s + (k === j ? 0 : v * beta[k]), 0);
          r += X[i][j] * (y[i] - pred);
          z += X[i][j] ** 2;
        }
        const soft = z < 1e-12 ? 0 : Math.sign(r) * Math.max(0, Math.abs(r) - alpha * n) / z;
        beta[j] = soft;
      }
    }
    return beta;
  }

  function elasticNetFit(X, y, alpha, l1Ratio) {
    const l1 = alpha * l1Ratio;
    const l2 = alpha * (1 - l1Ratio);
    const n = X.length; const m = X[0].length;
    const beta = Array(m).fill(0);
    for (let it = 0; it < 200; it++) {
      for (let j = 1; j < m; j++) {
        let r = 0; let z = l2;
        for (let i = 0; i < n; i++) {
          const pred = X[i].reduce((s, v, k) => s + (k === j ? 0 : v * beta[k]), 0);
          r += X[i][j] * (y[i] - pred);
          z += X[i][j] ** 2;
        }
        beta[j] = z < 1e-12 ? 0 : Math.sign(r) * Math.max(0, Math.abs(r) - l1 * n) / z;
      }
      let r0 = 0;
      for (let i = 0; i < n; i++) {
        const pred = X[i].slice(1).reduce((s, v, k) => s + v * beta[k + 1], 0);
        r0 += y[i] - pred;
      }
      beta[0] = r0 / n;
    }
    return beta;
  }

  function buildTree(X, y, idx, depth, maxDepth, rng, nTry, minLeaf) {
    const minSamples = minLeaf || 5;
    if (depth >= maxDepth || idx.length < minSamples * 2) {
      const mean = idx.reduce((s, i) => s + y[i], 0) / idx.length;
      return { leaf: mean };
    }
    const p = X[0].length;
    const feats = shuffleIdx(p, rng).slice(0, Math.max(1, nTry));
    let bestGain = 0; let best = null;
    for (const j of feats) {
      const vals = idx.map((i) => X[i][j]).sort((a, b) => a - b);
      const candidates = [0.25, 0.5, 0.75].map((q) => vals[Math.floor(vals.length * q)] || vals[0]);
      for (const thr of [...new Set(candidates)]) {
        const left = []; const right = [];
        idx.forEach((i) => (X[i][j] <= thr ? left : right).push(i));
        if (left.length < minSamples || right.length < minSamples) continue;
        const meanL = left.reduce((s, i) => s + y[i], 0) / left.length;
        const meanR = right.reduce((s, i) => s + y[i], 0) / right.length;
        let sse = 0;
        idx.forEach((i) => {
          const m = left.includes(i) ? meanL : meanR;
          sse += (y[i] - m) ** 2;
        });
        const base = idx.reduce((s, i) => s + y[i], 0) / idx.length;
        const sse0 = idx.reduce((s, i) => s + (y[i] - base) ** 2, 0);
        const gain = sse0 - sse;
        if (gain > bestGain) {
          bestGain = gain;
          best = { j, thr, left, right };
        }
      }
    }
    if (!best) {
      const mean = idx.reduce((s, i) => s + y[i], 0) / idx.length;
      return { leaf: mean };
    }
    return {
      j: best.j, thr: best.thr,
      left: buildTree(X, y, best.left, depth + 1, maxDepth, rng, nTry, minSamples),
      right: buildTree(X, y, best.right, depth + 1, maxDepth, rng, nTry, minSamples),
    };
  }

  function treePredict(node, x) {
    if (node.leaf != null) return node.leaf;
    return x[node.j] <= node.thr ? treePredict(node.left, x) : treePredict(node.right, x);
  }

  function randomForestTrain(X, y, opts) {
    const rng = mulberry32(opts.seed || SEED);
    const nTrees = opts.nTrees || 80;
    const maxDepth = opts.maxDepth || 12;
    const minLeaf = opts.minLeaf || 5;
    const trees = [];
    const n = X.length;
    for (let t = 0; t < nTrees; t++) {
      const idx = Array.from({ length: n }, () => Math.floor(rng() * n));
      trees.push(buildTree(X, y, idx, 0, maxDepth, rng, Math.ceil(Math.sqrt(X[0].length)), minLeaf));
    }
    return {
      type: 'rf', trees, params: { nTrees, maxDepth, minLeaf },
      predictScaled(mat) {
        return mat.map((x) => {
          const preds = trees.map((tr) => treePredict(tr, x));
          return preds.reduce((s, v) => s + v, 0) / preds.length;
        });
      },
      featureImportance() {
        const imp = Array(X[0].length).fill(0);
        trees.forEach((tr) => {
          function walk(node) {
            if (node.leaf != null) return;
            imp[node.j] += 1;
            walk(node.left); walk(node.right);
          }
          walk(tr);
        });
        const s = imp.reduce((a, b) => a + b, 0) || 1;
        return imp.map((v) => v / s);
      },
    };
  }

  function gbmTrain(X, y, opts) {
    const rng = mulberry32(opts.seed || SEED);
    const rounds = opts.rounds || 100;
    const lr = opts.lr || 0.05;
    const maxDepth = opts.maxDepth || 4;
    const base = y.reduce((s, v) => s + v, 0) / y.length;
    let pred = Array(y.length).fill(base);
    const trees = [];
    for (let r = 0; r < rounds; r++) {
      const resid = y.map((yi, i) => yi - pred[i]);
      const idx = X.map((_, i) => i);
      const tree = buildTree(X, resid, idx, 0, maxDepth, rng, X[0].length, 5);
      trees.push(tree);
      for (let i = 0; i < pred.length; i++) pred[i] += lr * treePredict(tree, X[i]);
    }
    return {
      type: 'gbm', trees, lr, base, params: { rounds, lr, maxDepth },
      predictScaled(mat) {
        return mat.map((x) => {
          let p = base;
          trees.forEach((tr) => { p += lr * treePredict(tr, x); });
          return p;
        });
      },
      featureImportance() {
        const imp = Array(X[0].length).fill(0);
        trees.forEach((tr) => { if (tr.j != null) imp[tr.j] += 1; });
        const s = imp.reduce((a, b) => a + b, 0) || 1;
        return imp.map((v) => v / s);
      },
    };
  }

  function xgbTrain(X, y, opts) {
    const rng = mulberry32(opts.seed || SEED);
    const rounds = opts.rounds || 120;
    const lr = opts.lr || 0.05;
    const maxDepth = opts.maxDepth || 5;
    const subsample = opts.subsample || 0.8;
    const regLambda = opts.regLambda || 1.0;
    const base = y.reduce((s, v) => s + v, 0) / y.length;
    let pred = Array(y.length).fill(base);
    const trees = [];
    const n = X.length;
    for (let r = 0; r < rounds; r++) {
      const resid = y.map((yi, i) => yi - pred[i]);
      const idx = shuffleIdx(n, rng)
        .slice(0, Math.max(5, Math.floor(n * subsample)))
        .map((i) => i);
      const tree = buildTree(X, resid, idx, 0, maxDepth, rng, Math.ceil(Math.sqrt(X[0].length)), 5);
      trees.push(tree);
      for (let i = 0; i < n; i++) {
        const leaf = treePredict(tree, X[i]);
        const shrink = leaf / (1 + regLambda);
        pred[i] += lr * shrink;
      }
    }
    return {
      type: 'xgb', trees, lr, base, params: { rounds, lr, maxDepth, subsample, regLambda },
      predictScaled(mat) {
        return mat.map((x) => {
          let p = base;
          trees.forEach((tr) => { p += lr * (treePredict(tr, x) / (1 + regLambda)); });
          return p;
        });
      },
      featureImportance() {
        const imp = Array(X[0].length).fill(0);
        trees.forEach((tr) => { if (tr.j != null) imp[tr.j] += 1; });
        const s = imp.reduce((a, b) => a + b, 0) || 1;
        return imp.map((v) => v / s);
      },
    };
  }

  function lgbmTrain(X, y, opts) {
    const core = gbmTrain(X, y, {
      seed: opts.seed || SEED,
      rounds: opts.rounds || 150,
      lr: opts.lr || 0.05,
      maxDepth: opts.maxDepth || 8,
    });
    return {
      ...core,
      type: 'lgbm',
      params: { rounds: opts.rounds || 150, lr: opts.lr || 0.05, maxDepth: opts.maxDepth || 8 },
    };
  }

  function mlpTrain(X, y, opts) {
    const rng = mulberry32(opts.seed || SEED);
    const h = opts.hidden || 48;
    const lr = opts.lr || 0.02;
    const epochs = opts.epochs || 250;
    const n = X.length; const p = X[0].length;
    const rand = () => (rng() - 0.5) * 0.2;
    let W1 = Array.from({ length: p }, () => Array.from({ length: h }, rand));
    let b1 = Array(h).fill(0);
    let W2 = Array.from({ length: h }, rand);
    let b2 = 0;
    const relu = (v) => (v > 0 ? v : 0);
    function forward(x) {
      const z1 = b1.map((b, j) => b + W1.reduce((s, row, i) => s + row[j] * x[i], 0));
      const a1 = z1.map(relu);
      const out = b2 + W2.reduce((s, w, j) => s + w * a1[j], 0);
      return { z1, a1, out };
    }
    for (let ep = 0; ep < epochs; ep++) {
      for (let i = 0; i < n; i++) {
        const { z1, a1, out } = forward(X[i]);
        const err = out - y[i];
        for (let j = 0; j < h; j++) W2[j] -= lr * err * a1[j];
        b2 -= lr * err;
        for (let j = 0; j < h; j++) {
          const da = err * W2[j] * (z1[j] > 0 ? 1 : 0);
          b1[j] -= lr * da;
          for (let k = 0; k < p; k++) W1[k][j] -= lr * da * X[i][k];
        }
      }
    }
    return {
      type: 'mlp', W1, b1, W2, b2, params: { hidden: h, lr, epochs },
      predictScaled(mat) {
        return mat.map((x) => forward(x).out);
      },
      coefImportance() {
        return W1.map((row) => row.reduce((s, v) => s + Math.abs(v), 0));
      },
    };
  }

  function knnTrain(X, y, k) {
    const kk = k || 15;
    return {
      type: 'knn', X, y, k: kk, params: { k: kk },
      predictScaled(mat) {
        return mat.map((x) => {
          const dists = X.map((xi, i) => {
            let d = 0;
            for (let j = 0; j < x.length; j++) d += (x[j] - xi[j]) ** 2;
            return { i, d: Math.sqrt(d) };
          }).sort((a, b) => a.d - b.d).slice(0, kk);
          const wsum = dists.reduce((s, d) => s + 1 / (d.d + 1e-6), 0);
          return dists.reduce((s, d) => s + y[d.i] / (d.d + 1e-6), 0) / wsum;
        });
      },
    };
  }

  const DEFAULT_HP = {
    OLS: {},
    Ridge: { alpha: 1.0 },
    Lasso: { alpha: 0.05 },
    ElasticNet: { alpha: 0.05, l1Ratio: 0.5 },
    'Random Forest': { nTrees: 80, maxDepth: 12, minLeaf: 5 },
    'Gradient Boosting': { rounds: 100, lr: 0.05, maxDepth: 4 },
    XGBoost: { rounds: 120, lr: 0.05, maxDepth: 5, subsample: 0.8, regLambda: 1.0 },
    LightGBM: { rounds: 150, lr: 0.05, maxDepth: 8 },
    'k-NN': { k: 15 },
    MLP: { hidden: 48, lr: 0.02, epochs: 250 },
  };

  const HP_GRIDS = {
    Ridge: { alpha: [0.01, 0.1, 1, 10, 100] },
    Lasso: { alpha: [0.001, 0.01, 0.05, 0.1, 0.5] },
    ElasticNet: { alpha: [0.01, 0.05, 0.1], l1Ratio: [0.25, 0.5, 0.75] },
    'Random Forest': { nTrees: [50, 80, 120], maxDepth: [8, 12, 16], minLeaf: [3, 5, 10] },
    'Gradient Boosting': { rounds: [60, 100, 150], lr: [0.03, 0.05, 0.1], maxDepth: [3, 4, 6] },
    XGBoost: { rounds: [80, 120], lr: [0.03, 0.05, 0.08], maxDepth: [4, 5, 6] },
    LightGBM: { rounds: [100, 150], lr: [0.03, 0.05, 0.08], maxDepth: [6, 8, 10] },
    'k-NN': { k: [5, 10, 15, 20, 30] },
    MLP: { hidden: [32, 48, 64], lr: [0.01, 0.02, 0.05] },
  };

  function cartesian(grid) {
    const keys = Object.keys(grid);
    if (!keys.length) return [{}];
    const out = [];
    function walk(i, cur) {
      if (i >= keys.length) { out.push({ ...cur }); return; }
      const k = keys[i];
      grid[k].forEach((v) => { cur[k] = v; walk(i + 1, cur); });
    }
    walk(0, {});
    return out;
  }

  function randomHpSamples(grid, n, rng) {
    const keys = Object.keys(grid);
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = {};
      keys.forEach((k) => { p[k] = grid[k][Math.floor(rng() * grid[k].length)]; });
      out.push(p);
    }
    return out;
  }

  function trainModelCore(name, Xtr, ytr, params) {
    const p = { ...DEFAULT_HP[name], ...params };
    if (name === 'OLS') {
      const beta = ridgeFit(addIntercept(Xtr), ytr, 1e-8);
      return {
        type: 'linear', beta, params: p,
        predictScaled(mat) { return predictLinear(addIntercept(mat), beta); },
        coefImportance() { return beta.slice(1).map(Math.abs); },
      };
    }
    if (name === 'Ridge') {
      const beta = ridgeFit(addIntercept(Xtr), ytr, p.alpha);
      return {
        type: 'linear', beta, params: p,
        predictScaled(mat) { return predictLinear(addIntercept(mat), beta); },
        coefImportance() { return beta.slice(1).map(Math.abs); },
      };
    }
    if (name === 'Lasso') {
      const beta = lassoFit(addIntercept(Xtr), ytr, p.alpha, 400);
      return {
        type: 'linear', beta, params: p,
        predictScaled(mat) { return predictLinear(addIntercept(mat), beta); },
        coefImportance() { return beta.slice(1).map(Math.abs); },
      };
    }
    if (name === 'ElasticNet') {
      const beta = elasticNetFit(addIntercept(Xtr), ytr, p.alpha, p.l1Ratio);
      return {
        type: 'linear', beta, params: p,
        predictScaled(mat) { return predictLinear(addIntercept(mat), beta); },
        coefImportance() { return beta.slice(1).map(Math.abs); },
      };
    }
    if (name === 'Random Forest') return randomForestTrain(Xtr, ytr, { seed: SEED, ...p });
    if (name === 'Gradient Boosting') return gbmTrain(Xtr, ytr, { seed: SEED, ...p });
    if (name === 'XGBoost') return xgbTrain(Xtr, ytr, { seed: SEED, ...p });
    if (name === 'LightGBM') return lgbmTrain(Xtr, ytr, { seed: SEED, ...p });
    if (name === 'MLP') return mlpTrain(Xtr, ytr, { seed: SEED, ...p });
    if (name === 'k-NN') return knnTrain(Xtr, ytr, p.k);
    throw new Error(`Unknown model: ${name}`);
  }

  function finalizeModel(core, xScaler, yScaler) {
    return {
      ...core,
      xScaler, yScaler,
      params: core.params || {},
      predict(mat) {
        const Xs = xScaler.transform(mat);
        const yScaled = core.predictScaled(Xs);
        return yScaler.inverse(yScaled);
      },
      coefImportance() { return core.coefImportance ? core.coefImportance() : null; },
      featureImportance() { return core.featureImportance ? core.featureImportance() : null; },
    };
  }

  function trainModel(name, Xtr, ytr, xScaler, yScaler, params) {
    const Xs = xScaler.transform(Xtr);
    const ys = yScaler.transform(ytr);
    const core = trainModelCore(name, Xs, ys, params);
    return finalizeModel(core, xScaler, yScaler);
  }

  function tuneModel(name, Xtr, ytr, Xva, yva, xScaler, yScaler, hpConfig) {
    const grid = HP_GRIDS[name];
    const strategy = hpConfig?.strategy || 'default';
    const rmse = (y, p) => Math.sqrt(y.reduce((s, yi, i) => s + (yi - p[i]) ** 2, 0) / y.length);
    if (!grid || strategy === 'default') {
      const mdl = trainModel(name, Xtr, ytr, xScaler, yScaler, DEFAULT_HP[name]);
      return { model: mdl, params: mdl.params };
    }
    const rng = mulberry32(SEED + name.length);
    const candidates = strategy === 'grid'
      ? cartesian(grid)
      : randomHpSamples(grid, hpConfig.iterations || 18, rng);
    let best = null; let bestRmse = Infinity; let bestParams = DEFAULT_HP[name];
    const XvaS = xScaler.transform(Xva);
    const yvaS = yScaler.transform(yva);
    for (const params of candidates) {
      try {
        const core = trainModelCore(name, xScaler.transform(Xtr), yScaler.transform(ytr), params);
        const pred = yScaler.inverse(core.predictScaled(XvaS));
        const score = rmse(yva, pred);
        if (score < bestRmse) {
          bestRmse = score;
          bestParams = { ...params };
          best = finalizeModel(core, xScaler, yScaler);
        }
      } catch (_) { /* skip bad combos */ }
    }
    if (!best) best = trainModel(name, Xtr, ytr, xScaler, yScaler, DEFAULT_HP[name]);
    return { model: best, params: bestParams, valRmse: bestRmse };
  }

  const METRIC_FNS = {
    RMSE(y, p) {
      return Math.sqrt(y.reduce((s, yi, i) => s + (yi - p[i]) ** 2, 0) / y.length);
    },
    MAE(y, p) {
      return y.reduce((s, yi, i) => s + Math.abs(yi - p[i]), 0) / y.length;
    },
    'R²'(y, p) {
      const mean = y.reduce((s, v) => s + v, 0) / y.length;
      const ssRes = y.reduce((s, yi, i) => s + (yi - p[i]) ** 2, 0);
      const ssTot = y.reduce((s, yi) => s + (yi - mean) ** 2, 0);
      return ssTot > 0 ? 1 - ssRes / ssTot : 0;
    },
    MAPE(y, p) {
      const m = y.map((yi, i) => (yi !== 0 ? Math.abs((yi - p[i]) / yi) : null)).filter((v) => v != null);
      return m.length ? (m.reduce((s, v) => s + v, 0) / m.length) * 100 : NaN;
    },
    MedAE(y, p) {
      const d = y.map((yi, i) => Math.abs(yi - p[i])).sort((a, b) => a - b);
      const mid = Math.floor(d.length / 2);
      return d.length % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2;
    },
  };

  function evaluate(y, p, metrics) {
    const out = {};
    metrics.forEach((m) => {
      const v = METRIC_FNS[m](y, p);
      out[m] = Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
    });
    return out;
  }

  function pearsonImp(rows, target, features) {
    const imp = {};
    features.forEach((f) => {
      const xs = []; const ys = [];
      rows.forEach((r) => {
        const x = r[f]; const y = r[target];
        if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
      });
      if (xs.length < 5) { imp[f] = 0; return; }
      const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
      const my = ys.reduce((s, v) => s + v, 0) / ys.length;
      let num = 0; let dx = 0; let dy = 0;
      for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        dx += (xs[i] - mx) ** 2;
        dy += (ys[i] - my) ** 2;
      }
      imp[f] = Math.abs(num / (Math.sqrt(dx * dy) || 1));
    });
    return imp;
  }

  function permImportance(model, X, y, features, metric) {
    const baseP = model.predict(X);
    const base = METRIC_FNS[metric](y, baseP);
    const imp = {};
    features.forEach((f, j) => {
      const Xp = X.map((row) => row.slice());
      const col = Xp.map((r) => r[j]);
      const shuf = shuffleIdx(col.length, mulberry32(SEED + j));
      for (let i = 0; i < Xp.length; i++) Xp[i][j] = col[shuf[i]];
      const p = model.predict(Xp);
      const sc = METRIC_FNS[metric](y, p);
      imp[f] = Math.max(0, (metric === 'R²' ? base - sc : sc - base));
    });
    return imp;
  }

  function drawBarH(el, labels, values, opts) {
    if (!el) return;
    const w = Math.max(420, el.clientWidth || 480);
    const h = Math.max(180, labels.length * 28 + 50);
    const padL = 120; const padR = 20; const padT = 24; const padB = 20;
    const vmax = Math.max(...values, 1e-9);
    const bars = labels.map((lab, i) => {
      const v = values[i];
      const bw = ((w - padL - padR) * v) / vmax;
      const y = padT + i * 26;
      const col = (opts.colors && opts.colors[i]) || '#14707e';
      return `<text x="${padL - 6}" y="${y + 14}" text-anchor="end" font-size="11">${lab}</text>`
        + `<rect x="${padL}" y="${y}" width="${Math.max(1, bw)}" height="18" fill="${col}" rx="2"/>`;
    }).join('');
    el.innerHTML = `<svg width="${w}" height="${h}" role="img"><text x="${padL}" y="14" font-size="12" font-weight="600">${opts.title || ''}</text>${bars}</svg>`;
  }

  function drawScatter(el, actual, predicted, title) {
    if (!el || !actual.length) return;
    const w = Math.max(420, el.clientWidth || 480);
    const h = 260;
    const pad = 40;
    const lo = Math.min(...actual, ...predicted);
    const hi = Math.max(...actual, ...predicted);
    const sx = (v) => pad + ((v - lo) / ((hi - lo) || 1)) * (w - pad - 12);
    const sy = (v) => h - pad - ((v - lo) / ((hi - lo) || 1)) * (h - pad - 12);
    const dots = actual.map((a, i) =>
      `<circle cx="${sx(a)}" cy="${sy(predicted[i])}" r="2.5" fill="#14707e" fill-opacity="0.4"/>`
    ).join('');
    const line = `<line x1="${sx(lo)}" y1="${sy(lo)}" x2="${sx(hi)}" y2="${sy(hi)}" stroke="#E24B4A" stroke-width="1.5" stroke-dasharray="4"/>`;
    el.innerHTML = `<svg width="${w}" height="${h}"><text x="${pad}" y="16" font-size="12">${title}</text>${dots}${line}</svg>`;
  }

  function drawHist(el, values, title) {
    if (!el || !values.length) return;
    const w = Math.max(420, el.clientWidth || 480);
    const h = 220;
    const min = Math.min(...values); const max = Math.max(...values);
    const bins = 30;
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

  function renderSplitBar(el, trainF, valF, testF) {
    if (!el) return;
    el.innerHTML = `<div class="ml-split-bar">
      <div class="ml-split-train" style="width:${(trainF * 100).toFixed(0)}%">Train ${(trainF * 100).toFixed(0)}%</div>
      <div class="ml-split-val" style="width:${(valF * 100).toFixed(0)}%">Val ${(valF * 100).toFixed(0)}%</div>
      <div class="ml-split-test" style="width:${(testF * 100).toFixed(0)}%">Test ${(testF * 100).toFixed(0)}%</div>
    </div>`;
  }

  function coalitionPredict(model, x, bgX, featIdx, coalition) {
    const coal = new Set(coalition);
    const hybrids = bgX.map((bg) => {
      const hybrid = bg.slice();
      featIdx.forEach((j) => { if (coal.has(j)) hybrid[j] = x[j]; });
      return hybrid;
    });
    const preds = model.predict(hybrids) || [];
    const finite = preds.filter((v) => Number.isFinite(v));
    if (!finite.length) return 0;
    return finite.reduce((s, v) => s + v, 0) / finite.length;
  }

  function exactShapley(model, x, bgX, featIdx) {
    const n = featIdx.length;
    const phi = Array(n).fill(0);
    const subsets = [];
    for (let mask = 0; mask < (1 << n); mask++) {
      const coal = featIdx.filter((_, i) => mask & (1 << i));
      subsets.push(coal);
    }
    const vCache = new Map();
    const vOf = (coal) => {
      const key = coal.slice().sort((a, b) => a - b).join(',');
      if (!vCache.has(key)) vCache.set(key, coalitionPredict(model, x, bgX, featIdx, coal));
      return vCache.get(key);
    };
    for (let i = 0; i < n; i++) {
      const j = featIdx[i];
      let sum = 0;
      subsets.forEach((coal) => {
        if (coal.includes(j)) return;
        const s = coal.length;
        const weight = factorial(s) * factorial(n - s - 1) / factorial(n);
        const withJ = coal.concat([j]);
        sum += weight * (vOf(withJ) - vOf(coal));
      });
      phi[i] = sum;
    }
    const base = vOf([]);
    const predRaw = model.predict([x])[0];
    const pred = Number.isFinite(predRaw) ? predRaw : base;
    return { phi, base, pred, featIdx };
  }

  function fastTopFeatures(model, features, pearsonImp, k) {
    const kk = k || 4;
    if (model?.featureImportance) {
      const vals = model.featureImportance();
      if (vals) {
        return features.slice()
          .sort((a, b) => (vals[features.indexOf(b)] || 0) - (vals[features.indexOf(a)] || 0))
          .slice(0, kk);
      }
    }
    if (model?.coefImportance) {
      const vals = model.coefImportance();
      if (vals) {
        return features.slice()
          .sort((a, b) => (vals[features.indexOf(b)] || 0) - (vals[features.indexOf(a)] || 0))
          .slice(0, kk);
      }
    }
    if (pearsonImp) {
      return features.slice()
        .sort((a, b) => (pearsonImp[b] || 0) - (pearsonImp[a] || 0))
        .slice(0, kk);
    }
    return features.slice(0, kk);
  }

  function shapFieldName(feature) {
    const base = String(feature).toLowerCase()
      .replace(/[^\w]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40);
    return `shap_${base || 'feature'}`;
  }

  function normalizeShapFips(v) {
    const s = String(v ?? '').replace(/\D/g, '');
    if (!s) return '';
    return s.padStart(5, '0').slice(-5);
  }

  function resolveShapFeatureIndices(topNames, features) {
    const featIdx = topNames.map((f) => features.indexOf(f)).filter((j) => j >= 0);
    if (!featIdx.length) throw new Error('No valid SHAP features found in the modeling frame.');
    return featIdx;
  }

  function buildCountyShapRow(meta, topNames, phi, base, pred) {
    const safeBase = Number.isFinite(base) ? base : 0;
    const safePred = Number.isFinite(pred) ? pred : safeBase;
    const row = {
      fips: normalizeShapFips(meta?.fips),
      year: meta?.year ?? '',
      shap_base: Math.round(safeBase * 10000) / 10000,
      shap_pred: Math.round(safePred * 10000) / 10000,
    };
    topNames.forEach((name, i) => {
      const v = Number(phi[i]);
      row[shapFieldName(name)] = Math.round((Number.isFinite(v) ? v : 0) * 10000) / 10000;
    });
    return row;
  }

  function buildShapResult(modelName, topNames, globalSum, globalAbs, local, n, bgSize, countyFrame) {
    return {
      modelName,
      topFeatures: topNames,
      global: {
        mean: globalSum.map((v) => v / n),
        meanAbs: globalAbs.map((v) => v / n),
      },
      local,
      n,
      bgSize,
      countyFrame: countyFrame || null,
    };
  }

  function computeShapAnalysis(model, X, y, features, opts) {
    if (!model || !X.length || !features.length) return null;
    const topK = opts?.topK || 4;
    const maxBg = opts?.maxBg || 12;
    const maxLocal = opts?.maxLocal || 3;
    const maxGlobalRows = opts?.maxGlobalRows || 32;
    const topNames = opts?.topFeatures || fastTopFeatures(model, features, opts?.pearsonImp, topK);
    const featIdx = resolveShapFeatureIndices(topNames, features);
    const rng = mulberry32(SEED + 7);
    const bgX = X.length <= maxBg ? X : shuffleIdx(X.length, rng)
      .slice(0, maxBg).map((i) => X[i]);
    const localIdx = shuffleIdx(X.length, mulberry32(SEED + 11)).slice(0, Math.min(maxLocal, X.length));
    const globalIdx = shuffleIdx(X.length, mulberry32(SEED + 13))
      .slice(0, Math.min(maxGlobalRows, X.length));
    const computeIdx = [...new Set([...globalIdx, ...localIdx])];
    const globalSum = Array(topNames.length).fill(0);
    const globalAbs = Array(topNames.length).fill(0);
    const local = [];
    computeIdx.forEach((rowIdx) => {
      const x = X[rowIdx];
      const { phi, base, pred } = exactShapley(model, x, bgX, featIdx);
      phi.forEach((v, i) => {
        globalSum[i] += v;
        globalAbs[i] += Math.abs(v);
      });
      if (localIdx.includes(rowIdx)) {
        local.push({ rowIdx, names: topNames, phi: phi.slice(), base, pred });
      }
    });
    const n = computeIdx.length;
    return buildShapResult(opts?.modelName || 'model', topNames, globalSum, globalAbs, local, n, bgX.length);
  }

  function computeShapAnalysisAsync(model, X, y, features, opts, onProgress) {
    return new Promise((resolve, reject) => {
      try {
        if (!model || !X.length || !features.length) {
          resolve(null);
          return;
        }
        const topK = opts?.topK || 4;
      const maxBg = opts?.maxBg || 12;
      const maxLocal = opts?.maxLocal || 3;
      const maxGlobalRows = opts?.maxGlobalRows || 32;
      const topNames = opts?.topFeatures || fastTopFeatures(model, features, opts?.pearsonImp, topK);
      const featIdx = resolveShapFeatureIndices(topNames, features);
      const rng = mulberry32(SEED + 7);
      const bgX = X.length <= maxBg ? X : shuffleIdx(X.length, rng)
        .slice(0, maxBg).map((i) => X[i]);
      const buildCountyFrame = opts?.buildCountyFrame === true
        && Array.isArray(opts?.evalMeta) && opts.evalMeta.length === X.length;
      const localIdx = shuffleIdx(X.length, mulberry32(SEED + 11))
        .slice(0, Math.min(maxLocal, X.length));
      const globalIdx = buildCountyFrame
        ? (opts?.allEvalCounties
          ? Array.from({ length: X.length }, (_, ii) => ii)
          : shuffleIdx(X.length, mulberry32(SEED + 19))
            .slice(0, Math.min(opts?.maxCountyRows ?? 200, X.length)))
        : shuffleIdx(X.length, mulberry32(SEED + 13))
          .slice(0, Math.min(maxGlobalRows, X.length));
      const computeIdx = buildCountyFrame
        ? globalIdx
        : [...new Set([...globalIdx, ...localIdx])];
      const globalSum = Array(topNames.length).fill(0);
      const globalAbs = Array(topNames.length).fill(0);
      const local = [];
      const countyFrame = buildCountyFrame ? [] : null;
      let i = 0;
      const yieldMs = opts?.yieldMs ?? (buildCountyFrame ? 14 : (model?.type === 'ensemble' ? 10 : 0));
      const chunk = buildCountyFrame
        ? 1
        : (opts?.chunkSize || (model?.type === 'ensemble' ? 1 : 3));
      const step = () => {
        try {
          const end = Math.min(i + chunk, computeIdx.length);
          for (; i < end; i++) {
            const rowIdx = computeIdx[i];
            const x = X[rowIdx];
            const { phi, base, pred } = exactShapley(model, x, bgX, featIdx);
            phi.forEach((v, j) => {
              globalSum[j] += v;
              globalAbs[j] += Math.abs(v);
            });
            if (localIdx.includes(rowIdx)) {
              local.push({ rowIdx, names: topNames, phi: phi.slice(), base, pred });
            }
            if (countyFrame) {
              countyFrame.push(buildCountyShapRow(opts.evalMeta[rowIdx], topNames, phi, base, pred));
            }
          }
          if (onProgress) {
            const label = buildCountyFrame
              ? `SHAP county frame: ${i}/${computeIdx.length} counties…`
              : `SHAP progress: ${i}/${computeIdx.length} rows…`;
            onProgress(label);
          }
          if (i < computeIdx.length) {
            setTimeout(step, yieldMs);
          } else {
            resolve(buildShapResult(
              opts?.modelName || 'model', topNames, globalSum, globalAbs, local, computeIdx.length, bgX.length,
              countyFrame,
            ));
          }
        } catch (err) {
          reject(err);
        }
      };
      setTimeout(step, 0);
      } catch (err) {
        reject(err);
      }
    });
  }

  function computeShapCountyFrameAsync(model, X, evalMeta, features, opts, onProgress) {
    return new Promise((resolve, reject) => {
      try {
        if (!model || !X.length || !Array.isArray(evalMeta) || evalMeta.length !== X.length) {
          resolve(null);
          return;
        }
        const topK = opts?.topK || 4;
        const maxBg = opts?.maxBg || (model?.type === 'ensemble' ? 6 : 10);
        const topNames = opts?.topFeatures || fastTopFeatures(model, features, opts?.pearsonImp, topK);
        const featIdx = resolveShapFeatureIndices(topNames, features);
        const rng = mulberry32(SEED + 7);
        const bgX = X.length <= maxBg ? X : shuffleIdx(X.length, rng)
          .slice(0, maxBg).map((ii) => X[ii]);
        const useAll = opts?.allEvalCounties === true;
        const cap = opts?.maxCountyRows != null ? opts.maxCountyRows : Math.min(X.length, 200);
        const indices = useAll
          ? Array.from({ length: X.length }, (_, ii) => ii)
          : shuffleIdx(X.length, mulberry32(SEED + 19)).slice(0, Math.min(cap, X.length));
        const countyFrame = [];
        let i = 0;
        const yieldMs = opts?.yieldMs ?? 14;
        const step = () => {
          try {
            const rowIdx = indices[i];
            const x = X[rowIdx];
            const { phi, base, pred } = exactShapley(model, x, bgX, featIdx);
            countyFrame.push(buildCountyShapRow(evalMeta[rowIdx], topNames, phi, base, pred));
            i += 1;
            if (onProgress) onProgress(`County SHAP: ${i}/${indices.length}…`);
            if (i < indices.length) {
              setTimeout(step, yieldMs);
            } else {
              resolve({
                topFeatures: topNames,
                countyFrame,
                n: indices.length,
                bgSize: bgX.length,
                sampled: !useAll && indices.length < X.length,
                totalEval: X.length,
              });
            }
          } catch (err) {
            reject(err);
          }
        };
        setTimeout(step, 0);
      } catch (err) {
        reject(err);
      }
    });
  }

  function drawShapGlobal(el, shapData) {
    if (!el || !shapData) {
      if (el) el.innerHTML = '<span class="note">Run training to compute SHAP values.</span>';
      return;
    }
    const { topFeatures, global: g } = shapData;
    const vals = g.meanAbs;
    const colors = topFeatures.map((f) => {
      const mi = g.mean[topFeatures.indexOf(f)];
      return mi >= 0 ? '#97C459' : '#F09595';
    });
    drawBarH(el, topFeatures, vals, {
      title: 'SHAP global — mean |φ| (top 4 features)',
      colors,
    });
  }

  function drawShapLocal(el, shapData) {
    if (!el || !shapData || !shapData.local.length) {
      if (el) el.innerHTML = '<span class="note">No local SHAP instances available.</span>';
      return;
    }
    const w = Math.max(480, el.clientWidth || 520);
    const instH = 120;
    const h = shapData.local.length * instH + 30;
    let svg = `<text x="12" y="18" font-size="12" font-weight="600">SHAP local — waterfall (top 4 features)</text>`;
    shapData.local.forEach((inst, ii) => {
      const y0 = 28 + ii * instH;
      const maxAbs = Math.max(...inst.phi.map(Math.abs), 1e-9);
      const barW = w - 180;
      let x = 100;
      svg += `<text x="8" y="${y0 + 14}" font-size="10">Row ${inst.rowIdx + 1}</text>`;
      svg += `<text x="8" y="${y0 + 28}" font-size="9" fill="#666">base ${Number.isFinite(inst.base) ? inst.base.toFixed(3) : '—'} → ${Number.isFinite(inst.pred) ? inst.pred.toFixed(3) : '—'}</text>`;
      inst.names.forEach((name, j) => {
        const v = inst.phi[j];
        const safeV = Number.isFinite(v) ? v : 0;
        const bw = (Math.abs(safeV) / maxAbs) * (barW / inst.names.length - 4);
        const col = safeV >= 0 ? '#97C459' : '#F09595';
        const dir = safeV >= 0 ? 1 : -1;
        if (dir > 0) {
          svg += `<rect x="${x}" y="${y0 + 8}" width="${Math.max(2, bw)}" height="14" fill="${col}" rx="1"/>`;
          x += bw;
        } else {
          x -= bw;
          svg += `<rect x="${x}" y="${y0 + 8}" width="${Math.max(2, bw)}" height="14" fill="${col}" rx="1"/>`;
        }
        svg += `<text x="${100 + j * (barW / inst.names.length)}" y="${y0 + 52}" font-size="8" text-anchor="middle">${name.slice(0, 10)}</text>`;
        svg += `<text x="${100 + j * (barW / inst.names.length)}" y="${y0 + 62}" font-size="8" text-anchor="middle" fill="#666">${safeV >= 0 ? '+' : ''}${safeV.toFixed(3)}</text>`;
      });
    });
    el.innerHTML = `<svg width="${w}" height="${h}" role="img">${svg}</svg>`;
  }

  function runTraining(config) {
    const {
      rows, target, features, models, metrics, rankBy, evalSet,
      splitStrategy, trainF, valF, ensemble, preprocess, hpConfig,
    } = config;
    const { X, y, meta } = prepareMatrix(rows, target, features);
    const rng = mulberry32(SEED);
    const split = splitIndices(meta, splitStrategy, trainF, valF, rng);
    const tr = subsetXY(X, y, split.train);
    const va = subsetXY(X, y, split.val);
    const te = subsetXY(X, y, split.test);
    const xScaler = preprocess?.standardizeFeatures !== false
      ? fitScaler(tr.X)
      : identityScaler(tr.X[0].length);
    const yScaler = preprocess?.standardizeTarget
      ? fitYScaler(tr.y)
      : identityYScaler();
    const evalXY = evalSet === 'Test set' ? te : va;
    const evalIdx = evalSet === 'Test set' ? split.test : split.val;
    const evalMeta = evalIdx.map((ii) => meta[ii]);

    const results = {};
    const trained = {};
    const tunedParams = {};

    models.forEach((name) => {
      let mdl;
      if (hpConfig && hpConfig.strategy !== 'default' && HP_GRIDS[name] && va.X.length >= 5) {
        const tuned = tuneModel(name, tr.X, tr.y, va.X, va.y, xScaler, yScaler, hpConfig);
        mdl = tuned.model;
        tunedParams[name] = tuned.params;
      } else {
        mdl = trainModel(name, tr.X, tr.y, xScaler, yScaler, DEFAULT_HP[name]);
        tunedParams[name] = mdl.params;
      }
      trained[name] = mdl;
      results[name] = evaluate(evalXY.y, mdl.predict(evalXY.X), metrics);
    });

    let ensName = null;
    if (ensemble && ensemble.enabled && ensemble.base.length >= 2) {
      const bl = ensemble.base.filter((b) => trained[b]);
      if (bl.length >= 2) {
        const kf = 5;
        const oof = Array(tr.X.length).fill(null).map(() => Array(bl.length).fill(0));
        const foldSize = Math.floor(tr.X.length / kf);
        for (let f = 0; f < kf; f++) {
          const vaIdx = Array.from({ length: foldSize }, (_, i) => f * foldSize + i);
          const trIdx = Array.from({ length: tr.X.length }, (_, i) => i).filter((i) => !vaIdx.includes(i));
          const fTr = { X: trIdx.map((i) => tr.X[i]), y: trIdx.map((i) => tr.y[i]) };
          const fVa = { X: vaIdx.map((i) => tr.X[i]), y: vaIdx.map((i) => tr.y[i]) };
          const scX = preprocess?.standardizeFeatures !== false ? fitScaler(fTr.X) : identityScaler(fTr.X[0].length);
          const scY = preprocess?.standardizeTarget ? fitYScaler(fTr.y) : identityYScaler();
          bl.forEach((bn, j) => {
            const fm = trainModel(bn, fTr.X, fTr.y, scX, scY, tunedParams[bn] || DEFAULT_HP[bn]);
            vaIdx.forEach((ii, k) => { oof[ii][j] = fm.predict([fVa.X[k]])[0]; });
          });
        }
        const metaX = addIntercept(oof);
        const metaBeta = ridgeFit(metaX, tr.y, 1e-6);
        ensName = `Ensemble (${ensemble.strategy})`;
        trained[ensName] = {
          type: 'ensemble',
          bl, metaBeta, xScaler, yScaler, baseModels: trained,
          predict(mat) {
            const bp = bl.map((bn) => trained[bn].predict(mat));
            return mat.map((_, i) => {
              const row = [1, ...bl.map((_, j) => bp[j][i])];
              return predictLinear([row], metaBeta)[0];
            });
          },
        };
        results[ensName] = evaluate(evalXY.y, trained[ensName].predict(evalXY.X), metrics);
      }
    }

    const asc = rankBy !== 'R²';
    const sorted = Object.entries(results).sort((a, b) => {
      const va = a[1][rankBy]; const vb = b[1][rankBy];
      if (va == null) return 1;
      if (vb == null) return -1;
      return asc ? va - vb : vb - va;
    });
    const bestName = sorted[0]?.[0];
    const bestPred = bestName ? trained[bestName].predict(evalXY.X) : [];

    return {
      results, trained, split, bestName, bestPred,
      evalY: evalXY.y, evalX: evalXY.X, evalMeta, evalIdx, meta,
      features, target, n: X.length,
      metrics, rankBy, tunedParams, preprocess,
    };
  }

  function featureCategory(name) {
    if (/^svi_|poverty|smoking|uninsured|obesity|food|unemploy/i.test(name)) return 'Socioeconomic';
    if (/air|pm25|no2|so2|pollution|places_/i.test(name)) return 'Environmental';
    if (name === 'year') return 'Temporal';
    if (/^(x|y|lon|lat|centroid_x_m|centroid_y_m)$/i.test(name)) return 'Spatial';
    return 'Other';
  }

  const VAR_COLORS = {
    Socioeconomic: '#185FA5', Environmental: '#3B6D11',
    Temporal: '#854F0B', Spatial: '#5F5E5A', Other: '#888780',
  };

  global.MlDashboard = {
    SEED,
    MODEL_LIST: [
      'OLS', 'Ridge', 'Lasso', 'ElasticNet',
      'Random Forest', 'Gradient Boosting', 'XGBoost', 'LightGBM',
      'k-NN', 'MLP',
    ],
    MODEL_BADGES,
    METRIC_LIST: ['RMSE', 'MAE', 'R²', 'MAPE', 'MedAE'],
    prepareMatrix,
    splitIndices,
    pearsonImp,
    permImportance,
    evaluate,
    DEFAULT_HP,
    HP_GRIDS,
    tuneModel,
    trainModel,
    runTraining,
    drawBarH,
    drawScatter,
    drawHist,
    renderSplitBar,
    featureCategory,
    VAR_COLORS,
    computeShapAnalysis,
    computeShapAnalysisAsync,
    computeShapCountyFrameAsync,
    drawShapGlobal,
    drawShapLocal,
    fastTopFeatures,
    shapFieldName,
    normalizeShapFips,
  };
})(typeof window !== 'undefined' ? window : globalThis);
