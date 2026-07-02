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
    // strong wave এর পর বেশি reverse/pullback — একটানা এক দিকে না
    if (r < 0.30)      dir = prevDir;
    else               dir = -prevDir;
  } else {
    // দুর্বল wave এর পর প্রায় সমান সম্ভাবনা
    if (r < 0.45)      dir = prevDir;
    else if (r < 0.85) dir = -prevDir;
    else               dir = Math.random() < 0.5 ? 1 : -1;
  }

  const isPullback = (dir === -prevDir && prevWasStrong);
  if (isPullback) {
    strength = 0.3 + Math.random() * 0.35;
    duration = 6 + (Math.random() * 8 | 0);    // ছোট: 6–14 tick
  } else {
    strength = 0.4 + Math.random() * 0.45;
    duration = 10 + (Math.random() * 16 | 0);  // মাঝারি: 10–26 tick
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
  // [GPT] wave শেষে envelope পুরো শূন্য হয় না — একটা residual (0.3) থাকে,
  // যাতে velocity পরের wave এ carry হয়। এই continuity-ই smooth animation।
  const p = Math.min(1, Math.max(0, progress));
  const bell = Math.sin(Math.PI * p);
  const shaped = Math.pow(bell, 1 / curvature);
  return 0.3 + shaped * 0.7; // 0.3–1.0, কখনো শূন্য না
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

  // ── WAVE ENGINE — velocity-based (position না) ───────────────────────
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

  // ── MICRO MODULATION — direction flip না, velocity slow/accelerate ───
  // GPT: micro wave direction উল্টায় না, শুধু force কমায় (slowdown)।
  // এতে ↑↑↑↓↓↑↑ এর মতো নয়, বরং velocity 0.8→0.5→0.2→0.4→0.8 হয় —
  // price কখনো একটু ধীরে, কখনো দ্রুত, কিন্তু direction carry থাকে।
  if (state._microTick === undefined || state._microTick <= 0) {
    const slowdown = Math.random() < 0.35; // ~35% সময় slowdown phase
    if (slowdown) {
      state._microTick = 2 + (Math.random() * 3 | 0);
      state._microScale = 0.15 + Math.random() * 0.35; // velocity কমায় (0.15–0.5)
    } else {
      state._microTick = 3 + (Math.random() * 6 | 0);
      state._microScale = 0.85 + Math.random() * 0.4;  // পূর্ণ গতি (0.85–1.25)
    }
  }
  state._microTick--;

  // ── TARGET FORCES — wave velocity কে push করে ────────────────────────
  const waveForce = waveDir * state._waveStrength * envelope * (state._microScale || 1);
  _updateLiquidity(state);
  const liqForce = _liquidityReaction(state, 1) / (vBase + 1e-9); // normalize to force

  let tradeForce = 0;
  if (ctrl.mode === 'trade-based') {
    const tb = _tradeBias(stats);
    const dur = state._candleDurMs || 60000;
    const tLeft = state.nextCandle ? (state.nextCandle - now) : dur;
    if (tb !== 0 && tLeft <= 8000 && tLeft > 0) tradeForce = tb * 0.25;
  }

  // ── VELOCITY PIPELINE — inertia + carry-over ─────────────────────────
  // wave force velocity কে push করে। smoothing 0.12 → 0.28 (কম inertia,
  // দ্রুত দিক বদলাতে পারে — একটানা এক দিকে যায় না)।
  if (state._velocity === undefined) state._velocity = 0;
  const waveTarget = (waveForce + liqForce + tradeForce) * vBase;
  state._velocity += (waveTarget - state._velocity) * 0.28;
  const maxVel = vBase * 1.8;
  state._velocity = Math.max(-maxVel, Math.min(maxVel, state._velocity));

  // ── price = velocity (momentum) + direct noise (tick texture) ────────
  const noiseTick = _perlin1D(state._noiseSeed, state._noiseX) * vBase * 0.45;
  let delta = (state._velocity + noiseTick) * speed;
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
