'use strict';

// ═══════════════════════════════════════════════════════════════
// GoldVest Candle Engine — Professional OTC Market Simulator
// ═══════════════════════════════════════════════════════════════
// শুধু price/candle generation। Settlement, RTDB write — এখানে নেই।
// otc-server.js থেকে generateTick(state, ctrl, stats) call করো।
// ═══════════════════════════════════════════════════════════════

// ── Market States ─────────────────────────────────────────────
// ranging     : support/resistance এর মধ্যে bounce
// uptrend     : higher highs, higher lows
// downtrend   : lower highs, lower lows
// pullback_up : uptrend এ ছোট correction
// pullback_dn : downtrend এ ছোট correction
// breakout_up : range এর উপরে break
// breakout_dn : range এর নিচে break

function _nextState(current) {
  const r = Math.random();
  switch (current) {
    case 'ranging':
      return r < 0.30 ? 'breakout_up'
           : r < 0.60 ? 'breakout_dn'
           : r < 0.80 ? 'uptrend'
           : 'downtrend';
    case 'uptrend':
      return r < 0.50 ? 'uptrend'
           : r < 0.75 ? 'pullback_up'
           : r < 0.90 ? 'ranging'
           : 'downtrend';
    case 'downtrend':
      return r < 0.50 ? 'downtrend'
           : r < 0.75 ? 'pullback_dn'
           : r < 0.90 ? 'ranging'
           : 'uptrend';
    case 'pullback_up':
      return r < 0.65 ? 'uptrend'
           : r < 0.85 ? 'ranging'
           : 'downtrend';
    case 'pullback_dn':
      return r < 0.65 ? 'downtrend'
           : r < 0.85 ? 'ranging'
           : 'uptrend';
    case 'breakout_up':
      return r < 0.70 ? 'uptrend'
           : r < 0.90 ? 'pullback_up'
           : 'ranging';
    case 'breakout_dn':
      return r < 0.70 ? 'downtrend'
           : r < 0.90 ? 'pullback_dn'
           : 'ranging';
    default:
      return 'ranging';
  }
}

// State duration — কত tick এই state এ থাকবে (500ms per tick)
function _stateDuration(s) {
  switch (s) {
    case 'ranging':     return 12 + Math.floor(Math.random() * 16); // 6–14s
    case 'uptrend':     return  8 + Math.floor(Math.random() * 12); // 4–10s
    case 'downtrend':   return  8 + Math.floor(Math.random() * 12);
    case 'pullback_up': return  3 + Math.floor(Math.random() *  5); // 1.5–4s
    case 'pullback_dn': return  3 + Math.floor(Math.random() *  5);
    case 'breakout_up': return  2 + Math.floor(Math.random() *  4); // 1–3s
    case 'breakout_dn': return  2 + Math.floor(Math.random() *  4);
    default:            return 10;
  }
}

// Direction bias per state
function _stateBias(s) {
  switch (s) {
    case 'uptrend':     return  0.55;
    case 'downtrend':   return -0.55;
    case 'pullback_up': return -0.30;
    case 'pullback_dn': return  0.30;
    case 'breakout_up': return  0.80;
    case 'breakout_dn': return -0.80;
    default:            return  0.00; // ranging — neutral
  }
}

// ── Support/Resistance ────────────────────────────────────────
function _updateSR(state) {
  if (!state._srHigh) state._srHigh = state.price * 1.002;
  if (!state._srLow)  state._srLow  = state.price * 0.998;
  if (!state._srTick) state._srTick = 0;
  state._srTick++;

  // প্রতি ২০ tick এ SR update
  if (state._srTick % 20 === 0) {
    // Swing high/low ধীরে ধীরে track করো
    state._srHigh = state._srHigh * 0.998 + state.candleHigh * 0.002;
    state._srLow  = state._srLow  * 0.998 + state.candleLow  * 0.002;
  }
}

// SR থেকে mean reversion force
function _meanReversionForce(state, v) {
  const mid   = (state._srHigh + state._srLow) / 2;
  const range = Math.max(state._srHigh - state._srLow, v * 4);
  const dev   = (state.price - mid) / (range * 0.5);
  // Ranging এ বেশি reversion, trend এ কম
  const strength = state._marketState === 'ranging' ? 0.5 : 0.2;
  return -dev * v * strength;
}

