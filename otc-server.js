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

// Twelve Data — ৪টা pair
const FOREX_SYMBOL_MAP = {
  'EURUSD': 'EUR/USD',
  'GBPUSD': 'GBP/USD',
  'EURGBP': 'EUR/GBP',
  'EURJPY': 'EUR/JPY',
};

// Finnhub — বাকি ৪টা pair
// Finnhub Forex format: IC MARKETS বা FXCM provider
const FINNHUB_SYMBOL_MAP = {
  'USDJPY': 'FXCM:USD/JPY',
  'EURNZD': 'FXCM:EUR/NZD',
  'NZDUSD': 'FXCM:NZD/USD',
  'NZDJPY': 'FXCM:NZD/JPY',
};

// Helper: কোন API use করবে
function _isFinnhub(id) { return !!FINNHUB_SYMBOL_MAP[id]; }
function _getTdSymbol(id) { return FOREX_SYMBOL_MAP[id] || null; }
function _getFhSymbol(id) { return FINNHUB_SYMBOL_MAP[id] || null; }

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

    if (d.status === 'error') {
      console.error(`[fetchForexHistory] API error: ${d.message}`);
      return [];
    }
    if (!Array.isArray(d.values) || d.values.length === 0) {
      console.warn(`[fetchForexHistory] Empty values for ${tdSymbol}`);
      return [];
    }

    return d.values
      .slice()
      .reverse()
      .map(v => {
        const [datePart, timePart] = v.datetime.split(' ');
        const t = Math.floor(new Date(datePart + 'T' + timePart + 'Z').getTime() / 1000);
        return {
          time:  t,
          open:  parseFloat(v.open),
          high:  parseFloat(v.high),
          low:   parseFloat(v.low),
          close: parseFloat(v.close),
        };
      })
      .filter(c => !isNaN(c.open) && c.time > 0);

  } catch (e) {
    console.error(`[fetchForexHistory] Exception: ${e.message}`);
    return [];
  }
}

// Finnhub REST থেকে historical candles নাও
async function fetchFinnhubHistory(finnhubSymbol, size = 200) {
  try {
    const toTs   = Math.floor(Date.now() / 1000);
    const fromTs = toTs - (size * 60 * 2); // 2x buffer
    // Finnhub forex candle endpoint
    const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(finnhubSymbol)}&resolution=1&from=${fromTs}&to=${toTs}&token=${FINNHUB_API_KEY}`;
    const d   = await (await fetch(url)).json();

    if (d.s === 'no_data' || !Array.isArray(d.t) || d.t.length === 0) {
      console.warn(`[fetchFinnhubHistory] No data for ${finnhubSymbol}`);
      return [];
    }

    return d.t.map((t, i) => ({
      time:  t,
      open:  parseFloat(d.o[i]),
      high:  parseFloat(d.h[i]),
      low:   parseFloat(d.l[i]),
      close: parseFloat(d.c[i]),
    })).filter(c => !isNaN(c.open) && c.time > 0);

  } catch (e) {
    console.error(`[fetchFinnhubHistory] Exception: ${e.message}`);
    return [];
  }
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

  // Twelve Data নাকি Finnhub?
  const isFinnhub = _isFinnhub(id);
  const tdSymbol  = _getTdSymbol(id);
  const fhSymbol  = _getFhSymbol(id);

  if (!tdSymbol && !fhSymbol) { console.warn(`[${id}] No symbol mapping`); return; }

  if (!isForexOpen()) {
    set(ref(db, `otc_status/${id}`), { enabled:false, reason:'market_closed' }).catch(()=>{});
    console.log(`[${id}] Market closed`);
    return;
  }
  set(ref(db, `otc_status/${id}`), { enabled:true }).catch(()=>{});

  // ── Historical candles — duplicate check ────────────────
  console.log(`[${id}] Loading history (${isFinnhub ? 'Finnhub' : 'TwelveData'})...`);
  const history    = isFinnhub
    ? await fetchFinnhubHistory(fhSymbol, 200)
    : await fetchForexHistory(tdSymbol, 200);

  const lastSaved  = await loadLastCandle(id);
  const lastSavedTime = lastSaved?.time || 0;
  const newCandles = history.filter(c => c.time > lastSavedTime);

  if (newCandles.length > 0) {
    for (const c of newCandles) await saveCandle(id, c);
    console.log(`[${id}] Written ${newCandles.length} new candles`);
  } else {
    console.log(`[${id}] Firebase up to date`);
  }

  const lastClose = history.length > 0
    ? history[history.length-1].close
    : (lastSaved?.close || 1.0);

  _forexPrices[id] = lastClose;

  // ── Admin control listener ──────────────────────────────
  _controls[id] = { mode:'auto', nextDirection:'auto' };
  onValue(ref(db, `otc_controls/${id}`), snap => {
    if (snap.exists()) _controls[id] = { ..._controls[id], ...snap.val() };
  });

  // ── State — OTC engine এর মতো ──────────────────────────
  const now      = Date.now();
  const start    = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  _states[id] = {
    type:       'forex',
    tdSymbol,
    price:      lastClose,
    candleOpen: lastClose,
    candleHigh: lastClose,
    candleLow:  lastClose,
    candleTime: start / 1000,
    nextCandle: start + CANDLE_MS,
    trendSteps: 0,
    trend:      0,
  };

  _activeMarkets.add(id);
  console.log(`[${id}] Forex started @ ${lastClose}`);

  // ── Shared WebSocket এ subscribe করো ───────────────────
  if (isFinnhub) {
    _ensureFhWS(); // shared Finnhub WS — একটাই connection
  } else {
    _ensureTdWS(); // shared TD WS — একটাই connection
    // নতুন pair টা subscribe করো যদি WS already open থাকে
    if (_tdWS && _tdReady && tdSymbol) {
      _tdWS.send(JSON.stringify({ action:'subscribe', params:{ symbols: tdSymbol } }));
    }
  }
}

// ══════════════════════════════════════════════════════════
// SHARED WebSocket CONNECTIONS
// একটাই TD connection + একটাই Finnhub connection
// সব pair একই connection এ subscribe করা হয়
// ══════════════════════════════════════════════════════════

let _tdWS       = null; // shared Twelve Data WS
let _fhWS       = null; // shared Finnhub WS
let _tdReady    = false;
let _fhReady    = false;

// Twelve Data shared WS শুরু করো
function _ensureTdWS() {
  if (_tdWS && (_tdWS.readyState === 0 || _tdWS.readyState === 1)) return;

  let WS;
  try { WS = require('ws'); } catch { return; }

  _tdWS   = new WS(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${TD_API_KEY}`);
  _tdReady = false;

  _tdWS.on('open', () => {
    _tdReady = true;
    console.log('[TD-WS] Connected');
    // Active Forex pair সব subscribe করো
    const tdPairs = [..._activeMarkets]
      .filter(id => FOREX_SYMBOL_MAP[id])
      .map(id => FOREX_SYMBOL_MAP[id]);
    if (tdPairs.length > 0) {
      _tdWS.send(JSON.stringify({ action:'subscribe', params:{ symbols: tdPairs.join(',') } }));
      console.log('[TD-WS] Subscribed:', tdPairs.join(', '));
    }
  });

  _tdWS.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'heartbeat' || msg.event === 'subscribe-status') return;
      if (!msg.price || isNaN(parseFloat(msg.price))) return;
      // symbol → id map
      const id = Object.keys(FOREX_SYMBOL_MAP).find(k => FOREX_SYMBOL_MAP[k] === msg.symbol);
      if (id && _activeMarkets.has(id)) _forexPrices[id] = parseFloat(msg.price);
    } catch (_) {}
  });

  let _tdReconnectCount = 0;
  _tdWS.on('close', () => {
    _tdReady = false;
    _tdReconnectCount++;
    if (_tdReconnectCount > 5) {
      // বারবার fail করলে REST polling এ fall back করো
      console.warn('[TD-WS] Too many reconnects, switching to REST polling');
      [..._activeMarkets]
        .filter(id => FOREX_SYMBOL_MAP[id])
        .forEach(id => _startForexPollFallback(id));
      return;
    }
    console.warn('[TD-WS] Closed, reconnect 5s');
    setTimeout(_ensureTdWS, 5000);
  });

  _tdWS.on('error', e => console.error('[TD-WS] Error:', e.message));
}

