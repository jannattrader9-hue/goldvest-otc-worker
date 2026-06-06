 // ============================================================
// otc-server.js — OTC + Forex Candle Generator
// OTC → Synthetic (Binance base)
// Forex → Twelve Data WebSocket (EUR/USD, GBP/USD only)
// ============================================================

const { initializeApp }  = require('firebase/app');
const { getDatabase, ref, push, set, get, onValue, query, orderByKey, limitToLast } = require('firebase/database');
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

const app       = initializeApp(firebaseConfig);
const db        = getDatabase(app);
const firestore = getFirestore(app);

const TICK_MS   = 500;
const CANDLE_MS = 60 * 1000;
const TD_KEY    = '392fa09f669c4cd7843f958e0fbbca36';

// Twelve Data symbol map
const TD_MAP = {
  'EURUSD': 'EUR/USD',
  'GBPUSD': 'GBP/USD',
};

// ─── Sub-minute timeframes server থেকে generate হবে ────────
// Firebase path: subcandles_{interval}/{symbol}/candles  → closed
//                subcandles_{interval}/{symbol}/live     → running
const SUB_INTERVALS = [
  { label: '15s', ms: 15 * 1000 },
  { label: '30s', ms: 30 * 1000 },
];

function isForexOpen() {
  const d = new Date(), day = d.getUTCDay(), h = d.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && h < 21) return false;
  if (day === 5 && h >= 22) return false;
  return true;
}

const _states        = {};
const _controls      = {};
const _activeMarkets = new Set();
const _forexPrices   = {};
const _tradeStats    = {}; // trade-based mode এর জন্য cached stats

// ── Firebase helpers ──────────────────────────────────────
async function fetchBinancePrice(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    return parseFloat((await r.json()).price) || 0;
  } catch { return 0; }
}

async function loadLastCandle(id) {
  try {
    const snap = await get(query(ref(db, `otc_candles/${id}/candles`), orderByKey(), limitToLast(1)));
    if (snap.exists()) return Object.values(snap.val())[0];
  } catch {}
  return null;
}

function saveCandle(id, candle) {
  push(ref(db, `otc_candles/${id}/candles`), candle)
    .then(() => console.log(`[${id}] candle close=${candle.close.toFixed(5)}`))
    .catch(e => console.error(`[${id}] save failed:`, e.message));
}

function saveLiveCandle(id, candle) {
  set(ref(db, `otc_candles/${id}/live`), candle).catch(() => {});
}

// ─── Sub-minute candle save helpers ──────────────────────
function saveSubCandle(id, label, candle) {
  push(ref(db, `subcandles_${label}/${id}/candles`), candle)
    .catch(e => console.error(`[${id}][${label}] sub save failed:`, e.message));
}

