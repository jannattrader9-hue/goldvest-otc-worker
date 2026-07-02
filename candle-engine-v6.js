'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// GoldVest Candle Engine v6 — WAVE-BASED
// ═══════════════════════════════════════════════════════════════════════════
//
// দর্শন: force এর উপর force বসাই না। Movement এর ভিত্তি একটাই — WAVE।
//
//   Wave (৮০%)          → price এর মূল চলন
//   Micro noise (১০%)   → ছোট imperfection (wick, texture)
//   Liquidity (৫%)      → level touch এ reaction
//   Trade bias (৫%)     → close এর আগে subtle influence
//
// প্রতিটা wave এর: direction, strength, duration, curvature (ease-in-out)।
// একটা wave শেষ হলে পরেরটা শুরু — chaining। Wave নিজেই trend, pullback,
// consolidation naturally তৈরি করে — আলাদা cluster/personality/hesitation
// লাগে না।
//
// otc-server.js থেকে:  generateTickV6(state, ctrl, stats)
// নতুন market এ:        initStateV6(price)
// ═══════════════════════════════════════════════════════════════════════════


// ── Perlin 1D noise (micro imperfection only) ───────────────────────────────
function _fade(t){ return t*t*t*(t*(t*6-15)+10); }
function _lerp(a,b,t){ return a+t*(b-a); }
function _hash(seed,i){ let h=seed+i*374761393; h=(h^(h>>>13))*1274126177; h=h^(h>>>16); return h>>>0; }
function _grad(h,x){ return (h&1)===0 ? x : -x; }
function _perlin1D(seed,x){
  const x0=Math.floor(x), x1=x0+1, dx=x-x0;
  const g0=_grad(_hash(seed,x0),dx), g1=_grad(_hash(seed,x1),dx-1);
  return _lerp(g0,g1,_fade(dx))*2;
}


// ─────────────────────────────────────────────────────────────────────────
// WAVE GENERATOR — একটা wave এর সব property ঠিক করে
// ─────────────────────────────────────────────────────────────────────────
// Wave chaining: আগের wave এর direction/strength দেখে পরেরটা ঠিক হয়।
// এতে trend (পরপর same-direction wave), pullback (দুর্বল opposite wave),
// consolidation (ছোট alternating wave) সব naturally আসে।

function _newWave(state) {
  const prevDir = state._waveDir || 0;
  const prevWasStrong = (state._waveStrength || 0) > 0.6;

  const r = Math.random();
  let dir, strength, duration;

  if (prevDir === 0) {
    dir = Math.random() < 0.5 ? 1 : -1;
  } else if (prevWasStrong) {
    // আগের wave strong → এবার বেশি সম্ভাবনা pullback/reverse (একদিকে
    // যেতেই থাকা বন্ধ করতে)
    if (r < 0.35)      dir = prevDir;      // continuation কম
    else if (r < 0.75) dir = -prevDir;     // pullback বেশি
    else               dir = -prevDir;     // reverse
  } else {
    if (r < 0.35)      dir = prevDir;
    else if (r < 0.75) dir = -prevDir;
    else               dir = Math.random() < 0.5 ? 1 : -1;
  }

  const isPullback = (dir === -prevDir && prevWasStrong);
  if (isPullback) {
    strength = 0.3 + Math.random() * 0.35;
    duration = 8 + (Math.random() * 12 | 0);   // ছোট: 8–20 tick
  } else {
    strength = 0.4 + Math.random() * 0.45;
    duration = 15 + (Math.random() * 25 | 0);  // মাঝারি: 15–40 tick (আগে 30–85)
  }

  // Curvature — wave কত sharp/smooth ease করবে
  const curvature = 0.6 + Math.random() * 0.8; // 0.6–1.4

  state._waveDir       = dir;
  state._waveStrength  = strength;
  state._waveDuration  = duration;
  state._waveElapsed   = 0;
  state._waveCurvature = curvature;
}