// Finnhub shared WS শুরু করো
function _ensureFhWS() {
  if (_fhWS && (_fhWS.readyState === 0 || _fhWS.readyState === 1)) return;

  let WS;
  try { WS = require('ws'); } catch { return; }

  _fhWS   = new WS(`wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`);
  _fhReady = false;

  _fhWS.on('open', () => {
    _fhReady = true;
    console.log('[FH-WS] Connected');
    // Active Finnhub pair সব subscribe করো
    [..._activeMarkets]
      .filter(id => FINNHUB_SYMBOL_MAP[id])
      .forEach(id => {
        _fhWS.send(JSON.stringify({ type:'subscribe', symbol: FINNHUB_SYMBOL_MAP[id] }));
      });
    console.log('[FH-WS] Subscribed Finnhub pairs');
  });

  _fhWS.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;
      msg.data.forEach(trade => {
        // Finnhub symbol → id map
        const id = Object.keys(FINNHUB_SYMBOL_MAP).find(k => FINNHUB_SYMBOL_MAP[k] === trade.s);
        if (id && _activeMarkets.has(id) && trade.p) {
          _forexPrices[id] = parseFloat(trade.p);
        }
      });
    } catch (_) {}
  });

  let _fhReconnectCount = 0;
  _fhWS.on('close', () => {
    _fhReady = false;
    _fhReconnectCount++;
    if (_fhReconnectCount > 5) {
      console.warn('[FH-WS] Too many reconnects, switching to REST polling');
      [..._activeMarkets]
        .filter(id => FINNHUB_SYMBOL_MAP[id])
        .forEach(id => _startForexPollFallback(id));
      return;
    }
    console.warn('[FH-WS] Closed, reconnect 5s');
    setTimeout(_ensureFhWS, 5000);
  });

  _fhWS.on('error', e => console.error('[FH-WS] Error:', e.message));
}

// Forex polling fallback (ws package না থাকলে)
function _startForexPollFallback(id) {
  const isFh  = _isFinnhub(id);
  const sym   = isFh ? _getFhSymbol(id) : _getTdSymbol(id);
  const intv  = setInterval(async () => {
    if (!_activeMarkets.has(id)) { clearInterval(intv); return; }
    try {
      let price = 0;
      if (isFh) {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_API_KEY}`);
        const d = await r.json();
        price = parseFloat(d.c) || 0;
      } else {
        const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${TD_API_KEY}`);
        const d = await r.json();
        price = parseFloat(d.price) || 0;
      }
      if (price > 0) _forexPrices[id] = price;
    } catch (_) {}
  }, 10_000);
}

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

  // ── Latest real price ─────────────────────────────────
  const realPrice = _forexPrices[id] || state.price;
  if (!realPrice || realPrice <= 0) return;

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
