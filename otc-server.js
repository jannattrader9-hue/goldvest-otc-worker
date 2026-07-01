// ============================================================
// otc-server.js — OTC + Forex Candle Generator (Admin SDK)
// OTC → Synthetic (Binance base)
// Forex → Twelve Data WebSocket (EUR/USD, GBP/USD only)
// ============================================================

const admin = require('firebase-admin');
const pLimit = require('p-limit');
const Redis  = require('ioredis');
const crypto = require('crypto');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential:  admin.credential.cert(serviceAccount),
    databaseURL: "https://goldvest-cf73d-default-rtdb.firebaseio.com"
});

const db        = admin.database();
const firestore = admin.firestore();

// ── NOWPayments crypto currencies cache ──
let _cryptoCurrenciesCache = null;
let _cryptoCurrenciesCacheTime = 0;

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

const TICK_MS   = 200;
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
const SETTLE_TOKEN        = process.env.SETTLE_TOKEN;

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

  // ── live_market_stats: settled trades remove করো ──
  try {
    let upDec = 0, downDec = 0, upAmt = 0, downAmt = 0;
    let hasTypeInfo = false;
    trades.forEach(t => {
      if (t.type) { hasTypeInfo = true; }
      if (t.type === 'up')   { upDec++;   upAmt   += t.amount || 0; }
      else if (t.type === 'down') { downDec++; downAmt += t.amount || 0; }
    });
    if (hasTypeInfo) {
      db.ref('live_market_stats/' + symbol).transaction(curr => {
        if (!curr) return curr;
        curr.up         = Math.max(0, (curr.up         || 0) - upDec);
        curr.down       = Math.max(0, (curr.down       || 0) - downDec);
        curr.upAmount   = Math.max(0, (curr.upAmount   || 0) - upAmt);
        curr.downAmount = Math.max(0, (curr.downAmount || 0) - downAmt);
        if ((curr.up || 0) <= 0 && (curr.down || 0) <= 0) return null;
        return curr;
      }).catch(() => {});

      // ── otc_trade_stats decrement — trade-based mode এর জন্য ──
      db.ref(`otc_trade_stats/${symbol}`).transaction(curr => {
        if (!curr) return curr;
        curr.upAmount     = Math.max(0, (curr.upAmount     || 0) - upAmt);
        curr.downAmount   = Math.max(0, (curr.downAmount   || 0) - downAmt);
        curr.upCount      = Math.max(0, (curr.upCount      || 0) - upDec);
        curr.downCount    = Math.max(0, (curr.downCount    || 0) - downDec);
        curr.totalExposure = Math.max(0, (curr.totalExposure || 0) - upAmt - downAmt);
        curr.updatedAt    = Date.now();
        return curr;
      }).catch(() => {});
    } else {
      db.ref('live_market_stats/' + symbol).remove().catch(() => {});
    }
  } catch (e) {}

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
          trades.push({ userId, tradeId: tradeNode.key, closePrice, type: t.type || '', amount: t.amount || 0 });
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

// ── Exposure Protection — cache ──────────────────────────
let _exposureConfig         = { enabled: false, threshold: 6 };
let _exposureConfigLoadTime = 0;
const _userDepositCache     = new Map(); // userId → { totalDeposits, loadTime }
const _userTradeDir         = new Map(); // userId → 'up' | 'down' (last trade)

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
    bySymbol.get(t.symbol).trades.push({ userId: t.userId, tradeId: t.tradeId, closePrice: state.price, type: t.type || '', amount: t.amount || 0 });
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
          bySymbol.get(t.symbol).trades.push({ userId, tradeId: tradeNode.key, closePrice: state.price, expiryTimestamp, type: t.type || '', amount: t.amount || 0 });
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
// ── Exposure Protection — bias calculator ────────────────
// Firestore exposure_config ৬০s cache করে পড়ে।
// Active trades এর user দের balance/deposit ratio check করে।
// threshold x+ হলে সেই user এর direction এর বিপরীতে subtle bias return করে।
// tickOTC() এ price calculation এ যোগ হয় — settlement logic ছোঁয় না।
async function _loadExposureConfig() {
  const now = Date.now();
  if (now - _exposureConfigLoadTime < 60000) return; // 60s cache
  try {
    const snap = await firestore.collection('settings').doc('exposure_config').get();
    if (snap.exists) {
      const d = snap.data();
      _exposureConfig = {
        enabled:   d.enabled   ?? false,
        threshold: d.threshold ?? 6,
      };
    }
    _exposureConfigLoadTime = now;
  } catch(e) {}
}

async function _getUserTotalDeposits(userId) {
  const cached = _userDepositCache.get(userId);
  if (cached && Date.now() - cached.loadTime < 300000) return cached.totalDeposits; // 5m cache
  try {
    const snap = await firestore.collection('users').doc(userId).get();
    const totalDeposits = snap.exists ? (snap.data().totalDeposits || 0) : 0;
    _userDepositCache.set(userId, { totalDeposits, loadTime: Date.now() });
    return totalDeposits;
  } catch(e) {
    return 0;
  }
}