function saveLiveSubCandle(id, label, candle) {
  set(ref(db, `subcandles_${label}/${id}/live`), candle).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// OTC ENGINE
// ══════════════════════════════════════════════════════════
function randomTrend() {
  const r = Math.random();
  return r < 0.38 ? 1 : r < 0.76 ? -1 : 0;
}

async function backfillOTC(id, lastTime, lastPrice) {
  const now = Math.floor(Date.now() / 1000);
  const missing = Math.min(Math.floor((Math.floor(now/60)*60 - lastTime)/60)-1, 480);
  if (missing <= 0) return lastPrice;
  console.log(`[${id}] Backfilling ${missing} candles...`);
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

  _controls[id] = { mode:'auto', nextDirection:'auto', volatility:'medium', trendStrength:0.6, speedMultiplier:1.0 };
  onValue(ref(db, `otc_controls/${id}`), snap => { if (snap.exists()) _controls[id] = { ..._controls[id], ...snap.val() }; });

  const now = Date.now(), start = Math.floor(now/CANDLE_MS)*CANDLE_MS;

  // ── Sub-minute state init ─────────────────────────────
  const subStates = {};
  for (const { label, ms } of SUB_INTERVALS) {
    const subStart = Math.floor(now / ms) * ms;
    subStates[label] = {
      candleOpen: price, candleHigh: price, candleLow: price,
      candleTime: subStart / 1000,
      nextCandle: subStart + ms,
      ms,
    };
  }

  _states[id] = {
    type:'otc', price, candleOpen:price, candleHigh:price, candleLow:price,
    candleTime:start/1000, nextCandle:start+CANDLE_MS,
    trend:0, trendSteps:0,
    subStates, // sub-minute state এখানে
  };
  _activeMarkets.add(id);
  console.log(`[${id}] OTC started @ ${price.toFixed(4)}`);
}

function tickOTC(id) {
  const state = _states[id];
  if (!state || state.type !== 'otc') return;
  const ctrl = _controls[id] || {};
  const volMul = { low:0.4, medium:1.0, high:2.2 }[ctrl.volatility] || 1.0;
  const speed = ctrl.speedMultiplier || 1.0;
  const now = Date.now();

  // ── Price generation — হুবহু আগের মতো ──────────────
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

  // ── 1m candle logic — হুবহু আগের মতো ───────────────
  if (now >= state.nextCandle) {
    saveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.price });
    set(ref(db, `otc_candles/${id}/live`), null).catch(()=>{});
    state.candleTime = state.nextCandle/1000; state.candleOpen = state.price;
    state.candleHigh = state.price; state.candleLow = state.price;
    state.nextCandle += CANDLE_MS;
    while (state.nextCandle <= now) { state.candleTime = state.nextCandle/1000; state.nextCandle += CANDLE_MS; }
  } else {
    saveLiveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.price, nextCandle:state.nextCandle });
  }

  // ── Sub-minute candle logic (15s, 30s) ───────────────
  for (const { label } of SUB_INTERVALS) {
    const ss = state.subStates[label];
    if (!ss) continue;

    if (state.price > ss.candleHigh) ss.candleHigh = state.price;
    if (state.price < ss.candleLow)  ss.candleLow  = state.price;

    if (now >= ss.nextCandle) {
      saveSubCandle(id, label, { time:ss.candleTime, open:ss.candleOpen, high:ss.candleHigh, low:ss.candleLow, close:state.price });
      set(ref(db, `subcandles_${label}/${id}/live`), null).catch(() => {});
      ss.candleTime = ss.nextCandle / 1000;
      ss.candleOpen = state.price;
      ss.candleHigh = state.price;
      ss.candleLow  = state.price;
      ss.nextCandle += ss.ms;
      while (ss.nextCandle <= now) { ss.candleTime = ss.nextCandle / 1000; ss.nextCandle += ss.ms; }
    } else {
      saveLiveSubCandle(id, label, { time:ss.candleTime, open:ss.candleOpen, high:ss.candleHigh, low:ss.candleLow, close:state.price, nextCandle:ss.nextCandle });
    }
  }
}

// ══════════════════════════════════════════════════════════
// FOREX ENGINE
// Twelve Data WebSocket → price cache → 500ms tick → candle
// শুধু EUR/USD আর GBP/USD (free tier এ ২টা symbol OK)
// ══════════════════════════════════════════════════════════

// Single shared WebSocket for all Forex pairs
let _tdWS      = null;
let _tdReady   = false;

function _startSharedTdWS() {
  if (_tdWS && (_tdWS.readyState === 0 || _tdWS.readyState === 1)) return;

  let WS;
  try { WS = require('ws'); } catch (e) {
    console.warn('[TD-WS] ws package not found');
    return;
  }

  _tdWS   = new WS(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${TD_KEY}`);
  _tdReady = false;

  _tdWS.on('open', () => {
    _tdReady = true;
    // সব TD_MAP pair subscribe করো — active হোক বা না হোক
    const allSymbols = Object.values(TD_MAP).join(',');
    _tdWS.send(JSON.stringify({ action:'subscribe', params:{ symbols: allSymbols } }));
    console.log(`[TD-WS] Connected & subscribed: ${allSymbols}`);
  });

  _tdWS.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'heartbeat' || msg.event === 'subscribe-status') return;
      if (!msg.price || isNaN(parseFloat(msg.price))) return;
      // symbol → id
      const id = Object.keys(TD_MAP).find(k => TD_MAP[k] === msg.symbol);
      if (id) _forexPrices[id] = parseFloat(msg.price);
    } catch (_) {}
  });

  _tdWS.on('close', () => {
    _tdReady = false;
    console.warn('[TD-WS] Closed, reconnect 5s');
    _tdWS = null;
    setTimeout(_startSharedTdWS, 5000);
  });

  _tdWS.on('error', e => console.error('[TD-WS] Error:', e.message));
}

async function fetchTdHistory(id) {
  const sym = TD_MAP[id];
  if (!sym) return [];
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1min&outputsize=200&timezone=UTC&apikey=${TD_KEY}`;
    const d   = await (await fetch(url)).json();
    if (d.status === 'error' || !Array.isArray(d.values) || !d.values.length) return [];
    return d.values.slice().reverse().map(v => {
      const [dp, tp] = v.datetime.split(' ');
      return {
        time:  Math.floor(new Date(dp+'T'+tp+'Z').getTime()/1000),
        open:  parseFloat(v.open),  high: parseFloat(v.high),
        low:   parseFloat(v.low),   close: parseFloat(v.close),
      };
    }).filter(c => !isNaN(c.open) && c.time > 0);
  } catch (e) { console.warn(`[TD History] ${id}:`, e.message); return []; }
}

