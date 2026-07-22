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

// ── Redis client ──
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

// ── Redis safe helper ──
async function redisSafe(op, ...args) {
    if (!redisPub || !redisReady) throw new Error('Redis not ready');
    return redisPub[op](...args);
}

const TICK_MS   = 500;
const CANDLE_MS = 60 * 1000;
const TD_KEY    = '392fa09f669c4cd7843f958e0fbbca36';

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

const SETTLE_FUNCTION_URL       = 'https://us-central1-goldvest-cf73d.cloudfunctions.net/settleTrade';
const BATCH_SETTLE_FUNCTION_URL = 'https://us-central1-goldvest-cf73d.cloudfunctions.net/batchSettle';
const SETTLE_TOKEN        = process.env.SETTLE_TOKEN || 'gv_settle_secret_2024';

// ── Batch broadcast ──
const _userSettleQueue = new Map();
const _userSettleTimers = new Map();

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

// ── Batch settle ──
async function _batchSettleAndBroadcast(symbol, trades, closePrice) {
  if (!trades || trades.length === 0) return;

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
    } else {
      db.ref('live_market_stats/' + symbol).remove().catch(() => {});
    }
  } catch (e) {}

  // ── Redis path (chunked for safety) ──
  if (redisPub && redisReady) {
    try {
      const CHUNK = 100; // LPUSH has arg limit
      for (let i = 0; i < trades.length; i += CHUNK) {
        const chunk = trades.slice(i, i + CHUNK);
        const jobs = chunk.map(t => JSON.stringify({
          userId:     t.userId,
          tradeId:    t.tradeId,
          closePrice: t.closePrice || closePrice,
          symbol,
          settledBy:  'redis-settler',
        }));
        await redisSafe('lpush', 'gv:settle_queue', ...jobs);
      }
      console.log(`[redis-push] ${symbol} pushed=${trades.length} closePrice=${closePrice.toFixed(5)}`);
      return;
    } catch (e) {
      console.error(`[redis-push] ${symbol} failed, falling back to HTTP:`, e.message);
    }
  }

  // ── HTTP fallback ──
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
      console.log(`[batch-settle] ${symbol} chunk=${Math.floor(i/CHUNK)+1} trades=${chunk.length} took=${_ms}ms ok=${results.filter(r=>r.result==='ok').length}`);
      results.forEach(r => {
        _queueSettlementBroadcast(r.userId, r.tradeId, r);
      });
    } catch (e) {
      console.error(`[batch-settle] ${symbol} chunk=${Math.floor(i/CHUNK)+1} failed:`, e.message);
    }
  }
}

