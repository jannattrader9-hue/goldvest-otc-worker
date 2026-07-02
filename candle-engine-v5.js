'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// GoldVest Candle Engine v5 — Professional Force-Based OTC Simulator
// ═══════════════════════════════════════════════════════════════════════════
//
// Design philosophy: price generate করি না — FORCE calculate করি।
// প্রতি tick এ multiple force যোগ হয় → net force → velocity → price।
//
// Forces:
//   - Trend force      (regime এর দিক)
//   - Momentum force    (inertia — আগের গতি ধরে রাখে)
//   - Mean reversion    (liquidity level এর দিকে টান)
//   - Noise force       (Perlin — correlated smooth randomness)
//   - Micro hesitation  (human-like pause/reversal)
//   - Trade bias        (trade-based mode)
//
// otc-server.js থেকে:  generateTickV5(state, ctrl, stats)
// নতুন market এ:        initStateV5(price)  → spread into state
// ═══════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────
// PERLIN-STYLE 1D NOISE — correlated, smooth randomness
// ─────────────────────────────────────────────────────────────────────────
// প্রতিটা market এর নিজস্ব permutation seed। fade + lerp দিয়ে smooth।

function _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function _lerp(a, b, t) { return a + t * (b - a); }

function _grad(hash, x) {
  // hash থেকে +1 বা -1 gradient
  return (hash & 1) === 0 ? x : -x;
}

// Deterministic hash — seed + integer
function _hash(seed, i) {
  let h = seed + i * 374761393;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return h >>> 0;
}

// 1D Perlin noise at position x (returns -1..1 approx)
function _perlin1D(seed, x) {
  const x0 = Math.floor(x);
  const x1 = x0 + 1;
  const dx = x - x0;
  const g0 = _grad(_hash(seed, x0), dx);
  const g1 = _grad(_hash(seed, x1), dx - 1);
  const u  = _fade(dx);
  return _lerp(g0, g1, u) * 2; // scale to ~-1..1
}

// Fractal Brownian Motion — multiple octaves মিলিয়ে natural texture
function _fbm(seed, x) {
  let total = 0, amp = 1, freq = 1, maxAmp = 0;
  for (let o = 0; o < 3; o++) {
    total  += _perlin1D(seed + o * 97, x * freq) * amp;
    maxAmp += amp;
    amp    *= 0.5;
    freq   *= 2.1;
  }
  return total / maxAmp; // normalized ~-1..1
}


// ─────────────────────────────────────────────────────────────────────────
// MARKET REGIME STATE MACHINE — extended states
// ─────────────────────────────────────────────────────────────────────────
// Real market behaviour phases:
//   accumulation  : tight range, low vol (before move)
//   markup        : strong uptrend
//   distribution  : tight range at top
//   markdown      : strong downtrend
//   expansion     : high volatility both ways
//   compression   : shrinking range (before breakout)
//   pullback_up   : correction in uptrend
//   pullback_dn   : correction in downtrend
//   liquidity_grab: fake spike then reverse
//   exhaustion    : trend slowing, about to reverse
//   ranging       : normal sideways

function _nextRegime(cur) {
  const r = Math.random();
  switch (cur) {
    case 'accumulation':
      return r < 0.45 ? 'markup' : r < 0.65 ? 'compression' : r < 0.85 ? 'accumulation' : 'markdown';
    case 'markup':
      return r < 0.35 ? 'markup' : r < 0.60 ? 'pullback_up' : r < 0.75 ? 'distribution'
           : r < 0.88 ? 'exhaustion' : 'expansion';
    case 'distribution':
      return r < 0.45 ? 'markdown' : r < 0.65 ? 'distribution' : r < 0.85 ? 'compression' : 'markup';
    case 'markdown':
      return r < 0.35 ? 'markdown' : r < 0.60 ? 'pullback_dn' : r < 0.75 ? 'accumulation'
           : r < 0.88 ? 'exhaustion' : 'expansion';
    case 'expansion':
      return r < 0.30 ? 'markup' : r < 0.60 ? 'markdown' : r < 0.80 ? 'ranging' : 'compression';
    case 'compression':
      return r < 0.40 ? 'liquidity_grab' : r < 0.70 ? 'markup' : 'markdown';
    case 'pullback_up':
      return r < 0.60 ? 'markup' : r < 0.80 ? 'ranging' : r < 0.92 ? 'distribution' : 'markdown';
    case 'pullback_dn':
      return r < 0.60 ? 'markdown' : r < 0.80 ? 'ranging' : r < 0.92 ? 'accumulation' : 'markup';
    case 'liquidity_grab':
      // fake move — তারপর reverse
      return r < 0.55 ? 'markup' : r < 0.90 ? 'markdown' : 'ranging';
    case 'exhaustion':
      return r < 0.45 ? 'ranging' : r < 0.70 ? 'pullback_up' : 'pullback_dn';
    case 'ranging':
    default:
      return r < 0.25 ? 'accumulation' : r < 0.45 ? 'compression'
           : r < 0.60 ? 'markup' : r < 0.75 ? 'markdown'
           : r < 0.90 ? 'ranging' : 'expansion';
  }
}

