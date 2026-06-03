// ============================================================
// otc-server.js — OTC + Forex Candle Generator Server
// Render.com এ 24/7 চলবে।
//
// OTC markets  → Binance base price → synthetic candle
// Forex markets → Twelve Data real price + Admin control
//
// Admin control (Firebase RTDB otc_controls/{symbol}):
//   mode: 'auto' | 'manual' | 'trade-based'
//   nextDirection: 'up' | 'down' | 'auto'
//   forexNudge: number (-1 to +1) — auto mode এ price nudge
// ============================================================

const { initializeApp }  = require('firebase/app');
const {
  getDatabase, ref, push, set, get, onValue,
  query, orderByKey, limitToLast
} = require('firebase/database');
const { getFirestore, collection, onSnapshot } = require('firebase/firestore');

const firebaseConfig = {
  apiKey:            "AIzaSyDKMa5s8UEqj14Um449TH0albHMNNTDgts",
  authDomain:        "goldvest-cf73d.firebaseapp.com",
  projectId:         "goldvest-cf73d",
  storageBucket:     "goldvest-cf73d.firebasestorage.app",
  messagingSenderId: "231132359006",
  appId:             "1:231132359006:web:6693b7ad95567b195547cf",
  databaseURL:       "https://goldvest-cf73d-default-rtdb.firebaseio.com"
};

const app        = initializeApp(firebaseConfig);
const db         = getDatabase(app);
const firestore  = getFirestore(app);

const TICK_MS    = 500;
const CANDLE_MS  = 60 * 1000;
const TD_API_KEY = '392fa09f669c4cd7843f958e0fbbca36';

const FOREX_SYMBOL_MAP = {
  'EURUSD': 'EUR/USD', 'GBPUSD': 'GBP/USD',
  'EURGBP': 'EUR/GBP', 'EURJPY': 'EUR/JPY',
  'USDJPY': 'USD/JPY', 'EURNZD': 'EUR/NZD',
  'NZDUSD': 'NZD/USD', 'NZDJPY': 'NZD/JPY',
};

function isForexOpen() {
  const now  = new Date();
  const day  = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && hour < 21) return false;
  if (day === 5 && hour >= 22) return false;
  return true;
}

const _states        = {};
const _controls      = {};
const _activeMarkets = new Set();
const _forexPrices   = {};
const _forexWS       = {};

// ── Fetch helpers ─────────────────────────────────────────
async function fetchBinancePrice(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    return parseFloat((await r.json()).price) || 0;
  } catch { return 0; }
}

async function fetchForexPrice(tdSymbol) {
  try {
    const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(tdSymbol)}&apikey=${TD_API_KEY}`);
    return parseFloat((await r.json()).price) || 0;
  } catch { return 0; }
}

async function fetchForexHistory(tdSymbol, size = 200) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=1min&outputsize=${size}&timezone=UTC&apikey=${TD_API_KEY}`;
    const d   = await (await fetch(url)).json();
    if (d.status === 'error' || !Array.isArray(d.values)) return [];
    return d.values.slice().reverse().map(v => ({
      time:  Math.floor(new Date(v.datetime.replace(' ','T')+'Z').getTime() / 1000),
      open:  parseFloat(v.open),  high: parseFloat(v.high),
      low:   parseFloat(v.low),   close: parseFloat(v.close),
    })).filter(c => !isNaN(c.open));
  } catch { return []; }
}

// ── Firebase helpers ──────────────────────────────────────
async function loadLastCandle(id) {
  try {
    const snap = await get(query(ref(db, `otc_candles/${id}/candles`), orderByKey(), limitToLast(1)));
    if (snap.exists()) return Object.values(snap.val())[0];
  } catch {}
  return null;
}

async function saveCandle(id, candle) {
  try {
    await push(ref(db, `otc_candles/${id}/candles`), candle);
    console.log(`[${id}] candle close=${candle.close.toFixed(5)}`);
  } catch (e) { console.error(`[${id}] save failed:`, e.message); }
}