// ── Candle settlement ──
async function settleTradesForCandle(symbol, candleTime, closePrice) {
  _candleSettlingSymbols.add(symbol);

  try {
    const queueSnap = await db.ref(`settlement_queue/${candleTime}`).once('value');

    if (!queueSnap.exists()) {
      const fsSnap = await firestore.collectionGroup('trades')
        .where('symbol', '==', symbol)
        .where('status', '==', 'live')
        .where('accountType', '==', 'live')
        .where('expiryTimestamp', '==', candleTime)
        .get();
      if (fsSnap.empty) { return; }
      const trades = fsSnap.docs.map(doc => ({
        userId: doc.data().userId || doc.ref.parent.parent?.id,
        tradeId: doc.id,
        closePrice,
      })).filter(t => t.userId);
      trades.forEach(t => {
        const key = `${t.userId}/${t.tradeId}`;
        _activeTradesMemory.delete(key);
        _pendingSettle.add(key);
      });
      await _batchSettleAndBroadcast(symbol, trades, closePrice);
      return;
    }

    const trades = [];
    queueSnap.forEach(userNode => {
      const userId = userNode.key;
      userNode.forEach(tradeNode => {
        const t = tradeNode.val();
        if (t.symbol === symbol && t.accountType === 'live') {
          trades.push({ userId, tradeId: tradeNode.key, closePrice, type: t.type || '', amount: t.amount || 0 });
          const key = `${userId}/${tradeNode.key}`;
          _activeTradesMemory.delete(key);
          _pendingSettle.add(key);
        }
      });
    });

    if (trades.length === 0) { return; }
    console.log(`[settle] ${symbol} candleTime=${candleTime} found ${trades.length} trades in queue`);

    const pendingKeys = trades.map(t => `${t.userId}/${t.tradeId}`);
    setTimeout(() => pendingKeys.forEach(k => _pendingSettle.delete(k)), 30000);

    await _batchSettleAndBroadcast(symbol, trades, closePrice);

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

const _activeTradesMemory = new Map();
const _pendingSettle = new Set();
const _candleSettlingSymbols = new Set();

// ── Recovery ──
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
          _pendingSettle.delete(key);
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

// ── Tick settlement from memory (DISABLED — use RTDB only to avoid duplicates) ──
async function _settleDueTradesFromMemory() {
  // Disabled: RTDB path is more reliable. 
  // Candle close path handles symbol-specific settlement.
  // This prevents race condition with settleTradesForCandle.
  return;
}

// ── RTDB tick settlement ──
const _rtdbSettledKeys = new Set();

async function _settleDueTradesFromRTDB() {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const snap = await db.ref('settlement_queue').once('value');
    if (!snap.exists()) return;

    const bySymbol = new Map();
    snap.forEach(timeNode => {
      const expiryTimestamp = parseInt(timeNode.key);
      if (expiryTimestamp > nowSec) return;
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
          bySymbol.get(t.symbol).trades.push({ 
            userId, tradeId: tradeNode.key, closePrice: state.price, 
            expiryTimestamp, type: t.type || '', amount: t.amount || 0 
          });
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
      await Promise.allSettled(trades.map(t =>
        db.ref(`settlement_queue/${t.expiryTimestamp}/${t.userId}/${t.tradeId}`).remove()
      ));
    }));

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

// ── 24h change tracking ──
const _openPrice24h  = {};

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

setInterval(() => {
  _activeMarkets.forEach(id => {
    _load24hOpenPrice(id);
  });
}, 60 * 60 * 1000);

// ── Firebase helpers ──
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
// OTC ENGINE — IMPROVED
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
    trend:0, trendSteps:0, lastMove:0,
    subStates,
  };
  _activeMarkets.add(id);

  await _load24hOpenPrice(id);
  console.log(`[${id}] OTC started @ ${price.toFixed(4)}`);
}