// Regime duration in ticks (500ms per tick)
function _regimeDuration(s) {
  switch (s) {
    case 'accumulation':  return 16 + (Math.random() * 20 | 0); // 8–18s
    case 'markup':        return 10 + (Math.random() * 16 | 0); // 5–13s
    case 'distribution':  return 16 + (Math.random() * 20 | 0);
    case 'markdown':      return 10 + (Math.random() * 16 | 0);
    case 'expansion':     return  6 + (Math.random() * 10 | 0); // 3–8s
    case 'compression':   return 10 + (Math.random() * 12 | 0);
    case 'pullback_up':   return  4 + (Math.random() *  6 | 0); // 2–5s
    case 'pullback_dn':   return  4 + (Math.random() *  6 | 0);
    case 'liquidity_grab':return  3 + (Math.random() *  4 | 0); // 1.5–3.5s
    case 'exhaustion':    return  5 + (Math.random() *  7 | 0);
    case 'ranging':
    default:              return 12 + (Math.random() * 16 | 0);
  }
}

// Regime → { trendForce, volatilityMul, reversionMul }
function _regimeParams(s, grabDir) {
  switch (s) {
    case 'accumulation':  return { trend:  0.05, vol: 0.4, rev: 0.9 };
    case 'markup':        return { trend:  0.55, vol: 1.0, rev: 0.2 };
    case 'distribution':  return { trend: -0.05, vol: 0.4, rev: 0.9 };
    case 'markdown':      return { trend: -0.55, vol: 1.0, rev: 0.2 };
    case 'expansion':     return { trend:  0.00, vol: 1.8, rev: 0.3 };
    case 'compression':   return { trend:  0.00, vol: 0.3, rev: 1.1 };
    case 'pullback_up':   return { trend: -0.30, vol: 0.7, rev: 0.4 };
    case 'pullback_dn':   return { trend:  0.30, vol: 0.7, rev: 0.4 };
    case 'liquidity_grab':return { trend: (grabDir || 1) * 1.1, vol: 1.5, rev: 0.1 };
    case 'exhaustion':    return { trend:  0.00, vol: 0.6, rev: 0.7 };
    case 'ranging':
    default:              return { trend:  0.00, vol: 0.6, rev: 0.6 };
  }
}


// ─────────────────────────────────────────────────────────────────────────
// LIQUIDITY MEMORY — multiple support/resistance levels
// ─────────────────────────────────────────────────────────────────────────
// Swing high/low detect করে level হিসেবে store করি (max ~15টা)।
// Price কোনো level এর কাছে গেলে সেই level এর দিকে টান / bounce।

function _updateLiquidity(state) {
  if (!state._liq) state._liq = [];
  if (!state._swingTick) state._swingTick = 0;
  state._swingTick++;

  // প্রতি ৮ tick এ swing detect
  if (state._swingTick % 8 !== 0) return;

  const p = state.price;
  // recent high/low track
  if (!state._recentHigh || p > state._recentHigh) state._recentHigh = p;
  if (!state._recentLow  || p < state._recentLow)  state._recentLow  = p;

  // প্রতি ৪০ tick এ swing confirm করে level হিসেবে যোগ করি
  if (state._swingTick % 40 === 0) {
    const hi = state._recentHigh, lo = state._recentLow;
    if (hi) state._liq.push({ price: hi, strength: 1.0 });
    if (lo) state._liq.push({ price: lo, strength: 1.0 });
    state._recentHigh = p;
    state._recentLow  = p;
    // পুরনো level decay + prune
    state._liq.forEach(l => l.strength *= 0.9);
    state._liq = state._liq.filter(l => l.strength > 0.15).slice(-15);
  }
}

// Liquidity force — কাছের level এর দিকে টান বা bounce
function _liquidityForce(state, v) {
  if (!state._liq || state._liq.length === 0) return 0;
  const p = state.price;
  let force = 0;
  for (const l of state._liq) {
    const dist = (l.price - p) / (v * 20 + 1e-9); // normalized distance
    if (Math.abs(dist) < 3) {
      // কাছাকাছি — টান (magnet effect), strength ও distance অনুযায়ী
      const pull = Math.sign(dist) * Math.exp(-Math.abs(dist)) * l.strength;
      force += pull;
    }
  }
  return force * v * 0.15;
}