async function _getExposureBias(userId, currentBalFloat) {
  if (!_exposureConfig.enabled) return 0;
  const totalDeposits = await _getUserTotalDeposits(userId);
  if (!totalDeposits || totalDeposits <= 0) return 0;
  const ratio = currentBalFloat / totalDeposits;
  if (ratio < _exposureConfig.threshold) return 0;
  // threshold পার করেছে — user এর last trade direction এর বিপরীতে bias
  const dir = _userTradeDir.get(userId);
  if (!dir) return 0;
  return dir === 'up' ? -1 : 1; // -1 = price down bias, +1 = price up bias
}

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

  _controls[id] = { mode:'trade-based', nextDirection:'auto', volatility:'medium', trendStrength:0.6, speedMultiplier:1.0 };
  db.ref(`otc_controls/${id}`).on('value', snap => {
    if (snap.exists()) _controls[id] = { ..._controls[id], ...snap.val() };
  });
  // trade-based mode এর জন্য — Forex engine এ যেভাবে আছে, OTC তেও same pattern
  db.ref(`otc_trade_stats/${id}`).on('value', snap => {
    _tradeStats[id] = snap.exists() ? snap.val() : {};
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
    momentum: 0,
    subStates,
  };
  _activeMarkets.add(id);

  // 24h open price load করো
  await _load24hOpenPrice(id);

  console.log(`[${id}] OTC started @ ${price.toFixed(4)}`);
}

// ── Smooth noise (Perlin-like) — pure Math, no library ──────────────────────
function _smoothNoise(t) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f); // smoothstep
  const a = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  const b = Math.sin((i+1) * 127.1 + 311.7) * 43758.5453;
  return (a - Math.floor(a)) * (1 - u) + (b - Math.floor(b)) * u;
}

// ── Market State Machine ─────────────────────────────────────────────────────
// State গুলো: ranging, uptrend, downtrend, pullback_up, pullback_down, breakout_up, breakout_down
const MARKET_STATES = ['ranging', 'uptrend', 'downtrend', 'pullback_up', 'pullback_down', 'breakout_up', 'breakout_down'];

function _nextMarketState(current) {
  const r = Math.random();
  switch (current) {
    case 'ranging':       return r < 0.35 ? 'breakout_up' : r < 0.70 ? 'breakout_down' : r < 0.85 ? 'uptrend' : 'downtrend';
    case 'uptrend':       return r < 0.45 ? 'uptrend' : r < 0.75 ? 'pullback_up' : r < 0.90 ? 'ranging' : 'downtrend';
    case 'downtrend':     return r < 0.45 ? 'downtrend' : r < 0.75 ? 'pullback_down' : r < 0.90 ? 'ranging' : 'uptrend';
    case 'pullback_up':   return r < 0.60 ? 'uptrend' : r < 0.85 ? 'ranging' : 'downtrend';
    case 'pullback_down': return r < 0.60 ? 'downtrend' : r < 0.85 ? 'ranging' : 'uptrend';
    case 'breakout_up':   return r < 0.65 ? 'uptrend' : r < 0.85 ? 'pullback_up' : 'ranging';
    case 'breakout_down': return r < 0.65 ? 'downtrend' : r < 0.85 ? 'pullback_down' : 'ranging';
    default:              return 'ranging';
  }
}

function _stateDuration(s) {
  // tick count (200ms each)
  switch (s) {
    case 'ranging':       return 20 + Math.floor(Math.random() * 40); // 4–12s
    case 'uptrend':       return 15 + Math.floor(Math.random() * 35); // 3–10s
    case 'downtrend':     return 15 + Math.floor(Math.random() * 35);
    case 'pullback_up':   return  8 + Math.floor(Math.random() * 12); // 1.6–4s
    case 'pullback_down': return  8 + Math.floor(Math.random() * 12);
    case 'breakout_up':   return  5 + Math.floor(Math.random() * 10); // 1–3s
    case 'breakout_down': return  5 + Math.floor(Math.random() * 10);
    default:              return 20;
  }
}

function _stateBias(s) {
  // direction bias: +1 up, -1 down, 0 neutral
  switch (s) {
    case 'uptrend':       return  0.7;
    case 'downtrend':     return -0.7;
    case 'pullback_up':   return -0.4;
    case 'pullback_down': return  0.4;
    case 'breakout_up':   return  1.2;
    case 'breakout_down': return -1.2;
    default:              return  0.0; // ranging
  }
}