// ══════════════════════════════════════════════════════════
// IMPROVED tickOTC — Smoother, more natural price movement
// ══════════════════════════════════════════════════════════
function tickOTC(id) {
  const state = _states[id];
  if (!state || state.type !== 'otc') return;
  const ctrl = _controls[id] || {};
  const volMul = { low:0.3, medium:0.8, high:1.8 }[ctrl.volatility] || 0.8;
  const speed = ctrl.speedMultiplier || 1.0;
  const now = Date.now();

  // ── Trend logic ──
  if (!ctrl.mode || ctrl.mode === 'auto') {
    if (state.trendSteps <= 0) { 
      state.trend = randomTrend(); 
      state.trendSteps = Math.round((15 + Math.floor(Math.random()*25)) / speed); 
    }
    state.trendSteps--;
  } else if (ctrl.mode === 'manual') {
    state.trend = ctrl.nextDirection === 'up' ? 1 : ctrl.nextDirection === 'down' ? -1 : 0;
    state.trendSteps = 99;
  } else if (ctrl.mode === 'trade-based') {
    const stats = _tradeStats[id] || {};
    const up    = parseFloat(stats.upAmount)   || 0;
    const down  = parseFloat(stats.downAmount) || 0;
    const total = up + down;
    
    if (total > 0) {
      const ratio = up / total;
      state.trend = (0.5 - ratio) * 2;
    } else {
      state.trend = 0;
    }
    state.trendSteps = 99;
  }

  // ── Smoother price calculation ──
  const baseVol = state.price * 0.0005 * volMul;
  const prevMove = state.lastMove || 0;
  
  const trendComponent    = state.trend * baseVol * 0.6;
  const randomComponent   = (Math.random() - 0.5) * baseVol * 1.5;
  const momentumComponent = prevMove * 0.2;
  
  const move = (trendComponent + randomComponent + momentumComponent) * speed;
  state.lastMove = move;
  
  state.price = Math.max(state.price + move, 0.0001);
  
  if (state.price > state.candleHigh) state.candleHigh = state.price;
  if (state.price < state.candleLow)  state.candleLow  = state.price;

  // ── Candle close ──
  if (now >= state.nextCandle) {
    const closedCandleTime  = state.nextCandle / 1000;
    const closedCandleClose = state.price;
    
    saveCandle(id, { 
      time: state.candleTime, 
      open: state.candleOpen, 
      high: state.candleHigh, 
      low: state.candleLow, 
      close: state.price 
    });
    
    db.ref(`otc_candles/${id}/live`).set({ 
      time: state.candleTime, 
      open: state.candleOpen, 
      high: state.candleHigh, 
      low: state.candleLow, 
      close: state.price, 
      nextCandle: state.nextCandle 
    }).catch(()=>{});

    _candleSettlingSymbols.add(id);
    settleTradesForCandle(id, closedCandleTime, closedCandleClose)
      .finally(() => { _candleSettlingSymbols.delete(id); });

    state.candleTime = state.nextCandle / 1000;
    state.candleOpen = state.price;
    state.candleHigh = state.price;
    state.candleLow  = state.price;
    state.nextCandle += CANDLE_MS;
    while (state.nextCandle <= now) { 
      state.candleTime = state.nextCandle / 1000; 
      state.nextCandle += CANDLE_MS; 
    }
  } else {
    saveLiveCandle(id, { 
      time: state.candleTime, 
      open: state.candleOpen, 
      high: state.candleHigh, 
      low: state.candleLow, 
      close: state.price, 
      nextCandle: state.nextCandle 
    });
  }

  // ── Sub-intervals ──
  for (const { label } of SUB_INTERVALS) {
    const ss = state.subStates[label];
    if (!ss) continue;
    if (state.price > ss.candleHigh) ss.candleHigh = state.price;
    if (state.price < ss.candleLow)  ss.candleLow  = state.price;
    
    if (now >= ss.nextCandle) {
      saveSubCandle(id, label, { 
        time: ss.candleTime, 
        open: ss.candleOpen, 
        high: ss.candleHigh, 
        low: ss.candleLow, 
        close: state.price 
      });
      db.ref(`subcandles_${label}/${id}/live`).set(null).catch(() => {});
      
      ss.candleTime = ss.nextCandle / 1000;
      ss.candleOpen = state.price;
      ss.candleHigh = state.price;
      ss.candleLow  = state.price;
      ss.nextCandle += ss.ms;
      
      while (ss.nextCandle <= now) { 
        ss.candleTime = ss.nextCandle / 1000; 
        ss.nextCandle += ss.ms; 
      }
    } else {
      saveLiveSubCandle(id, label, { 
        time: ss.candleTime, 
        open: ss.candleOpen, 
        high: ss.candleHigh, 
        low: ss.candleLow, 
        close: state.price, 
        nextCandle: ss.nextCandle 
      });
    }
  }
}

// ══════════════════════════════════════════════════════════
// FOREX ENGINE — IMPROVED (Real price only)
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
  
  // Forex controls — mode ignored, always auto/real price
  _controls[id] = { mode:'auto', nextDirection:'auto' };
  
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

  await _load24hOpenPrice(id);
  console.log(`[${id}] Forex started @ ${lastClose}`);
  if (_tdWS && _tdWS.readyState === 1 && _tdReady) {
    _tdWS.send(JSON.stringify({ action:'subscribe', params:{ symbols: TD_MAP[id] } }));
  } else {
    _startSharedTdWS();
  }
}

