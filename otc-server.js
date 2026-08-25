// ============================================================
// otc-server.js — OTC + Forex Candle Generator (Admin SDK)
// OTC → Synthetic (Binance base)
// Forex → Twelve Data WebSocket (EUR/USD, GBP/USD only)
// ============================================================

const admin = require('firebase-admin');
const pLimit = require('p-limit');
const Redis  = require('ioredis');
const crypto = require('crypto');
const orderSettle = require('./ordersettle.js');   // [MTG PROTECTION] majority-loses close price adjustment
const tradeReservation = require('./tradereservation.js');   // [BALANCE RESERVATION] click-time reserve, animation-sync execute
const mtgGuard = require('./mtgguard.js');         // [MTG PROTECTION] single-trader pattern detection
const https  = require('https');   // [MARKET REFERENCE] real-world price fetch করতে

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

    // [BALANCE RESERVATION] tradereservation.js এর Lua-commands register
    tradeReservation.registerReservationCommands(redisPub);

    // [SECURITY ১.২] balance যাচাই + কাটা — একটাই অবিভাজ্য (atomic) কাজ।
    // আগে get() তারপর incrbyfloat() — দুই ধাপ। ১ লাখ user এ কেউ দ্রুত দুবার
    // চাপলে দুটো trade ই পাস করতে পারত (টাকা একটার)। Lua পুরো যুক্তি Redis এর
    // ভেতরে একবারে চালায়, তাই মাঝখানে অন্য request ঢুকতে পারে না।
    // ফেরত: [ok(1/0), newBalance] — টাকা কম হলে ok=0, balance অপরিবর্তিত।
    redisPub.defineCommand('gvDeductBalance', {
        numberOfKeys: 1,
        lua: `
            local bal = redis.call('GET', KEYS[1])
            if bal == false then return {-1, '0'} end   -- key নেই: caller Firestore থেকে load করবে
            local b = tonumber(bal)
            local amt = tonumber(ARGV[1])
            if b < amt then return {0, bal} end          -- টাকা কম
            local nb = redis.call('INCRBYFLOAT', KEYS[1], -amt)
            redis.call('EXPIRE', KEYS[1], 3600)
            return {1, nb}
        `,
    });

    // [SECURITY ১.২] sell এর জন্য — status live → sold atomically।
    // settler এর gvClaimTrade এর হুবহু জমজ। sell আর settle একসাথে চললে
    // যে আগে দখল নেবে সে ই credit করবে, অন্যজন 0 পেয়ে থামবে — double-credit নেই।
    redisPub.defineCommand('gvClaimTrade', {
        numberOfKeys: 1,
        lua: `
            local st = redis.call('HGET', KEYS[1], 'status')
            if st == false then return 0 end         -- hash নেই — sell করা যাবে না
            if st ~= 'live' then return 0 end          -- আগেই settled/sold
            redis.call('HSET', KEYS[1], 'status', ARGV[1])
            return 1
        `,
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
// [ENGINE] দামের physics আলাদা ফাইলে (engine.js) — otc-server ছোট রাখতে।
// ENGINE_MODE=off দিলে পুরনো inline physics চলবে (তাৎক্ষণিক rollback)।
const engine      = require('./engine.js');
const tickHistory = require('./tickhistory.js');   // [TICK IDENTITY] entry/settlement এর জন্য canonical tick lookup
const ENGINE_MODE = (process.env.ENGINE_MODE || 'on').toLowerCase() !== 'off';
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
// [LATENCY] প্রথম item কখন এসেছিল — debounce যেন অনির্দিষ্টকাল
// পিছিয়ে না যায়, তার কঠিন সীমার জন্য।
const _userSettleFirstAt = new Map(); // userId -> ms

function _queueSettlementBroadcast(userId, tradeId, settleResult) {
  if (!userId || !settleResult || settleResult.result !== 'ok') return;
  if (!_userSettleQueue.has(userId)) _userSettleQueue.set(userId, []);
  _userSettleQueue.get(userId).push({
    tradeId,
    status:     settleResult.status,
    closePrice: settleResult.closePrice,
    profit:     settleResult.profit,
  });

  // ══════════════════════════════════════════════════════════════
  // [LATENCY] আগে এখানে ৮০০ms এর debounce ছিল, এবং সেটা প্রতিবার
  // reset হতো — একই user এর আরেকটা trade এর মধ্যে settle হলে আবার
  // ৮০০ms শুরু। ফলে ফল ঘোষণায় সবচেয়ে বড় দেরিটা এখানেই জমত।
  //
  // উদ্দেশ্যটা ঠিক ছিল: একাধিক trade একসাথে পাঠালে client একটাই
  // event এ সব দেখাতে পারে (Quotex-pattern)। কিন্তু settle loop এর
  // সব due trade *একই পাসে* queue তে যায় — অর্থাৎ সিঙ্ক্রোনাসভাবে।
  // তাই পুরো ব্যাচ ধরতে ৬০ms ই যথেষ্ট, ৮০০ms এর দরকার নেই।
  //
  // সাথে একটা কঠিন সীমা: প্রথম item আসার ২০০ms এর মধ্যে flush হবেই,
  // যত reset ই হোক। নইলে দ্রুত পরপর trade করলে ঘোষণা অনির্দিষ্টকাল
  // পিছিয়ে যেতে পারত।
  // ══════════════════════════════════════════════════════════════
  const firstAt = _userSettleFirstAt.get(userId);
  if (firstAt === undefined) _userSettleFirstAt.set(userId, Date.now());

  if (firstAt !== undefined && (Date.now() - firstAt) >= 200) {
    if (_userSettleTimers.has(userId)) clearTimeout(_userSettleTimers.get(userId));
    _flushUserSettleBatch(userId);
    return;
  }

  if (_userSettleTimers.has(userId)) clearTimeout(_userSettleTimers.get(userId));
  _userSettleTimers.set(userId, setTimeout(() => _flushUserSettleBatch(userId), 60));
}

function _flushUserSettleBatch(userId) {
  _userSettleTimers.delete(userId);
  _userSettleFirstAt.delete(userId);
  const items = _userSettleQueue.get(userId);
  _userSettleQueue.delete(userId);
  if (!items || items.length === 0) return;

  const batchId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[batch-broadcast] userId=${userId} batchId=${batchId} items=${items.length}`);

  // NOTE: এই function টা কেবল HTTP-fallback পথে চলে (Redis বন্ধ থাকলে)।
  // স্বাভাবিক অবস্থায় settlement broadcast করে redis-settler service —
  // _batchSettleAndBroadcast() এ `lpush('gv:settle_queue')` করে return
  // করে দেয়, তাই নিচের কোড পর্যন্ত পৌঁছায় না।
  //
  // WebSocket fast-path (Redis channel `settle:{userId}`) তাই এখানে নয়,
  // redis-settler.js এর _flushBroadcast() এ বসানো হয়েছে — যেখানে আসল
  // broadcast হয়। এখানে বসালে সেটা কখনো চলত না।
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
  // transaction এর বদলে increment/decrement — পুরো node delete না করে
  // নতুন trades এ type/amount আছে, তাই সঠিক decrement হবে
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
        // সব 0 হলে node delete করো
        if ((curr.up || 0) <= 0 && (curr.down || 0) <= 0) return null;
        return curr;
      }).catch(() => {});
    } else {
      // পুরানো trades (type নেই) — node clear করো
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
        preAdjusted: t.preAdjusted || false,   // [MTG PROTECTION] true হলে settler নিজে থেকে দাম আবার খুঁজবে না
        symbol,
        settledBy:  'redis-settler',
        // [AUDIT TRAIL] settlement কোন canonical tick থেকে এসেছে তার
        // traceability — redis-settler.js এই field গুলো trade-record
        // এ persist করবে (যদি সেই ফাইলে support থাকে, না থাকলে এই
        // extra field harmless ভাবে ignored হবে)।
        settlementTickId: t.settlementTickId ?? null,
        settlementTimestamp: t.settlementTimestamp ?? null,
        settlementSource: t.settlementSource ?? 'legacy',
      }));
      // LPUSH — settler blpop করে instantly process করবে
      await redisPub.lpush('gv:settle_queue', ...jobs);
      // [LATENCY MEASURE] expiry → queue push, প্রকৃত ms।
      //
      // settler এর log এ lagMs = expiry → broadcast (মাপা: ৯৮৯-১৭৮৭ms),
      // আর settler এর নিজের debounce এখন সর্বোচ্চ ১৫০ms। অর্থাৎ বড়
      // অংশটা queue তে পৌঁছানোর আগেই খরচ হচ্ছে — কিন্তু ঠিক কোথায়,
      // সেটা অনুমান না করে এখানে মেপে নিই।
      //
      // pushLagMs ছোট (<২০০ms) হলে দেরিটা settler এর ভেতরে;
      // বড় হলে দেরিটা otc-server এ — expiry শনাক্ত করা বা
      // _applyExpiryPrices এর await গুলোতে।
      const _pushLag = trades.reduce((mn, t) => {
        const e = t.expiryTimestampMs > 0 ? t.expiryTimestampMs : (t.expiryTimestamp || 0) * 1000;
        return (e > 0 && (mn === 0 || e < mn)) ? e : mn;
      }, 0);
      console.log(`[redis-push] ${symbol} pushed=${trades.length} closePrice=${closePrice.toFixed(5)} pushLagMs=${_pushLag > 0 ? Date.now() - _pushLag : -1}`);
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
      await _applyExpiryPrices(symbol, trades);   // [TICK HISTORY] expiry এর সঠিক দাম
      { const _snap = []; for (const t of _activeTradesMemory.values()) if (t.symbol === symbol) _snap.push({ userId: t.userId, type: t.type, amount: t.amount });
        for (const t of trades) _snap.push({ userId: t.userId, type: t.type, amount: t.amount });
        closePrice = orderSettle.adjustClosePrice(_snap, closePrice, _states[symbol]?._eng?.decimals); }   // [MTG PROTECTION]
      trades.forEach(t => { t.closePrice = closePrice; t.preAdjusted = true; });
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
          // [TICK HISTORY] candleTime ই এই trade গুলোর expiry — ওই মুহূর্তের
          // দাম ইতিহাস থেকে নেওয়া হবে (_applyExpiryPrices)। t.expiryTimestampMs
          // থাকলে (user এর আসল ms-নির্ভুল expiry) সেটাই প্রাধান্য পাবে।
          trades.push({ userId, tradeId: tradeNode.key, closePrice, expiryTimestamp: candleTime, expiryTimestampMs: t.expiryTimestampMs || 0, type: t.type || '', amount: t.amount || 0 });
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

    await _applyExpiryPrices(symbol, trades);   // [TICK HISTORY] expiry এর সঠিক দাম
    { const _snap = []; for (const t of _activeTradesMemory.values()) if (t.symbol === symbol) _snap.push({ userId: t.userId, type: t.type, amount: t.amount });
      for (const t of trades) _snap.push({ userId: t.userId, type: t.type, amount: t.amount });
      closePrice = orderSettle.adjustClosePrice(_snap, closePrice, _states[symbol]?._eng?.decimals); }   // [MTG PROTECTION]
      trades.forEach(t => { t.closePrice = closePrice; t.preAdjusted = true; });
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
            expiryTimestampMs: parseInt(t.expiryTimestampMs) || 0,   // [PRECISION FIX] recovery তেও বহাল রাখা
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

// [SCALE ২.১] Firestore shadow listener সরানো হয়েছে।
// আগে collectionGroup('trades').where('status','==','live').onSnapshot() দিয়ে
// সব user এর সব live trade পড়া হতো — ১ লাখ live trade মানে বিপুল Firestore
// read, প্রতিদিন কয়েকশো ডলার। অথচ একই তথ্য RTDB settlement_queue তেই আছে।
//
// এখন _activeTradesMemory ভরে দুই উৎস থেকে (Firestore ছাড়াই):
//   ১. server চালু হওয়ার সময় — _recoverLiveTradesFromRTDB()
//   ২. নতুন trade বসার সময় — /place-trade নিজেই memory তে যোগ করে
// আর _pendingSettle guard এর ৩০/৬০ সেকেন্ডের safety timeout আগে থেকেই আছে,
// তাই listener এর "confirm" এর দরকার নেই। RTDB path (_settleDueTradesFromRTDB)
// সব ক্ষেত্রেই catch-all হিসেবে কাজ করে।

// ── [ধাপ ২] In-memory map থেকে tick-based settlement ──────
// প্রতি tick এ — যেসব live trade এর expiryTimestamp <= now, তাদের সেই
// symbol এর current state.price দিয়ে সাথে সাথে settle করো (candle-close
// trigger এর পাশাপাশি/parallel — duplicate-safe, কারণ _doSettle এ
// status !== 'live' guard আছে)
/**
 * [TICK IDENTITY] প্রতিটা trade এর closePrice কে তার নিজের expiry এর
 * সঠিক মুহূর্তের canonical দাম দিয়ে বদলে দেয় — tickhistory.js এর
 * in-memory, tickId-consistent history থেকে (আগে Redis-based
 * _histPriceAt/HIST_ON flag নির্ভর ছিল, এখন entry-price lookup এর
 * সাথে একই canonical source ব্যবহার হয়, দুটো সমান্তরাল system থাকল
 * না)।
 *
 * কেন: settle চলে প্রতি ৫০০ms এ, তাই ৫s এর trade ৫.৩s এ settle হলে
 * আগে ০.৩ সেকেন্ড পরের দাম ধরা হত। এখন expiry এর ঠিক আগের/সমান শেষ
 * canonical tick নেওয়া হয় — settle কখন চলল তাতে কিছু যায় আসে না,
 * ফল সবসময় deterministic।
 *
 * ইতিহাসে না পেলে আগের দামই থাকে (trade কখনো আটকায় না)।
 */
async function _applyExpiryPrices(symbol, trades) {
  for (const t of trades) {
    // [PRECISION FIX] আগে expSec * 1000 করলে sub-second (0-999ms) অংশ
    // হারিয়ে যেত, ৫s trade এ যা duration এর ~২০% পর্যন্ত ভুল সময়ের দাম
    // ধরিয়ে দিত। এখন ms-নির্ভুল expiry থাকলে সেটাই ব্যবহার হয়; পুরনো
    // client (যাদের এই field নেই) এর জন্য সেকেন্ড-fallback অক্ষত রইল।
    const expMs = t.expiryTimestampMs > 0 ? t.expiryTimestampMs : (t.expiryTimestamp ? t.expiryTimestamp * 1000 : 0);
    if (!expMs) continue;
    const tick = tickHistory.findLatestTickAtOrBefore(symbol, expMs);
    if (tick) {
      t.closePrice = tick.price;
      // [AUDIT TRAIL] পরে dispute/debugging এ কোন tick, কখন, কোন
      // source থেকে settlement হয়েছে তা traceable রাখা — financial
      // system এ ছোট এই metadata-ই পরে সবচেয়ে বেশি কাজে লাগে।
      t.settlementTickId = tick.tickId;
      t.settlementTimestamp = tick.timestamp;
      t.settlementSource = 'tickhistory';
    }
    // [FALLBACK] tickHistory তে না পেলে (server সদ্য restart হয়েছে,
    // history এখনো জমেনি) পুরনো Redis-based lookup fallback হিসেবে।
    // দুটো source ভিন্ন ফল দিতে পারে বলে audit trail এ source লিখে
    // রাখা হয়, যাতে পরে trade-history দেখে বোঝা যায় কোনটা ব্যবহার হয়েছে।
    else if (HIST_ON) {
      const p = await _histPriceAt(symbol, expMs);
      if (p) {
        t.closePrice = p;
        t.settlementTickId = null;
        t.settlementTimestamp = expMs;
        t.settlementSource = 'redis-fallback';
      }
    }
  }
}

async function _settleDueTradesFromMemory() {
  // [LATENCY] আগে শর্ত ছিল `t.expiryTimestamp <= nowSec` — অর্থাৎ ceil
  // করা সেকেন্ড-bucket। trade শেষ হতো ...992.948 এ, কিন্তু settle
  // অপেক্ষা করত ...993 সেকেন্ড পর্যন্ত — ১০০০ms পর্যন্ত অপচয়, অথচ
  // ms-নির্ভুল expiry পাশেই সংরক্ষিত ছিল, ব্যবহারই হতো না।
  //
  // এখন সরাসরি ms এ তুলনা। expiryTimestampMs না থাকলে (পুরনো trade)
  // আগের সেকেন্ড-হিসাবেই fallback — তাই কিছু ভাঙে না।
  //
  // দাম কোন মুহূর্তের সেটা এতে বদলায় না — _applyExpiryPrices আগের
  // মতোই expiryTimestampMs ধরে tickHistory থেকে দাম নেয়। শুধু
  // *ঘোষণা* দ্রুত হয়, ফলাফল অপরিবর্তিত।
  const nowMs = Date.now();
  const due = [];
  for (const [key, t] of _activeTradesMemory.entries()) {
    const expMs = t.expiryTimestampMs > 0 ? t.expiryTimestampMs : (t.expiryTimestamp * 1000);
    if (expMs <= nowMs && t.accountType === 'live') {
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
    // [TICK HISTORY] closePrice নিচে expiry এর সঠিক মুহূর্তের দাম দিয়ে
    // বদলে দেওয়া হয় (_applyExpiryPrices)। এখানে state.price শুধু fallback।
    bySymbol.get(t.symbol).trades.push({ userId: t.userId, tradeId: t.tradeId, closePrice: state.price, expiryTimestamp: t.expiryTimestamp, expiryTimestampMs: t.expiryTimestampMs || 0, type: t.type || '', amount: t.amount || 0 });
  }

  // প্রতি symbol-এর trades batchSettle-এ পাঠাও
  await Promise.allSettled([...bySymbol.entries()].map(async ([symbol, { closePrice, trades }]) => {
    console.log(`[tick-settle] ${symbol} due=${trades.length} closePrice=${closePrice.toFixed(5)}`);
    await _applyExpiryPrices(symbol, trades);   // [TICK HISTORY] expiry এর সঠিক দাম
    // [MTG FIX — মিশ্র duration] শুধু "একই মুহূর্তে expire" হওয়া trades
    // (`trades`) দিয়ে majority বের করলে ভুল হয় — user A এর 2min আর
    // user B এর 5s trade কখনো একই batch এ পড়বে না, তাই majority ধরাই
    // পড়ত না। এখন এই market এ *এই মুহূর্তে যত trade এখনো চলছে* (live
    // open trades, সব duration মিলিয়ে) — তাদের সম্মিলিত up/down amount
    // দিয়ে majority ঠিক হয়, তারপর সেই adjustment এখন expire হওয়া
    // trades এ প্রয়োগ হয়।
    const liveSnapshot = [];
    for (const t of _activeTradesMemory.values()) {
      if (t.symbol === symbol) liveSnapshot.push({ userId: t.userId, type: t.type, amount: t.amount });
    }
    // নিজেদেরও (এখন settle হচ্ছে) snapshot এ যোগ করি — তারা তো মাত্রই
    // পর্যন্ত open ছিল, বাদ দিলে ছোট market এ snapshot ফাঁকা হয়ে যেতে পারে
    for (const t of trades) liveSnapshot.push({ userId: t.userId, type: t.type, amount: t.amount });

    closePrice = orderSettle.adjustClosePrice(liveSnapshot, closePrice, _states[symbol]?._eng?.decimals);   // [MTG PROTECTION]
      trades.forEach(t => { t.closePrice = closePrice; t.preAdjusted = true; });
      await _batchSettleAndBroadcast(symbol, trades, closePrice);
      // ══════════════════════════════════════════════════════════════
      // [DUPLICATE SETTLE FIX] settle হয়ে যাওয়া trade গুলো RTDB
      // settlement_queue থেকেও মুছে দিই।
      //
      // আগে এই path কেবল _activeTradesMemory থেকে সরাত, RTDB queue
      // অক্ষত রেখে যেত। ফলে পরের tick এ _settleDueTradesFromRTDB()
      // ঠিক একই trade আবার queue তে পেয়ে দ্বিতীয়বার settle চালাত —
      // log এ [tick-settle] ও [rtdb-tick-settle] একই সেকেন্ডে একই
      // closePrice নিয়ে জোড়ায় জোড়ায় আসত। টাকা দ্বিগুণ হতো না
      // (downstream idempotent), কিন্তু প্রতিটা trade এর settlement
      // কাজ দুইবার হতো — user বাড়লে এই অপচয় রৈখিকভাবে বাড়ত।
      //
      // এখন queue entry থাকা মানেই "এই trade এখনো নিষ্পত্তি হয়নি" —
      // তাই RTDB path তার আসল ভূমিকাতেই থাকে: server restart বা
      // crash এ হারিয়ে যাওয়া trade উদ্ধার করা। settle এর পরে কিন্তু
      // remove এর আগে crash হলে entry থেকে যাবে এবং RTDB path আবার
      // চালাবে — সেটাও নিরাপদ, কারণ downstream duplicate ধরে।
      //
      // allSettled ব্যবহার করা হয়েছে ইচ্ছাকৃতভাবে: RTDB remove ব্যর্থ
      // হলেও settlement ভাঙবে না, শুধু entry পড়ে থাকবে — অর্থাৎ
      // সবচেয়ে খারাপ ক্ষেত্রেও আচরণ আজকের মতোই থাকে, খারাপ হয় না।
      // ══════════════════════════════════════════════════════════════
      await Promise.allSettled(trades.map(t =>
        db.ref(`settlement_queue/${t.expiryTimestamp}/${t.userId}/${t.tradeId}`).remove()
      ));
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
    // [SCALE] আগে পুরো settlement_queue নামানো হতো প্রতি tick এ। queue এর key
    // হলো expiryTimestamp, অর্থাৎ তাক টা সময় দিয়ে সাজানো — তাই orderByKey()
    // + endAt(now) দিয়ে শুধু "সময় হয়ে গেছে" এমন অংশটুকুই আনি। ভবিষ্যতের
    // trade (৪ ঘণ্টা পর্যন্ত, লক্ষ user) আর ছোঁয়াই হয় না — user বাড়লেও
    // এই কাজের ভার বাড়ে না।
    const snap = await db.ref('settlement_queue')
                         .orderByKey()
                         .endAt(String(nowSec))
                         .once('value');
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
          bySymbol.get(t.symbol).trades.push({ userId, tradeId: tradeNode.key, closePrice: state.price, expiryTimestamp, expiryTimestampMs: t.expiryTimestampMs || 0, type: t.type || '', amount: t.amount || 0 });
          _rtdbSettledKeys.add(key);
          _pendingSettle.add(key);
          _activeTradesMemory.delete(key);
        });
      });
    });

    if (bySymbol.size === 0) return;

    await Promise.allSettled([...bySymbol.entries()].map(async ([symbol, { closePrice, trades }]) => {
      console.log(`[rtdb-tick-settle] ${symbol} due=${trades.length} closePrice=${closePrice.toFixed(5)}`);
      await _applyExpiryPrices(symbol, trades);   // [TICK HISTORY] expiry এর সঠিক দাম
      { const _snap = []; for (const t of _activeTradesMemory.values()) if (t.symbol === symbol) _snap.push({ userId: t.userId, type: t.type, amount: t.amount });
        for (const t of trades) _snap.push({ userId: t.userId, type: t.type, amount: t.amount });
        closePrice = orderSettle.adjustClosePrice(_snap, closePrice, _states[symbol]?._eng?.decimals); }   // [MTG PROTECTION]
      trades.forEach(t => { t.closePrice = closePrice; t.preAdjusted = true; });
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

// ══════════════════════════════════════════════════════════════════
// [CANDLE HISTORY IN REDIS] বন্ধ হওয়া প্রতিটা candle Redis এর একটা
// list এ রাখি — client এখান থেকেই history নেবে, WebSocket দিয়ে।
//
// কেন দরকার: history এতদিন RTDB থেকে আসত। RTDB instance আমেরিকায়
// (nam5), আর reconnect এর পর সেটা ১২ সেকেন্ড পর্যন্ত নিত, কখনো সাড়াই
// দিত না (লাইভ log এ "500 candles loaded" একবারও আসেনি)। ওই দেরির
// সময়টুকুতেই নতুন market এর tick পুরনো chart এ মিশে ভাঙা chart তৈরি
// হতো — gap, ভুল দাম, "নাম বদলাল chart বদলাল না", open/close না মেলা
// — সব একই কারণের লক্ষণ।
//
// Redis ও Railway দুটোই এখন সিঙ্গাপুরে, তাই এই পথ অনেক কাছের।
// RTDB write অক্ষত রাখা হয়েছে — client এ WS ব্যর্থ হলে সেটাই fallback।
//
// LTRIM দিয়ে প্রতি symbol এ সর্বশেষ ৫০০ রাখা হয়; ২৯ market এ মোট
// ~১৪,৫০০ entry, কয়েক MB — Redis এর জন্য নগণ্য।
// ══════════════════════════════════════════════════════════════════
const CANDLE_HISTORY_MAX = 500;
function _pushCandleToRedis(id, candle) {
  if (!redisReady) {
    // [DIAG] Redis প্রস্তুত না থাকলে candle টা list এ যায় না — তখন
    // client এর history এক candle পিছিয়ে থাকবে এবং প্রতিবার "gap"
    // মনে হবে। এটা নীরবে ঘটলে ধরা কঠিন, তাই log করি।
    console.warn(`[${id}] redis প্রস্তুত নয় — candle history তে যোগ হলো না (time=${candle.time})`);
    return;
  }
  const key = `gv:candles:${id}`;
  redisPub.multi()
    .rpush(key, JSON.stringify(candle))
    .ltrim(key, -CANDLE_HISTORY_MAX, -1)
    .exec()
    // [DIAG] লাইভ log এ দেখা গেছে client এর history বারবার একই candle এ
    // থেমে ছিল (close=0.87227), অথচ live দাম এগিয়ে গিয়েছিল — অর্থাৎ
    // সর্বশেষ বন্ধ candle Redis list এ পৌঁছায়নি। সেটা সত্যিই ঘটছে
    // কিনা এবং list কত লম্বা, তা এখানেই দেখা যাবে।
    .then(res => {
      const len = res && res[0] && res[0][1];
      console.log(`[${id}] redis candle push ok time=${candle.time} listLen=${len}`);
    })
    .catch(e => console.error(`[${id}] redis candle push failed:`, e.message));
}

function saveCandle(id, candle) {
  _pushCandleToRedis(id, candle);
  db.ref(`otc_candles/${id}/candles`).push(candle)
    .then(() => {
      console.log(`[${id}] candle close=${candle.close.toFixed(5)}`);
      // Candle close হলে 24h change update করো
      _save24hChange(id, candle.close);
    })
    .catch(e => console.error(`[${id}] save failed:`, e.message));
}

// ══════════════════════════════════════════════════════════════════════
// [BILL — VIEWER GATING] যে market কেউ দেখছে না, তার tick-by-tick RTDB
// লেখা বাদ দেওয়া।
// ----------------------------------------------------------------------
// কেন: ২৯টা market ২৪/৭ চলে, প্রতি tick এ ৩টা করে RTDB লেখা — অথচ
// সাধারণত ১-২টার বেশি market কেউ দেখে না। বাকি লেখাগুলো কেউ পড়েই না,
// শুধু Railway network বিল বাড়ায় (মাপা ~২৬৭ GB/মাস)।
//
// কে জানায়: ws-server.js প্রতি ৫s এ `gv:active:symbols` এ লিখে রাখে কোন
// symbol গুলোতে এখন client subscribe করে আছে (TTL ১৫s)।
//
// নিরাপত্তা — তিন স্তর, সব ক্ষেত্রেই ব্যর্থতা "লেখা চালু" দিকে যায়:
//   ১. ENABLE_VIEWER_GATING != 'on'  → gating সম্পূর্ণ নিষ্ক্রিয়।
//      Railway variable বদলেই তাৎক্ষণিক বন্ধ করা যায়, redeploy লাগে না।
//   ২. key না পাওয়া / Redis ব্যর্থ / ws-server মৃত (TTL শেষ) / JSON ভাঙা
//      → _activeSymbols থাকে null, অর্থাৎ "অজানা" — তখন সব market এর
//      লেখা আগের মতোই চলে।
//   ৩. তালিকায় "*" থাকলে (কোনো client সব symbol এ subscribe করেছে)
//      → gating নিষ্ক্রিয়।
//
// আর candle-boundary এর লেখা (force=true) কখনোই বাদ যায় না — তাই বন্ধ
// থাকা market এও `/live` সর্বোচ্চ ১ মিনিটের পুরনো হয়, আর `candles`
// ইতিহাস সম্পূর্ণ অক্ষত থাকে।
// ══════════════════════════════════════════════════════════════════════
const VIEWER_GATING     = (process.env.ENABLE_VIEWER_GATING || 'off').toLowerCase() === 'on';
const ACTIVE_SYMBOLS_KEY = 'gv:active:symbols';
const ACTIVE_POLL_MS     = 2000;
let   _activeSymbols     = null;   // null = অজানা → সব লেখা চালু (নিরাপদ ডিফল্ট)

async function _refreshActiveSymbols() {
  if (!VIEWER_GATING || !redisReady || !redisPub) { _activeSymbols = null; return; }
  try {
    const raw = await redisPub.get(ACTIVE_SYMBOLS_KEY);
    if (!raw) { _activeSymbols = null; return; }   // key নেই/মেয়াদ শেষ → অজানা
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) { _activeSymbols = null; return; }
    if (arr.includes('*')) { _activeSymbols = null; return; }   // wildcard → নিষ্ক্রিয়
    _activeSymbols = new Set(arr);
  } catch (e) {
    // যেকোনো ত্রুটিতে "অজানা" — অর্থাৎ কিছুই বন্ধ হয় না
    _activeSymbols = null;
  }
}

if (VIEWER_GATING) {
  console.log('[gating] দর্শক-ভিত্তিক RTDB gating চালু (ENABLE_VIEWER_GATING=on)');
  setInterval(() => { _refreshActiveSymbols().catch(() => {}); }, ACTIVE_POLL_MS);
} else {
  console.log('[gating] নিষ্ক্রিয় — সব market এর RTDB live লেখা আগের মতোই চলবে');
}

/** এই symbol এ এখন কেউ তাকিয়ে আছে? অনিশ্চিত হলে সবসময় true। */
function _isWatched(id) {
  if (!VIEWER_GATING)   return true;
  if (_activeSymbols === null) return true;   // অজানা → নিরাপদ দিকে
  return _activeSymbols.has(id);
}

function saveLiveCandle(id, candle, force = false) {
  // RTDB — client এখনো এখান থেকেই দাম পড়ে (অক্ষত, fallback হিসেবে থাকবে)।
  // [BILL] কেউ না দেখলে এই লেখাটা বাদ; candle-boundary এ (force) কখনো নয়।
  if (force || _isWatched(id)) {
    db.ref(`otc_candles/${id}/live`).set(candle).catch(() => {});
  }

  // [SCALE ২.৪ — ধাপ ১] Redis Pub/Sub এ একই দাম publish।
  // ভবিষ্যতের ws-service এটা subscribe করে লক্ষ client কে WebSocket এ পাঠাবে
  // (Firebase egress এর বদলে সস্তা Railway egress)। এখন শুধু publish হচ্ছে —
  // কেউ subscribe না করলেও Redis publish প্রায় শূন্য খরচ, তাই নিরাপদ।
  // payload ছোট: শুধু দরকারি field, JSON string।
  if (redisReady && redisPub) {
    // ══════════════════════════════════════════════════════════════
    // [LIVE SNAPSHOT] চলমান candle টা Redis এ *সংরক্ষণ* ও করি (publish
    // তো নিচে হচ্ছেই)। কারণ client history পাওয়ার পর চলমান candle টা
    // RTDB এর `/live` থেকে পড়ত — সেই read লাইভ log এ প্রতিবার ঝুলে
    // যাচ্ছিল ("live snapshot এলো না (1500ms)"), ফলে প্রতিটা market
    // switch এ ১.৫ সেকেন্ড নষ্ট হতো আর চলমান candle প্রথমে দেখা যেত না।
    //
    // এখন ws-server history এর সাথেই এটা পাঠিয়ে দেবে — RTDB এর দরকার
    // ফুরোবে। TTL ৩০০s: কোনো market বন্ধ হলে পুরনো মান পড়ে থাকবে না।
    // ══════════════════════════════════════════════════════════════
    redisPub.set(`gv:live:${id}`, JSON.stringify(candle), 'EX', 300).catch(() => {});

    const msg = JSON.stringify({
      s: id,                 // symbol
      t: candle.time,        // candle time
      o: candle.open,
      h: candle.high,
      l: candle.low,
      c: candle.close,       // current price
      n: candle.nextCandle,  // next candle boundary
      // [TICK IDENTITY] এই WebSocket path (goldvest-ws service) দিয়েই
      // আসলে frontend price পাচ্ছিল (RTDB না) — এতদিন এখানে tickId
      // ছিল না বলেই chartengine.js কখনো visibleTickId capture করতে
      // পারেনি, যদিও RTDB-broadcast এ ঠিকই ছিল। এটাই root cause ছিল
      // "trade ভুল জায়গায় পড়া" সমস্যার।
      k: candle.tickId,      // tickId — ছোট payload রাখতে সংক্ষিপ্ত key
    });
    // fire-and-forget — publish ব্যর্থ হলেও RTDB path অক্ষত, দাম বন্ধ হয় না
    redisPub.publish(`px:${id}`, msg).catch(() => {});
    // [TICK HISTORY] সময় সহ দাম জমা — entry ও settlement দুটোতেই ব্যবহার
    _histWrite(id, Date.now(), candle.close);
  }
}

// ══════════════════════════════════════════════════════════════════════
// [TICK HISTORY] সময় সহ দামের ইতিহাস — Redis Sorted Set এ
// ----------------------------------------------------------------------
// কেন দরকার:
//   • Entry — user ক্লিক করা থেকে request পৌঁছাতে ১০০-৩০০ms লাগে, ওই
//     সময়ে দাম বদলে যায়। ইতিহাস থাকলে ক্লিকের ঠিক মুহূর্তের দাম বসে।
//   • Settlement — settle চলে প্রতি ৫০০ms এ, তাই ৫s trade ৫.৩s এ settle
//     হলে ০.৩s পরের দাম ধরা হত। এখন expiry এর ঠিক মুহূর্তের দাম নেওয়া হয়।
//
// Redis এ রাখার কারণ: server restart এ মুছে যায় না, settler ও পড়তে
// পারে, আর একাধিক worker চললেও সবাই একই ইতিহাস দেখে।
//
// গঠন: ZSET  px:hist:{symbol}  →  score = timestamp(ms), member = "ts:price"
// পুরনো entry নিজে থেকেই ছাঁটা হয় (৫ ঘণ্টার বেশি রাখা হয় না — সবচেয়ে
// লম্বা trade ৪ ঘণ্টা, তাই নিরাপদ মার্জিন সহ)।
// ══════════════════════════════════════════════════════════════════════
const HIST_KEEP_MS = 5 * 3600 * 1000;         // ৫ ঘণ্টা
const HIST_ON = (process.env.TICK_HISTORY || 'on').toLowerCase() !== 'off';
const _histTrimAt = {};                        // symbol → শেষ কবে ছাঁটা হয়েছে

function _histWrite(id, ts, price) {
  if (!HIST_ON || !redisPub) return;
  const key = `px:hist:${id}`;
  // একই ms এ দুটো tick এলে member আলাদা রাখতে ts+price একসাথে
  redisPub.zadd(key, ts, `${ts}:${price}`).catch(() => {});

  // প্রতি ৩০ সেকেন্ডে একবার পুরনো ছাঁটি — প্রতি tick এ নয় (খরচ কম)
  const last = _histTrimAt[id] || 0;
  if (ts - last > 30000) {
    _histTrimAt[id] = ts;
    redisPub.zremrangebyscore(key, 0, ts - HIST_KEEP_MS).catch(() => {});
    redisPub.expire(key, Math.ceil(HIST_KEEP_MS / 1000) + 600).catch(() => {});
  }
}

/**
 * নির্দিষ্ট সময়ে দাম কত ছিল — "ওই সময় বা তার ঠিক আগের শেষ tick"।
 * এটাই আসল broker দের নিয়ম।
 * @returns {Promise<number|null>} দাম, না পেলে null
 */
async function _histPriceAt(id, ts) {
  if (!HIST_ON || !redisPub) return null;
  try {
    // ts এর সমান বা ছোট, সবচেয়ে কাছের একটা
    const rows = await redisPub.zrevrangebyscore(
      `px:hist:${id}`, ts, ts - 60000, 'LIMIT', 0, 1
    );
    if (!rows || !rows.length) return null;
    const v = parseFloat(String(rows[0]).split(':')[1]);
    return isFinite(v) && v > 0 ? v : null;
  } catch (e) {
    return null;
  }
}

function saveSubCandle(id, label, candle) {
  db.ref(`subcandles_${label}/${id}/candles`).push(candle)
    .catch(e => console.error(`[${id}][${label}] sub save failed:`, e.message));
}

function saveLiveSubCandle(id, label, candle) {
  // [BILL] কেউ এই market না দেখলে লেখা বাদ — ১৫s/৩০s এর চলমান candle
  // শুধু তখনই দরকার যখন কেউ সত্যিই ওই চার্ট খুলে আছে। বন্ধ candle
  // (`subcandles_*/candles`) সবসময় লেখা হয়, তাই ইতিহাস অক্ষত।
  if (!_isWatched(id)) return;
  db.ref(`subcandles_${label}/${id}/live`).set(candle).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// OTC ENGINE — REALISTIC PHYSICS
// ══════════════════════════════════════════════════════════
function randomTrend() {
  const r = Math.random();
  return r < 0.38 ? 1 : r < 0.76 ? -1 : 0;
}

// ── REGIME — market এর বর্তমান "মেজাজ" ───────────────────────────────────
// trending: এক দিকে জোরালো চলে (বড় body), ranging: এলোমেলো (ছোট body),
// calm: শান্ত ধীর, breakout: হঠাৎ শক্তিশালী move।
const _REGIMES = {
  trending: { vol: 1.15, trend: 1.0,  friction: 0.90, dur: [35, 80] },
  ranging:  { vol: 0.75, trend: 0.15, friction: 0.78, dur: [25, 60] },
  calm:     { vol: 0.5,  trend: 0.25, friction: 0.82, dur: [30, 65] },
  breakout: { vol: 1.5,  trend: 1.3,  friction: 0.92, dur: [12, 30] },
};
function _regimeDur(name) {
  const [lo, hi] = _REGIMES[name].dur;
  return lo + (Math.random() * (hi - lo) | 0);
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

// ══════════════════════════════════════════════════════════════════════
// [MARKET REFERENCE] Real-world price এর সাথে বড় ফারাক ঠিক করা
// ------------------------------------------------------------------------
// সমস্যা: OTC engine শুধু random walk করে, কোনো "সত্যিকারের দামের দিকে
// ফেরার" ব্যবস্থা নেই। তাই সময়ের সাথে (সপ্তাহ/মাস) দাম আসল বাজার থেকে
// অনেক দূরে সরে যেতে পারে (দেখা গেছে: AUD/NZD আসল ~1.198, synthetic হয়ে
// গিয়েছিল 0.0238 — প্রায় ৫০ ভাগের ১ ভাগ)।
//
// সমাধান: market শুরু/restart হওয়ার সময় Firestore এর market_reference
// collection (Index.js এর updateMarketReferencePrices প্রতিদিন লেখে)
// থেকে real price পড়ি। >১৫% ফারাক থাকলে একটা মাত্র candle এ সম্পূর্ণ
// জাম্প করে ঠিক জায়গায় নিয়ে যাই — ধাপে ধাপে না, কারণ ধাপে ধাপে গেলে
// দাম কয়েক candle ধরে predictable দিকে সরত, user সেটা ধরে নিয়ে সহজে
// জিততে পারত। এক-লাফে হলে দিক অননুমেয়ই থাকে।
//
// পুরনো candle history কখনো মোছা হয় না — এই জাম্প শুধু নতুন candle
// হিসেবে যোগ হয়।
// ══════════════════════════════════════════════════════════════════════
const REFERENCE_JUMP_THRESHOLD = 0.15;   // ১৫% এর বেশি ফারাক হলে সংশোধন

// [DECIMALS TABLE] প্রতিটা market এর দশমিক ঘর — Quotex এর সাথে সরাসরি
// মিলিয়ে (২৫টা pair এর current price দেখে)। আগে "seed price এর string
// length" বা "মোট ৬ সংখ্যা" জাতীয় সূত্র দিয়ে অনুমান করা হচ্ছিল, কিন্তু
// কোনো সূত্রই ১০০% মেলেনি (যেমন USD/ARS ২ ঘর, EUR/JPY ৩ ঘর, AUD/USD ৫
// ঘর — কোনো একক magnitude-নিয়মে পড়ে না)। তাই এখন সরাসরি নির্ভুল তালিকা।
// নতুন market যোগ হলে এখানে না থাকলে পুরনো fallback (string-length,
// ন্যূনতম ৫) ব্যবহার হবে — market বন্ধ হবে না, শুধু হয়তো ঠিক দশমিক
// নাও মিলতে পারে যতক্ষণ না এখানে যোগ করা হয়।
const _MARKET_DECIMALS = {
  AUDNZDOTC: 5, AUDUSDOTC: 5, CADCHFOTC: 5, CNYJPYOTC: 4,
  EURAUDOTC: 5, EURGBPOTC: 5, EURJPYOTC: 3, EURNZDOTC: 5,
  GBPJPYOTC: 3, GBPUSDOTC: 5, INRUSDOTC: 5, MXNUSDOTC: 5,
  NZDJPYOTC: 4, NZDUSDOTC: 5, USDARSOTC: 2, USDBRLOTC: 5,
  USDCADOTC: 5, USDCHFOTC: 5, USDCOPOTC: 2, USDEGPOTC: 4,
  USDIDROTC: 2, USDJPYOTC: 3, USDNGNOTC: 2, USDPHPOTC: 4,
  USDPKROTC: 3,

  // ── Binance feed (real crypto) ────────────────────────────────
  // এগুলোর দাম Binance থেকে আসে, তাই ঘরও Binance এর tickSize
  // অনুযায়ী হওয়া উচিত — কোনো সাধারণ নিয়ম থেকে নয়। নিচের তিনটি
  // স্ক্রিনশট মিলিয়ে যাচাই করা: BTC 64084.00, BNB 606.59, SOL 75.95
  // — তিনটিই ২ ঘর। বাকিগুলোও Binance এর প্রচলিত tickSize:
  //   BTC/ETH/BNB/SOL → 0.01  → ২ ঘর
  //   XRP/ADA         → 0.0001 → ৪ ঘর
  //   DOGE            → 0.00001 → ৫ ঘর
  // (XRP/ADA/DOGE স্ক্রিনশটে যাচাই করা হয়নি — Binance এ দেখে নিশ্চিত
  //  করলে ভালো, ভুল হলে এখানে এক জায়গায় বদলালেই হবে।)
  // (crypto এখানে হাতে লেখা নেই — ইচ্ছাকৃত, নিচের NOTE দেখো)

  // ── FOREX feed (real) ─────────────────────────────────────────
  // OTC সংস্করণের সাথে একই ঘর — একই মুদ্রা-জোড়া, তাই আলাদা হওয়ার
  // কারণ নেই। এগুলো না থাকায় এতদিন এরাও fallback এ যেত।
  EURGBP: 5, EURJPY: 3, EURNZD: 5, EURUSD: 5,
  GBPUSD: 5, NZDJPY: 4, NZDUSD: 5, USDJPY: 3,

  // ── USDT/BDT ──────────────────────────────────────────────────
  // দাম ~১২২, তাই ৩ ঘর (৬-সংখ্যার নিয়মের সাথেও মেলে)
  USDTBDT: 3,

  // ── NOTE: crypto (real ও OTC) ইচ্ছাকৃতভাবে এখানে নেই ──────────
  // প্রথমে হাতে বসানো হয়েছিল (সব ২ ঘর), কিন্তু তাতে মোট সংখ্যা
  // এলোমেলো হতো: BNB 607.12 (৫টি), SOL 78.98 (৪টি), XRP 1.00 (৩টি)।
  //
  // Eork এর চাওয়া: সব market এ মোট প্রায় ৬টি সংখ্যা, শুধু BTC ৭টি।
  // নিচের decimalsFor() এর নিয়ম ঠিক সেটাই দেয় — হাতে কিছু না লিখেই:
  //     BTC   64090.00  → ৭ (৬-৫=১, min ২ এ clamp)
  //     ETH    3100.00  → ৬
  //     BNB     607.120 → ৬
  //     SOL      78.9800→ ৬
  //     XRP/ADA/DOGE     → ৬
  // তাই crypto কে নিয়মের হাতেই ছেড়ে দেওয়া হলো। এখানে কিছু যোগ করলে
  // সেটা নিয়মকে override করবে — শুধু তখনই করো যখন কোনো market কে
  // ইচ্ছাকৃতভাবে ব্যতিক্রম রাখতে চাও।
};

// ══════════════════════════════════════════════════════════════════
// [DECIMALS — একটাই উৎস] কোনো market এর দাম কত ঘর দশমিকে দেখানো হবে।
//
// নিয়ম: মোট প্রায় ৬টি সংখ্যা দেখাও —
//     decimals = ৬ − (পূর্ণসংখ্যার ঘর),  সর্বনিম্ন ২, সর্বোচ্চ ৫
//
// এই নিয়মটা আবিষ্কার করা হয়নি, নিচের _MARKET_DECIMALS টেবিল থেকেই
// বের করা: টেবিলের ১৬টি pair-ই ব্যতিক্রমহীনভাবে এটা মেনে চলে
// (EURGBP 0.87→5, CNYJPY 24.8→4, USDJPY 156→3, USDARS 1387→2,
//  USDIDR 17841→2)। তাই টেবিল ও নিয়ম একই ফল দেয় — টেবিল অক্ষত রেখেই
// নতুন market গুলো স্বয়ংক্রিয়ভাবে সঠিক হয়।
//
// কেন দরকার হলো: আগের fallback ছিল seed-price এর *string দৈর্ঘ্য* —
//   Math.max(5, String(price).split('.')[1].length)
// JavaScript এর float এ 606.62 লেখা হয় 606.6200000000001 হিসেবে, তাই
// টেবিলে না-থাকা market (সব crypto) পেত decimals ১৪-১৫। এতে শুধু
// প্রদর্শন নয়, engine ও ভাঙত: pip = 10^-decimals, অর্থাৎ pip হয়ে যেত
// ০.০০০০০০০০০০০০০০১ — দাম কার্যত নড়তই না।
//
// এটাই একমাত্র জায়গা যেখানে decimals ঠিক হয়। OTC, forex ও crypto —
// তিন path ই এখান থেকে নেয়, তাই ভবিষ্যতে নতুন market যোগ করলে আর
// কোথাও কিছু করতে হবে না।
// ══════════════════════════════════════════════════════════════════
function decimalsFor(id, price) {
  const fromTable = _MARKET_DECIMALS[id];
  if (typeof fromTable === 'number') return fromTable;

  const p = Math.abs(Number(price));
  if (!isFinite(p) || p <= 0) return 5;   // দাম এখনো জানা নেই — নিরাপদ ডিফল্ট
  const intDigits = p >= 1 ? Math.floor(Math.log10(p)) + 1 : 1;
  return Math.max(2, Math.min(5, 6 - intDigits));
}

// symbol → [base, quote] — admin panel এর ঠিক তালিকা অনুযায়ী (Index.js
// এর _OTC_PAIR_MAP এর সাথে হুবহু মিলিয়ে রাখা, দুই জায়গায় duplicate
// রাখা হলো কারণ otc-server.js ও Index.js সম্পূর্ণ আলাদা service/repo)
const _OTC_PAIR_MAP = {
  AUDNZDOTC: ['AUD', 'NZD'], AUDUSDOTC: ['AUD', 'USD'],
  CADCHFOTC: ['CAD', 'CHF'], CNYJPYOTC: ['CNY', 'JPY'],
  EURAUDOTC: ['EUR', 'AUD'], EURGBPOTC: ['EUR', 'GBP'],
  EURJPYOTC: ['EUR', 'JPY'], EURNZDOTC: ['EUR', 'NZD'],
  GBPJPYOTC: ['GBP', 'JPY'], GBPUSDOTC: ['GBP', 'USD'],
  INRUSDOTC: ['INR', 'USD'], MXNUSDOTC: ['MXN', 'USD'],
  NZDJPYOTC: ['NZD', 'JPY'], NZDUSDOTC: ['NZD', 'USD'],
  USDARSOTC: ['USD', 'ARS'], USDBRLOTC: ['USD', 'BRL'],
  USDCADOTC: ['USD', 'CAD'], USDCHFOTC: ['USD', 'CHF'],
  USDCOPOTC: ['USD', 'COP'], USDEGPOTC: ['USD', 'EGP'],
  USDIDROTC: ['USD', 'IDR'], USDJPYOTC: ['USD', 'JPY'],
  USDNGNOTC: ['USD', 'NGN'], USDPHPOTC: ['USD', 'PHP'],
  USDPKROTC: ['USD', 'PKR'],
  USDTBDT:   ['USD', 'BDT'],
};

function _fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

/**
 * [MARKET REFERENCE — STARTUP FETCH] Server চালু হওয়ার সাথে সাথেই
 * (deploy/restart এ) নিজে থেকে exchangerate-api থেকে real price টেনে
 * Firestore এর market_reference collection এ লিখে দেয়। Index.js এর
 * দৈনিক schedule (রাত ০০:৩০ UTC) এর জন্য অপেক্ষা করতে হয় না — deploy
 * করার সাথে সাথেই সংশোধন কার্যকর হয়।
 *
 * ব্যর্থ হলে (API down, key নেই) শুধু log করে থেমে যায় — server চালু
 * হতে বা market শুরু হতে কখনো বাধা দেয় না।
 */
async function _fetchAndStoreReferencePrices() {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  if (!apiKey) {
    console.warn('[market-reference] EXCHANGE_RATE_API_KEY নেই — startup fetch skip (দৈনিক Firebase schedule এর উপর নির্ভর করবে)');
    return;
  }
  try {
    const data = await _fetchJson(`https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`);
    if (data.result !== 'success' || !data.conversion_rates) {
      console.error('[market-reference] startup fetch ব্যর্থ:', data.result || 'unknown response');
      return;
    }
    const rates = data.conversion_rates;
    const batch = firestore.batch();
    let count = 0;

    for (const [symbol, [base, quote]] of Object.entries(_OTC_PAIR_MAP)) {
      const baseRate  = base  === 'USD' ? 1 : rates[base];
      const quoteRate = quote === 'USD' ? 1 : rates[quote];
      if (!baseRate || !quoteRate) continue;
      const price = quoteRate / baseRate;
      batch.set(firestore.collection('market_reference').doc(symbol), {
        price, base, quote,
        source: 'exchangerate-api-startup',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      count++;
    }

    await batch.commit();
    console.log(`[market-reference] startup fetch — ${count}/${Object.keys(_OTC_PAIR_MAP).length} pair Firestore এ লেখা হলো`);
  } catch (e) {
    console.error('[market-reference] startup fetch ব্যর্থ:', e.message);
    // ব্যর্থ হলেও থেমে থাকব না — Index.js এর দৈনিক schedule পরে ঠিক করে দেবে
  }
}

// ══════════════════════════════════════════════════════════════════
// [CRYPTO OTC REFERENCE] crypto OTC → যে Binance symbol এর দাম অনুসরণ
// করবে।
//
// forex OTC গুলো _OTC_PAIR_MAP + exchangerate-api দিয়ে market_reference
// পায়, তাই তাদের দাম সবসময় বাস্তবের কাছাকাছি থাকে। crypto OTC কোনো
// map এই ছিল না — exchangerate-api তে BTC/ETH/BNB/SOL নেই — তাই তাদের
// market_reference doc কখনো তৈরিই হয়নি, referencePrice থাকত ০, অর্থাৎ
// anchor সম্পূর্ণ নিষ্ক্রিয়। ফলে যেখান থেকে শুরু হয়েছিল সেখানেই ভেসে
// বেড়াত (BNBOTC ০.৪৩ বনাম আসল ৬০৬, SOLOTC ৪৫৬ বনাম আসল ৭৫.৯৫)।
//
// এখানে আলাদা map রাখা হলো কারণ উৎসও আলাদা (Binance, exchangerate-api
// নয়)। ফলাফল একই collection এ লেখা হয়, তাই বাকি pipeline
// (_getReferencePrice → referencePrice → anchor) অপরিবর্তিত থাকে।
// ══════════════════════════════════════════════════════════════════
const _CRYPTO_OTC_MAP = {
  BTCOTC: 'BTCUSDT',
  ETHOTC: 'ETHUSDT',
  BNBOTC: 'BNBUSDT',
  SOLOTC: 'SOLUSDT',
};

/**
 * [CRYPTO REFERENCE — STARTUP FETCH] Binance এর public ticker থেকে
 * crypto OTC গুলোর real price এনে market_reference এ লেখে।
 * _fetchAndStoreReferencePrices() এর crypto সংস্করণ — একই কাজ, ভিন্ন উৎস।
 *
 * ব্যর্থ হলে শুধু log করে থেমে যায়; server চালু হতে বা market শুরু হতে
 * কখনো বাধা দেয় না (আগের মতোই আচরণ — anchor নিষ্ক্রিয় থাকবে, ক্ষতি নেই)।
 */
async function _fetchAndStoreCryptoReferencePrices() {
  const symbols = Object.values(_CRYPTO_OTC_MAP);
  if (!symbols.length) return;
  try {
    const query = encodeURIComponent(JSON.stringify(symbols));
    const data = await _fetchJson(`https://api.binance.com/api/v3/ticker/price?symbols=${query}`);
    if (!Array.isArray(data)) {
      console.error('[crypto-reference] startup fetch ব্যর্থ: অপ্রত্যাশিত response');
      return;
    }
    const bySymbol = {};
    for (const row of data) {
      const p = parseFloat(row && row.price);
      if (row && row.symbol && isFinite(p) && p > 0) bySymbol[row.symbol] = p;
    }

    const batch = firestore.batch();
    let count = 0;
    for (const [otcId, binanceSymbol] of Object.entries(_CRYPTO_OTC_MAP)) {
      const price = bySymbol[binanceSymbol];
      if (!price) continue;
      batch.set(firestore.collection('market_reference').doc(otcId), {
        price, base: binanceSymbol, quote: 'USDT',
        source: 'binance-startup',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      count++;
    }
    if (count > 0) await batch.commit();
    console.log(`[crypto-reference] startup fetch — ${count}/${symbols.length} crypto OTC pair Firestore এ লেখা হলো`);
  } catch (e) {
    console.error('[crypto-reference] startup fetch ব্যর্থ:', e.message);
  }
}

async function _getReferencePrice(id) {
  try {
    const snap = await firestore.collection('market_reference').doc(id).get();
    if (!snap.exists) return null;
    const p = snap.data().price;
    return (typeof p === 'number' && p > 0) ? p : null;
  } catch (e) {
    console.error(`[market-reference] ${id} পড়তে ব্যর্থ:`, e.message);
    return null;   // ব্যর্থ হলে কিছুই বদলাবে না, market স্বাভাবিকভাবে চলবে
  }
}

/**
 * বর্তমান দাম real-world reference থেকে অনেক দূরে থাকলে একটা জাম্প-candle
 * দিয়ে ঠিক জায়গায় নিয়ে যায়। ফেরত দেয় চূড়ান্ত (সম্ভবত সংশোধিত) দাম।
 */
async function _snapToReferenceIfNeeded(id, price) {
  const ref = await _getReferencePrice(id);
  if (!ref) return price;   // reference নেই (crypto market, বা fetch ব্যর্থ) — অপরিবর্তিত

  const diff = Math.abs(price - ref) / ref;
  if (diff <= REFERENCE_JUMP_THRESHOLD) return price;   // যথেষ্ট কাছেই আছে

  // বড় ফারাক — এক candle এ জাম্প করে সংশোধন। wick টা পুরনো ও নতুন দাম
  // দুটোই ধরে রাখে (high/low), তাই chart এ real history দেখা যায়।
  const now = Date.now();
  const candleTime = Math.floor(now / 1000 / 60) * 60;
  saveCandle(id, {
    time:  candleTime,
    open:  price,
    high:  Math.max(price, ref),
    low:   Math.min(price, ref),
    close: ref,
  });
  console.warn(`[market-reference] ${id} — বড় ফারাক (${(diff*100).toFixed(1)}%), সংশোধন: ${price.toFixed(6)} → ${ref.toFixed(6)}`);
  return ref;
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

  // [MARKET REFERENCE] শুধু pre-existing market এর ক্ষেত্রেই সংশোধন করি
  // (crypto/নতুন market — baseSymbol/fixedStart থেকে already real price)।
  // "last" থাকা মানে এই market আগে থেকেই চলছিল, তাই drift জমে থাকতে পারে।
  if (last) {
    price = await _snapToReferenceIfNeeded(id, price);
  }

  _controls[id] = { mode:'auto', nextDirection:'auto', volatility:'medium', trendStrength:0.6, speedMultiplier:1.0 };
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
    subStates,
    // ── realistic engine state ──
    _regime: 'ranging',
    _regimeTick: _regimeDur('ranging'),
    _regimeDir: Math.random() < 0.5 ? 1 : -1,
    _candleConviction: 0.4,
    _cChar: 'normal',
    _cWickTend: 0.6,
    _cIndecision: 0.4,
    _cRejectDir: -1,
    _cRejectDone: false,
    _clusterTick: 5 + (Math.random()*12|0),
    _clusterDir: Math.random() < 0.5 ? 1 : -1,
    _clusterStr: 0.4 + Math.random()*0.5,
    _noiseX: Math.random()*1000,
    _noiseSeed: (Math.random()*1e9)|0,
    _levels: [],
    _swingTick: 0,
    _lastLevelHit: null,
    _fakeBreakTicks: 0,
    _fakeBreakDir: 0,
    _trendAge: 0,
    _actTick: 0,
    _actState: 'active',
    _actScale: 1.0,
    _actScaleCur: 1.0,
    _pendingDir: 0,
    _coilPressure: 0,
    _releaseDir: 0,
    _volSmooth: 0.3,
    _synCycle: undefined,
    _synBase: 50,
    _synSpikeTicks: 0,
    _synSpikeMag: 1,
    _recentHigh: price,
    _recentLow: price,
    _anchor: price,
    _velocity: 0,
    _friction: 0.85,
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

  // ══════════════════════════════════════════════════════════════════
  // [ENGINE] দামের সব physics engine.js এ। পুরনো inline physics
  // (regime, S/R, candle character, activity states) মুছে ফেলা হয়েছে —
  // engine চালু হওয়ার পর সেগুলো আর চলত না, শুধু ফাইল বড় করছিল।
  //
  // admin এর চারটা নিয়ন্ত্রণই এখানে মানা হয়:
  //   mode           — auto / manual
  //   nextDirection  — manual এ up / down (auto হলে engine নিজে ঠিক করে)
  //   trendStrength  — manual এ দিকের জোর
  //   volatility     — low / medium / high (পায়ের আকার)
  //   speedMultiplier— সব নড়াচড়ার গুণক
  // ══════════════════════════════════════════════════════════════════
  if (!state._eng) {
    // [DECIMALS] একটাই উৎস — decimalsFor() (উপরে সংজ্ঞায়িত)। table এ
    // থাকলে টেবিলের মান, নইলে ৬-সংখ্যার নিয়ম। আগে এখানে string-দৈর্ঘ্যের
    // fallback ছিল, যা crypto গুলোকে decimals ১৪-১৫ দিত।
    const dec = decimalsFor(id, state.price);
    state._eng = engine.createState(state.price, Math.max(1, dec));
    console.log(`[engine] ${id} — চালু (decimals: ${state._eng.decimals}${_MARKET_DECIMALS[id] ? ', table থেকে' : ', fallback দিয়ে'})`);
    // [REFERENCE ANCHOR] শুধু প্রথমবার engine তৈরি হওয়ার সময় Firestore
    // থেকে reference price পড়ি (প্রতি tick এ নয় — খরচ/গতি বাঁচাতে)।
    // ব্যর্থ হলেও কিছু আটকাবে না (referencePrice: 0 = anchor নিষ্ক্রিয়,
    // যেটা createState() এর নিরাপদ ডিফল্ট)।
    _getReferencePrice(id).then(ref => {
      if (ref && state._eng) state._eng.referencePrice = ref;
    }).catch(() => {});
    state._refRefreshAt = Date.now() + 3600000;   // ১ ঘণ্টা পর হালকা refresh
  } else if (Date.now() >= (state._refRefreshAt || Infinity)) {
    // পর্যায়ক্রমে refresh — Firebase এর দৈনিক আপডেট চলার সময় market
    // দীর্ঘক্ষণ চলতে থাকলেও নতুন reference ধরতে পারে।
    state._refRefreshAt = Date.now() + 3600000;
    _getReferencePrice(id).then(ref => {
      if (ref && state._eng) state._eng.referencePrice = ref;
    }).catch(() => {});
  }
  state._eng.price = state.price;          // বাইরে থেকে দাম বদলালে মেনে নেয়

  const volMul = { low: 0.4, medium: 1.0, high: 2.2 }[ctrl.volatility] || 1.0;
  const speed  = ctrl.speedMultiplier || 1.0;
  const manual = ctrl.mode === 'manual';
  const dir    = ctrl.nextDirection;

  state.price = engine.nextPrice(state._eng, Date.now(), {
    unit: engine.CFG.unit * volMul * speed,
    forceDir: manual ? (dir === 'up' ? 1 : dir === 'down' ? -1 : 0) : 0,
    trendStrength: ctrl.trendStrength ?? 0.6,
  });

  // [TICK IDENTITY] প্রতিটা tick এর canonical price/timestamp সংরক্ষণ —
  // entry (visible tickId lookup) ও settlement (expiry-এর আগের শেষ tick)
  // দুটোই এই একই history থেকে resolve হবে।
  tickHistory.recordTick(id, state._eng.tickId, Date.now(), state.price);

  _tickTail(id, state);
}


function _tickTail(id, state) {
  const now = Date.now();

  if (state.price > state.candleHigh) state.candleHigh = state.price;
  if (state.price < state.candleLow)  state.candleLow  = state.price;

  if (now >= state.nextCandle) {
    // trade.expiryTimestamp = candle close time (= next candle's open time), candleTime এ candle open time থাকে
    const closedCandleTime  = state.nextCandle / 1000;
    const closedCandleClose = state.price;
    // [DECIMALS SYNC] engine যে decimals ব্যবহার করছে (settlement এও যা
    // ব্যবহার হয়) সেটাই candle data এর সাথে পাঠাই। আগে frontend নিজের
    // magnitude-অনুমান দিয়ে decimals ঠিক করত, যা backend থেকে আলাদা হয়ে
    // যেত (যেমন AUD/USD 0.7042 এ ছোট নড়াচড়া display এ হারিয়ে যেত)।
    const _dec = state._eng ? state._eng.decimals : 5;   // [SAFETY] undefined RTDB write ব্যর্থ করে দেয়, তাই ৫ (আগের default) fallback
    saveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.price, decimals:_dec });
    // [GAP FIX] closed candle-এর final close (এই tick-এর দাম) WS/Redis এ
    // কখনো broadcast হতো না। ফলে frontend candle N কে আগের tick-এর দামে
    // finalize করত, আর candle N+1 খুলত এই tick-এর দামে → ঠিক এক tick-এর
    // gap। RTDB-তে candle N-এর close সঠিক থাকায় reload দিলে gap উধাও হতো।
    // এখানে state mutate হওয়ার আগেই closed candle-এর final state publish
    // করা হচ্ছে — এর ঠিক পরেই (নিচে) candle N+1 broadcast হবে, order
    // preserved (একই Redis connection)।
    saveLiveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.price, nextCandle:state.nextCandle, decimals:_dec, tickId: (state._eng ? state._eng.tickId : 0) }, true);
    // [BILL] এখানে আগে `otc_candles/${id}/live` এ আরেকটা `.set()` ছিল —
    // ঠিক উপরের saveLiveCandle() যে object টা একই path এ লিখেছে, হুবহু
    // সেটাই দ্বিতীয়বার। মাঝে state এর কোনো মান বদলায় না, তাই লেখা দুটো
    // অভিন্ন ছিল। Railway network বিল কমাতে পুনরাবৃত্তিটা সরানো হলো —
    // /live এখনো প্রতি candle-close এ closed candle এর final value ই
    // পায় (saveLiveCandle থেকে), আচরণ অপরিবর্তিত।

    // ── candle just closed — এই মুহূর্তের close price দিয়ে matching live trades settle করো ──
    // Synchronously mark — একই tick-এ _settleDueTradesFromMemory এই symbol skip করবে
    _candleSettlingSymbols.add(id);
    settleTradesForCandle(id, closedCandleTime, closedCandleClose).catch(() => {
      _candleSettlingSymbols.delete(id);
    });

    state.candleTime = state.nextCandle/1000; state.candleOpen = state.price;
    state.candleHigh = state.price; state.candleLow = state.price;
    state.nextCandle += CANDLE_MS;
    // [FIX] tick দেরিতে এলে (জমাটে ব্যবধান বড় হয়) একাধিক candle পার হয়ে
    // যেতে পারে। আগে এখানে শুধু সময় এগোত, কিন্তু open/high/low পুরনোই
    // থেকে যেত — ফলে নতুন candle পুরনো শিখর নিয়ে শুরু করত আর বিশাল
    // wick দেখাত। এখন প্রতিটা এড়িয়ে যাওয়া candle এও নতুন করে বসে।
    while (state.nextCandle <= now) {
      state.candleTime = state.nextCandle/1000;
      state.candleOpen = state.price;
      state.candleHigh = state.price;
      state.candleLow  = state.price;
      state.nextCandle += CANDLE_MS;
    }

    // [GAP-CONSISTENCY FIX] আগে candle-boundary পার হওয়ার এই একই cycle এ
    // saveLiveCandle() (running-candle broadcast) কল হতো না — শুধু else
    // branch এ (normal, non-boundary tick) হতো। ফলে নতুন candle এর
    // candleOpen set হওয়ার সাথে সাথেই frontend সেটা পেত না — পরের tick
    // পর্যন্ত অপেক্ষা করতে হতো, যতক্ষণে state.price ইতিমধ্যে একটু এগিয়ে
    // যেত। এই এক-tick miss-ই ছিল live chart-এ যে gap দেখা যাচ্ছিল,
    // RTDB-persisted candle এ সেটা reflect না হওয়ার root cause — কারণ
    // otcengine.js এর live-merge (_mergeIntoHTF) নতুন HTF candle শুরুর
    // সময় ঠিক এই broadcast এর candle.open ব্যবহার করে, যেটা miss হলে
    // সঠিক gap-open কখনো broadcast-ই হতো না। এখন candle-boundary পার
    // হওয়ার সাথে সাথেই (এই একই cycle এ) নতুন candleOpen দিয়ে broadcast
    // করা হচ্ছে — কোনো tick miss নেই।
    saveLiveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.candleOpen, nextCandle:state.nextCandle, decimals: (state._eng ? state._eng.decimals : 5), tickId: (state._eng ? state._eng.tickId : 0) }, true);
  } else {
    saveLiveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:state.price, nextCandle:state.nextCandle, decimals: (state._eng ? state._eng.decimals : 5), tickId: (state._eng ? state._eng.tickId : 0) });
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
      // [FIX] এড়িয়ে যাওয়া candle এও open/high/low নতুন করে — নইলে
      // পুরনো শিখর বয়ে নিয়ে গিয়ে বিশাল wick দেখাত (উপরে একই সংশোধন)
      while (ss.nextCandle <= now) {
        ss.candleTime = ss.nextCandle / 1000;
        ss.candleOpen = state.price;
        ss.candleHigh = state.price;
        ss.candleLow  = state.price;
        ss.nextCandle += ss.ms;
      }
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

  // [TICK IDENTITY] forex market এ engine.js নেই (real broker-price
  // ব্যবহার হয়), তাই এখানে state এর নিজস্ব সাধারণ monotonic counter —
  // OTC এর engine-tickId এর সমতুল্য ভূমিকা পালন করে।
  state._forexTickId = (state._forexTickId || 0) + 1;
  tickHistory.recordTick(id, state._forexTickId, now, price);

  if (price > state.candleHigh) state.candleHigh = price;
  if (price < state.candleLow)  state.candleLow  = price;
  if (now >= state.nextCandle) {
    // trade.expiryTimestamp = candle close time (= next candle's open time), candleTime এ candle open time থাকে
    const closedCandleTime  = state.nextCandle / 1000;
    const closedCandleClose = price;
    // [DECIMALS FIX] real (forex/crypto) path এ decimals কখনোই পাঠানো
    // হতো না — frontend তখন আগের market এর _decimals ধরে বসে থাকত।
    // তাই BNB/USDT OTC (তখন ভুলভাবে ১৫) দেখার পর real BNB/USDT এ গেলে
    // সেখানেও ১৫ ঘর দেখাত। এখন তিনটি write ই decimals বহন করে।
    const _rdec = decimalsFor(id, price);
    saveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:price, decimals:_rdec });
    // [GAP FIX — REAL PATH] OTC path এ (tickOTC) এই সংশোধন আগেই যোগ
    // করা হয়েছিল, কিন্তু real (forex/crypto) path এ যায়নি — তাই
    // BTC/USDT, BNB/USDT সহ সব Binance/FOREX market এ candle
    // gap-up/gap-down bug টা রয়ে গিয়েছিল।
    //
    // কারণ একই: স্বাভাবিক tick এ নিচের else-শাখা saveLiveCandle()
    // দিয়ে Redis/WS এ broadcast করে, কিন্তু candle boundary তে শুধু
    // RTDB তে লেখা হতো। ফলে WS-শ্রোতা frontend candle N এর *final*
    // close কখনো পেত না — সে candle N কে আগের tick এর দামে finalize
    // করত আর candle N+1 খুলত এই tick এর দামে → ঠিক এক tick এর gap।
    // reload দিলে RTDB এর সঠিক close আসত বলে gap উধাও হয়ে যেত।
    //
    // এখানে state mutate হওয়ার আগেই closed candle এর final state
    // publish করা হচ্ছে; ঠিক পরেই candle N+1 broadcast হবে, একই Redis
    // connection বলে ক্রম অক্ষুণ্ন থাকে।
    saveLiveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:price, nextCandle:state.nextCandle, decimals:_rdec, tickId: (state._forexTickId || 0) }, true);
    // [BILL] OTC path এর মতোই এখানেও `otc_candles/${id}/live` এ একটা
    // অভিন্ন দ্বিতীয় `.set()` ছিল — ঠিক উপরের saveLiveCandle() যা
    // লিখেছে তারই নকল। সরানো হলো, আচরণ অপরিবর্তিত।

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
    saveLiveCandle(id, { time:state.candleTime, open:state.candleOpen, high:state.candleHigh, low:state.candleLow, close:price, nextCandle:state.nextCandle, decimals: decimalsFor(id, price), tickId: (state._forexTickId || 0) });
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
      // [FIX] এড়িয়ে যাওয়া candle এও open/high/low নতুন করে — নইলে
      // পুরনো শিখর বয়ে নিয়ে গিয়ে বিশাল wick দেখাত (উপরে একই সংশোধন)
      while (ss.nextCandle <= now) {
        ss.candleTime = ss.nextCandle / 1000;
        ss.candleOpen = state.price;
        ss.candleHigh = state.price;
        ss.candleLow  = state.price;
        ss.nextCandle += ss.ms;
      }
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
  // [MARKET REFERENCE] watchFirestoreMarkets() (যেটা initOTC ডাকে) এর
  // আগেই real price fetch করে ফেলি, যাতে market শুরু হওয়ার সময় সংশোধনের
  // জন্য দরকারি ডেটা ইতিমধ্যে Firestore এ থাকে — deploy করার সাথে সাথেই
  // কাজ করে, দৈনিক schedule এর জন্য অপেক্ষা করতে হয় না।
  await _fetchAndStoreReferencePrices();
  // [CRYPTO REFERENCE] crypto OTC এর উৎস আলাদা (Binance), তাই আলাদা
  // fetch — কিন্তু একই সময়ে, market শুরু হওয়ার আগেই।
  await _fetchAndStoreCryptoReferencePrices();
  watchFirestoreMarkets();
  await _recoverLiveTradesFromRTDB();
  // ══════════════════════════════════════════════════════════════════
  // [TICK RHYTHM] প্রতিটা market নিজের ছন্দে tick পাঠায়।
  // engine চললে ছন্দ engine.nextDelay() থেকেই আসে — ঝলকে দ্রুত, শ্বাসে
  // ধীর, মাঝে মাঝে ঝাঁক। আগে স্থির ৫০০ms ছিল, তাই পরীক্ষার পাতার মত
  // লাগত না (ওখানে গড় ~৩২০ms ও অসম)।
  // settlement আগের মতোই স্থির ছন্দে — কোনো পরিবর্তন নেই।
  // ══════════════════════════════════════════════════════════════════
  const _tickTimers = {};

  function _tickDelay(id) {
    const st = _states[id];
    if (ENGINE_MODE && st && st._eng) return engine.nextDelay(st._eng);
    return TICK_MS * (0.75 + Math.random() * 0.5);   // পুরনো physics এর জন্য
  }

  function _scheduleTick(id) {
    _tickTimers[id] = setTimeout(() => {
      if (!_activeMarkets.has(id)) { delete _tickTimers[id]; return; }
      try {
        const st = _states[id];
        if (st?.type === 'otc')   tickOTC(id);
        if (st?.type === 'forex') tickForex(id);
      } catch (e) {
        console.error(`[tick] ${id}:`, e.message);
      }
      _scheduleTick(id);
    }, _tickDelay(id));
  }

  setInterval(() => {
    // সক্রিয় market এর ছন্দ চালু আছে কিনা দেখি, বন্ধ হলে timer সরাই
    _activeMarkets.forEach(id => { if (!_tickTimers[id]) _scheduleTick(id); });
    Object.keys(_tickTimers).forEach(id => {
      if (!_activeMarkets.has(id)) { clearTimeout(_tickTimers[id]); delete _tickTimers[id]; }
    });
    // [LATENCY] memory path এখন ১০০ms এ — এটা RAM এর উপর লুপ, কোনো
    // I/O নেই, তাই খরচ নগণ্য। আগে ৫০০ms ছিল, অর্থাৎ ট্রেড শেষ হওয়ার
    // পর গড়ে ২৫০ms শুধু পরের চক্রের অপেক্ষায় যেত।
    _settleDueTradesFromMemory().catch(e => console.error('[tick-settle] error:', e.message));
  }, 100);

  // RTDB path আলাদা, ধীর ছন্দে — এটা প্রতিবার RTDB পড়ে, তাই ১০০ms এ
  // চালালে Firebase read খরচ ৫ গুণ বাড়ত। এর কাজ শুধু restart/crash এ
  // হারানো trade উদ্ধার, তাই ৫০০ms ই যথেষ্ট।
  setInterval(() => {
    _settleDueTradesFromRTDB().catch(e => console.error('[rtdb-tick-settle] error:', e.message));
  }, TICK_MS);
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

      // ── [SECURITY] entry price server এর engine থেকে ─────────────────
      // আগে client এর পাঠানো entryPrice সরাসরি বসত — browser এর কোড বদলে
      // যেকেউ নিজের পছন্দমতো দাম পাঠিয়ে প্রায় নিশ্চিত জেতা trade বানাতে
      // পারত। এখন এই server এ চলা market এর জন্য নিজের engine এর দামই
      // ব্যবহার হয়। যে market এখানে চলে না (যেমন real crypto), সেখানে
      // client এর মানই থাকে — trade কখনো বাতিল করা হয় না, শুধু দাম সংশোধন
      // (ধীর নেটওয়ার্কে আসল user এর trade যেন আটকে না যায়)।
      const _clientEntry = parseFloat(trade.entryPrice) || 0;
      const _serverState = _states[trade.symbol];
      const _serverPrice = (_serverState && typeof _serverState.price === 'number')
                           ? _serverState.price : 0;

      // [TICK IDENTITY — exact match, সর্বোচ্চ priority] client যদি ঠিক
      // কোন tickId visually দেখে click করেছে সেটা পাঠায়, backend এর
      // tick-history তে সেই exact tick খুঁজে তার canonical price নেওয়া
      // হয় — এটা approximate timestamp-lookup এর চেয়ে বেশি নির্ভুল,
      // কারণ network-delay/animation-delay যাই হোক না কেন, ঠিক সেই
      // visible tick-ই ব্যবহার হবে। tickId history-window এর বাইরে চলে
      // গেলে (খুব পুরনো/tampered) এখানে null আসবে, fallback নিচে।
      let _tickIdEntry = 0;
      const _visibleTickId = trade.visibleTickId;
      if (_visibleTickId !== undefined && _visibleTickId !== null) {
        const _tick = tickHistory.findTickById(trade.symbol, _visibleTickId);
        // [SECURITY — TICK STALENESS] tick টা পাওয়া গেলেই যথেষ্ট নয়,
        // সেটা *এই মুহূর্তের* tick কিনা তাও দেখতে হবে।
        //
        // tickhistory.js প্রতি symbol এ ৫০০০ tick রাখে — বর্তমান
        // cadence এ প্রায় ৭৯ মিনিট। বয়স যাচাই না করায় যেকোনো পুরনো
        // tickId পাঠিয়ে সেই সময়ের দামে entry নেওয়া যেত, অর্থাৎ
        // ফলাফল আগে থেকে জেনে trade করা — কার্যত নিশ্চিত জয়।
        //
        // এটা কেবল তাত্ত্বিক আক্রমণ নয়: tab background এ গেলে
        // chartengine এর RAF জমে যায় আর _visibleTickId পুরনো tick এ
        // আটকে থাকে। লাইভ মাপা হয়েছে — ১৩.৬ মিনিট পুরনো tickId,
        // ৪৪ pip দামের পার্থক্য। অর্থাৎ শুধু ট্যাব বদলালেই সাধারণ
        // user দুর্ঘটনাক্রমে এই সুবিধা পেয়ে যেত।
        //
        // clickTs fallback পথে ইতিমধ্যেই ±২ সেকেন্ডের drift-check আছে
        // (নিচে), কিন্তু tickId পথের অগ্রাধিকার বেশি হওয়ায় সেটা এড়িয়ে
        // যেত। একই ২ সেকেন্ড সীমা এখানেও প্রয়োগ করা হলো।
        //
        // [LIVE SAFETY] বাসি হলে trade *বাতিল* করা হয় না — শুধু এই
        // পথটা ছেড়ে নিচের স্বাভাবিক fallback chain এ যায় (clickTs →
        // server price)। তাই কারও বৈধ trade আটকাবে না।
        if (_tick) {
          const _tickAge = Math.abs(Date.now() - _tick.timestamp);
          if (_tickAge <= 2000) {
            _tickIdEntry = _tick.price;
          } else {
            console.warn(`[place-trade] tickId=${_visibleTickId} বাসি (${_tickAge}ms পুরনো) — উপেক্ষা, fallback ব্যবহার হবে (userId=${userId})`);
          }
        } else {
          console.warn(`[place-trade] visibleTickId=${_visibleTickId} history তে পাওয়া যায়নি (userId=${userId}) — fallback ব্যবহার হবে`);
        }
      }

      // [TICK HISTORY — fallback] client tickId না পাঠালে (পুরনো client)
      // বা tickId history তে না পেলে, আগের timestamp-based approximate
      // lookup fallback হিসেবে থাকে। নেটওয়ার্কে ১০০-৩০০ms দেরির কারণে
      // দাম বদলে যাওয়ার সমস্যা এতে আংশিক মেটে। সময় যাচাই: server
      // সময়ের ±২ সেকেন্ডের মধ্যে হতে হবে, নইলে কেউ পুরনো সময় পাঠিয়ে
      // সুবিধা নিতে পারত।
      let _histEntry = 0;
      const _clickTs = parseInt(trade.clickTs) || 0;
      if (_tickIdEntry === 0 && _clickTs > 0) {
        const _drift = Math.abs(Date.now() - _clickTs);
        if (_drift <= 2000) {
          const _hp = await _histPriceAt(trade.symbol, _clickTs);
          if (_hp) _histEntry = _hp;
        } else {
          console.warn(`[place-trade] clickTs drift=${_drift}ms — উপেক্ষা (userId=${userId})`);
        }
      }

      const entryPrice = _tickIdEntry > 0 ? _tickIdEntry
                       : (_histEntry > 0 ? _histEntry
                       : (_serverPrice > 0 ? _serverPrice : _clientEntry));
      if (_serverPrice > 0 && _clientEntry > 0) {
        const _diffPct = Math.abs(_serverPrice - _clientEntry) / _serverPrice * 100;
        if (_diffPct > 0.5) {
          console.warn(`[place-trade] entryPrice mismatch userId=${userId} symbol=${trade.symbol} client=${_clientEntry} server=${_serverPrice} diff=${_diffPct.toFixed(3)}%`);
        }
      }

      // ══════════════════════════════════════════════════════════════
      // [SECURITY — EXPIRY] trade কখন শেষ হবে সেটা client এর হাতে
      // ছেড়ে দেওয়া যায় না।
      //
      // আগে expiryTimestamp / expiryTimestampMs দুটোই client যা পাঠাত
      // তাই যাচাই ছাড়া Redis এ বসে যেত। অর্থাৎ কেউ browser থেকে অতীতের
      // একটা মুহূর্ত পাঠালে trade সাথে সাথেই settle হতো — এমন দামের
      // বিপরীতে যেটা সে আগেই জেনে গেছে। পুরনো visibleTickId এর সাথে
      // মিলিয়ে দিলে entry ও close দুটোই বেছে নেওয়া যেত = নিশ্চিত জয়।
      //
      // এখানে server নিজে duration থেকে expiry হিসাব করে। client এর
      // মান তখনই মানা হয় যখন সেটা server এর হিসাবের কাছাকাছি — এতে
      // 'time' mode এর ঘড়ি-মিলানো expiry (যেটা ঠিক মিনিটের মাথায়
      // পড়ে) অক্ষত থাকে।
      //
      // [LIVE SAFETY] এখানে কোনো trade *reject* করা হয় না — সীমার
      // বাইরে গেলে শুধু server এর মান ব্যবহার হয় ও log হয়। তাই
      // timesync drift বা ধীর নেটওয়ার্কে কারও trade আটকাবে না।
      // সহনশীলতা ৫ সেকেন্ড রাখা হয়েছে কারণ মাপা clockOffset ২ সেকেন্ড
      // পর্যন্ত ওঠানামা করে (timesyncmanager.js এর আলাদা issue)।
      // ══════════════════════════════════════════════════════════════
      const _EXP_TOLERANCE_MS = 5000;
      const _nowMs    = Date.now();
      const _duration = parseInt(trade.duration) || 0;
      let _expiryMs   = parseInt(trade.expiryTimestampMs) || 0;

      if (_duration > 0) {
        const _serverExpiryMs = _nowMs + _duration * 1000;
        if (_expiryMs <= _nowMs || Math.abs(_expiryMs - _serverExpiryMs) > _EXP_TOLERANCE_MS) {
          console.warn(`[place-trade] expiry সংশোধন userId=${userId} client=${_expiryMs} server=${_serverExpiryMs} duration=${_duration}s`);
          _expiryMs = _serverExpiryMs;
        }
      } else if (_expiryMs <= _nowMs) {
        // duration নেই (পুরনো client) অথচ expiry অতীতে — একমাত্র যে
        // ক্ষেত্রে duration ছাড়া কিছু করার নেই, সেখানে client এর
        // সেকেন্ড-field থেকে নেওয়া হয়, নইলে 0 (পুরনো fallback path)।
        const _secMs = (parseInt(trade.expiryTimestamp) || 0) * 1000;
        _expiryMs = _secMs > _nowMs ? _secMs : 0;
      }

      // settlement-queue এর সেকেন্ড-bucket সবসময় প্রকৃত expiry এর
      // সমান বা পরে থাকতে হবে — নইলে queue আগে চলে গিয়ে এমন tick
      // খুঁজত যেটা তখনো তৈরি হয়নি।
      const _expirySec = _expiryMs > 0
        ? Math.ceil(_expiryMs / 1000)
        : (parseInt(trade.expiryTimestamp) || 0);

      // 3. [BALANCE RESERVATION] atomic reserve — সাথে সাথেই deduct হয়
      // (double-spend প্রতিরোধ, ১০০টা click একসাথে এলেও Redis
      // sequentially process করে), কিন্তু trade "pending" থাকে যতক্ষণ
      // না frontend জানায় chart visually এই entryPrice এ পৌঁছেছে।
      const balKey = BAL_KEY_OTC(userId);

      let { ok, newBalance, reservationId } = await tradeReservation.reserveTradeBalance(
        redisPub, balKey, amount, entryPrice, Date.now()
      );

      if (ok === -1) {
        // Redis miss — Firestore থেকে load করে cache, তারপর আবার atomic reserve
        const snap = await firestore.collection('users').doc(userId).get();
        const bal  = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600, 'NX');
        ({ ok, newBalance, reservationId } = await tradeReservation.reserveTradeBalance(
          redisPub, balKey, amount, entryPrice, Date.now()
        ));
      }

      if (ok !== 1) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Insufficient balance', balance: newBalance }));
        return;
      }

      const newBal = newBalance;
      await redisPub.set(`gv:bal:dirty:${userId}`, '1', 'EX', 3600);

      console.log(`[place-trade] userId=${userId} tradeId=${tradeId} amount=${amount} newBal=${newBal} reservationId=${reservationId}`);

      // 4. Redis Hash এ trade data save — settler <1ms এ পাবে
      await redisPub.hset(TRADE_KEY_OTC(tradeId),
        'userId',          userId,
        'symbol',          trade.symbol || '',
        'entryPrice',      String(entryPrice),   // [SECURITY] server এর দাম
        'amount',          String(amount),
        'type',            trade.type || '',
        'payoutPercent',   String(trade.payoutPercent || 92),
        'status',          'live',
        'accountType',     'live',
        'expiryTimestamp', String(_expirySec || 0),   // [SECURITY] server-যাচাই করা
        // [PRECISION FIX] settlement এর সময় ms-নির্ভুল দাম খুঁজতে —
        // না থাকলে (পুরনো client) 0, তখন fallback সেকেন্ড-ভিত্তিক path
        'expiryTimestampMs', String(_expiryMs || 0),   // [SECURITY] server-যাচাই করা
        // [TIE PRECISION] settler কে জানাতে হবে এই market এ দাম কত ঘরে
        // দেখানো হয়। কারণ user পর্দায় গোল-করা দাম দেখে (USD/COP ২ ঘর),
        // অথচ settler হুবহু float তুলনা করত — তাই "Difference 0" দেখেও
        // trade lost হত। এখন settler এই ঘর অনুযায়ী তুলনা করবে।
        'decimals',        String(decimalsFor(trade.symbol, entryPrice)),
        'currency',        trade.currency || 'USD',
      );
      // [MAX DURATION] সর্বোচ্চ ৪ ঘণ্টার trade + ১ ঘণ্টা নিরাপত্তা মার্জিন।
      // আগে ২ ঘণ্টা ছিল — ২ ঘণ্টার বেশি trade এ Redis থেকে তথ্য মুছে গিয়ে
      // settlement ভেঙে পড়ত।
      await redisPub.expire(TRADE_KEY_OTC(tradeId), 18000); // 5h TTL

      // 5. RTDB settlement_queue write — otc-server candle close এ এখান থেকে পাবে
      db.ref(`settlement_queue/${_expirySec}/${userId}/${tradeId}`).set({
        userId, tradeId,
        symbol:      trade.symbol || '',
        accountType: 'live',
        type:        trade.type || '',
        amount:      amount,
        feedType:    trade.feedType || '',
        entryPrice,   // [SECURITY] server এর দাম
        // [PRECISION FIX] path key (সেকেন্ড) অপরিবর্তিত রাখা হলো — শুধু
        // data এর ভেতরে ms-নির্ভুল expiry যোগ, settlement এ ব্যবহার হবে
        expiryTimestampMs: _expiryMs || 0,   // [SECURITY] server-যাচাই করা
      }).catch(e => console.error('[place-trade] RTDB queue failed:', e.message));

      // [SCALE ২.১] in-memory map এ যোগ — আগে Firestore listener এটা করত।
      // এতে tick-settle (সবচেয়ে দ্রুত পথ) Firestore ছাড়াই কাজ করে।
      _activeTradesMemory.set(`${userId}/${tradeId}`, {
        userId, tradeId,
        symbol:            trade.symbol || '',
        expiryTimestamp:   _expirySec || 0,   // [SECURITY] server-যাচাই করা
        expiryTimestampMs: _expiryMs || 0,   // [PRECISION FIX] + server-যাচাই করা
        accountType:       'live',
        status:            'live',
        type:              trade.type || '',
        amount:            amount,
      });

      // [MTG PROTECTION] নতুন trade placement track করি (single-trader
      // pattern detection এর জন্য) — win/loss তখনো জানা নেই, শুধু
      // direction+amount দিয়ে repeat/growth pattern দেখা হবে।
      mtgGuard.recordResult(userId, trade.type || '', null, amount);

      // 6. Firestore trade save — background, non-blocking
      // [DECIMALS SYNC] tradehistorymanager.js এ Open/Close/Difference
      // এখন এই field ব্যবহার করবে (নিজের magnitude-অনুমান বাদ দিয়ে) —
      // chartengine.js তে যেমন করা হয়েছিল, একই ধরনের সংশোধন।
      const _tradeDecimals = _states[trade.symbol]?._eng?.decimals;
      firestore.collection('users').doc(userId).collection('trades').doc(tradeId).set({
        ...trade,
        entryPrice,   // [SECURITY] client এর মান override — server এর দামই নথিতে
        // [SECURITY] expiry ও server-যাচাই করা মান দিয়ে override — নইলে
        // Redis/queue এ এক সময় আর Firestore নথিতে অন্য সময় থাকত, এবং
        // পরে বিতর্ক হলে নথিটাই ভুল প্রমাণ দিত।
        expiryTimestamp:   _expirySec || 0,
        expiryTimestampMs: _expiryMs   || 0,
        decimals:   _tradeDecimals || 5,   // [DECIMALS SYNC] fallback ৫ — undefined Firestore write ব্যর্থ করে না, কিন্তু নিরাপত্তার জন্য সংখ্যা রাখা ভালো
        redisDeducted: true,   // [১.৩] Redis এ balance কাটা হয়েছে — settler TTL miss
                               // এ এটা দেখেই বুঝবে জিতলে credit দেওয়া নিরাপদ
        userId,
        tradeLine:  null,
        createdAt:  admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => console.error('[place-trade] Firestore save failed:', e.message));

      // ══════════════════════════════════════════════════════════════
      // [ORPHAN GUARD] trade এখন সব জায়গায় লেখা হয়ে গেছে (Redis hash,
      // settlement queue, memory, Firestore) — অর্থাৎ /place-trade
      // সম্পূর্ণ সফল। তাই reservation কে 'executed' করে pending-index
      // থেকে সরিয়ে দিই।
      //
      // কেন জরুরি: frontend কখনোই /execute-trade কল করে না
      // (tradeengine.js এ এর কোনো caller নেই), অথচ trade এখানেই
      // চূড়ান্ত হয়ে যায়। ফলে প্রতিটা reservation 'pending' থেকে যেত,
      // আর orphan-sweep সেটা দেখে টাকা ফেরত দিয়ে দিত — অথচ trade
      // বাতিল হতো না, settle হয়ে payout ও দিত। user stake ফেরত পেত
      // আর trade ও চালাত। ৫s trade এ ঝুঁকি সবচেয়ে বেশি ছিল, কারণ
      // সেটা reservation এর আয়ুর ভেতরেই settle হয়ে যায়।
      //
      // এখন status ই প্রমাণ: 'executed' = trade সত্যিই বসেছে, টাকা
      // ন্যায্যভাবে কাটা। আর server এই লাইনে পৌঁছানোর আগে মরে গেলে
      // status 'pending' থেকে যাবে ও sweep কয়েক সেকেন্ডেই টাকা ফেরত
      // দেবে — দুই পক্ষই ন্যায্য।
      // ══════════════════════════════════════════════════════════════
      tradeReservation.executeReservation(redisPub, reservationId)
        .catch(e => console.error('[place-trade] reservation execute failed:', e.message));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal), reservationId, entryPrice }));

    } catch(e) {
      console.error('[place-trade] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // [BALANCE RESERVATION — EXECUTE] frontend যখন জানায় chart visually
  // reserved entryPrice এ পৌঁছেছে (queue-based animation শেষ), তখন এই
  // endpoint কল হয় — reservation কে চূড়ান্ত করে, trade "live" করে দেয়।
  // Balance ইতিমধ্যেই reserve-time এ deduct হয়ে গেছে, এখানে শুধু trade
  // এর RTDB hash এ status/visibility আপডেট হয়।
  // ══════════════════════════════════════════════════════════════════
  // [WS AUTH] settlement ফল WebSocket এ পাঠাতে হলে ws-server কে জানতে
  // হবে কোন socket কোন user এর — নইলে একজনের ফল আরেকজন দেখে ফেলবে।
  //
  // ws-server এ firebase-admin যোগ না করে সমাধান: এখানে (যেখানে
  // idToken যাচাই করার সব ব্যবস্থা আছে) একটা এলোমেলো short-lived token
  // বানিয়ে Redis এ uid এর সাথে বেঁধে রাখি। client সেটা socket এ পাঠায়,
  // ws-server শুধু Redis এ দেখে নেয় — তার Redis সংযোগ আগে থেকেই আছে।
  //
  // token এলোমেলো ৩২ byte, TTL ১০ মিনিট, একবার ব্যবহারে মুছে যায় না
  // (পুনঃসংযোগে দরকার হয়), কিন্তু মেয়াদ শেষে নিজেই উধাও।
  // ══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && req.url === '/ws-token') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken } = body;
      if (!idToken) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing idToken' })); return; }

      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }

      if (!redisReady) { res.writeHead(503); res.end(JSON.stringify({ error: 'Not ready' })); return; }

      const token = require('crypto').randomBytes(32).toString('hex');
      await redisPub.set(`gv:wstoken:${token}`, decoded.uid, 'EX', 600);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, token, expiresIn: 600 }));
    } catch (e) {
      console.error('[ws-token] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/execute-trade') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, reservationId, tradeId } = body;
      if (!idToken || !reservationId || !tradeId) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Missing fields' })); return;
      }

      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }

      const executed = await tradeReservation.executeReservation(redisPub, reservationId);
      if (!executed) {
        // ইতিমধ্যে executed/released/expired — duplicate call বা timeout
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Reservation not pending (already executed, released, or expired)' }));
        return;
      }

      console.log(`[execute-trade] userId=${decoded.uid} tradeId=${tradeId} reservationId=${reservationId} executed`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));

    } catch(e) {
      console.error('[execute-trade] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // [BALANCE RESERVATION — RELEASE] client trade বাতিল করলে (submit-এর
  // পরে কিন্তু execute-এর আগে user app বন্ধ করলো ইত্যাদি) balance ফেরত।
  // TTL (১০s) এমনিতেই safety-net হিসেবে আছে, কিন্তু explicit release
  // হলে user সাথে সাথে balance ফেরত দেখতে পায়, ১০ সেকেন্ড অপেক্ষা না করে।
  if (req.method === 'POST' && req.url === '/release-trade') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, reservationId } = body;
      if (!idToken || !reservationId) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Missing fields' })); return;
      }

      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }

      const balKey = BAL_KEY_OTC(decoded.uid);
      const released = await tradeReservation.releaseReservation(redisPub, reservationId, balKey);
      if (released) {
        await redisPub.set(`gv:bal:dirty:${decoded.uid}`, '1', 'EX', 3600);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: released }));

    } catch(e) {
      console.error('[release-trade] error:', e.message);
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

      // [SECURITY ১.২] atomic claim — status live → sold একবারে।
      // credit করার আগেই দখল নিই; settler ইতিমধ্যে settle করে থাকলে claim=0,
      // তখন sell বাতিল (দুবার credit হবে না)।
      const _claimed = await redisPub.gvClaimTrade(TRADE_KEY, 'sold');
      if (_claimed !== 1) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Trade already settled' })); return;
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
      // status 'sold' ইতিমধ্যে atomic claim এ লেখা হয়েছে — আলাদা hset লাগে না

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

// [BALANCE RESERVATION — ORPHAN RECOVERY] যদি /place-trade মাঝপথে
// ব্যর্থ হয় (server crash, Redis hiccup) — টাকা কেটে গেছে কিন্তু trade
// কোথাও লেখা হয়নি — তখন reservation 'pending' থেকে যায়। এই কাজটা
// সেগুলো খুঁজে user কে টাকা ফেরত দেয়।
//
// আগে এটা প্রতি ৩০ সেকেন্ডে SCAN দিয়ে চলত, অথচ reservation বাঁচত
// মাত্র ১০ সেকেন্ড — তাই বেশির ভাগ orphan ধরাই পড়ত না, টাকা হারিয়ে
// যেত। এখন pending-index (ZSET) থেকে একটাই কলে মেয়াদোত্তীর্ণদের পাওয়া
// যায়, খরচ প্রায় স্থির — তাই প্রতি ২ সেকেন্ডে চালানো নিরাপদ, আর
// প্রতিটা orphan ৩-৫ সেকেন্ডের মধ্যেই ফেরত হয়।
setInterval(async () => {
  if (!redisReady) return;
  try {
    const { released, lost } = await tradeReservation.sweepExpiredReservations(redisPub);
    if (released > 0) console.log(`[reservation-sweep] ${released} টা orphaned reservation এর টাকা ফেরত দেওয়া হলো`);
    // lost > 0 মানে reservation-hash TTL এ মুছে গিয়েছিল sweep পৌঁছানোর
    // আগেই — টাকা ফেরত দেওয়া যায়নি। এটা কখনো দেখা গেলে interval বা
    // hash TTL বাড়াতে হবে, তাই আলাদা করে চিহ্নিত করা হলো।
    if (lost > 0) console.error(`[reservation-sweep] ⚠️ ${lost} টা reservation এর তথ্য পাওয়া যায়নি — টাকা ফেরত দেওয়া যায়নি`);
  } catch (e) {
    console.error('[reservation-sweep] error:', e.message);
  }
}, 2*1000);