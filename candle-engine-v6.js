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

function _selectFamily(state) {
  // Phase 1: ৩টা family — Momentum, Impulse, Elastic
  // GPT: hierarchical base probability + Markov transition + anti-repeat memory
  const prev = state._waveFamily || 'momentum';

  // Markov transition — একই family পরপর হওয়ার chance কম
  // (chart personality evolve করে, robotic repeat হয় না)
  let probs;
  if (prev === 'momentum') {
    probs = { momentum: 0.35, impulse: 0.30, elastic: 0.35 };
  } else if (prev === 'impulse') {
    probs = { momentum: 0.50, impulse: 0.15, elastic: 0.35 };
  } else { // elastic
    probs = { momentum: 0.50, impulse: 0.30, elastic: 0.20 };
  }

  // anti-repetition memory — impulse পরপর ৩ বার না, elastic ২ বার না
  state._famStreak = (state._famStreakOf === prev) ? (state._famStreak || 1) : 0;
  if (prev === 'impulse' && state._famStreak >= 2) probs.impulse = 0;
  if (prev === 'elastic'  && state._famStreak >= 1) probs.elastic = 0;

  // normalize + pick
  const total = probs.momentum + probs.impulse + probs.elastic;
  let roll = Math.random() * total;
  let picked;
  if ((roll -= probs.momentum) < 0)      picked = 'momentum';
  else if ((roll -= probs.impulse) < 0)  picked = 'impulse';
  else                                    picked = 'elastic';

  // streak update
  if (picked === state._famStreakOf) state._famStreak = (state._famStreak || 0) + 1;
  else { state._famStreakOf = picked; state._famStreak = 1; }

  return picked;
}

function _newWave(state) {
  const prevDir = state._waveDir || 0;
  const prevWasStrong = (state._waveStrength || 0) > 0.6;

  // [GPT WAVE FAMILY] এই wave এর motion personality
  state._waveFamily = _selectFamily(state);

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

  // [GPT] strength ও duration family থেকে — নাটকীয়ভাবে আলাদা যাতে চোখে
  // পড়ে। Impulse ছোট+শক্তিশালী (burst), Momentum লম্বা+মাঝারি (glide),
  // Elastic মাঝারি (bounce)।
  const fpw = _FAMILY_PHYSICS[state._waveFamily] || _FAMILY_PHYSICS.momentum;
  strength = fpw.strMin + Math.random() * (fpw.strMax - fpw.strMin);
  duration = fpw.durMin + (Math.random() * (fpw.durMax - fpw.durMin) | 0);

  const curvature = 0.5 + Math.random() * 1.2; // 0.5–1.7 বেশি variation

  // [GPT WAVE FAMILY] physics family থেকে আসে — random না। family = personality।
  // সামান্য random variation রাখি (±15%) যাতে একই family ও একঘেয়ে না হয়।
  const fp = _FAMILY_PHYSICS[state._waveFamily] || _FAMILY_PHYSICS.momentum;
  const jit = () => 0.85 + Math.random() * 0.30; // ±15% jitter
  state._physAccel   = fp.accel   * jit();
  state._physDamping = Math.min(0.97, fp.damping * jit());
  state._physMaxVel  = fp.maxVel  * jit();
  state._physBlend   = Math.max(4, fp.blend * jit() | 0);
  state._physSkew    = 0.5 + Math.random() * 1.0;
  // family-specific medium ও noise behavior
  state._famMedStrength = fp.medStrength;
  state._famMedPullback = fp.medPullback;
  state._famNoiseScale  = fp.noiseScale;
  state._famSigStrength = fp.sigStrength;
  state._famFriction    = fp.friction || 0.86;

  // [GPT FIX] _newWave শুধু wave তৈরি করে — velocity এখানে modify করি না।
  // carry-over এর intent সংরক্ষণ করি, প্রয়োগ হয় generateTickV6 এ।
  state._carryOverSameDir = (dir === prevDir);

  // Wave blending — পুরনো wave এর নিজের progress/envelope সংরক্ষণ
  state._prevWaveDir       = state._waveDir || dir;
  state._prevWaveStrength  = state._waveStrength || strength;
  state._prevWaveCurvature = state._waveCurvature || 1.0;
  state._prevWaveProgress  = state._waveDuration
                             ? (state._waveElapsed / state._waveDuration) : 1;
  state._blendTicks        = state._physBlend || 10;
  state._justStartedWave   = true; // generateTick এ carry-over প্রয়োগের signal

  state._waveDir       = dir;
  state._waveStrength  = strength;
  state._waveDuration  = duration;
  state._waveElapsed   = 0;
  state._waveCurvature = curvature;
}

