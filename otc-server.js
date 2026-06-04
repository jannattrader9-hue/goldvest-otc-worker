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

const TICK_MS         = 500;
const CANDLE_MS       = 60 * 1000;
const TD_API_KEY      = '392fa09f669c4cd7843f958e0fbbca36';
const FINNHUB_API_KEY = 'd7v1ippr01qp7l70m80gd7v1ippr01qp7l70m810';

// সব ৮টা Forex pair
const FOREX_PAIRS = [
  'EURUSD','GBPUSD','EURGBP','EURJPY',
  'USDJPY','EURNZD','NZDUSD','NZDJPY'
];

// Pair থেকে base/quote বের করো
function _parseForexId(id) {
  const base  = id.slice(0, 3);
  const quote = id.slice(3, 6);
  return { base, quote };
}

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

// ── Twelve Data symbol map (historical candles এর জন্য) ──
const TD_SYMBOL_MAP = {
  'EURUSD':'EUR/USD','GBPUSD':'GBP/USD',
  'EURGBP':'EUR/GBP','EURJPY':'EUR/JPY',
  'USDJPY':'USD/JPY','EURNZD':'EUR/NZD',
  'NZDUSD':'NZD/USD','NZDJPY':'NZD/JPY',
};

// ── ExchangeRate-API: সব pair এর price একটাই call এ ────
let _ratesCache     = {};
let _ratesLastFetch = 0;

async function _fetchAllRates() {
  const now = Date.now();
  if (now - _ratesLastFetch < 30_000) return; // 30s cache
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/EUR');
    const d = await r.json();
    if (d.result === 'success' && d.rates) {
      _ratesCache     = d.rates;
      _ratesLastFetch = now;
      console.log('[ExchangeRate] Rates updated');
    }
  } catch (e) { console.warn('[ExchangeRate] fetch failed:', e.message); }
}

async function getForexPairPrice(id) {
  await _fetchAllRates();
  if (!Object.keys(_ratesCache).length) return 0;
  const base  = id.slice(0, 3).toUpperCase();
  const quote = id.slice(3, 6).toUpperCase();
  try {
    if (base === 'EUR') return _ratesCache[quote] || 0;
    const eurBase  = _ratesCache[base]  || 0;
    const eurQuote = _ratesCache[quote] || 0;
    if (!eurBase || !eurQuote) return 0;
    return parseFloat((eurQuote / eurBase).toFixed(6));
  } catch (_) { return 0; }
}

// প্রতি মিনিটে rates update করো
setInterval(_fetchAllRates, 60_000);