// ══════════════════════════════════════════════════════════
// IMPROVED tickForex — Real price ONLY, no manipulation
// ══════════════════════════════════════════════════════════
function tickForex(id) {
  const state = _states[id];
  if (!state || state.type !== 'forex') return;
  if (!isForexOpen()) {
    stopSymbol(id);
    db.ref(`otc_status/${id}`).set({ enabled:false, reason:'market_closed' }).catch(()=>{});
    return;
  }
  const now = Date.now();
  const realPrice = _forexPrices[id];
  
  if (!realPrice || realPrice <= 0) return;
  
  // ALWAYS use real price — no manual/trade-based override for forex
  state.price = realPrice;
  
  if (realPrice > state.candleHigh) state.candleHigh = realPrice;
  if (realPrice < state.candleLow)  state.candleLow  = realPrice;
  
  if (now >= state.nextCandle) {
    const closedCandleTime  = state.nextCandle / 1000;
    const closedCandleClose = realPrice;
    
    saveCandle(id, { 
      time: state.candleTime, 
      open: state.candleOpen, 
      high: state.candleHigh, 
      low: state.candleLow, 
      close: realPrice 
    });
    
    db.ref(`otc_candles/${id}/live`).set({ 
      time: state.candleTime, 
      open: state.candleOpen, 
      high: state.candleHigh, 
      low: state.candleLow, 
      close: realPrice, 
      nextCandle: state.nextCandle 
    }).catch(()=>{});

    _candleSettlingSymbols.add(id);
    settleTradesForCandle(id, closedCandleTime, closedCandleClose)
      .finally(() => { _candleSettlingSymbols.delete(id); });

    state.candleTime = state.nextCandle/1000;
    state.candleOpen = realPrice;
    state.candleHigh = realPrice;
    state.candleLow  = realPrice;
    state.nextCandle += CANDLE_MS;
    while (state.nextCandle <= now) { 
      state.candleTime = state.nextCandle/1000; 
      state.nextCandle += CANDLE_MS; 
    }
  } else {
    saveLiveCandle(id, { 
      time: state.candleTime, 
      open: state.candleOpen, 
      high: state.candleHigh, 
      low: state.candleLow, 
      close: realPrice, 
      nextCandle: state.nextCandle 
    });
  }
  
  for (const { label } of SUB_INTERVALS) {
    const ss = state.subStates[label];
    if (!ss) continue;
    if (realPrice > ss.candleHigh) ss.candleHigh = realPrice;
    if (realPrice < ss.candleLow)  ss.candleLow  = realPrice;
    
    if (now >= ss.nextCandle) {
      saveSubCandle(id, label, { 
        time: ss.candleTime, 
        open: ss.candleOpen, 
        high: ss.candleHigh, 
        low: ss.candleLow, 
        close: realPrice 
      });
      db.ref(`subcandles_${label}/${id}/live`).set(null).catch(() => {});
      
      ss.candleTime = ss.nextCandle / 1000;
      ss.candleOpen = realPrice;
      ss.candleHigh = realPrice;
      ss.candleLow  = realPrice;
      ss.nextCandle += ss.ms;
      
      while (ss.nextCandle <= now) { 
        ss.candleTime = ss.nextCandle / 1000; 
        ss.nextCandle += ss.ms; 
      }
    } else {
      saveLiveSubCandle(id, label, { 
        time: ss.candleTime, 
        open: ss.candleOpen, 
        high: ss.candleHigh, 
        low: ss.candleLow, 
        close: realPrice, 
        nextCandle: ss.nextCandle 
      });
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
    _settleDueTradesFromRTDB().catch(e => console.error('[rtdb-tick-settle] error:', e.message));
  }, TICK_MS);
  console.log('Server running ✅');
}
main().catch(console.error);