// ── Trade-based direction ──────────────────────────────────────
function _tradeBias(stats) {
  const up   = parseFloat(stats.upAmount)   || 0;
  const down = parseFloat(stats.downAmount) || 0;
  if (up > down * 1.1)   return -1; // majority UP → candle DOWN
  if (down > up * 1.1)   return  1; // majority DOWN → candle UP
  return 0;
}

// ── Main tick function ────────────────────────────────────────
// state  : _states[id] — price, candleHigh, candleLow, candleOpen, nextCandle
// ctrl   : _controls[id] — mode, volatility, speedMultiplier, trendStrength
// stats  : _tradeStats[id] — upAmount, downAmount
function generateTick(state, ctrl, stats) {
  if (!state || !state.price) return;

  const volMul = { low:0.4, medium:1.0, high:2.0 }[ctrl.volatility] || 1.0;
  const speed  = ctrl.speedMultiplier || 1.0;
  const now    = Date.now();

  // Base volatility — price এর ০.০২% per tick (natural, small movement)
  const v = state.price * 0.0002 * volMul;

  // ── Market State Machine ──────────────────────────────────
  if (!state._marketState) {
    state._marketState    = 'ranging';
    state._marketStateTick = _stateDuration('ranging');
  }
  state._marketStateTick--;
  if (state._marketStateTick <= 0) {
    state._marketState     = _nextState(state._marketState);
    state._marketStateTick = _stateDuration(state._marketState);
  }

  // ── Direction bias ────────────────────────────────────────
  let bias = 0;

  if (ctrl.mode === 'manual') {
    bias = ctrl.nextDirection === 'up' ? 1.2
         : ctrl.nextDirection === 'down' ? -1.2
         : 0;
  } else if (ctrl.mode === 'trade-based') {
    bias = _stateBias(state._marketState);
    state._tradeTrend = _tradeBias(stats);
  } else {
    bias = _stateBias(state._marketState);
  }

  // ── Random noise — no spike, smooth ──────────────────────
  const r = Math.random();
  let noise;
  if (r < 0.58) {
    noise = 0;                                    // flat — 58%
  } else if (r < 0.79) {
    noise = v * (0.1 + Math.random() * 0.4);      // small up — 21%
  } else {
    noise = -v * (0.1 + Math.random() * 0.4);     // small down — 21%
  }
  // spike সম্পূর্ণ বাদ — wick কম হবে

  // ── Momentum — slow decay, smooth movement ────────────────
  if (!state._momentum) state._momentum = 0;
  state._momentum = state._momentum * 0.82 + (bias * v * 0.25) + (noise * 0.35);

  // Clamp momentum — বড় jump বন্ধ
  const maxMom = v * 1.5;
  state._momentum = Math.max(-maxMom, Math.min(maxMom, state._momentum));

  // ── Support/Resistance + Mean Reversion ───────────────────
  _updateSR(state);
  const mrForce = _meanReversionForce(state, v);

  // ── Trade-based close push — শেষ ৮s এ subtle ────────────
  let closePush = 0;
  if (ctrl.mode === 'trade-based' && state._tradeTrend !== 0) {
    const timeLeft = state.nextCandle ? (state.nextCandle - now) : 99999;
    if (timeLeft <= 8000 && timeLeft > 0) {
      closePush = state._tradeTrend * v * 0.18; // very subtle
    }
  }

  // ── Final delta ───────────────────────────────────────────
  const delta = (state._momentum + mrForce + closePush) * speed;
  state.price = Math.max(state.price + delta, 0.0001);
}

// ── State initializer — নতুন market শুরুতে call করো ─────────
function initCandleState(price) {
  return {
    _marketState:     'ranging',
    _marketStateTick: _stateDuration('ranging'),
    _momentum:        0,
    _tradeTrend:      0,
    _srHigh:          price * 1.002,
    _srLow:           price * 0.998,
    _srTick:          0,
  };
}

module.exports = { generateTick, initCandleState };