// Wave envelope — ease-in-out (শুরুতে ধীরে, মাঝে দ্রুত, শেষে ধীরে)
// এটাই "acceleration → glide → deceleration" natural feel দেয়।
function _waveEnvelope(progress, curvature) {
  // progress 0..1 → smooth bell-ish velocity profile
  // sin(π·p) দেয় ০→১→০ (মাঝে peak), curvature দিয়ে shape adjust
  const base = Math.sin(Math.PI * Math.min(1, Math.max(0, progress)));
  return Math.pow(base, 1 / curvature);
}


// ─────────────────────────────────────────────────────────────────────────
// LIQUIDITY — শুধু level memory + touch reaction (magnet না)
// ─────────────────────────────────────────────────────────────────────────
function _updateLiquidity(state) {
  if (!state._liq) state._liq = [];
  if (!state._swingTick) state._swingTick = 0;
  state._swingTick++;
  const p = state.price;
  if (!state._recentHigh || p > state._recentHigh) state._recentHigh = p;
  if (!state._recentLow  || p < state._recentLow)  state._recentLow  = p;
  if (state._swingTick % 45 === 0) {
    if (state._recentHigh) state._liq.push({ price: state._recentHigh, s: 1.0 });
    if (state._recentLow)  state._liq.push({ price: state._recentLow,  s: 1.0 });
    state._recentHigh = p; state._recentLow = p;
    state._liq.forEach(l => l.s *= 0.88);
    state._liq = state._liq.filter(l => l.s > 0.2).slice(-12);
  }
}

// Touch reaction — level এর খুব কাছে এলে ছোট reaction (probabilistic)
function _liquidityReaction(state, v) {
  if (!state._liq || state._liq.length === 0) return 0;
  const p = state.price;
  for (const l of state._liq) {
    const distPct = Math.abs(l.price - p) / p;
    if (distPct < 0.0008) { // খুব কাছে (~0.08%)
      // touch — bounce বা break (probabilistic, একবারই react)
      if (!state._lastReactLevel || Math.abs(state._lastReactLevel - l.price) > p*0.0005) {
        state._lastReactLevel = l.price;
        const roll = Math.random();
        if (roll < 0.55) {
          // bounce — level থেকে দূরে ঠেলে
          return -Math.sign(l.price - p) * v * 0.8 * l.s;
        }
        // নাহলে ignore/break — কিছু করি না, wave চলতে থাকে
      }
    }
  }
  return 0;
}


function _tradeBias(stats) {
  const up = parseFloat(stats.upAmount)||0, down = parseFloat(stats.downAmount)||0;
  if (up > down*1.1) return -1;
  if (down > up*1.1) return 1;
  return 0;
}