function saveLiveCandle(id, candle) {
  set(ref(db, `otc_candles/${id}/live`), candle).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// OTC ENGINE (Synthetic)
// ══════════════════════════════════════════════════════════
function randomTrend() {
  const r = Math.random();
  return r < 0.38 ? 1 : r < 0.76 ? -1 : 0;
}

async function backfillOTC(id, lastTime, lastPrice) {
  const now = Math.floor(Date.now() / 1000);
  const missing = Math.min(Math.floor((Math.floor(now/60)*60 - lastTime)/60)-1, 480);
  if (missing <= 0) return lastPrice;
  console.log(`[${id}] Backfilling ${missing} OTC candles...`);
  let price = lastPrice, trend = 0, steps = 0;
  for (let i = 0; i < missing; i++) {
    if (steps <= 0) { trend = randomTrend(); steps = 8 + Math.floor(Math.random()*12); }
    steps--;
    let open = price, high = price, low = price;
    for (let k = 0; k < 120; k++) {
      const v = price * 0.0008;
      price = Math.max(price + trend*v*0.4 + (Math.random()-0.5)*v*2, 0.0001);
      if (price > high) high = price;
      if (price < low)  low  = price;
    }
    await saveCandle(id, { time: lastTime+(i+1)*60, open, high, low, close: price });
  }
  return price;
}

async function initOTC(market) {
  const { id, baseSymbol, startPrice: fixedStart } = market;
  if (_activeMarkets.has(id)) return;
  const last = await loadLastCandle(id);
  let price;
  if (last) {
    const gap = Math.floor((Math.floor(Date.now()/1000/60)*60 - last.time)/60)-1;
    price = gap > 0 ? await backfillOTC(id, last.time, last.close) : last.close;
  } else {
    price = baseSymbol ? await fetchBinancePrice(baseSymbol) : (fixedStart || 1.0);
    if (!price || price <= 0) price = fixedStart || 1.0;
  }

  _controls[id] = { mode:'auto', nextDirection:'auto', volatility:'medium', trendStrength:0.6, wickFactor:0.4, speedMultiplier:1.0 };
  onValue(ref(db, `otc_controls/${id}`), snap => { if (snap.exists()) _controls[id] = { ..._controls[id], ...snap.val() }; });

  const now = Date.now(), start = Math.floor(now/CANDLE_MS)*CANDLE_MS;
  _states[id] = { type:'otc', price, candleOpen:price, candleHigh:price, candleLow:price, candleTime:start/1000, nextCandle:start+CANDLE_MS, trend:0, trendSteps:0 };
  _activeMarkets.add(id);
  console.log(`[${id}] OTC started @ ${price.toFixed(4)}`);
}

async function tickOTC(id) {
  const state = _states[id];
  if (!state || state.type !== 'otc') return;
  const ctrl = _controls[id] || {};
  const volMul = { low:0.4, medium:1.0, high:2.2 }[ctrl.volatility] || 1.0;
  const speed = ctrl.speedMultiplier || 1.0;
  const now = Date.now();

  if (!ctrl.mode || ctrl.mode === 'auto') {
    if (state.trendSteps <= 0) { state.trend = randomTrend(); state.trendSteps = Math.round((8+Math.floor(Math.random()*12))/speed); }
    state.trendSteps--;
  } else if (ctrl.mode === 'manual') {
    state.trend = ctrl.nextDirection === 'up' ? 1 : ctrl.nextDirection === 'down' ? -1 : 0;
    state.trendSteps = 99;
  }

  const v = state.price * 0.0008 * volMul;
  state.price = Math.max(state.price + (state.trend*v*(ctrl.trendStrength||0.6) + (Math.random()-0.5)*v*2)*speed, 0.0001);
  if (state.price > state.candleHigh) state.candleHigh = state.price;
  if (state.price < state.candleLow)  state.candleLow  = state.price;

  if (now >= state.nextCandle) {
    await saveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.price });
    set(ref(db, `otc_candles/${id}/live`), null).catch(()=>{});
    state.candleTime = state.nextCandle/1000; state.candleOpen = state.price;
    state.candleHigh = state.price; state.candleLow = state.price;
    state.nextCandle += CANDLE_MS;
    while (state.nextCandle <= now) { state.candleTime = state.nextCandle/1000; state.nextCandle += CANDLE_MS; }
  } else {
    saveLiveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.price, nextCandle:state.nextCandle });
  }
}