// ─────────────────────────────────────────────────────────────────────────
// TRADE-BASED BIAS
// ─────────────────────────────────────────────────────────────────────────
function _tradeBias(stats) {
  const up   = parseFloat(stats.upAmount)   || 0;
  const down = parseFloat(stats.downAmount) || 0;
  if (up > down * 1.1)  return -1; // majority UP  → push DOWN
  if (down > up * 1.1)  return  1; // majority DOWN → push UP
  return 0;
}


// ─────────────────────────────────────────────────────────────────────────
// MAIN TICK — force-based physics
// ─────────────────────────────────────────────────────────────────────────
function generateTickV5(state, ctrl, stats) {
  if (!state || !state.price) return;

  const volCfg = { low: 0.5, medium: 1.0, high: 1.9 }[ctrl.volatility] || 1.0;
  const speed  = ctrl.speedMultiplier || 1.0;
  const now    = Date.now();

  // Base unit of movement — v3 এর মতো ০.০২৫%
  const vBase = state.price * 0.00025 * volCfg;

  // ── Perlin noise position advance ────────────────────────────────────
  if (state._noiseX === undefined) state._noiseX = Math.random() * 1000;
  if (state._noiseSeed === undefined) state._noiseSeed = (Math.random() * 1e9) | 0;
  state._noiseX += 0.08; // slow advance = smooth correlated noise

  // ── Regime state machine ─────────────────────────────────────────────
  if (!state._regime) {
    state._regime = 'ranging';
    state._regimeTick = _regimeDuration('ranging');
    state._grabDir = 1;
  }
  state._regimeTick--;
  if (state._regimeTick <= 0) {
    const next = _nextRegime(state._regime);
    if (next === 'liquidity_grab') state._grabDir = Math.random() < 0.5 ? 1 : -1;
    state._regime = next;
    state._regimeTick = _regimeDuration(next);
  }

  const rp = _regimeParams(state._regime, state._grabDir);
  const v  = vBase * rp.vol;

  // ── [v4.1] SMART TICK CLUSTERING ────────────────────────────────────
  // Cluster direction pure random না — regime bias + velocity + আগের
  // cluster মিলিয়ে ঠিক হয়। Duration ও volatility অনুযায়ী variable।
  if (state._clusterTick === undefined || state._clusterTick <= 0) {
    const regimeBias = rp.trend;
    const velBias    = Math.sign(state._velocity || 0) * 0.5;
    const prevBias   = (state._clusterDir || 0) * 0.45;   // continuation ঝোঁক বেশি
    const score      = regimeBias + velBias + prevBias;
    const pUp = 0.5 + Math.max(-0.45, Math.min(0.45, score * 0.4));
    state._clusterDir = Math.random() < pUp ? 1 : -1;

    // [v5] Directional persistence — cluster লম্বা (৬–১৮ tick)
    // এতে candle এর মধ্যে price এক দিকে বেশি যায় → বড় body, ছোট wick
    const volFactor = rp.vol;
    const baseDur   = volFactor > 1.2 ? 6 : volFactor < 0.5 ? 14 : 10;
    state._clusterTick = Math.max(5, baseDur + (Math.random() * 8 - 4 | 0)); // 5–18 range
    state._clusterStr  = 0.5 + Math.random() * 0.5;
  }
  state._clusterTick--;
  // [v5] cluster force — 0.35 → 0.45 (আরও directional drive)
  const clusterForce = state._clusterDir * v * state._clusterStr * 0.45;

  // ── FORCE 1: Trend force (regime direction) ─────────────────────────
  let trendForce = rp.trend * v * 0.5;

  // Manual/trade-based override
  if (ctrl.mode === 'manual') {
    const dir = ctrl.nextDirection === 'up' ? 1 : ctrl.nextDirection === 'down' ? -1 : 0;
    trendForce = dir * v * 0.8;
  } else if (ctrl.mode === 'trade-based') {
    state._tradeTrend = _tradeBias(stats);
    // regime চলবে normally, শুধু শেষ ৮s এ subtle push (নিচে যোগ হবে)
  }

  // ── FORCE 2: Noise force (Perlin/FBM, correlated) ───────────────────
  const noiseForce = _fbm(state._noiseSeed, state._noiseX) * v * 0.7;

  // ── FORCE 3: Liquidity force (support/resistance magnet) ────────────
  _updateLiquidity(state);
  const liqForce = _liquidityForce(state, v);

  // ── FORCE 4: Mean reversion (v3 simple anchor) ──────────────────────
  if (state._anchor === undefined) state._anchor = state.price;
  state._anchor = state._anchor * 0.998 + state.price * 0.002;
  // [v5] Mean reversion কমানো — 0.05 → 0.025 (কম center-pull, বড় body)
  const reversionForce = (state._anchor - state.price) * 0.025 * rp.rev;

  // ── FORCE 5: Micro hesitation (human behaviour) ─────────────────────
  // প্রতি কয়েক tick এ ছোট বিপরীত পা — trend এও hesitation
  if (!state._hesTick) state._hesTick = 0;
  state._hesTick++;
  let hesitationForce = 0;
  const hesPhase = state._hesTick % 6;
  if (hesPhase === 4) hesitationForce = -Math.sign(state._velocity || 0) * v * 0.15;
  if (hesPhase === 5) hesitationForce = -(state._velocity || 0) * 0.08; // brief brake

  // ── FORCE 6: Trade-based close push (শেষ ৮s, subtle) ────────────────
  let closePush = 0;
  if (ctrl.mode === 'trade-based' && state._tradeTrend) {
    const timeLeft = state.nextCandle ? (state.nextCandle - now) : 99999;
    if (timeLeft <= 8000 && timeLeft > 0) {
      closePush = state._tradeTrend * v * 0.2;
    }
  }

  // ── PHYSICS: net force → acceleration → velocity → price ────────────
  const netForce = trendForce + clusterForce + noiseForce + liqForce + reversionForce + hesitationForce + closePush;

  if (state._velocity === undefined)     state._velocity = 0;
  if (state._acceleration === undefined) state._acceleration = 0;

  // acceleration = force (mass=1)
  state._acceleration = netForce;
  state._velocity += state._acceleration;

  // ── [v4.1] DYNAMIC FRICTION — smooth lerp, per-tick random বাদ ──────
  // Friction regime অনুযায়ী target এর দিকে smoothly move করে।
  // GPT: per-tick Math.random() বাদ — professional engine এ friction smooth।
  if (state._friction === undefined) state._friction = 0.85;
  let frictionTarget;
  if (state._regime === 'markup' || state._regime === 'markdown' ||
      state._regime === 'expansion' || state._regime === 'liquidity_grab') {
    frictionTarget = 0.90; // কম damping → বেশি glide
  } else if (state._regime === 'ranging' || state._regime === 'compression' ||
             state._regime === 'accumulation' || state._regime === 'distribution') {
    frictionTarget = 0.78; // বেশি damping → ধীর
  } else {
    frictionTarget = 0.84;
  }
  // smooth transition — কোনো per-tick random নেই
  state._friction += (frictionTarget - state._friction) * 0.08;
  state._velocity *= Math.max(0.70, Math.min(0.94, state._friction));

  // velocity clamp — বড় spike রোধ
  const maxVel = v * 2.2;
  state._velocity = Math.max(-maxVel, Math.min(maxVel, state._velocity));

  // ── HARD SAFETY CLAMP — এক tick এ price max ±0.15% এর বেশি নড়বে না ──────
  const proposedPrice = state.price + state._velocity * speed;
  const maxStep = state.price * 0.0015; // 0.15% max per tick
  const clampedDelta = Math.max(-maxStep, Math.min(maxStep, proposedPrice - state.price));
  state.price = Math.max(state.price + clampedDelta, 0.0001);
}


// ─────────────────────────────────────────────────────────────────────────
// STATE INITIALIZER
// ─────────────────────────────────────────────────────────────────────────
function initStateV5(price) {
  return {
    _regime:       'ranging',
    _regimeTick:   _regimeDuration('ranging'),
    _grabDir:      1,
    _velocity:     0,
    _acceleration: 0,
    _noiseX:       Math.random() * 1000,
    _noiseSeed:    (Math.random() * 1e9) | 0,
    _anchor:       price,
    _liq:          [],
    _swingTick:    0,
    _recentHigh:   price,
    _recentLow:    price,
    _hesTick:      0,
    _tradeTrend:   0,
    // [v4-stable] tick clustering + dynamic friction
    _clusterTick:  4 + (Math.random() * 5 | 0),
    _clusterDir:   Math.random() < 0.5 ? 1 : -1,
    _clusterStr:   0.3 + Math.random() * 0.5,
    _friction:     0.85,
  };
}

module.exports = { generateTickV5, initStateV5 };
