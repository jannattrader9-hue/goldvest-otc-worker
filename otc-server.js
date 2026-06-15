// ============================================================
// otc-server.js — OTC + Forex Candle Generator (Admin SDK)
// OTC → Synthetic (Binance base)
// Forex → Twelve Data WebSocket (EUR/USD, GBP/USD only)
// ============================================================

const admin = require('firebase-admin');
const pLimit = require('p-limit');
const Redis  = require('ioredis');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential:  admin.credential.cert(serviceAccount),
    databaseURL: "https://goldvest-cf73d-default-rtdb.firebaseio.com"
});

const db        = admin.database();
const firestore = admin.firestore();

// ── Redis client — settler service-এ trade jobs push করে ──
const REDIS_URL = process.env.REDIS_URL;
let   redisPub  = null;
let   redisReady = false;

if (REDIS_URL) {
    redisPub = new Redis(REDIS_URL, {
        lazyConnect:          true,
        maxRetriesPerRequest: null,
        enableOfflineQueue:   true,
    });
    redisPub.on('ready', () => {
        redisReady = true;
        console.log('[Redis] connected ✅');
    });
    redisPub.on('error', (e) => {
        redisReady = false;
        console.error('[Redis] error:', e.message);
    });
    redisPub.on('close', () => {
        redisReady = false;
    });
    redisPub.connect().catch(e => {
        console.error('[Redis] connect failed:', e.message);
    });
} else {
    console.warn('[Redis] REDIS_URL not set — falling back to batchSettle HTTP');
}

const TICK_MS   = 500;
const CANDLE_MS = 60 * 1000;
const TD_KEY    = '392fa09f669c4cd7843f958e0fbbca36';

// Settlement burst protection — একই candle close এ অনেক trade একসাথে due
// হলেও, সবগুলো এক মুহূর্তে fetch() না করে এই সংখ্যক concurrent request এ
// limit করো (Cloud Function concurrency / Firestore transaction storm এড়াতে)
const SETTLE_CONCURRENCY = 50;
const settleLimit = pLimit(SETTLE_CONCURRENCY);

const TD_MAP = {
  'EURUSD': 'EUR/USD',
  'GBPUSD': 'GBP/USD',
};

const SUB_INTERVALS = [
  { label: '15s', ms: 15 * 1000 },
  { label: '30s', ms: 30 * 1000 },
];

// ── Settlement (candle-close triggered, delay-free) ───────
const SETTLE_FUNCTION_URL       = 'https://us-central1-goldvest-cf73d.cloudfunctions.net/settleTrade';
const BATCH_SETTLE_FUNCTION_URL = 'https://us-central1-goldvest-cf73d.cloudfunctions.net/batchSettle';
const SETTLE_TOKEN        = process.env.SETTLE_TOKEN || 'gv_settle_secret_2024';

// ── Batch broadcast — settled trades কে per-user group করে RTDB তে
// একসাথে push করো, যাতে client একটাই event এ সব trades একসাথে process করে
// (Quotex-pattern: single event → instant bulk UI update)
const _userSettleQueue = new Map(); // userId -> [{tradeId, status, closePrice, profit}, ...]
const _userSettleTimers = new Map(); // userId -> timeout handle

function _queueSettlementBroadcast(userId, tradeId, settleResult) {
  if (!userId || !settleResult || settleResult.result !== 'ok') return;
  if (!_userSettleQueue.has(userId)) _userSettleQueue.set(userId, []);
  _userSettleQueue.get(userId).push({
    tradeId,
    status:     settleResult.status,
    closePrice: settleResult.closePrice,
    profit:     settleResult.profit,
  });

  if (_userSettleTimers.has(userId)) clearTimeout(_userSettleTimers.get(userId));
  _userSettleTimers.set(userId, setTimeout(() => _flushUserSettleBatch(userId), 800));
}