// ── Twelve Data historical candles (শুধু initial load) ──
async function fetchForexHistory(id, size = 200) {
  const tdSymbol = TD_SYMBOL_MAP[id];
  if (!tdSymbol) return [];
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=1min&outputsize=${size}&timezone=UTC&apikey=${TD_API_KEY}`;
    const d   = await (await fetch(url)).json();
    if (d.status === 'error' || !Array.isArray(d.values) || !d.values.length) return [];
    return d.values.slice().reverse().map(v => {
      const [dp, tp] = v.datetime.split(' ');
      return {
        time:  Math.floor(new Date(dp+'T'+tp+'Z').getTime()/1000),
        open:  parseFloat(v.open),
        high:  parseFloat(v.high),
        low:   parseFloat(v.low),
        close: parseFloat(v.close),
      };
    }).filter(c => !isNaN(c.open) && c.time > 0);
  } catch (e) { console.warn(`[TD History] ${id}:`, e.message); return []; }
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
//
// Architecture (OTC engine এর মতো):
//   WebSocket → price cache (কোনো Firebase write না)
//   প্রতি 500ms → cached price দিয়ে candle update → Firebase
//   মিনিট শেষে → candle save → নতুন candle শুরু
// ══════════════════════════════════════════════════════════

const _forexCandleTimers = {};

async function initForex(id) {
  if (_activeMarkets.has(id)) return;
  if (!TD_SYMBOL_MAP[id]) { console.warn(`[${id}] No symbol mapping`); return; }

  if (!isForexOpen()) {
    set(ref(db, `otc_status/${id}`), { enabled:false, reason:'market_closed' }).catch(()=>{});
    console.log(`[${id}] Market closed`);
    return;
  }
  set(ref(db, `otc_status/${id}`), { enabled:true }).catch(()=>{});

  // ── Historical candles (Twelve Data — একবারই) ───────────
  console.log(`[${id}] Loading history...`);
  const history       = await fetchForexHistory(id, 200);
  const lastSaved     = await loadLastCandle(id);
  const lastSavedTime = lastSaved?.time || 0;
  const newCandles    = history.filter(c => c.time > lastSavedTime);

  if (newCandles.length > 0) {
    for (const c of newCandles) await saveCandle(id, c);
    console.log(`[${id}] Written ${newCandles.length} new candles`);
  } else {
    console.log(`[${id}] Firebase up to date`);
  }

  // ── Initial price (ExchangeRate) ─────────────────────────
  let lastClose = history.length > 0
    ? history[history.length-1].close
    : (lastSaved?.close || 0);

  if (!lastClose || lastClose <= 0) {
    lastClose = await getForexPairPrice(id);
  }
  _forexPrices[id] = lastClose;

  // ── Admin control listener ──────────────────────────────
  _controls[id] = { mode:'auto', nextDirection:'auto' };
  onValue(ref(db, `otc_controls/${id}`), snap => {
    if (snap.exists()) _controls[id] = { ..._controls[id], ...snap.val() };
  });

  // ── State ───────────────────────────────────────────────
  const now   = Date.now();
  const start = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  _states[id] = {
    type:       'forex',
    price:      lastClose,
    candleOpen: lastClose,
    candleHigh: lastClose,
    candleLow:  lastClose,
    candleTime: start / 1000,
    nextCandle: start + CANDLE_MS,
  };

  _activeMarkets.add(id);
  console.log(`[${id}] Forex started @ ${lastClose}`);
  // ExchangeRate প্রতি মিনিটে price update করবে (setInterval উপরে আছে)
}

// ── ExchangeRate API প্রতি 30s এ cache update করে ──────
// tickForex এ getForexPairPrice(id) call করলে latest price পাওয়া যায়

async function tickForex(id) {
  const state = _states[id];
  if (!state || state.type !== 'forex') return;

  if (!isForexOpen()) {
    stopSymbol(id);
    set(ref(db, `otc_status/${id}`), { enabled:false, reason:'market_closed' }).catch(()=>{});
    return;
  }

  const now      = Date.now();
  const ctrl     = _controls[id] || {};

  // ── Latest real price (ExchangeRate cache থেকে) ──────────
  const erPrice   = await getForexPairPrice(id);
  const realPrice = (erPrice > 0) ? erPrice : (_forexPrices[id] || state.price);
  if (!realPrice || realPrice <= 0) return;
  _forexPrices[id] = realPrice;

  // ── Admin control apply ───────────────────────────────
  let price = realPrice;

  if (ctrl.mode === 'manual') {
    const dir = ctrl.nextDirection;
    const v   = realPrice * 0.000025; // Forex এ খুব tiny movement
    if (dir === 'up')        price = realPrice + v * (0.5 + Math.random() * 0.5);
    else if (dir === 'down') price = realPrice - v * (0.5 + Math.random() * 0.5);
    // 'auto' direction → real price

  } else if (ctrl.mode === 'trade-based') {
    try {
      const statsSnap = await get(ref(db, `otc_trade_stats/${id}`));
      const stats  = statsSnap.exists() ? statsSnap.val() : {};
      const upAmt  = parseFloat(stats.upAmount)  || 0;
      const downAmt= parseFloat(stats.downAmount)|| 0;
      const v = realPrice * 0.000025;
      if (upAmt > downAmt * 1.2)    price = realPrice - v * (0.5 + Math.random() * 0.5);
      else if (downAmt > upAmt*1.2) price = realPrice + v * (0.5 + Math.random() * 0.5);
      // কাছাকাছি → real price
    } catch(_) {}

  } else {
    // Auto mode → real price exactly
    price = realPrice;
  }

  state.price = price;

  // ── Candle update (OTC engine এর মতো) ─────────────────
  if (price > state.candleHigh) state.candleHigh = price;
  if (price < state.candleLow)  state.candleLow  = price;

  if (now >= state.nextCandle) {
    // মিনিট শেষ — candle save করো
    await saveCandle(id, {
      time:  state.candleTime,
      open:  state.candleOpen,
      high:  state.candleHigh,
      low:   state.candleLow,
      close: price,
    });
    set(ref(db, `otc_candles/${id}/live`), null).catch(()=>{});

    // নতুন candle শুরু
    state.candleTime  = state.nextCandle / 1000;
    state.candleOpen  = price;
    state.candleHigh  = price;
    state.candleLow   = price;
    state.nextCandle += CANDLE_MS;
    while (state.nextCandle <= now) {
      state.candleTime  = state.nextCandle / 1000;
      state.nextCandle += CANDLE_MS;
    }
  } else {
    // Live candle update — Firebase এ লেখো
    saveLiveCandle(id, {
      time:       state.candleTime,
      open:       state.candleOpen,
      high:       state.candleHigh,
      low:        state.candleLow,
      close:      price,
      nextCandle: state.nextCandle,
    });
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

// Self-ping প্রতি 8 মিনিট — Render free tier spin down এড়াতে
setInterval(() => {
  fetch('https://goldvest-otc-worker.onrender.com/')
    .then(() => console.log('[keepalive] ping OK'))
    .catch(e => console.warn('[keepalive] ping failed:', e.message));
}, 8 * 60 * 1000);