// ── FAMILY PHYSICS PROFILES — GPT: family = সম্পূর্ণ motion personality ──
// প্রতি family শুধু envelope না — acceleration, damping, medium behavior,
// pullback সব আলাদা। এক wave personality পুরো system জুড়ে (macro+medium)।
const _FAMILY_PHYSICS = {
  momentum: {
    accel: 0.10, damping: 0.90, maxVel: 1.8, blend: 12,
    medStrength: 0.9, medPullback: 0.35, noiseScale: 0.22,
    durMin: 35, durMax: 70, friction: 0.88,
    strMin: 0.45, strMax: 0.75,  // মাঝারি
    sigStrength: 0.10,           // smooth (কম direct signature)
  },
  impulse: {
    accel: 0.26, damping: 0.80, maxVel: 2.6, blend: 5,
    medStrength: 0.5, medPullback: 0.18, noiseScale: 0.32,
    durMin: 8, durMax: 20, friction: 0.82,
    strMin: 0.80, strMax: 1.10,  // শক্তিশালী
    sigStrength: 0.50,           // strong burst (বেশি direct)
  },
  elastic: {
    accel: 0.16, damping: 0.95, maxVel: 2.0, blend: 8,
    medStrength: 1.3, medPullback: 0.60, noiseScale: 0.16,
    durMin: 18, durMax: 42, friction: 0.90,
    strMin: 0.40, strMax: 0.80,
    sigStrength: 0.28,           // bounce
  },
};

// ── WAVE FAMILY ENVELOPES — প্রতি family এর নিজস্ব motion topology ────────
// GPT: amplitude না, rhythm/shape ই robotic feel এর কারণ। প্রতি family
// সম্পূর্ণ আলাদা velocity profile — user আর একই rhythm অনুভব করবে না।

// Momentum — classic bell (accelerate → peak → decelerate)
function _envMomentum(p, curv) {
  const bell = Math.sin(Math.PI * p);
  return 0.3 + Math.pow(bell, 1 / curv) * 0.7;
}
// Impulse — শুরুতেই peak, তারপর দ্রুত decay (front-loaded burst)
function _envImpulse(p) {
  // দ্রুত rise (প্রথম 15%), তারপর exponential decay
  const rise = Math.min(1, p / 0.15);
  const decay = Math.exp(-3 * Math.max(0, p - 0.15));
  return 0.25 + rise * decay * 0.85;
}
// Elastic — যায়, overshoot করে, bounce back (damped oscillation)
function _envElastic(p) {
  // মূল push + একটা damped sine oscillation (bounce feel)
  const base = Math.sin(Math.PI * p);
  const bounce = Math.sin(Math.PI * p * 3) * Math.exp(-2 * p) * 0.4;
  return 0.3 + (base * 0.7 + bounce) * 0.7;
}

// Family অনুযায়ী envelope route করে
function _familyEnvelope(family, p, curv) {
  switch (family) {
    case 'impulse': return _envImpulse(p);
    case 'elastic': return _envElastic(p);
    case 'momentum':
    default:        return _envMomentum(p, curv);
  }
}