// ══════════════════════════════════════════════════════════
// FOREX ENGINE
// Strategy:
//   - প্রতি মিনিটে Twelve Data REST API থেকে exact OHLC নেওয়া হয়
//     → TradingView এর সাথে exact same candle
//   - Live candle: current minute এর latest price দিয়ে build করা হয়
//   - Admin control: manual/trade-based mode এ live candle manipulate করা হয়
//     (closed candle গুলো সবসময় real থাকে)
// ══════════════════════════════════════════════════════════

// Per-symbol Forex state
const _forexCandleTimers = {}; // { id: intervalId } — প্রতি মিনিটে candle fetch

async function initForex(id) {
  if (_activeMarkets.has(id)) return;
  const tdSymbol = FOREX_SYMBOL_MAP[id];
  if (!tdSymbol) { console.warn(`[${id}] No TD symbol mapping`); return; }

  if (!isForexOpen()) {
    set(ref(db, `otc_status/${id}`), { enabled:false, reason:'market_closed' }).catch(()=>{});
    console.log(`[${id}] Forex market closed, skipping`);
    return;
  }

  set(ref(db, `otc_status/${id}`), { enabled:true }).catch(()=>{});

  // ── Step 1: Historical candles লেখো (200 candles) ──────
  console.log(`[${id}] Loading Forex history...`);
  const history = await fetchForexHistory(tdSymbol, 200);
  if (history.length > 0) {
    for (const c of history) await saveCandle(id, c);
    console.log(`[${id}] Written ${history.length} historical candles`);
  }

  // ── Step 2: Latest price ──────────────────────────────
  let price = history.length > 0 ? history[history.length-1].close : 1.0;
  _forexPrices[id] = price;

  // ── Step 3: Admin control listener ───────────────────
  _controls[id] = { mode:'auto', nextDirection:'auto' };
  onValue(ref(db, `otc_controls/${id}`), snap => {
    if (snap.exists()) _controls[id] = { ..._controls[id], ...snap.val() };
  });

  // ── Step 4: State initialize ──────────────────────────
  const now   = Date.now();
  const start = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  _states[id] = {
    type:        'forex',
    tdSymbol,
    price,
    // Current live candle (এই মিনিটের)
    liveCandle:  null,
    // Last fetched closed candle time (duplicate avoid)
    lastClosedTime: history.length > 0 ? history[history.length-1].time : 0,
    nextCandle:  start + CANDLE_MS,
  };

  _activeMarkets.add(id);
  console.log(`[${id}] Forex started @ ${price}`);

  // ── Step 5: Live candle build শুরু করো ──────────────
  _startForexLiveCandle(id, tdSymbol);

  // ── Step 6: প্রতি মিনিটে closed candle fetch করো ────
  // মিনিটের শুরুতে align করো
  const msToNextMinute = CANDLE_MS - (now % CANDLE_MS);
  setTimeout(() => {
    _fetchAndSaveClosedCandle(id, tdSymbol);
    _forexCandleTimers[id] = setInterval(() => {
      _fetchAndSaveClosedCandle(id, tdSymbol);
    }, CANDLE_MS);
  }, msToNextMinute + 5000); // 5s extra — API এ candle close হতে সময় লাগে
}

// ── প্রতি মিনিটে REST থেকে latest closed candle fetch করো ──
async function _fetchAndSaveClosedCandle(id, tdSymbol) {
  const state = _states[id];
  if (!state || state.type !== 'forex') return;
  if (!isForexOpen()) return;

  const ctrl = _controls[id] || {};

  // Manual বা trade-based mode এ closed candle manipulate করো
  if (ctrl.mode === 'manual' || ctrl.mode === 'trade-based') {
    // Real candle save না করে synthetic tick চালিয়ে যাও
    return;
  }

  try {
    // Latest 2 candle নাও — index 0 = newest (just closed), index 1 = previous
    const url = `https://api.twelvedata.com/time_series`
      + `?symbol=${encodeURIComponent(tdSymbol)}`
      + `&interval=1min`
      + `&outputsize=2`
      + `&timezone=UTC`
      + `&apikey=${TD_API_KEY}`;

    const res  = await fetch(url);
    const data = await res.json();

    if (data.status === 'error' || !Array.isArray(data.values) || data.values.length < 2) return;

    // index 1 = just closed candle (index 0 = current forming)
    const closed = data.values[1];
    const candle = {
      time:  Math.floor(new Date(closed.datetime.replace(' ', 'T') + 'Z').getTime() / 1000),
      open:  parseFloat(closed.open),
      high:  parseFloat(closed.high),
      low:   parseFloat(closed.low),
      close: parseFloat(closed.close),
    };

    // Duplicate check
    if (candle.time <= state.lastClosedTime) return;
    state.lastClosedTime = candle.time;

    // Firebase এ save করো
    await saveCandle(id, candle);
    _forexPrices[id] = candle.close;
    state.price = candle.close;
    console.log(`[${id}] Real candle saved: close=${candle.close} t=${new Date(candle.time*1000).toISOString()}`);

    // Live candle clear করো — নতুন মিনিট শুরু হচ্ছে
    set(ref(db, `otc_candles/${id}/live`), null).catch(()=>{});
    state.liveCandle = null;

  } catch (e) {
    console.warn(`[${id}] Candle fetch error:`, e.message);
  }
}