async function initForex(id) {
  if (_activeMarkets.has(id)) return;
  if (!TD_MAP[id]) { console.warn(`[${id}] Not in TD_MAP, skipping`); return; }

  if (!isForexOpen()) {
    set(ref(db, `otc_status/${id}`), { enabled:false, reason:'market_closed' }).catch(()=>{});
    console.log(`[${id}] Forex market closed`);
    return;
  }
  set(ref(db, `otc_status/${id}`), { enabled:true }).catch(()=>{});

  // Historical candles
  console.log(`[${id}] Loading history...`);
  const history       = await fetchTdHistory(id);
  const lastSaved     = await loadLastCandle(id);
  const lastSavedTime = lastSaved?.time || 0;
  const newCandles    = history.filter(c => c.time > lastSavedTime);

  if (newCandles.length > 0) {
    for (const c of newCandles) await saveCandle(id, c);
    console.log(`[${id}] Written ${newCandles.length} new candles`);
  } else {
    console.log(`[${id}] Firebase up to date`);
  }

  const lastClose = history.length > 0 ? history[history.length-1].close : (lastSaved?.close || 1.0);
  _forexPrices[id] = lastClose;

  // Admin control
  _controls[id] = { mode:'auto', nextDirection:'auto' };
  onValue(ref(db, `otc_controls/${id}`), snap => {
    if (snap.exists()) _controls[id] = { ..._controls[id], ...snap.val() };
  });
  // Trade stats cache — background realtime update
  onValue(ref(db, `otc_trade_stats/${id}`), snap => {
    _tradeStats[id] = snap.exists() ? snap.val() : {};
  });

  // State
  const now = Date.now(), start = Math.floor(now/CANDLE_MS)*CANDLE_MS;

  // ── Sub-minute state init for Forex ──────────────────
  const subStates = {};
  for (const { label, ms } of SUB_INTERVALS) {
    const subStart = Math.floor(now / ms) * ms;
    subStates[label] = {
      candleOpen: lastClose, candleHigh: lastClose, candleLow: lastClose,
      candleTime: subStart / 1000,
      nextCandle: subStart + ms,
      ms,
    };
  }

  _states[id] = {
    type:'forex', price:lastClose,
    candleOpen:lastClose, candleHigh:lastClose, candleLow:lastClose,
    candleTime:start/1000, nextCandle:start+CANDLE_MS,
    subStates,
  };

  _activeMarkets.add(id);
  console.log(`[${id}] Forex started @ ${lastClose}`);

  // WS open থাকলে সাথে সাথে subscribe, না হলে start করো
  if (_tdWS && _tdWS.readyState === 1 && _tdReady) {
    _tdWS.send(JSON.stringify({ action:'subscribe', params:{ symbols: TD_MAP[id] } }));
    console.log(`[${id}] Subscribed to TD-WS`);
  } else {
    // WS start করো — open হলে সব active forex pair subscribe হবে
    _startSharedTdWS();
  }
}