// Wave envelope — legacy (medium wave এ ব্যবহৃত)
function _waveEnvelope(progress, curvature) {
  const p = Math.min(1, Math.max(0, progress));
  const bell = Math.sin(Math.PI * p);
  const shaped = Math.pow(bell, 1 / curvature);
  return 0.3 + shaped * 0.7;
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
  const vBase = state.price * 0.0002 * volCfg;

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
  // [GPT] skew দিয়ে envelope এর peak সরাই — কোনো wave শুরুতে fast
  // (skew<1), কোনো শেষে fast (skew>1)। প্রতি wave আলাদা acceleration timing।
  const skewedProg = Math.pow(progress, state._physSkew || 1.0);
  // [GPT WAVE FAMILY] macro envelope family অনুযায়ী — আলাদা shape।
  const envelope = _familyEnvelope(state._waveFamily || 'momentum', skewedProg, state._waveCurvature);

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
    state._medTick = 5 + (Math.random() * 12 | 0);
    // [GPT] medium pullback probability family থেকে — Elastic এ বেশি
    // pullback (bounce), Impulse এ কম। এক personality পুরো system জুড়ে।
    const medAgainst = Math.random() < (state._famMedPullback || 0.35);
    state._medDir = medAgainst ? -state._waveDir : state._waveDir;
    // medium strength ও family থেকে
    const fms = state._famMedStrength || 0.9;
    state._medStrength = medAgainst
      ? (0.3 + Math.random() * 0.4) * fms
      : (0.5 + Math.random() * 0.5) * fms;
    state._medElapsed = 0;
    state._medDuration = state._medTick;
  }
  state._medTick--;
  state._medElapsed = (state._medElapsed || 0) + 1;
  const medProg = state._medElapsed / (state._medDuration || 1);
  // [GPT] medium envelope ও family অনুযায়ী — আর bell এ আটকে নেই।
  // এটাই ছিল সবচেয়ে বড় ফাঁক (medium 58% dominant, কিন্তু সবসময় bell)।
  const medEnv = _familyEnvelope(state._waveFamily || 'momentum', medProg, 1.0);
  const medComponent = (state._medDir || state._waveDir) * state._medStrength * medEnv;

  // ── MICRO MODULATION — family-specific (GPT: micro ও family follow করবে) ─
  if (state._microTick === undefined || state._microTick <= 0) {
    const roll = Math.random();
    const fam = state._waveFamily || 'momentum';
    if (fam === 'impulse') {
      // Impulse — ছোট sharp burst, দ্রুত পরিবর্তন
      if (roll < 0.10) { state._microTick = 1 + (Math.random()*2|0); state._microScale = -0.15 - Math.random()*0.2; }
      else if (roll < 0.35) { state._microTick = 1 + (Math.random()*2|0); state._microScale = 1.2 + Math.random()*0.6; } // burst
      else { state._microTick = 2 + (Math.random()*3|0); state._microScale = 0.7 + Math.random()*0.5; }
    } else if (fam === 'elastic') {
      // Elastic — বেশি reverse (bounce), oscillating micro
      if (roll < 0.20) { state._microTick = 2 + (Math.random()*3|0); state._microScale = -0.2 - Math.random()*0.3; } // strong reverse
      else if (roll < 0.45) { state._microTick = 2 + (Math.random()*3|0); state._microScale = 0.1 + Math.random()*0.3; }
      else { state._microTick = 3 + (Math.random()*5|0); state._microScale = 0.7 + Math.random()*0.5; }
    } else {
      // Momentum — smooth, কম reverse, দীর্ঘ consistent
      if (roll < 0.05) { state._microTick = 2 + (Math.random()*2|0); state._microScale = -0.08 - Math.random()*0.1; }
      else if (roll < 0.35) { state._microTick = 3 + (Math.random()*4|0); state._microScale = 0.3 + Math.random()*0.4; }
      else { state._microTick = 4 + (Math.random()*7|0); state._microScale = 0.85 + Math.random()*0.4; }
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

  // ── [v6.1] v3-STYLE INTEGRATOR — force → velocity → price ────────────
  // GPT: v3 এর motion জীবন্ত ছিল কারণ সরল। target-chasing, triple
  // smoothing, famSignature সব বাদ। শুধু force→velocity→friction→price।
  // v6 এর সব feature (family, medium, liquidity, noise) থাকছে — শুধু
  // integration v3 এর মতো সরল।
  if (state._velocity === undefined) state._velocity = 0;

  // carry-over (wave শুরুতে)
  if (state._justStartedWave) {
    state._justStartedWave = false;
    state._velocity = (state._velocity || 0) * (state._carryOverSameDir ? 0.85 : 0.5);
  }

  // net force — v6 wave force বড়, তাই scale করি (v3 এর মতো moderate)
  const netForce = (waveForce + medComponent * 0.9 + liqForce + tradeForce) * vBase * 0.35;

  // v3 physics: acceleration = force (সরাসরি, target-chasing না)
  state._acceleration = netForce;
  state._velocity += state._acceleration;
  // একটাই friction (v3 এর 0.86) — family অনুযায়ী সামান্য ভিন্ন
  state._velocity *= (state._famFriction || 0.86);

  // velocity clamp
  const maxVel = vBase * (state._physMaxVel || 2.2);
  state._velocity = Math.max(-maxVel, Math.min(maxVel, state._velocity));

  // ── [GPT: LIFE] imperfections — jerk / dead-tick / burst ────────────
  if (state._impTick === undefined || state._impTick <= 0) {
    const roll = Math.random();
    if (roll < 0.06)      { state._impMode = 'dead';  state._impTick = 2 + (Math.random()*2|0); }
    else if (roll < 0.12) { state._impMode = 'burst'; state._impTick = 1 + (Math.random()*2|0); }
    else if (roll < 0.20) { state._impMode = 'jerk';  state._impTick = 2 + (Math.random()*3|0); }
    else                  { state._impMode = 'normal';state._impTick = 3 + (Math.random()*8|0); }
  }
  state._impTick--;
  let impMul = 1.0;
  if (state._impMode === 'dead')       impMul = 0.15 + Math.random()*0.15;
  else if (state._impMode === 'burst') impMul = 1.4 + Math.random()*0.5;
  else if (state._impMode === 'jerk')  impMul = 0.5 + Math.random()*0.9;

  // noise price এ সরাসরি (tick texture)
  const noiseTick = _perlin1D(state._noiseSeed, state._noiseX) * vBase * (state._famNoiseScale || 0.22);

  // ── price = velocity + noise, imperfection সহ (v3 এর মতো সরল) ────────
  let delta = (state._velocity + noiseTick) * impMul * speed;
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
    _physAccel:     0.16,
    _physDamping:   0.9,
    _physMaxVel:    1.8,
    _physBlend:     10,
    _physSkew:      1.0,
    _waveFamily:    'momentum',
    _famStreak:     0,
    _famStreakOf:   'momentum',
    _famMedStrength: 0.9,
    _famMedPullback: 0.35,
    _famNoiseScale:  0.22,
    _famSigStrength: 0.25,
    _famFriction:   0.86,
    _impTick:       0,
    _impMode:       "normal",
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