// ─────────────────────────────────────────────────────────────────────────
// MAIN TICK — wave-driven
// ─────────────────────────────────────────────────────────────────────────
function generateTickV6(state, ctrl, stats) {
  if (!state || !state.price) return;

  const volCfg = { low: 0.5, medium: 1.0, high: 1.8 }[ctrl.volatility] || 1.0;
  const speed  = ctrl.speedMultiplier || 1.0;
  const now    = Date.now();

  // Base movement unit — price এর ০.০৩%
  const vBase = state.price * 0.0003 * volCfg;

  // ── Perlin advance (micro noise) ─────────────────────────────────────
  if (state._noiseX === undefined) state._noiseX = Math.random()*1000;
  if (state._noiseSeed === undefined) state._noiseSeed = (Math.random()*1e9)|0;
  state._noiseX += 0.10;

  // ── WAVE ENGINE (80%) — Main Wave + Nested Micro Wave ────────────────
  if (!state._waveDuration || state._waveElapsed >= state._waveDuration) {
    _newWave(state);
  }
  state._waveElapsed++;
  const progress = state._waveElapsed / state._waveDuration;
  const envelope = _waveEnvelope(progress, state._waveCurvature);

  // Manual override on direction
  let waveDir = state._waveDir;
  if (ctrl.mode === 'manual') {
    waveDir = ctrl.nextDirection === 'up' ? 1 : ctrl.nextDirection === 'down' ? -1 : state._waveDir;
  }

  // ── NESTED MICRO-WAVE ────────────────────────────────────────────────
  // Main wave overall direction ঠিক করে, কিন্তু ভেতরে ছোট micro-swing
  // থাকে — মাঝে মাঝে ২-৫ tick বিপরীতে যায়, তারপর আবার trend continue।
  // এতে motion সোজা লাইন না হয়ে Quotex এর মতো natural হয়:
  //   ↗↗↗↘↗↗↗↘↗↗  (overall up কিন্তু micro correction সহ)
  if (state._microTick === undefined || state._microTick <= 0) {
    // নতুন micro-swing: বেশিরভাগ সময় main direction, মাঝে মাঝে বিপরীত
    const againstMain = Math.random() < 0.32; // ~32% micro-swing বিপরীতে
    state._microDir = againstMain ? -waveDir : waveDir;
    if (againstMain) {
      state._microTick = 2 + (Math.random() * 3 | 0);   // ছোট বিপরীত: 2–4 tick
      state._microMag  = 0.4 + Math.random() * 0.4;      // দুর্বল
    } else {
      state._microTick = 3 + (Math.random() * 6 | 0);   // main: 3–8 tick
      state._microMag  = 0.8 + Math.random() * 0.5;      // শক্তিশালী
    }
  }
  state._microTick--;

  // Wave contribution — main + micro-swing মিশিয়ে।
  // micro-swing বিপরীতে গেলে সেই tick এ সত্যিই বিপরীত move হয় (net negative)
  // — তাই ↗↗↗↘↗↗↘ এর মতো natural motion আসে।
  const mainComponent  = waveDir * state._waveStrength * envelope;
  const microComponent = (state._microDir || waveDir) * (state._microMag || 1);
  // micro against main হলে সেটা main কে ছাপিয়ে যেতে পারে (net reverse tick)
  const waveMove = (mainComponent * 0.45 + microComponent * 0.75) * vBase;

  // ── Micro noise (10%) ────────────────────────────────────────────────
  const noiseMove = _perlin1D(state._noiseSeed, state._noiseX) * vBase * 0.55;

  // ── Liquidity reaction (5%) ──────────────────────────────────────────
  _updateLiquidity(state);
  const liqMove = _liquidityReaction(state, vBase);

  // ── Trade bias (5%) — শুধু close এর আগে ─────────────────────────────
  let tradeMove = 0;
  if (ctrl.mode === 'trade-based') {
    const tb = _tradeBias(stats);
    const dur = state._candleDurMs || 60000;
    const tLeft = state.nextCandle ? (state.nextCandle - now) : dur;
    if (tb !== 0 && tLeft <= 8000 && tLeft > 0) {
      tradeMove = tb * vBase * 0.25;
    }
  }

  // ── Combine — wave dominant, বাকিরা ছোট ──────────────────────────────
  let delta = (waveMove + noiseMove + liqMove + tradeMove) * speed;

  // Hard safety clamp — এক tick এ max ±0.15%
  const maxStep = state.price * 0.0015;
  delta = Math.max(-maxStep, Math.min(maxStep, delta));

  state.price = Math.max(state.price + delta, 0.0001);
}


function initStateV6(price) {
  return {
    _waveDir:       0,
    _waveStrength:  0,
    _waveDuration:  0,
    _waveElapsed:   0,
    _waveCurvature: 1.0,
    _microTick:     0,
    _microDir:      0,
    _microMag:      1.0,
    _noiseX:        Math.random()*1000,
    _noiseSeed:     (Math.random()*1e9)|0,
    _liq:           [],
    _swingTick:     0,
    _recentHigh:    price,
    _recentLow:     price,
    _lastReactLevel: null,
    _candleDurMs:   60000,
  };
}

module.exports = { generateTickV6, initStateV6 };