const http = require('http');

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    const otc   = [..._activeMarkets].filter(id => _states[id]?.type === 'otc');
    const forex = [..._activeMarkets].filter(id => _states[id]?.type === 'forex');
    res.writeHead(200);
    res.end(`GoldVest ✅\nOTC: ${otc.join(',')||'none'}\nForex: ${forex.join(',')||'none'}`);
    return;
  }

  // ── POST /place-trade ──
  if (req.method === 'POST' && req.url === '/place-trade') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, trade } = body;
      if (!idToken || !trade) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Missing idToken or trade' })); return;
      }

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

      const balKey = BAL_KEY_OTC(userId);
      let currentBal;
      
      try {
        currentBal = await redisSafe('get', balKey);
      } catch (e) {
        const snap = await firestore.collection('users').doc(userId).get();
        const bal  = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600);
        currentBal = bal.toString();
      }

      const balFloat = parseFloat(currentBal);
      if (balFloat < amount) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Insufficient balance', balance: balFloat })); return;
      }

      const newBal = await redisSafe('incrbyfloat', balKey, -amount);
      await redisSafe('expire', balKey, 3600);
      await redisSafe('set', `gv:bal:dirty:${userId}`, '1', 'EX', 3600);

      console.log(`[place-trade] userId=${userId} tradeId=${tradeId} amount=${amount} newBal=${newBal}`);

      await redisSafe('hset', TRADE_KEY_OTC(tradeId),
        'userId',          userId,
        'symbol',          trade.symbol || '',
        'entryPrice',      String(trade.entryPrice || 0),
        'amount',          String(amount),
        'type',            trade.type || '',
        'payoutPercent',   String(trade.payoutPercent || 92),
        'status',          'live',
        'accountType',     'live',
        'expiryTimestamp', String(trade.expiryTimestamp || 0),
        'currency',        trade.currency || 'USD',
      );
      await redisSafe('expire', TRADE_KEY_OTC(tradeId), 7200);

      db.ref(`settlement_queue/${trade.expiryTimestamp}/${userId}/${tradeId}`).set({
        userId, tradeId,
        symbol:      trade.symbol || '',
        accountType: 'live',
        type:        trade.type || '',
        amount:      amount,
        feedType:    trade.feedType || '',
        entryPrice:  trade.entryPrice || 0,
      }).catch(e => console.error('[place-trade] RTDB queue failed:', e.message));

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

  // ── POST /withdraw-deduct ──
  if (req.method === 'POST' && req.url === '/withdraw-deduct') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, amount } = body;
      if (!idToken || !amount || parseFloat(amount) <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Missing fields' })); return;
      }

      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      const uid = decoded.uid;

      const deductAmt = parseFloat(amount);
      const balKey = BAL_KEY_OTC(uid);

      let currentBal;
      try {
        currentBal = await redisSafe('get', balKey);
      } catch (e) {
        const snap = await firestore.collection('users').doc(uid).get();
        const bal  = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600);
        currentBal = bal.toString();
      }

      const balFloat = parseFloat(currentBal);
      if (balFloat < deductAmt) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Insufficient balance', balance: balFloat })); return;
      }

      const newBal = await redisSafe('incrbyfloat', balKey, -deductAmt);
      await redisSafe('expire', balKey, 3600);
      await redisSafe('set', `gv:bal:dirty:${uid}`, '1', 'EX', 3600);

      console.log(`[withdraw-deduct] uid=${uid} amount=${deductAmt} newBal=${newBal}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));

    } catch(e) {
      console.error('[withdraw-deduct] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── POST /admin-deduct ──
  if (req.method === 'POST' && req.url === '/admin-deduct') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { uid, amount, adminSecret } = body;
      if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      if (!uid || !amount || parseFloat(amount) <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid uid or amount' })); return;
      }

      const deductAmt = parseFloat(amount);
      const balKey = BAL_KEY_OTC(uid);

      let currentBal;
      try {
        currentBal = await redisSafe('get', balKey);
      } catch (e) {
        const snap = await firestore.collection('users').doc(uid).get();
        const bal  = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600);
        currentBal = bal.toString();
      }

      const balFloat = parseFloat(currentBal);
      if (balFloat < deductAmt) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Insufficient balance', balance: balFloat })); return;
      }

      const newBal = await redisSafe('incrbyfloat', balKey, -deductAmt);
      await redisSafe('expire', balKey, 3600);
      await redisSafe('set', `gv:bal:dirty:${uid}`, '1', 'EX', 3600);

      console.log(`[admin-deduct] uid=${uid} amount=${deductAmt} newBal=${newBal}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));

    } catch(e) {
      console.error('[admin-deduct] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── POST /admin-credit ──
  if (req.method === 'POST' && req.url === '/admin-credit') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, uid, amount } = body;
      if (!idToken) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }

      if (!decoded.admin) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden — admin only' })); return;
      }
      if (!uid || !amount || parseFloat(amount) <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid uid or amount' })); return;
      }

      const creditAmt = parseFloat(amount);
      const balKey = BAL_KEY_OTC(uid);

      let currentBal;
      try {
        currentBal = await redisSafe('get', balKey);
      } catch (e) {
        const snap = await firestore.collection('users').doc(uid).get();
        const bal  = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600);
      }

      const newBal = await redisSafe('incrbyfloat', balKey, creditAmt);
      await redisSafe('expire', balKey, 3600);
      await redisSafe('set', `gv:bal:dirty:${uid}`, '1', 'EX', 3600);

      console.log(`[admin-credit] uid=${uid} amount=${creditAmt} newBal=${newBal}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));

    } catch(e) {
      console.error('[admin-credit] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── POST /sell-trade ──
  if (req.method === 'POST' && req.url === '/sell-trade') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid body' })); return; }

      const { idToken, tradeId, userId, sellPrice: claimedSellPrice } = body;
      if (!idToken || !tradeId || !userId || !claimedSellPrice) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Missing fields' })); return;
      }

      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      if (decoded.uid !== userId) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }

      const TRADE_KEY = `gv:trade:${tradeId}`;
      let hash;
      try {
        hash = await redisSafe('hgetall', TRADE_KEY);
      } catch (e) {
        res.writeHead(503); res.end(JSON.stringify({ error: 'Service temporarily unavailable' })); return;
      }
      
      if (!hash || !hash.userId) {
        res.writeHead(404); res.end(JSON.stringify({ error: 'Trade not found' })); return;
      }
      if (hash.userId !== userId) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      if (hash.status === 'sold' || hash.status === 'won' || hash.status === 'lost' || hash.status === 'refunded') {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Trade already settled' })); return;
      }

      const tradeAmount = parseFloat(hash.amount || 0);
      const payoutPercent = parseFloat(hash.payoutPercent || 92);
      const maxPossible = tradeAmount + (tradeAmount * payoutPercent / 100);
      const sellPrice = parseFloat(claimedSellPrice);

      if (!sellPrice || sellPrice <= 0 || sellPrice > maxPossible) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid sell price' })); return;
      }

      const balKey = BAL_KEY_OTC(userId);
      let currentBal;
      try {
        currentBal = await redisSafe('get', balKey);
      } catch (e) {
        const snap = await firestore.collection('users').doc(userId).get();
        const bal = snap.exists ? (snap.data().liveBalance || 0) : 0;
        await redisPub.set(balKey, bal.toString(), 'EX', 3600);
      }

      const newBal = await redisSafe('incrbyfloat', balKey, sellPrice);
      await redisSafe('expire', balKey, 3600);
      await redisSafe('set', `gv:bal:dirty:${userId}`, '1', 'EX', 3600);
      await redisSafe('hset', `gv:trade:${tradeId}`, 'status', 'sold');

      console.log(`[sell-trade] userId=${userId} tradeId=${tradeId} sellPrice=${sellPrice} newBal=${newBal}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));

    } catch(e) {
      console.error('[sell-trade] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // ── GET /crypto-currencies ──
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

  // ── POST /create-crypto-payment ──
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

      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      const userId = decoded.uid;

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

  // ── POST /nowpayments-webhook ──
  if (req.method === 'POST' && req.url === '/nowpayments-webhook') {
    try {
      let body;
      try { body = await _readBody(req); }
      catch(e) { res.writeHead(400); res.end('Invalid body'); return; }

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
        console.warn('[nowpayments-webhook] signature mismatch');
        res.writeHead(401); res.end('Invalid signature'); return;
      }

      const { payment_id, payment_status, price_amount } = body;
      if (!payment_id) {
        res.writeHead(400); res.end('Missing payment_id'); return;
      }

      console.log(`[nowpayments-webhook] paymentId=${payment_id} status=${payment_status}`);

      if (payment_status === 'finished') {
        const payDocRef = firestore.collection('cryptoPayments').doc(String(payment_id));
        let shouldCredit = false;
        let uid = null;
        let creditAmt = 0;

        await firestore.runTransaction(async (tx) => {
          const payDoc = await tx.get(payDocRef);
          if (!payDoc.exists) {
            console.warn(`[nowpayments-webhook] paymentId=${payment_id} — no matching record`);
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
          tx.update(payDocRef, {
            status:         'finished',
            creditedAmount: creditAmt,
            finishedAt:     admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        if (shouldCredit && uid) {
          const balKey = BAL_KEY_OTC(uid);
          let currentBal;
          try {
            currentBal = await redisSafe('get', balKey);
          } catch (e) {
            const userSnap = await firestore.collection('users').doc(uid).get();
            const bal = userSnap.exists ? (userSnap.data().liveBalance || 0) : 0;
            await redisPub.set(balKey, bal.toString(), 'EX', 3600);
          }

          const newBal = await redisSafe('incrbyfloat', balKey, creditAmt);
          await redisSafe('expire', balKey, 3600);
          await redisSafe('set', `gv:bal:dirty:${uid}`, '1', 'EX', 3600);

          console.log(`[nowpayments-webhook] uid=${uid} paymentId=${payment_id} credited=${creditAmt} newBal=${newBal}`);
        }

      } else {
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