function tickForex(id) {
  const state = _states[id];
  if (!state || state.type !== 'forex') return;

  if (!isForexOpen()) {
    stopSymbol(id);
    set(ref(db, `otc_status/${id}`), { enabled:false, reason:'market_closed' }).catch(()=>{});
    return;
  }

  const now       = Date.now();
  const ctrl      = _controls[id] || {};
  const realPrice = _forexPrices[id] || state.price;
  if (!realPrice || realPrice <= 0) return;

  // Admin control — হুবহু আগের মতো
  let price = realPrice;
  if (ctrl.mode === 'manual') {
    const dir = ctrl.nextDirection;
    const v   = realPrice * 0.000025;
    if (dir === 'up')        price = realPrice + v*(0.5+Math.random()*0.5);
    else if (dir === 'down') price = realPrice - v*(0.5+Math.random()*0.5);
  } else if (ctrl.mode === 'trade-based') {
    // Cached stats use করো (background এ refresh হয়)
    const stats = _tradeStats[id] || {};
    const up    = parseFloat(stats.upAmount)   || 0;
    const down  = parseFloat(stats.downAmount) || 0;
    const v     = realPrice * 0.000025;
    if (up > down*1.2)   price = realPrice - v*(0.5+Math.random()*0.5);
    else if (down>up*1.2) price = realPrice + v*(0.5+Math.random()*0.5);
  }

  state.price = price;
  if (price > state.candleHigh) state.candleHigh = price;
  if (price < state.candleLow)  state.candleLow  = price;

  // ── 1m candle logic — হুবহু আগের মতো ───────────────
  if (now >= state.nextCandle) {
    saveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:price });
    set(ref(db, `otc_candles/${id}/live`), null).catch(()=>{});
    state.candleTime = state.nextCandle/1000; state.candleOpen = price;
    state.candleHigh = price; state.candleLow = price;
    state.nextCandle += CANDLE_MS;
    while (state.nextCandle <= now) { state.candleTime = state.nextCandle/1000; state.nextCandle += CANDLE_MS; }
  } else {
    saveLiveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:price, nextCandle:state.nextCandle });
  }

  // ── Sub-minute candle logic (15s, 30s) ───────────────
  for (const { label } of SUB_INTERVALS) {
    const ss = state.subStates[label];
    if (!ss) continue;

    if (price > ss.candleHigh) ss.candleHigh = price;
    if (price < ss.candleLow)  ss.candleLow  = price;

    if (now >= ss.nextCandle) {
      saveSubCandle(id, label, { time:ss.candleTime, open:ss.candleOpen, high:ss.candleHigh, low:ss.candleLow, close:price });
      set(ref(db, `subcandles_${label}/${id}/live`), null).catch(() => {});
      ss.candleTime = ss.nextCandle / 1000;
      ss.candleOpen = price;
      ss.candleHigh = price;
      ss.candleLow  = price;
      ss.nextCandle += ss.ms;
      while (ss.nextCandle <= now) { ss.candleTime = ss.nextCandle / 1000; ss.nextCandle += ss.ms; }
    } else {
      saveLiveSubCandle(id, label, { time:ss.candleTime, open:ss.candleOpen, high:ss.candleHigh, low:ss.candleLow, close:price, nextCandle:ss.nextCandle });
    }
  }
}

// ══════════════════════════════════════════════════════════
// COMMON
// ══════════════════════════════════════════════════════════
function stopSymbol(id) {
  if (!_activeMarkets.has(id)) return;
  _activeMarkets.delete(id);
  delete _states[id]; delete _controls[id]; delete _forexPrices[id]; delete _tradeStats[id];
  set(ref(db, `otc_candles/${id}/live`), null).catch(()=>{});
  // Sub-minute live candles ও clear করো
  for (const { label } of SUB_INTERVALS) {
    set(ref(db, `subcandles_${label}/${id}/live`), null).catch(() => {});
  }
  console.log(`[${id}] stopped`);
}

function watchFirestoreMarkets() {
  onSnapshot(collection(firestore, 'markets'), snap => {
    snap.docChanges().forEach(async change => {
      const data = change.doc.data(), id = change.doc.id;
      if (change.type === 'added' || change.type === 'modified') {
        if (data.visible === false) { stopSymbol(id); return; }
        if (data.feed === 'twelvedata') await initForex(id);
        else if (data.otc || data.feed === 'otc-engine' || data.feed === 'usdtbdt-engine')
          await initOTC({ id, baseSymbol:data.baseSymbol||null, startPrice:data.startPrice||1.0 });
      }
      if (change.type === 'removed') stopSymbol(id);
    });
  }, err => console.error('[Firestore]', err.message));
  console.log('[Firestore] Watching markets...');
}

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
  console.log('GoldVest Server starting...');
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
  res.end(`GoldVest ✅\nOTC: ${otc.join(',')||'none'}\nForex: ${forex.join(',')||'none'}`);
}).listen(process.env.PORT||3000, () => console.log('HTTP alive'));

setInterval(() => {
  fetch('https://goldvest-otc-worker.onrender.com/')
    .then(() => console.log('[ping] OK'))
    .catch(() => {});
}, 8*60*1000);