function _flushUserSettleBatch(userId) {
  _userSettleTimers.delete(userId);
  const items = _userSettleQueue.get(userId);
  _userSettleQueue.delete(userId);
  if (!items || items.length === 0) return;

  const batchId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[batch-broadcast] userId=${userId} batchId=${batchId} items=${items.length}`);
  db.ref(`user_settlement_batches/${userId}/${batchId}`).set({
    items,
    timestamp: Date.now(),
  }).catch(e => console.error(`[batch-broadcast] ${userId} failed:`, e.message));
}

// ── Batch settle — Redis queue-এ push করো (settler service process করবে)
// Redis না থাকলে পুরনো batchSettle HTTP endpoint-এ fallback করো
async function _batchSettleAndBroadcast(symbol, trades, closePrice) {
  if (!trades || trades.length === 0) return;

  // ── Redis path (fast, <1ms per trade) ──────────────────
  if (redisPub && redisReady) {
    try {
      const jobs = trades.map(t => JSON.stringify({
        userId:     t.userId,
        tradeId:    t.tradeId,
        closePrice: t.closePrice || closePrice,
        symbol,
        settledBy:  'redis-settler',
      }));
      // LPUSH — settler blpop করে instantly process করবে
      await redisPub.lpush('gv:settle_queue', ...jobs);
      console.log(`[redis-push] ${symbol} pushed=${trades.length} closePrice=${closePrice.toFixed(5)}`);
      return;
    } catch (e) {
      console.error(`[redis-push] ${symbol} failed, falling back to HTTP:`, e.message);
    }
  }

  // ── HTTP fallback (যদি Redis না থাকে) ──────────────────
  const CHUNK = 500;
  for (let i = 0; i < trades.length; i += CHUNK) {
    const chunk = trades.slice(i, i + CHUNK);
    const _t0 = Date.now();
    try {
      const res = await fetch(BATCH_SETTLE_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-Settle-Token': SETTLE_TOKEN,
        },
        body: JSON.stringify({ trades: chunk, settledBy: 'otc-server' }),
      });
      const data = await res.json().catch(() => ({}));
      const _ms = Date.now() - _t0;
      const results = data.results || [];
      console.log(`[batch-settle] ${symbol} chunk=${i/CHUNK+1} trades=${chunk.length} took=${_ms}ms ok=${results.filter(r=>r.result==='ok').length}`);
      results.forEach(r => {
        _queueSettlementBroadcast(r.userId, r.tradeId, r);
      });
    } catch (e) {
      console.error(`[batch-settle] ${symbol} chunk=${i/CHUNK+1} failed:`, e.message);
    }
  }
}

// candle close হওয়ার মুহূর্তে — সেই symbol+candleTime এ expire হওয়া সব live trades
// খুঁজে exact close price দিয়ে settle করো (একই tick, delay-free)
async function settleTradesForCandle(symbol, candleTime, closePrice) {
  // Synchronously mark — tick-settle এই symbol skip করবে এখন থেকে
  // tickOTC/tickForex ইতিমধ্যে synchronously mark করেছে — এটা safety fallback
  // (direct call হলে যেমন Firestore fallback path এ)
  _candleSettlingSymbols.add(symbol);

  try {
    // settlement_queue RTDB থেকে এই candleTime-এ due trades পড়ো —
    // collectionGroup Firestore query-এর চেয়ে অনেক lighter (indexed by expiry)
    const queueSnap = await db.ref(`settlement_queue/${candleTime}`).once('value');

    if (!queueSnap.exists()) {
      // Fallback: RTDB queue-এ না থাকলে Firestore collectionGroup query
      // (পুরনো trades যেগুলো queue-এ লেখা হয়নি, বা Cloud Function miss করেছে)
      const fsSnap = await firestore.collectionGroup('trades')
        .where('symbol', '==', symbol)
        .where('status', '==', 'live')
        .where('accountType', '==', 'live')
        .where('expiryTimestamp', '==', candleTime)
        .get();
      if (fsSnap.empty) { _candleSettlingSymbols.delete(symbol); return; }
      const trades = fsSnap.docs.map(doc => ({
        userId: doc.data().userId || doc.ref.parent.parent?.id,
        tradeId: doc.id,
        closePrice,
      })).filter(t => t.userId);
      // tick-settle duplicate এড়াতে pending mark করো
      trades.forEach(t => {
        const key = `${t.userId}/${t.tradeId}`;
        _activeTradesMemory.delete(key);
        _pendingSettle.add(key);
      });
      await _batchSettleAndBroadcast(symbol, trades, closePrice);
      _candleSettlingSymbols.delete(symbol);
      return;
    }

    // settlement_queue-এ এই symbol-এর trades বের করো
    const trades = [];
    queueSnap.forEach(userNode => {
      const userId = userNode.key;
      userNode.forEach(tradeNode => {
        const t = tradeNode.val();
        // symbol filter — একই candleTime-এ অনেক symbol-এর trades থাকতে পারে
        if (t.symbol === symbol && t.accountType === 'live') {
          trades.push({ userId, tradeId: tradeNode.key, closePrice });
          // tick-settle duplicate এড়াতে pending mark করো
          const key = `${userId}/${tradeNode.key}`;
          _activeTradesMemory.delete(key);
          _pendingSettle.add(key);
        }
      });
    });

    if (trades.length === 0) { _candleSettlingSymbols.delete(symbol); return; }
    console.log(`[settle] ${symbol} candleTime=${candleTime} found ${trades.length} trades in queue`);

    // 30s safety — Firestore confirm না এলেও pending guard clear করো
    const pendingKeys = trades.map(t => `${t.userId}/${t.tradeId}`);
    setTimeout(() => pendingKeys.forEach(k => _pendingSettle.delete(k)), 30000);

    await _batchSettleAndBroadcast(symbol, trades, closePrice);

    // Candle settle শেষ — tick-settle আবার চলতে পারবে
    _candleSettlingSymbols.delete(symbol);

    // settle হয়ে গেলে queue entry গুলো cleanup — এই symbol-এর trades remove
    // (অন্য symbol-এর trades একই candleTime-এ থাকতে পারে, তাই selective delete)
    const cleanups = [];
    trades.forEach(t => {
      cleanups.push(db.ref(`settlement_queue/${candleTime}/${t.userId}/${t.tradeId}`).remove());
    });
    await Promise.allSettled(cleanups);

  } catch (e) {
    console.error(`[settle] ${symbol} query failed:`, e.message);
  }
}

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
const _tradeStats    = {};

// ── [SHADOW TRACKING - ধাপ ১] In-memory active trades map ──
// এটি শুধুমাত্র observation/verification এর জন্য — settlement logic এখনও বদলায়নি।
// Key: `${userId}/${tradeId}`, Value: { userId, tradeId, symbol, expiryTimestamp, status }
const _activeTradesMemory = new Map();
// Settlement শুরু হয়েছে কিন্তু Firestore onSnapshot এখনো confirm করেনি —
// এই set-এ থাকা trades পরের tick-এ duplicate settle attempt করবে না।
const _pendingSettle = new Set();
// Candle close হলে এই symbol-কে synchronously mark করা হয় —
// tick-settle এই symbol-এর trades skip করবে যতক্ষণ candle batch শেষ না হয়।
const _candleSettlingSymbols = new Set();

// ── Restart recovery — RTDB settlement_queue থেকে live trades reload ──
// OTC server restart হলে _activeTradesMemory খালি হয়ে যায়।
// এই function টা start এ একবার RTDB থেকে pending trades load করে
// যাতে tick-settle instant কাজ করতে পারে।
async function _recoverLiveTradesFromRTDB() {
  try {
    const snap = await db.ref('settlement_queue').once('value');
    if (!snap.exists()) {
      console.log('[recovery] No pending trades in settlement_queue');
      return;
    }
    let count = 0;
    snap.forEach(timeNode => {
      const expiryTimestamp = parseInt(timeNode.key);
      timeNode.forEach(userNode => {
        const userId = userNode.key;
        userNode.forEach(tradeNode => {
          const t = tradeNode.val();
          if (t.accountType !== 'live') return;
          const key = `${userId}/${tradeNode.key}`;
          _activeTradesMemory.set(key, {
            userId,
            tradeId: tradeNode.key,
            symbol: t.symbol,
            expiryTimestamp,
            accountType: 'live',
            status: 'live',
          });
          count++;
        });
      });
    });
    console.log(`[recovery] Loaded ${count} pending trades into memory ✅`);
  } catch (e) {
    console.error('[recovery] Failed:', e.message);
  }
}

function _startActiveTradesShadowListener() {
  firestore.collectionGroup('trades')
    .where('status', '==', 'live')
    .onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const data   = change.doc.data();
        const userId = change.doc.ref.parent.parent.id;
        const key     = `${userId}/${change.doc.id}`;
        if (change.type === 'removed' || data.status !== 'live') {
          _activeTradesMemory.delete(key);
          _pendingSettle.delete(key); // confirmed — pending guard clear করো
        } else {
          _activeTradesMemory.set(key, {
            userId, tradeId: change.doc.id,
            symbol: data.symbol, expiryTimestamp: data.expiryTimestamp,
            accountType: data.accountType, status: data.status
          });
        }
      });
    }, err => console.error('[shadow-tracking] listener error:', err.message));
}

// প্রতি tick এ shadow map থেকে কতগুলো trade "due" (expiryTimestamp <= now) তা log করো — observational only
function _logShadowDueTrades() {
  const nowSec = Math.floor(Date.now() / 1000);
  let due = 0;
  for (const t of _activeTradesMemory.values()) {
    if (t.expiryTimestamp <= nowSec) due++;
  }
  if (due > 0) {
    console.log(`[shadow-tracking] active=${_activeTradesMemory.size} due=${due}`);
  }
}

// ── [ধাপ ২] In-memory map থেকে tick-based settlement ──────
// প্রতি tick এ — যেসব live trade এর expiryTimestamp <= now, তাদের সেই
// symbol এর current state.price দিয়ে সাথে সাথে settle করো (candle-close
// trigger এর পাশাপাশি/parallel — duplicate-safe, কারণ _doSettle এ
// status !== 'live' guard আছে)
async function _settleDueTradesFromMemory() {
  const nowSec = Math.floor(Date.now() / 1000);
  const due = [];
  for (const [key, t] of _activeTradesMemory.entries()) {
    if (t.expiryTimestamp <= nowSec && t.accountType === 'live') {
      if (_pendingSettle.has(key)) continue; // Firestore confirm আসেনি — skip
      if (_candleSettlingSymbols.has(t.symbol)) continue; // candle path চলছে — skip
      due.push([key, t]);
    }
  }
  if (due.length === 0) return;

  // duplicate attempt এড়াতে — settlement শুরুর আগেই pending mark করো
  // Firestore onSnapshot status change confirm করলে _pendingSettle থেকে সরাবে
  for (const [key] of due) {
    _activeTradesMemory.delete(key);
    _pendingSettle.add(key);
  }

  // symbol দিয়ে group করো — প্রতিটা symbol-এর জন্য আলাদা close price
  const bySymbol = new Map();
  for (const [key, t] of due) {
    const state = _states[t.symbol];
    if (!state || typeof state.price !== 'number') continue;
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, { closePrice: state.price, trades: [] });
    bySymbol.get(t.symbol).trades.push({ userId: t.userId, tradeId: t.tradeId, closePrice: state.price });
  }

  // প্রতি symbol-এর trades batchSettle-এ পাঠাও
  await Promise.allSettled([...bySymbol.entries()].map(async ([symbol, { closePrice, trades }]) => {
    console.log(`[tick-settle] ${symbol} due=${trades.length} closePrice=${closePrice.toFixed(5)}`);
    await _batchSettleAndBroadcast(symbol, trades, closePrice);
  }));

  // Safety cleanup — 30s পরে Firestore confirm না এলেও pending guard clear করো
  // (যাতে কোনো trade চিরতরে আটকে না যায়)
  const keys = due.map(([key]) => key);
  setTimeout(() => {
    keys.forEach(k => _pendingSettle.delete(k));
  }, 30000);
}

// ── RTDB settlement_queue থেকে directly due trades settle ──
// Firestore shadow listener slow হলেও এই path কাজ করে।
// প্রতি tick এ RTDB queue চেক করে — expiryTimestamp <= now হলে settle করো।
const _rtdbSettledKeys = new Set(); // duplicate guard
async function _settleDueTradesFromRTDB() {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const snap = await db.ref('settlement_queue').once('value');
    if (!snap.exists()) return;

    const bySymbol = new Map();
    snap.forEach(timeNode => {
      const expiryTimestamp = parseInt(timeNode.key);
      if (expiryTimestamp > nowSec) return; // এখনো due হয়নি
      timeNode.forEach(userNode => {
        const userId = userNode.key;
        userNode.forEach(tradeNode => {
          const t = tradeNode.val();
          if (t.accountType !== 'live') return;
          const key = `${userId}/${tradeNode.key}`;
          if (_rtdbSettledKeys.has(key)) return;
          if (_candleSettlingSymbols.has(t.symbol)) return;
          const state = _states[t.symbol];
          if (!state || typeof state.price !== 'number') return;
          if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, { closePrice: state.price, trades: [] });
          bySymbol.get(t.symbol).trades.push({ userId, tradeId: tradeNode.key, closePrice: state.price, expiryTimestamp });
          _rtdbSettledKeys.add(key);
          _pendingSettle.add(key);
          _activeTradesMemory.delete(key);
        });
      });
    });

    if (bySymbol.size === 0) return;

    await Promise.allSettled([...bySymbol.entries()].map(async ([symbol, { closePrice, trades }]) => {
      console.log(`[rtdb-tick-settle] ${symbol} due=${trades.length} closePrice=${closePrice.toFixed(5)}`);
      await _batchSettleAndBroadcast(symbol, trades, closePrice);
      // settle হয়ে গেলে RTDB queue থেকে delete করো
      await Promise.allSettled(trades.map(t =>
        db.ref(`settlement_queue/${t.expiryTimestamp}/${t.userId}/${t.tradeId}`).remove()
      ));
    }));

    // 60s পরে guard clear করো
    setTimeout(() => {
      [...bySymbol.values()].forEach(({ trades }) => {
        trades.forEach(t => {
          const key = `${t.userId}/${t.tradeId}`;
          _rtdbSettledKeys.delete(key);
          _pendingSettle.delete(key);
        });
      });
    }, 60000);
  } catch (e) {
    console.error('[rtdb-tick-settle] error:', e.message);
  }
}

// ── 24h change tracking ───────────────────────────────────
// প্রতি symbol এর জন্য 24h আগের open price cache করো
const _openPrice24h  = {}; // { BTCOTC: { price, time } }

// 24h change calculate + RTDB save
function _save24hChange(id, currentClose) {
  try {
    const ref24 = _openPrice24h[id];
    if (!ref24 || !ref24.price) return;

    const change = ((currentClose - ref24.price) / ref24.price) * 100;
    db.ref(`otc_change/${id}`).set({
      change:    Number(change.toFixed(3)),
      updatedAt: Date.now(),
    }).catch(() => {});
  } catch (e) {}
}

// 24h আগের candle load করো — init এর সময় একবার
async function _load24hOpenPrice(id) {
  try {
    const now24hAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const snap = await db.ref(`otc_candles/${id}/candles`)
      .orderByChild('time')
      .startAt(now24hAgo)
      .limitToFirst(1)
      .once('value');

    if (snap.exists()) {
      const candle = Object.values(snap.val())[0];
      _openPrice24h[id] = { price: candle.open || candle.close, time: candle.time };
    }
  } catch (e) {}
}

// প্রতি ঘণ্টায় 24h reference update করো
setInterval(() => {
  _activeMarkets.forEach(id => {
    _load24hOpenPrice(id);
  });
}, 60 * 60 * 1000);

// ── Firebase helpers ──────────────────────────────────────
async function fetchBinancePrice(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    return parseFloat((await r.json()).price) || 0;
  } catch { return 0; }
}

async function loadLastCandle(id) {
  try {
    const snap = await db.ref(`otc_candles/${id}/candles`).orderByKey().limitToLast(1).once('value');
    if (snap.exists()) return Object.values(snap.val())[0];
  } catch {}
  return null;
}

function saveCandle(id, candle) {
  db.ref(`otc_candles/${id}/candles`).push(candle)
    .then(() => {
      console.log(`[${id}] candle close=${candle.close.toFixed(5)}`);
      // Candle close হলে 24h change update করো
      _save24hChange(id, candle.close);
    })
    .catch(e => console.error(`[${id}] save failed:`, e.message));
}

function saveLiveCandle(id, candle) {
  db.ref(`otc_candles/${id}/live`).set(candle).catch(() => {});
}

function saveSubCandle(id, label, candle) {
  db.ref(`subcandles_${label}/${id}/candles`).push(candle)
    .catch(e => console.error(`[${id}][${label}] sub save failed:`, e.message));
}

function saveLiveSubCandle(id, label, candle) {
  db.ref(`subcandles_${label}/${id}/live`).set(candle).catch(() => {});
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
  db.ref(`otc_controls/${id}`).on('value', snap => {
    if (snap.exists()) _controls[id] = { ..._controls[id], ...snap.val() };
  });

  const now = Date.now(), start = Math.floor(now/CANDLE_MS)*CANDLE_MS;

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
    subStates,
  };
  _activeMarkets.add(id);

  // 24h open price load করো
  await _load24hOpenPrice(id);

  console.log(`[${id}] OTC started @ ${price.toFixed(4)}`);
}

function tickOTC(id) {
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
    // trade.expiryTimestamp = candle close time (= next candle's open time), candleTime এ candle open time থাকে
    const closedCandleTime  = state.nextCandle / 1000;
    const closedCandleClose = state.price;
    saveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.price });
    // /live কে সাথে সাথে closed candle-এর final value দিয়ে আপডেট করো (null না) — client তাৎক্ষণিকভাবে সঠিক close পাবে
    db.ref(`otc_candles/${id}/live`).set({ time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.price, nextCandle:state.nextCandle }).catch(()=>{});

    // ── candle just closed — এই মুহূর্তের close price দিয়ে matching live trades settle করো ──
    // Synchronously mark — একই tick-এ _settleDueTradesFromMemory এই symbol skip করবে
    _candleSettlingSymbols.add(id);
    settleTradesForCandle(id, closedCandleTime, closedCandleClose).catch(() => {
      _candleSettlingSymbols.delete(id);
    });

    state.candleTime = state.nextCandle/1000; state.candleOpen = state.price;
    state.candleHigh = state.price; state.candleLow = state.price;
    state.nextCandle += CANDLE_MS;
    while (state.nextCandle <= now) { state.candleTime = state.nextCandle/1000; state.nextCandle += CANDLE_MS; }
  } else {
    saveLiveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.price, nextCandle:state.nextCandle });
  }

  for (const { label } of SUB_INTERVALS) {
    const ss = state.subStates[label];
    if (!ss) continue;
    if (state.price > ss.candleHigh) ss.candleHigh = state.price;
    if (state.price < ss.candleLow)  ss.candleLow  = state.price;
    if (now >= ss.nextCandle) {
      saveSubCandle(id, label, { time:ss.candleTime, open:ss.candleOpen, high:ss.candleHigh, low:ss.candleLow, close:state.price });
      db.ref(`subcandles_${label}/${id}/live`).set(null).catch(() => {});
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
// ══════════════════════════════════════════════════════════
let _tdWS    = null;
let _tdReady = false;

function _startSharedTdWS() {
  if (_tdWS && (_tdWS.readyState === 0 || _tdWS.readyState === 1)) return;
  let WS;
  try { WS = require('ws'); } catch (e) {
    console.warn('[TD-WS] ws package not found');
    return;
  }
  _tdWS    = new WS(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${TD_KEY}`);
  _tdReady = false;
  _tdWS.on('open', () => {
    _tdReady = true;
    const allSymbols = Object.values(TD_MAP).join(',');
    _tdWS.send(JSON.stringify({ action:'subscribe', params:{ symbols: allSymbols } }));
    console.log(`[TD-WS] Connected & subscribed: ${allSymbols}`);
  });
  _tdWS.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'heartbeat' || msg.event === 'subscribe-status') return;
      if (!msg.price || isNaN(parseFloat(msg.price))) return;
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
    db.ref(`otc_status/${id}`).set({ enabled:false, reason:'market_closed' }).catch(()=>{});
    console.log(`[${id}] Forex market closed`);
    return;
  }
  db.ref(`otc_status/${id}`).set({ enabled:true }).catch(()=>{});
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
  _controls[id] = { mode:'auto', nextDirection:'auto' };
  db.ref(`otc_controls/${id}`).on('value', snap => {
    if (snap.exists()) _controls[id] = { ..._controls[id], ...snap.val() };
  });
  db.ref(`otc_trade_stats/${id}`).on('value', snap => {
    _tradeStats[id] = snap.exists() ? snap.val() : {};
  });
  const now = Date.now(), start = Math.floor(now/CANDLE_MS)*CANDLE_MS;
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

  // 24h open price load করো
  await _load24hOpenPrice(id);

  console.log(`[${id}] Forex started @ ${lastClose}`);
  if (_tdWS && _tdWS.readyState === 1 && _tdReady) {
    _tdWS.send(JSON.stringify({ action:'subscribe', params:{ symbols: TD_MAP[id] } }));
  } else {
    _startSharedTdWS();
  }
}

