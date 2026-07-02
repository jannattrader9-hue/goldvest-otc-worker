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

  // [UNPREDICTABLE] direction অনেক বেশি random — pattern ধরা যাবে না।
  // continuation/reverse এর কোনো নির্দিষ্ট নিয়ম নেই, প্রতিবার ভিন্ন।
  if (prevDir === 0) {
    dir = Math.random() < 0.5 ? 1 : -1;
  } else {
    // continuation probability নিজেই random (35%–65%) — fixed না
    const contProb = 0.35 + Math.random() * 0.30;
    dir = (r < contProb) ? prevDir : -prevDir;
    // মাঝে মাঝে (~12%) সম্পূর্ণ random surprise
    if (Math.random() < 0.12) dir = Math.random() < 0.5 ? 1 : -1;
  }

  // strength সম্পূর্ণ random — দুর্বল/মাঝারি/শক্তিশালী সব হতে পারে
  strength = 0.25 + Math.random() * 0.75; // 0.25–1.0

  // duration অনেক বড় random range — timing unpredictable
  // কখনো ছোট (৮), কখনো বড় (৭০) — কোনো নির্দিষ্ট pattern নেই
  const durRoll = Math.random();
  if (durRoll < 0.25)      duration =  8 + (Math.random() * 12 | 0); // 8–20 ছোট
  else if (durRoll < 0.70) duration = 20 + (Math.random() * 30 | 0); // 20–50 মাঝারি
  else                     duration = 40 + (Math.random() * 35 | 0); // 40–75 বড়

  const curvature = 0.5 + Math.random() * 1.2; // 0.5–1.7 বেশি variation

  // [GPT FIX] _newWave শুধু wave তৈরি করে — velocity এখানে modify করি না।
  // carry-over এর intent সংরক্ষণ করি, প্রয়োগ হয় generateTickV6 এ।
  state._carryOverSameDir = (dir === prevDir);

  // Wave blending — পুরনো wave এর নিজের progress/envelope সংরক্ষণ
  state._prevWaveDir       = state._waveDir || dir;
  state._prevWaveStrength  = state._waveStrength || strength;
  state._prevWaveCurvature = state._waveCurvature || 1.0;
  state._prevWaveProgress  = state._waveDuration
                             ? (state._waveElapsed / state._waveDuration) : 1;
  state._blendTicks        = 10;
  state._justStartedWave   = true; // generateTick এ carry-over প্রয়োগের signal

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

  // ── [MULTI-TIMEFRAME] MEDIUM WAVE — macro wave এর ভেতরে swing/pullback ─
  // GPT: শুধু একটা wave layer থাকলে user ৪-৫ tick দেখেই trend বোঝে।
  // Medium wave macro এর ভেতরে ছোট swing দেয় — মাঝে মাঝে বিপরীতে যায়,
  // trend ভাঙে না কিন্তু short-term unpredictable করে।
  if (state._medTick === undefined || state._medTick <= 0) {
    state._medTick = 5 + (Math.random() * 12 | 0); // 5–17 tick medium wave
    // medium direction: বেশিরভাগ macro এর সাথে, ~35% বিপরীত (pullback)
    const medAgainst = Math.random() < 0.35;
    state._medDir = medAgainst ? -state._waveDir : state._waveDir;
    state._medStrength = medAgainst
      ? (0.3 + Math.random() * 0.4)   // pullback দুর্বল
      : (0.5 + Math.random() * 0.5);  // continuation
    state._medElapsed = 0;
    state._medDuration = state._medTick;
  }
  state._medTick--;
  state._medElapsed = (state._medElapsed || 0) + 1;
  const medProg = state._medElapsed / (state._medDuration || 1);
  const medEnv = _waveEnvelope(medProg, 1.0);
  const medComponent = (state._medDir || state._waveDir) * state._medStrength * medEnv;

  // ── MICRO MODULATION — direction flip না, velocity slow/accelerate ───
  if (state._microTick === undefined || state._microTick <= 0) {
    const roll = Math.random();
    // [GPT FIX] reverse কম ঘন ঘন (~8%) এবং amplitude ছোট (gentle pullback)
    if (roll < 0.08) {
      state._microTick = 2 + (Math.random() * 2 | 0);
      state._microScale = -0.1 - Math.random() * 0.15; // -0.1 থেকে -0.25 (ছোট)
    } else if (roll < 0.42) {
      // slowdown
      state._microTick = 2 + (Math.random() * 4 | 0);
      state._microScale = 0.15 + Math.random() * 0.4;
    } else {
      // full speed
      state._microTick = 2 + (Math.random() * 7 | 0);
      state._microScale = 0.8 + Math.random() * 0.5;
    }
  }
  state._microTick--;

  // ── TARGET FORCES — Macro drives velocity (smooth trend) ─────────────
  // Macro wave velocity কে push করে (smooth momentum/trend)।
  const macroComponent = waveDir * state._waveStrength * envelope;
  let waveForce = macroComponent * (state._microScale || 1);

  // [GPT FIX] WAVE BLENDING — পুরনো wave এর নিজের envelope ব্যবহার হয়
  // (fake না)। পুরনো wave তার শেষ progress থেকে ধীরে fade হয়।
  if (state._blendTicks && state._blendTicks > 0) {
    const blendProg = 1 - (state._blendTicks / 10); // 0→1
    // পুরনো wave নিজের progress থেকে এগিয়ে যাচ্ছে (fade out)
    const prevProg = Math.min(1, (state._prevWaveProgress || 1) + (1 - state._blendTicks / 10) * 0.3);
    const prevEnv  = _waveEnvelope(prevProg, state._prevWaveCurvature || 1.0);
    const prevForce = (state._prevWaveDir || waveDir) * (state._prevWaveStrength || 0) * prevEnv;
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

  // ── ACCELERATION → VELOCITY → PRICE (proper physics pipeline) ────────
  if (state._velocity === undefined)     state._velocity = 0;
  if (state._acceleration === undefined) state._acceleration = 0;

  // [GPT FIX] carry-over এখানে প্রয়োগ (physics generateTick এ, _newWave এ না)।
  if (state._justStartedWave) {
    state._justStartedWave = false;
    state._velocity = (state._velocity || 0) * (state._carryOverSameDir ? 0.85 : 0.5);
  }

  const targetVel = (waveForce + liqForce + tradeForce) * vBase;
  const accel = (targetVel - state._velocity) * 0.16;
  state._acceleration += (accel - state._acceleration) * 0.5;
  // [GPT FIX] acceleration damping — long-term oscillation রোধ করে।
  state._acceleration *= 0.9;
  state._velocity += state._acceleration;

  const maxVel = vBase * 1.8;
  state._velocity = Math.max(-maxVel, Math.min(maxVel, state._velocity));

  // ── price = velocity (macro trend) + medium swing + noise ────────────
  // GPT multi-timeframe: velocity macro trend দেয় (smooth)। Medium swing
  // ও noise সরাসরি price এ যোগ হয় (velocity bypass) — short-term up-down
  // বাঁচে, user পরের tick predict করতে পারে না, কিন্তু trend থাকে।
  const medMove   = medComponent * vBase * 0.9;
  const noiseTick = _perlin1D(state._noiseSeed, state._noiseX) * vBase * 0.22;
  let delta = (state._velocity * 0.75 + medMove + noiseTick) * speed;
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
    _prevWaveCurvature: 1.0,
    _prevWaveProgress: 1,
    _carryOverSameDir: false,
    _justStartedWave:  false,
    _medTick:       0,
    _medDir:        0,
    _medStrength:   0.5,
    _medElapsed:    0,
    _medDuration:   1,
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
