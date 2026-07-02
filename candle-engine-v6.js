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
    duration = 10 + (Math.random() * 12 | 0);  // 10–22 tick
  } else {
    strength = 0.4 + Math.random() * 0.45;
    duration = 25 + (Math.random() * 35 | 0);  // 25–60 tick (GPT: main wave লম্বা)
  }

  const curvature = 0.6 + Math.random() * 0.8;

  // [GPT] Wave energy carry-over — পুরনো wave এর momentum নতুন wave এ
  // inherit হয়। আগের wave same direction হলে বেশি energy, opposite হলে কম।
  const prevMomentum = state._velocity || 0;
  state._waveInheritedEnergy = prevMomentum;

  // [GPT] Wave blending — নতুন wave এর প্রথম কয়েক tick পুরনোটার সাথে blend হয়
  state._prevWaveDir      = state._waveDir || dir;
  state._prevWaveStrength = state._waveStrength || strength;
  state._blendTicks       = 10; // 10 tick overlap

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
    const roll = Math.random();
    if (roll < 0.15) {
      // ~15% — ছোট reverse (পুরো flip না, wave এর বিপরীতে হালকা)
      state._microTick = 2 + (Math.random() * 2 | 0);
      state._microScale = -0.3 - Math.random() * 0.3; // negative = বিপরীত
    } else if (roll < 0.45) {
      // ~30% — slowdown
      state._microTick = 2 + (Math.random() * 3 | 0);
      state._microScale = 0.15 + Math.random() * 0.35;
    } else {
      // ~55% — পূর্ণ গতি
      state._microTick = 3 + (Math.random() * 6 | 0);
      state._microScale = 0.85 + Math.random() * 0.4;
    }
  }
  state._microTick--;

  // ── TARGET FORCES — wave velocity কে push করে ────────────────────────
  let waveForce = waveDir * state._waveStrength * envelope * (state._microScale || 1);

  // [GPT] WAVE BLENDING — নতুন wave এর প্রথম ~10 tick পুরনো wave এর সাথে
  // blend হয় (hard transition বাদ)। blend শেষে পুরোপুরি নতুন wave।
  if (state._blendTicks && state._blendTicks > 0) {
    const blendProg = 1 - (state._blendTicks / 10); // 0→1
    const prevForce = (state._prevWaveDir || waveDir) * (state._prevWaveStrength || 0) * envelope;
    waveForce = prevForce * (1 - blendProg) + waveForce * blendProg;
    state._blendTicks--;
  }

  _updateLiquidity(state);
  const liqForce = _liquidityReaction(state, 1) / (vBase + 1e-9);

  let tradeForce = 0;
  if (ctrl.mode === 'trade-based') {
    const tb = _tradeBias(stats);
    const dur = state._candleDurMs || 60000;
    const tLeft = state.nextCandle ? (state.nextCandle - now) : dur;
    if (tb !== 0 && tLeft <= 8000 && tLeft > 0) tradeForce = tb * 0.25;
  }

  // ── ACCELERATION → VELOCITY → PRICE (GPT: proper physics pipeline) ───
  // Wave → target velocity → acceleration → velocity → price।
  // এই extra acceleration layer motion কে জীবন্ত করে (jump না)।
  if (state._velocity === undefined)     state._velocity = 0;
  if (state._acceleration === undefined) state._acceleration = 0;

  const targetVel = (waveForce + liqForce + tradeForce) * vBase;
  const accel = (targetVel - state._velocity) * 0.16;
  state._acceleration += (accel - state._acceleration) * 0.5;
  state._velocity += state._acceleration;

  const maxVel = vBase * 1.8;
  state._velocity = Math.max(-maxVel, Math.min(maxVel, state._velocity));

  // ── price = smooth velocity (glide) + noticeable tick noise (up-down) ─
  // velocity smooth momentum দেয় (Quotex glide), noise tick-level texture
  // দেয় (সোজা লাইন ভাঙে)। noise price এ যোগ হয় velocity তে না — তাই
  // inertia তে হারায় না।
  const noiseTick = _perlin1D(state._noiseSeed, state._noiseX) * vBase * 0.55;
  let delta = (state._velocity + noiseTick) * speed;
  const maxStep = state.price * 0.0015;
  delta = Math.max(-maxStep, Math.min(maxStep, delta));
  state.price = Math.max(state.price + delta, 0.0001);
}


function initStateV6(price) {
  return {
    _waveDir:       0,
    _waveStrength:  0,
    _acceleration:  0,
    _blendTicks:    0,
    _prevWaveDir:   0,
    _prevWaveStrength: 0,
    _waveInheritedEnergy: 0,
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