function tickForex(id) {
  const state = _states[id];
  if (!state || state.type !== 'forex') return;
  if (!isForexOpen()) {
    stopSymbol(id);
    db.ref(`otc_status/${id}`).set({ enabled:false, reason:'market_closed' }).catch(()=>{});
    return;
  }
  const now       = Date.now();
  const ctrl      = _controls[id] || {};
  const realPrice = _forexPrices[id] || state.price;
  if (!realPrice || realPrice <= 0) return;
  let price = realPrice;
  if (ctrl.mode === 'manual') {
    const dir = ctrl.nextDirection;
    const v   = realPrice * 0.000025;
    if (dir === 'up')        price = realPrice + v*(0.5+Math.random()*0.5);
    else if (dir === 'down') price = realPrice - v*(0.5+Math.random()*0.5);
  } else if (ctrl.mode === 'trade-based') {
    const stats = _tradeStats[id] || {};
    const up    = parseFloat(stats.upAmount)   || 0;
    const down  = parseFloat(stats.downAmount) || 0;
    const v     = realPrice * 0.000025;
    if (up > down*1.2)    price = realPrice - v*(0.5+Math.random()*0.5);
    else if (down>up*1.2) price = realPrice + v*(0.5+Math.random()*0.5);
  }
  state.price = price;
  if (price > state.candleHigh) state.candleHigh = price;
  if (price < state.candleLow)  state.candleLow  = price;
  if (now >= state.nextCandle) {
    // trade.expiryTimestamp = candle close time (= next candle's open time), candleTime এ candle open time থাকে
    const closedCandleTime  = state.nextCandle / 1000;
    const closedCandleClose = price;
    saveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:price });
    // /live কে সাথে সাথে closed candle-এর final value দিয়ে আপডেট করো (null না) — client তাৎক্ষণিকভাবে সঠিক close পাবে
    db.ref(`otc_candles/${id}/live`).set({ time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:price, nextCandle:state.nextCandle }).catch(()=>{});

    // ── candle just closed — এই মুহূর্তের close price দিয়ে matching live trades settle করো ──
    // Synchronously mark — একই tick-এ _settleDueTradesFromMemory এই symbol skip করবে
    _candleSettlingSymbols.add(id);
    settleTradesForCandle(id, closedCandleTime, closedCandleClose).catch(() => {
      _candleSettlingSymbols.delete(id);
    });

    state.candleTime = state.nextCandle/1000; state.candleOpen = price;
    state.candleHigh = price; state.candleLow = price;
    state.nextCandle += CANDLE_MS;
    while (state.nextCandle <= now) { state.candleTime = state.nextCandle/1000; state.nextCandle += CANDLE_MS; }
  } else {
    saveLiveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:price, nextCandle:state.nextCandle });
  }
  for (const { label } of SUB_INTERVALS) {
    const ss = state.subStates[label];
    if (!ss) continue;
    if (price > ss.candleHigh) ss.candleHigh = price;
    if (price < ss.candleLow)  ss.candleLow  = price;
    if (now >= ss.nextCandle) {
      saveSubCandle(id, label, { time:ss.candleTime, open:ss.candleOpen, high:ss.candleHigh, low:ss.candleLow, close:price });
      db.ref(`subcandles_${label}/${id}/live`).set(null).catch(() => {});
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
  delete _openPrice24h[id];
  db.ref(`otc_candles/${id}/live`).set(null).catch(()=>{});
  for (const { label } of SUB_INTERVALS) {
    db.ref(`subcandles_${label}/${id}/live`).set(null).catch(() => {});
  }
  console.log(`[${id}] stopped`);
}

function watchFirestoreMarkets() {
  firestore.collection('markets').onSnapshot(snap => {
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
        db.ref(`otc_status/${id}`).set({ enabled:false, reason:'market_closed' }).catch(()=>{});
      }
    });
  }
}, 60_000);

async function main() {
  console.log('GoldVest Server starting (Admin SDK)...');
  watchFirestoreMarkets();
  await _recoverLiveTradesFromRTDB();
  _startActiveTradesShadowListener();
  setInterval(() => {
    _activeMarkets.forEach(id => {
      if (_states[id]?.type === 'otc')   tickOTC(id);
      if (_states[id]?.type === 'forex') tickForex(id);
    });
    _settleDueTradesFromMemory().catch(e => console.error('[tick-settle] error:', e.message));
    _settleDueTradesFromRTDB().catch(e => console.error('[rtdb-tick-settle] error:', e.message));
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
  fetch('https://goldvest-otc-worker-production.up.railway.app/')
    .then(() => console.log('[ping] OK'))
    .catch(() => {});
}, 8*60*1000);