// ── Live candle: WebSocket tick থেকে current minute এর OHLC build ──
function _startForexLiveCandle(id, tdSymbol) {
  let WS;
  try { WS = require('ws'); } catch {
    console.warn(`[${id}] ws package not found, using REST polling for live`);
    _startForexLivePolling(id, tdSymbol);
    return;
  }

  const ws = new WS(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${TD_API_KEY}`);

  ws.on('open', () => {
    ws.send(JSON.stringify({ action:'subscribe', params:{ symbols: tdSymbol } }));
    console.log(`[${id}] WS connected`);
  });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'heartbeat' || msg.event === 'subscribe-status') return;
      if (!msg.price || isNaN(parseFloat(msg.price))) return;

      const price  = parseFloat(msg.price);
      const nowSec = Math.floor(Date.now() / 1000);
      _forexPrices[id] = price;
      _updateForexLiveCandle(id, price, nowSec);
    } catch (_) {}
  });

  ws.on('close', () => {
    console.warn(`[${id}] WS closed, reconnect 5s`);
    delete _forexWS[id];
    if (_activeMarkets.has(id)) setTimeout(() => _startForexLiveCandle(id, tdSymbol), 5000);
  });

  ws.on('error', e => console.error(`[${id}] WS error:`, e.message));
  _forexWS[id] = ws;
}

// Fallback: REST polling প্রতি 10s (live candle এর জন্য)
function _startForexLivePolling(id, tdSymbol) {
  const intv = setInterval(async () => {
    if (!_activeMarkets.has(id)) { clearInterval(intv); return; }
    try {
      const url  = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(tdSymbol)}&apikey=${TD_API_KEY}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.price) {
        const price  = parseFloat(data.price);
        const nowSec = Math.floor(Date.now() / 1000);
        _forexPrices[id] = price;
        _updateForexLiveCandle(id, price, nowSec);
      }
    } catch (_) {}
  }, 10_000);
}

// Live candle update (WebSocket tick থেকে)
function _updateForexLiveCandle(id, price, nowSec) {
  const state = _states[id];
  if (!state) return;

  const ctrl     = _controls[id] || {};
  const bucketTime = Math.floor(nowSec / 60) * 60;

  // Admin control: manual/trade-based mode এ price modify করো
  let finalPrice = price;
  if (ctrl.mode === 'manual') {
    const dir = ctrl.nextDirection;
    const v   = price * 0.00008;
    if (dir === 'up')        finalPrice = price + v * (0.5 + Math.random() * 0.5);
    else if (dir === 'down') finalPrice = price - v * (0.5 + Math.random() * 0.5);
  } else if (ctrl.mode === 'trade-based') {
    // Async — fire and forget
    _applyTradeBasedControl(id, price).then(p => { _forexPrices[id] = p; }).catch(() => {});
  }

  // Live candle build করো
  const live = state.liveCandle;
  if (!live || live.time !== bucketTime) {
    // নতুন মিনিট — নতুন live candle
    state.liveCandle = {
      time:  bucketTime,
      open:  state.price || finalPrice,
      high:  finalPrice,
      low:   finalPrice,
      close: finalPrice,
      nextCandle: (bucketTime + 60) * 1000,
    };
  } else {
    if (finalPrice > live.high) live.high = finalPrice;
    if (finalPrice < live.low)  live.low  = finalPrice;
    live.close = finalPrice;
  }

  state.price = finalPrice;

  // Firebase RTDB এ live candle লেখো
  saveLiveCandle(id, { ...state.liveCandle });
}

async function _applyTradeBasedControl(id, realPrice) {
  try {
    const statsSnap = await get(ref(db, `otc_trade_stats/${id}`)).catch(() => null);
    const stats  = statsSnap?.exists() ? statsSnap.val() : {};
    const upAmt  = parseFloat(stats.upAmount)   || 0;
    const downAmt= parseFloat(stats.downAmount) || 0;
    const v      = realPrice * 0.00008;
    if (upAmt > downAmt * 1.2)  return realPrice - v * (0.5 + Math.random() * 0.5);
    if (downAmt > upAmt * 1.2)  return realPrice + v * (0.5 + Math.random() * 0.5);
    return realPrice;
  } catch (_) { return realPrice; }
}

// tickForex — এখন শুধু market close check করে
// আসল কাজ _fetchAndSaveClosedCandle() এবং _updateForexLiveCandle() করে
async function tickForex(id) {
  const state = _states[id];
  if (!state || state.type !== 'forex') return;
  if (!isForexOpen()) {
    console.log(`[${id}] Forex market closed`);
    stopSymbol(id);
    set(ref(db, `otc_status/${id}`), { enabled:false, reason:'market_closed' }).catch(()=>{});
  }
}

// ══════════════════════════════════════════════════════════
// COMMON
// ══════════════════════════════════════════════════════════
function stopSymbol(id) {
  if (!_activeMarkets.has(id)) return;
  _activeMarkets.delete(id);
  delete _states[id]; delete _controls[id]; delete _forexPrices[id];
  if (_forexCandleTimers[id]) { clearInterval(_forexCandleTimers[id]); delete _forexCandleTimers[id]; }
  if (_forexWS[id]) { try { _forexWS[id].terminate(); } catch(_){} delete _forexWS[id]; }
  set(ref(db, `otc_candles/${id}/live`), null).catch(()=>{});
  console.log(`[${id}] stopped`);
}

function watchFirestoreMarkets() {
  onSnapshot(collection(firestore, 'markets'), snap => {
    snap.docChanges().forEach(async change => {
      const data = change.doc.data(), id = change.doc.id;
      if (change.type === 'added' || change.type === 'modified') {
        if (data.visible === false) { stopSymbol(id); return; }
        if (data.feed === 'twelvedata')       await initForex(id);
        else if (data.otc || data.feed === 'otc-engine' || data.feed === 'usdtbdt-engine')
          await initOTC({ id, baseSymbol: data.baseSymbol||null, startPrice: data.startPrice||1.0 });
      }
      if (change.type === 'removed') stopSymbol(id);
    });
  }, err => console.error('[Firestore]', err.message));
  console.log('[Firestore] Watching markets...');
}

// Market hours auto check
setInterval(() => {
  if (!isForexOpen()) {
    [..._activeMarkets].forEach(id => {
      if (_states[id]?.type === 'forex') {
        stopSymbol(id);
        set(ref(db, `otc_status/${id}`), { enabled:false, reason:'market_closed' }).catch(()=>{});
      }
    });
  }
}, 60_000);

async function main() {
  console.log('GoldVest OTC+Forex Server starting...');
  watchFirestoreMarkets();
  setInterval(() => {
    _activeMarkets.forEach(id => {
      if (_states[id]?.type === 'otc')   tickOTC(id);
      if (_states[id]?.type === 'forex') tickForex(id);
    });
  }, TICK_MS);
  console.log('Server running ✅');
}
main().catch(console.error);

const http = require('http');
http.createServer((req, res) => {
  const otc   = [..._activeMarkets].filter(id => _states[id]?.type === 'otc');
  const forex = [..._activeMarkets].filter(id => _states[id]?.type === 'forex');
  res.writeHead(200);
  res.end(`GoldVest Server\nOTC: ${otc.join(', ')||'none'}\nForex: ${forex.join(', ')||'none'}`);
}).listen(process.env.PORT||3000, () => console.log('HTTP alive'));

setInterval(() => {
  fetch('https://goldvest-otc-worker.onrender.com/').catch(()=>{});
}, 14*60*1000);