function tickOTC(id) {
  const state = _states[id];
  if (!state || state.type !== 'otc') return;
  const ctrl    = _controls[id] || {};
  const volMul  = { low:0.5, medium:1.0, high:1.8 }[ctrl.volatility] || 1.0;
  const speed   = ctrl.speedMultiplier || 1.0;
  const now     = Date.now();

  // ── Base volatility — price এর ০.০২% per tick ──────────────────────────
  const v = state.price * 0.0002 * volMul;

  // ── Noise counter (smooth noise seed) ───────────────────────────────────
  if (!state._noiseSeed) state._noiseSeed = Math.random() * 1000;
  state._noiseSeed += 0.15;

  // ── Market State Machine ─────────────────────────────────────────────────
  if (!state.marketState) {
    state.marketState     = 'ranging';
    state.marketStateTick = _stateDuration('ranging');
  }
  state.marketStateTick--;
  if (state.marketStateTick <= 0) {
    state.marketState     = _nextMarketState(state.marketState);
    state.marketStateTick = _stateDuration(state.marketState);
  }

  // ── Velocity model ───────────────────────────────────────────────────────
  if (!state.velocity)     state.velocity     = 0;
  if (!state.acceleration) state.acceleration = 0;

  // ── Trade/Manual/Auto mode — direction bias ──────────────────────────────
  let directionBias = 0;

  if (!ctrl.mode || ctrl.mode === 'auto') {
    // State machine controls direction
    directionBias = _stateBias(state.marketState);
  } else if (ctrl.mode === 'manual') {
    directionBias = ctrl.nextDirection === 'up' ? 1.5 : ctrl.nextDirection === 'down' ? -1.5 : 0;
  } else if (ctrl.mode === 'trade-based') {
    const stats = _tradeStats[id] || {};
    const up    = parseFloat(stats.upAmount)  || 0;
    const down  = parseFloat(stats.downAmount) || 0;
    // State machine চলবে normally, শুধু close এ subtle push
    directionBias = _stateBias(state.marketState);
    // Trade direction store করো close push এর জন্য
    if (up > down * 1.1)       state.trend = -1;
    else if (down > up * 1.1)  state.trend =  1;
    else                       state.trend =  0;
  }

  // ── Smooth noise (Perlin-like) ────────────────────────────────────────────
  const noise1 = (_smoothNoise(state._noiseSeed * 0.3) - 0.5) * 2;
  const noise2 = (_smoothNoise(state._noiseSeed * 1.2) - 0.5) * 2;
  const noise3 = (_smoothNoise(state._noiseSeed * 4.0) - 0.5) * 2;
  const smoothNoise = noise1 * 0.5 + noise2 * 0.35 + noise3 * 0.15;

  // ── Micro pullback + breathing ────────────────────────────────────────────
  // প্রতি tick এ move না — pause এবং micro correction থাকবে
  if (!state._microTick) state._microTick = 0;
  state._microTick++;

  // Breathing pattern — 3 tick up, 1 tick micro down, 1 tick pause
  const microPhase = state._microTick % 5;
  let microFactor = 1.0; // normal move
  if (microPhase === 3) {
    // micro correction — direction এর বিপরীতে ছোট move
    microFactor = -0.3;
  } else if (microPhase === 4) {
    // pause — প্রায় কোনো movement নেই
    microFactor = 0.05;
  }

  // ── Dynamic Support / Resistance ─────────────────────────────────────────
  if (!state.srHigh) state.srHigh = state.price * 1.003;
  if (!state.srLow)  state.srLow  = state.price * 0.997;
  if (!state.srTick) state.srTick = 0;
  state.srTick++;
  if (state.srTick % 30 === 0) {
    state.srHigh = state.srHigh * 0.997 + state.candleHigh * 0.003;
    state.srLow  = state.srLow  * 0.997 + state.candleLow  * 0.003;
  }

  // ── Mean reversion (Ornstein-Uhlenbeck) ──────────────────────────────────
  const midPoint  = (state.srHigh + state.srLow) / 2;
  const rangeSize = Math.max(state.srHigh - state.srLow, v * 2);
  const deviation = (state.price - midPoint) / (rangeSize * 0.5);
  const meanReversionForce = -deviation * v * 0.4;

  // ── Trade-based mode — candle শেষ ৭s এ very subtle drift ────────────────
  const timeToNextCandle = state.nextCandle ? (state.nextCandle - now) : 99999;
  let closePush = 0;
  if (ctrl.mode === 'trade-based' && state.trend !== 0 && timeToNextCandle <= 7000) {
    closePush = -state.trend * v * 0.12;
  }

  // ── Velocity + Acceleration ───────────────────────────────────────────────
  const targetVelocity = (directionBias * v * 0.35) + (smoothNoise * v * 0.55);
  state.acceleration   = (targetVelocity - state.velocity) * 0.20;
  state.velocity       = state.velocity * 0.80 + state.acceleration;
  const maxV           = v * 2.5;
  state.velocity       = Math.max(-maxV, Math.min(maxV, state.velocity));

  // ── Final price update — microFactor দিয়ে breathing apply ───────────────
  const delta = (state.velocity * microFactor + meanReversionForce + closePush) * speed;
  state.price = Math.max(state.price + delta, 0.0001);
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
  _controls[id] = { mode:'trade-based', nextDirection:'auto' };
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
    if (up > down*1.1)    price = realPrice - v*(0.5+Math.random()*0.5);
    else if (down>up*1.1) price = realPrice + v*(0.5+Math.random()*0.5);
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
  await _loadExposureConfig();
  _startActiveTradesShadowListener();

  // ── Variable tick timing — natural feel (80ms–350ms random interval) ──────
  // Fixed interval এর বদলে setTimeout loop — প্রতিবার নতুন random delay
  function _scheduleNextTick() {
    const baseMs = 150; // average tick
    const jitter = Math.floor(Math.random() * 200) - 100; // ±100ms
    const delay  = Math.max(80, baseMs + jitter); // 80ms minimum
    setTimeout(() => {
      _activeMarkets.forEach(id => {
        if (_states[id]?.type === 'otc')   tickOTC(id);
        if (_states[id]?.type === 'forex') tickForex(id);
      });
      _scheduleNextTick();
    }, delay);
  }
  _scheduleNextTick();

  // Settlement — fixed 200ms (trade settle কে affect করব না)
  setInterval(() => {
    _settleDueTradesFromMemory().catch(e => console.error('[tick-settle] error:', e.message));
    _settleDueTradesFromRTDB().catch(e => console.error('[rtdb-tick-settle] error:', e.message));
  }, 200);

  console.log('Server running ✅');
}
main().catch(console.error);

const http = require('http');

// ── /place-trade helper — body parse ──────────────────────
function _readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

const BAL_KEY_OTC   = (uid) => `gv:bal:${uid}`;
const TRADE_KEY_OTC = (tid) => `gv:trade:${tid}`;

http.createServer(async (req, res) => {
  // CORS — client fetch করতে পারবে
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET / — health check ──────────────────────────────
  if (req.method === 'GET' && req.url === '/') {
    const otc   = [..._activeMarkets].filter(id => _states[id]?.type === 'otc');
    const forex = [..._activeMarkets].filter(id => _states[id]?.type === 'forex');
    res.writeHead(200);
    res.end(`GoldVest ✅\nOTC: ${otc.join(',')||'none'}\nForex: ${forex.join(',')||'none'}`);
    return;
  }

  // ── GET /reset-candle-prices — RTDB এ corrupt OTC candle price reset করো ──
  // SETTLE_TOKEN দিয়ে authenticate
  if (req.method === 'GET' && req.url?.startsWith('/reset-candle-prices')) {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (token !== SETTLE_TOKEN) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    // Symbol → real price mapping
    const PRICE_MAP = {
      'BTCOTC':     async () => { const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'); const d = await r.json(); return parseFloat(d.price); },
      'ETHOTC':     async () => { const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT'); const d = await r.json(); return parseFloat(d.price); },
      'BNBOTC':     async () => { const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT'); const d = await r.json(); return parseFloat(d.price); },
      'SOLOTC':     async () => { const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT'); const d = await r.json(); return parseFloat(d.price); },
      'EURUSDOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/EUR'); const d = await r.json(); return d.rates?.USD || 1.08; },
      'GBPUSDOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/GBP'); const d = await r.json(); return d.rates?.USD || 1.27; },
      'EURGBPOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/EUR'); const d = await r.json(); return d.rates?.GBP || 0.84; },
      'USDJPYOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.JPY || 150; },
      'EURJPYOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/EUR'); const d = await r.json(); return d.rates?.JPY || 162; },
      'GBPJPYOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/GBP'); const d = await r.json(); return d.rates?.JPY || 190; },
      'AUDUSDOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/AUD'); const d = await r.json(); return d.rates?.USD || 0.65; },
      'AUDNZDOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/AUD'); const d = await r.json(); return d.rates?.NZD || 1.08; },
      'EURAUDOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/EUR'); const d = await r.json(); return d.rates?.AUD || 1.65; },
      'EURNZDOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/EUR'); const d = await r.json(); return d.rates?.NZD || 1.78; },
      'NZDUSDOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/NZD'); const d = await r.json(); return d.rates?.USD || 0.60; },
      'NZDJPYOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/NZD'); const d = await r.json(); return d.rates?.JPY || 90; },
      'USDCADOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.CAD || 1.36; },
      'CADCHFOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/CAD'); const d = await r.json(); return d.rates?.CHF || 0.65; },
      'USDCHFOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.CHF || 0.89; },
      'INRUSDOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/INR'); const d = await r.json(); return d.rates?.USD || 0.012; },
      'USDARSOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.ARS || 900; },
      'USDBRLOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.BRL || 5.0; },
      'USDMXNOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.MXN || 17; },
      'MXNUSDOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/MXN'); const d = await r.json(); return d.rates?.USD || 0.058; },
      'CNYJPYOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/CNY'); const d = await r.json(); return d.rates?.JPY || 21; },
      'USDIDROTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.IDR || 15600; },
      'USDNGNOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.NGN || 1550; },
      'USDPKROTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.PKR || 278; },
      'USDPHPOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.PHP || 56; },
      'USDEGPOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.EGP || 30; },
      'USDCOPOTC':  async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.COP || 4000; },
      'USDTBDT':    async () => { const r = await fetch('https://open.er-api.com/v6/latest/USD'); const d = await r.json(); return d.rates?.BDT || 110; },
    };

    const results = [];
    for (const id of _activeMarkets) {
      const state = _states[id];
      if (!state || state.type !== 'otc') continue;
      try {
        let newPrice = null;

        // Price map থেকে নাও
        if (PRICE_MAP[id]) {
          try { newPrice = await PRICE_MAP[id](); } catch(e) {}
        }

        // Fallback — Firestore initialPrice
        if (!newPrice) {
          const mSnap = await firestore.collection('markets').doc(id).get();
          if (mSnap.exists && mSnap.data().initialPrice) {
            newPrice = parseFloat(mSnap.data().initialPrice);
          }
        }

        if (!newPrice || newPrice <= 0) { results.push(`${id}: skip (no price)`); continue; }

        // ⚠️ RTDB candle history DELETE করা হচ্ছে না — শুধু in-memory state reset
        // State reset — server এর current price ঠিক করো
        state.price      = newPrice;
        state.candleOpen = newPrice;
        state.candleHigh = newPrice;
        state.candleLow  = newPrice;
        state.momentum   = 0;
        state.trend      = 0;
        const now = Date.now();
        state.candleTime = Math.floor(now / 60000) * 60;
        state.nextCandle = (state.candleTime + 60) * 1000;

        results.push(`${id}: reset to ${newPrice}`);
        console.log(`[reset] ${id} price reset to ${newPrice}`);
      } catch(e) {
        results.push(`${id}: error ${e.message}`);
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(results.join('\n'));
    return;
  }

  // ── POST /place-trade ─────────────────────────────────
  if (req.method === 'POST' && req.url === '/place-trade') {
    try {
      // 1. Body parse
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, trade } = body;
      if (!idToken || !trade) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Missing idToken or trade' })); return;
      }

      // 2. Firebase Auth token verify — server side security
      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }

      const userId  = decoded.uid;
      const amount  = parseFloat(trade.amount);
      const tradeId = trade.firestoreId;

      if (!tradeId || !amount || amount <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid trade data' })); return;
      }

      // Max trade amount — $1000 per trade
      const MAX_TRADE_AMOUNT = 1000;
      if (amount > MAX_TRADE_AMOUNT) {
        res.writeHead(400); res.end(JSON.stringify({ error: `Maximum trade amount is $${MAX_TRADE_AMOUNT}` })); return;
      }

      // 3. Redis balance check + atomic deduct
      const balKey = BAL_KEY_OTC(userId);
      let currentBal = await redisPub.get(balKey);

      if (currentBal === null) {
        // Redis miss — Firestore থেকে load করে cache করো
        const snap = await firestore.collection('users').doc(userId).get();
        const bal  = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600);
        currentBal = bal.toString();
      }

      const balFloat = parseFloat(currentBal);
      if (balFloat < amount) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Insufficient balance', balance: balFloat })); return;
      }

      // Atomic deduct — race condition safe
      const newBal = await redisPub.incrbyfloat(balKey, -amount);
      await redisPub.expire(balKey, 3600);
      await redisPub.set(`gv:bal:dirty:${userId}`, '1', 'EX', 3600);

      console.log(`[place-trade] userId=${userId} tradeId=${tradeId} amount=${amount} newBal=${newBal}`);

      // ── Exposure Protection — user এর last trade direction save ──
      if (trade.type === 'up' || trade.type === 'down') {
        _userTradeDir.set(userId, trade.type);
      }

      // ── Trade Stats update — trade-based mode এর জন্য ──
      const symbol = trade.symbol || '';
      if (symbol && (trade.type === 'up' || trade.type === 'down')) {
        const statsRef = db.ref(`otc_trade_stats/${symbol}`);
        const field = trade.type === 'up' ? 'upAmount' : 'downAmount';
        const countField = trade.type === 'up' ? 'upCount' : 'downCount';
        statsRef.transaction(curr => {
          if (!curr) curr = { upAmount: 0, downAmount: 0, upCount: 0, downCount: 0, totalExposure: 0 };
          curr[field]       = (curr[field]       || 0) + amount;
          curr[countField]  = (curr[countField]  || 0) + 1;
          curr.totalExposure = (curr.totalExposure || 0) + amount;
          curr.updatedAt    = Date.now();
          return curr;
        }).catch(e => console.warn('[trade-stats] update failed:', e.message));
      }

      // 4a. Firestore থেকে market এর real payout নাও — client value বিশ্বাস করা হচ্ছে না
      let verifiedPayout = 92; // safe fallback
      try {
        const mSnap = await firestore.collection('markets').doc(trade.symbol || '').get();
        if (mSnap.exists) {
          const mData = mSnap.data();
          const duration = parseFloat(trade.duration || 0);
          // 5 মিনিট (300s) বা তার বেশি হলে payout5, না হলে payout
          verifiedPayout = (duration >= 300 && mData.payout5)
            ? mData.payout5
            : (mData.payout || 92);
        }
      } catch(e) {
        console.warn('[place-trade] market payout fetch failed, using fallback:', e.message);
      }

      // 4. Redis Hash এ trade data save — settler <1ms এ পাবে
      await redisPub.hset(TRADE_KEY_OTC(tradeId),
        'userId',          userId,
        'symbol',          trade.symbol || '',
        'entryPrice',      String(trade.entryPrice || 0),
        'amount',          String(amount),
        'type',            trade.type || '',
        'payoutPercent',   String(verifiedPayout), // Firestore verified — client value ignore
        'status',          'live',
        'accountType',     'live',
        'expiryTimestamp', String(trade.expiryTimestamp || 0),
        'currency',        trade.currency || 'USD',
      );
      await redisPub.expire(TRADE_KEY_OTC(tradeId), 7200); // 2h TTL

      // 5. RTDB settlement_queue write — otc-server candle close এ এখান থেকে পাবে
      db.ref(`settlement_queue/${trade.expiryTimestamp}/${userId}/${tradeId}`).set({
        userId, tradeId,
        symbol:      trade.symbol || '',
        accountType: 'live',
        type:        trade.type || '',
        amount:      amount,
        feedType:    trade.feedType || '',
        entryPrice:  trade.entryPrice || 0,
      }).catch(e => console.error('[place-trade] RTDB queue failed:', e.message));

      // 6. Firestore trade save — background, non-blocking
      firestore.collection('users').doc(userId).collection('trades').doc(tradeId).set({
        ...trade,
        userId,
        tradeLine:  null,
        createdAt:  admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => console.error('[place-trade] Firestore save failed:', e.message));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));

    } catch(e) {
      console.error('[place-trade] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── POST /withdraw-deduct ─────────────────────────────────
  // User নিজের withdraw request submit করলে এই endpoint call হয়।
  // adminSecret নেই — Firebase idToken দিয়ে user authenticate করা হয়।
  // uid client থেকে আসে না — token থেকে নেওয়া হয় (tamper-proof)।
  if (req.method === 'POST' && req.url === '/withdraw-deduct') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, amount } = body;

      if (!idToken || !amount || parseFloat(amount) <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Missing fields' })); return;
      }

      // idToken verify — uid token থেকে নেওয়া হচ্ছে, client-এর uid বিশ্বাস করা হচ্ছে না
      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      const uid = decoded.uid;

      const deductAmt = parseFloat(amount);
      const balKey = BAL_KEY_OTC(uid);

      // Redis miss হলে Firestore থেকে load
      let currentBal = await redisPub.get(balKey);
      if (currentBal === null) {
        const snap = await firestore.collection('users').doc(uid).get();
        const bal  = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600);
        currentBal = bal.toString();
      }

      const balFloat = parseFloat(currentBal);
      if (balFloat < deductAmt) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Insufficient balance', balance: balFloat })); return;
      }

      // Atomic deduct
      const newBal = await redisPub.incrbyfloat(balKey, -deductAmt);
      await redisPub.expire(balKey, 3600);
      await redisPub.set(`gv:bal:dirty:${uid}`, '1', 'EX', 3600);

      console.log(`[withdraw-deduct] uid=${uid} amount=${deductAmt} newBal=${newBal}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));

    } catch(e) {
      console.error('[withdraw-deduct] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── POST /admin-deduct ────────────────────────────────────
  if (req.method === 'POST' && req.url === '/admin-deduct') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { uid, amount, adminSecret } = body;

      // Admin secret check
      if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }

      if (!uid || !amount || parseFloat(amount) <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid uid or amount' })); return;
      }

      const deductAmt = parseFloat(amount);
      const balKey = BAL_KEY_OTC(uid);

      // Redis miss হলে Firestore থেকে load
      let currentBal = await redisPub.get(balKey);
      if (currentBal === null) {
        const snap = await firestore.collection('users').doc(uid).get();
        const bal  = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600);
        currentBal = bal.toString();
      }

      const balFloat = parseFloat(currentBal);
      if (balFloat < deductAmt) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Insufficient balance', balance: balFloat })); return;
      }

      // Atomic deduct
      const newBal = await redisPub.incrbyfloat(balKey, -deductAmt);
      await redisPub.expire(balKey, 3600);
      await redisPub.set(`gv:bal:dirty:${uid}`, '1', 'EX', 3600);

      console.log(`[admin-deduct] uid=${uid} amount=${deductAmt} newBal=${newBal}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));

    } catch(e) {
      console.error('[admin-deduct] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── POST /admin-credit ───────────────────────────────────
  // Admin panel থেকে deposit approve বা withdrawal reject করলে call হয়।
  // adminSecret নেই — Firebase idToken + admin custom claim verify করা হয়।
  if (req.method === 'POST' && req.url === '/admin-credit') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, uid, amount } = body;

      // idToken verify — caller কে authenticate করো
      if (!idToken) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }

      // Admin custom claim check — token.admin === true হলেই allow
      if (!decoded.admin) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden — admin only' })); return;
      }

      if (!uid || !amount || parseFloat(amount) <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid uid or amount' })); return;
      }

      const creditAmt = parseFloat(amount);
      const balKey = BAL_KEY_OTC(uid);

      // Redis miss হলে Firestore থেকে load
      let currentBal = await redisPub.get(balKey);
      if (currentBal === null) {
        const snap = await firestore.collection('users').doc(uid).get();
        const bal  = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600);
      }

      // Atomic credit
      const newBal = await redisPub.incrbyfloat(balKey, creditAmt);
      await redisPub.expire(balKey, 3600);
      await redisPub.set(`gv:bal:dirty:${uid}`, '1', 'EX', 3600);

      console.log(`[admin-credit] uid=${uid} amount=${creditAmt} newBal=${newBal}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));

    } catch(e) {
      console.error('[admin-credit] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── POST /sell-trade ─────────────────────────────────────
  if (req.method === 'POST' && req.url === '/sell-trade') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, tradeId, userId, sellPrice: claimedSellPrice } = body;

      if (!idToken || !tradeId || !userId || !claimedSellPrice) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Missing fields' })); return;
      }

      // idToken verify — user authenticate
      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }

      if (decoded.uid !== userId) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }

      // Redis Hash থেকে trade data নাও — দ্রুত validate (Firestore এর বদলে)
      const TRADE_KEY = `gv:trade:${tradeId}`;
      const hash = await redisPub.hgetall(TRADE_KEY);
      if (!hash || !hash.userId) {
        res.writeHead(404); res.end(JSON.stringify({ error: 'Trade not found' })); return;
      }

      if (hash.userId !== userId) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }

      if (hash.status === 'sold' || hash.status === 'won' || hash.status === 'lost' || hash.status === 'refunded') {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Trade already settled' })); return;
      }

      // sellPrice sanity check — max payout এর বেশি হতে পারবে না
      const tradeAmount = parseFloat(hash.amount || 0);
      const payoutPercent = parseFloat(hash.payoutPercent || 92);
      const maxPossible = tradeAmount + (tradeAmount * payoutPercent / 100);
      const sellPrice = parseFloat(claimedSellPrice);

      if (!sellPrice || sellPrice <= 0 || sellPrice > maxPossible) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid sell price' })); return;
      }

      // Redis এ atomic credit
      const balKey = BAL_KEY_OTC(userId);
      let currentBal = await redisPub.get(balKey);
      if (currentBal === null) {
        const snap = await firestore.collection('users').doc(userId).get();
        const bal = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600);
      }

      const newBal = await redisPub.incrbyfloat(balKey, sellPrice);
      await redisPub.expire(balKey, 3600);
      await redisPub.set(`gv:bal:dirty:${userId}`, '1', 'EX', 3600);
      // Redis Hash এ status 'sold' set করো — settler আর credit করবে না
      await redisPub.hset(`gv:trade:${tradeId}`, 'status', 'sold');

      console.log(`[sell-trade] userId=${userId} tradeId=${tradeId} sellPrice=${sellPrice} newBal=${newBal}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));

    } catch(e) {
      console.error('[sell-trade] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── GET /crypto-currencies ───────────────────────────────
  // NOWPayments থেকে available crypto currencies list — 1 ঘণ্টা cache করা হয়
  if (req.method === 'GET' && req.url === '/crypto-currencies') {
    try {
      const now = Date.now();
      if (_cryptoCurrenciesCache && (now - _cryptoCurrenciesCacheTime) < 3600000) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, currencies: _cryptoCurrenciesCache, cached: true }));
        return;
      }

      const npRes = await fetch('https://api.nowpayments.io/v1/full-currencies', {
        headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY }
      });
      const npData = await npRes.json();

      if (!npData.currencies) {
        res.writeHead(502); res.end(JSON.stringify({ error: 'NOWPayments currencies fetch failed' })); return;
      }

      // শুধু enabled currency গুলো রাখো, frontend এর জন্য simplify করো
      const list = npData.currencies
        .filter(c => c.enable)
        .map(c => ({ code: c.code, name: c.name, logo: c.logo_url || null, network: c.network }));

      _cryptoCurrenciesCache = list;
      _cryptoCurrenciesCacheTime = now;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, currencies: list, cached: false }));

    } catch(e) {
      console.error('[crypto-currencies] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── POST /create-crypto-payment ──────────────────────────
  if (req.method === 'POST' && req.url === '/create-crypto-payment') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, amountUSD, payCurrency } = body;

      if (!idToken || !amountUSD || !payCurrency) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Missing fields' })); return;
      }

      const amt = parseFloat(amountUSD);
      if (!amt || amt <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid amount' })); return;
      }

      // idToken verify — user authenticate
      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      const userId = decoded.uid;

      // NOWPayments — Create Payment
      const npRes = await fetch('https://api.nowpayments.io/v1/payment', {
        method: 'POST',
        headers: {
          'x-api-key':    process.env.NOWPAYMENTS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          price_amount:      amt,
          price_currency:    'usd',
          pay_currency:      payCurrency,
          order_id:          `gv_${userId}_${Date.now()}`,
          order_description: 'GoldVest Deposit',
          ipn_callback_url:  'https://goldvest-otc-worker-production.up.railway.app/nowpayments-webhook'
        })
      });
      const npData = await npRes.json();

      if (!npData.payment_id || !npData.pay_address) {
        console.error('[create-crypto-payment] NOWPayments error:', JSON.stringify(npData));
        res.writeHead(502); res.end(JSON.stringify({ error: 'Payment creation failed', detail: npData.message || npData })); return;
      }

      // Firestore এ track করার জন্য record রাখো
      await firestore.collection('cryptoPayments').doc(String(npData.payment_id)).set({
        uid:           userId,
        amountUSD:     amt,
        payCurrency:   payCurrency,
        payAddress:    npData.pay_address,
        payAmount:     npData.pay_amount,
        status:        'waiting',
        createdAt:     admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`[create-crypto-payment] uid=${userId} paymentId=${npData.payment_id} amountUSD=${amt} currency=${payCurrency}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success:        true,
        paymentId:      npData.payment_id,
        payAddress:     npData.pay_address,
        payAmount:      npData.pay_amount,
        payCurrency:    npData.pay_currency,
        extraId:        npData.payin_extra_id || null,
        expirationDate: npData.expiration_estimate_date || null
      }));

    } catch(e) {
      console.error('[create-crypto-payment] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── POST /nowpayments-webhook ────────────────────────────
  // NOWPayments IPN callback — payment status update পাঠায়
  if (req.method === 'POST' && req.url === '/nowpayments-webhook') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end('Invalid body'); return; }

      // ── Signature verify — HMAC-SHA512, sorted keys ──
      const receivedSig = req.headers['x-nowpayments-sig'];
      if (!receivedSig) {
        console.warn('[nowpayments-webhook] missing signature header');
        res.writeHead(401); res.end('Missing signature'); return;
      }

      function _sortObject(obj) {
        return Object.keys(obj).sort().reduce((result, key) => {
          result[key] = (obj[key] && typeof obj[key] === 'object') ? _sortObject(obj[key]) : obj[key];
          return result;
        }, {});
      }

      const sortedBody = _sortObject(body);
      const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET);
      hmac.update(JSON.stringify(sortedBody));
      const expectedSig = hmac.digest('hex');

      if (expectedSig !== receivedSig) {
        console.warn('[nowpayments-webhook] signature mismatch — possible forged request');
        res.writeHead(401); res.end('Invalid signature'); return;
      }

      // ── Signature OK — payment process করো ──
      const { payment_id, payment_status, price_amount } = body;

      if (!payment_id) {
        res.writeHead(400); res.end('Missing payment_id'); return;
      }

      console.log(`[nowpayments-webhook] paymentId=${payment_id} status=${payment_status}`);

      // শুধু 'finished' status এ balance credit করো
      if (payment_status === 'finished') {
        const payDocRef = firestore.collection('cryptoPayments').doc(String(payment_id));

        // Transaction দিয়ে atomic check-and-mark — duplicate webhook race condition প্রতিরোধ করে
        let shouldCredit = false;
        let uid = null;
        let creditAmt = 0;

        await firestore.runTransaction(async (tx) => {
          const payDoc = await tx.get(payDocRef);

          if (!payDoc.exists) {
            console.warn(`[nowpayments-webhook] paymentId=${payment_id} — no matching record found`);
            return;
          }

          const payData = payDoc.data();

          if (payData.status === 'finished') {
            console.log(`[nowpayments-webhook] paymentId=${payment_id} already processed — skip`);
            return;
          }

          uid = payData.uid;
          creditAmt = parseFloat(price_amount) || payData.amountUSD;
          shouldCredit = true;

          // এখনই status 'finished' মার্ক করো — পরবর্তী duplicate webhook এই check এ আটকে যাবে
          tx.update(payDocRef, {
            status:         'finished',
            creditedAmount: creditAmt,
            finishedAt:     admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        if (shouldCredit && uid) {
          // Redis এ USD credit (transaction এর বাইরে — Redis Firestore transaction এ অংশ নেয় না)
          const balKey = BAL_KEY_OTC(uid);
          let currentBal = await redisPub.get(balKey);
          if (currentBal === null) {
            const userSnap = await firestore.collection('users').doc(uid).get();
            const bal = userSnap.exists ? (userSnap.data().liveBalance || 0) : 0;
            await redisPub.set(balKey, bal.toString(), 'EX', 3600);
          }

          const newBal = await redisPub.incrbyfloat(balKey, creditAmt);
          await redisPub.expire(balKey, 3600);
          await redisPub.set(`gv:bal:dirty:${uid}`, '1', 'EX', 3600);

          console.log(`[nowpayments-webhook] uid=${uid} paymentId=${payment_id} credited=${creditAmt} newBal=${newBal}`);
        }

      } else {
        // অন্য status (waiting, confirming, partially_paid, failed, expired) — শুধু log/track করো
        const payDocRef = firestore.collection('cryptoPayments').doc(String(payment_id));
        await payDocRef.update({ status: payment_status || 'unknown' }).catch(() => {});
      }

      res.writeHead(200); res.end('OK');

    } catch(e) {
      console.error('[nowpayments-webhook] error:', e.message);
      res.writeHead(500); res.end('Internal error');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');

}).listen(process.env.PORT||3000, () => console.log('HTTP alive'));

setInterval(() => {
  fetch('https://goldvest-otc-worker-production.up.railway.app/')
    .then(() => console.log('[ping] OK'))
    .catch(() => {});
}, 8*60*1000);








