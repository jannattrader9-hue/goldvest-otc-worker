'use strict';
// ══════════════════════════════════════════════════════════════════
// GoldVest Real Market Settlement Server
// Handles: Crypto (Binance) + Forex (TwelveData) trade settlement
// Same Redis/RTDB pattern as otc-server.js
// ══════════════════════════════════════════════════════════════════

const admin  = require('firebase-admin');
const Redis  = require('ioredis');
const http   = require('http');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db        = admin.database();
const firestore = admin.firestore();

// ── Redis ──────────────────────────────────────────────────────────
const REDIS_URL  = process.env.REDIS_URL;
let   redisPub   = null;
let   redisReady = false;

if (REDIS_URL) {
  redisPub = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true });
  redisPub.on('ready', () => { redisReady = true;  console.log('[redis] connected'); });
  redisPub.on('error', (e)  => { redisReady = false; console.error('[redis] error:', e.message); });
}

// ── Constants ─────────────────────────────────────────────────────
const BATCH_SETTLE_FUNCTION_URL = 'https://us-central1-goldvest-cf73d.cloudfunctions.net/batchSettle';
const SETTLE_TOKEN  = process.env.SETTLE_TOKEN || 'gv_settle_secret_2024';
const TICK_MS       = 500;   // 500ms tick
const TD_KEY        = process.env.TD_KEY || '392fa09f669c4cd7843f958e0fbbca36';

// ── In-memory trade tracking ───────────────────────────────────────
// key: userId/tradeId → { userId, tradeId, symbol, feedType, expiryTimestamp, type, amount, accountType }
const _activeTradesMemory = new Map();
const _pendingSettle      = new Set();
const _rtdbSettledKeys    = new Set();

// ── Real-time prices ──────────────────────────────────────────────
const _binancePrices = {}; // { BTCUSDT: 62500.00 }
const _forexPrices   = {}; // { EURUSD: 1.0850 }

// ══════════════════════════════════════════════════════════════════
// SETTLEMENT BROADCAST — same as otc-server.js
// ══════════════════════════════════════════════════════════════════
const _userSettleQueue  = new Map();
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

async function _batchSettleAndBroadcast(symbol, trades, closePrice) {
  if (!trades || trades.length === 0) return;

  // ── Redis path (fast) ──────────────────────────────────────────
  if (redisPub && redisReady) {
    try {
      const jobs = trades.map(t => JSON.stringify({
        userId:     t.userId,
        tradeId:    t.tradeId,
        closePrice: t.closePrice || closePrice,
        symbol,
        settledBy:  'real-server',
      }));
      await redisPub.lpush('gv:settle_queue', ...jobs);
      console.log(`[redis-push] ${symbol} pushed=${trades.length} closePrice=${closePrice}`);
      return;
    } catch (e) {
      console.error(`[redis-push] ${symbol} failed, falling back to HTTP:`, e.message);
    }
  }

  // ── HTTP fallback ──────────────────────────────────────────────
  const CHUNK = 500;
  for (let i = 0; i < trades.length; i += CHUNK) {
    const chunk = trades.slice(i, i + CHUNK);
    try {
      const res = await fetch(BATCH_SETTLE_FUNCTION_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Settle-Token': SETTLE_TOKEN },
        body:    JSON.stringify({ trades: chunk, settledBy: 'real-server' }),
      });
      const data    = await res.json().catch(() => ({}));
      const results = data.results || [];
      console.log(`[batch-settle] ${symbol} chunk=${i/CHUNK+1} trades=${chunk.length} ok=${results.filter(r=>r.result==='ok').length}`);
      results.forEach(r => _queueSettlementBroadcast(r.userId, r.tradeId, r));
    } catch (e) {
      console.error(`[batch-settle] ${symbol} chunk=${i/CHUNK+1} failed:`, e.message);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// BINANCE PRICE FEED — WebSocket
// ══════════════════════════════════════════════════════════════════
let _binanceWS = null;

function _startBinanceWS() {
  // Binance combined stream — সব crypto symbols একসাথে
  const symbols = ['btcusdt', 'ethusdt', 'bnbusdt', 'solusdt', 'xrpusdt',
                   'adausdt', 'dogeusdt', 'maticusdt', 'ltcusdt', 'dotusdt'];
  const streams = symbols.map(s => `${s}@trade`).join('/');
  const url     = `wss://stream.binance.com:9443/stream?streams=${streams}`;

  const { WebSocket } = require('ws');
  _binanceWS = new WebSocket(url);

  _binanceWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.data?.s && msg.data?.p) {
        _binancePrices[msg.data.s] = parseFloat(msg.data.p);
      }
    } catch (_) {}
  });

  _binanceWS.on('close', () => {
    console.log('[binance-ws] closed, reconnecting in 3s...');
    setTimeout(_startBinanceWS, 3000);
  });

  _binanceWS.on('error', (e) => console.error('[binance-ws] error:', e.message));
  console.log('[binance-ws] connecting...');
}

// ══════════════════════════════════════════════════════════════════
// TWELVEDATA PRICE FEED — WebSocket (Forex)
// ══════════════════════════════════════════════════════════════════
let _tdWS = null;

function _startTwelveDataWS() {
  const { WebSocket } = require('ws');
  _tdWS = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${TD_KEY}`);

  _tdWS.on('open', () => {
    _tdWS.send(JSON.stringify({ action: 'subscribe', params: { symbols: 'EUR/USD' } }));
    console.log('[twelvedata-ws] connected, subscribed EUR/USD');
  });

  _tdWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.symbol && msg.price) {
        _forexPrices[msg.symbol.replace('/', '')] = parseFloat(msg.price);
      }
    } catch (_) {}
  });

  _tdWS.on('close', () => {
    console.log('[twelvedata-ws] closed, reconnecting in 5s...');
    setTimeout(_startTwelveDataWS, 5000);
  });

  _tdWS.on('error', (e) => console.error('[twelvedata-ws] error:', e.message));
}

// ══════════════════════════════════════════════════════════════════
// TRADE TRACKING — RTDB settlement_queue listener
// ══════════════════════════════════════════════════════════════════
function _startTradeTracking() {
  // settlement_queue RTDB এ real market trades watch করো
  db.ref('settlement_queue').on('child_added', (candleSnap) => {
    const candleTime = parseInt(candleSnap.key);
    candleSnap.forEach(userSnap => {
      const userId = userSnap.key;
      userSnap.forEach(tradeSnap => {
        const t    = tradeSnap.val();
        const key  = `${userId}/${tradeSnap.key}`;
        // শুধু real market trades track করো (not OTC)
        const sym  = (t.symbol || '').toUpperCase();
        const feed = (t.feedType || '').toLowerCase();
        const isReal = feed === 'binance' || (feed !== 'otc' && !sym.includes('OTC') && !sym.includes('BDT') && feed !== 'usdtbdt-engine');
        const isForex = feed === 'forex';

        if (!isReal && !isForex) return;
        if (t.accountType !== 'live') return;
        if (_activeTradesMemory.has(key) || _pendingSettle.has(key)) return;

        _activeTradesMemory.set(key, {
          userId,
          tradeId:         tradeSnap.key,
          symbol:          t.symbol,
          feedType:        feed,
          expiryTimestamp: candleTime,
          type:            t.type || '',
          amount:          t.amount || 0,
          accountType:     t.accountType,
        });
        console.log(`[track] ${t.symbol} tradeId=${tradeSnap.key} expiry=${candleTime} feed=${feed}`);
      });
    });
  });

  // Trade settle হলে memory থেকে সরাও
  db.ref('settlement_queue').on('child_removed', (snap) => {
    const candleTime = snap.key;
    snap.forEach(userSnap => {
      const userId = userSnap.key;
      userSnap.forEach(tradeSnap => {
        _activeTradesMemory.delete(`${userId}/${tradeSnap.key}`);
      });
    });
  });

  console.log('[trade-tracking] RTDB listener started');
}

// ══════════════════════════════════════════════════════════════════
// SETTLEMENT TICK
// ══════════════════════════════════════════════════════════════════
async function _settleDueTrades() {
  const nowSec = Math.floor(Date.now() / 1000);
  const due    = [];

  for (const [key, t] of _activeTradesMemory.entries()) {
    if (t.expiryTimestamp <= nowSec) {
      if (_pendingSettle.has(key)) continue;
      due.push([key, t]);
    }
  }
  if (due.length === 0) return;

  // pending mark করো
  for (const [key] of due) {
    _activeTradesMemory.delete(key);
    _pendingSettle.add(key);
  }

  // symbol দিয়ে group করো
  const bySymbol = new Map();
  for (const [key, t] of due) {
    const sym = (t.symbol || '').toUpperCase();
    const feed = (t.feedType || '').toLowerCase();

    // Current price নাও
    let closePrice = 0;
    if (feed === 'forex') {
      closePrice = _forexPrices[sym.replace('/', '')] || 0;
    } else {
      closePrice = _binancePrices[sym] || 0;
    }

    // Price না পেলে Binance REST API থেকে নাও (fallback)
    if (!closePrice || closePrice <= 0) {
      try {
        const expiryMs = t.expiryTimestamp * 1000;
        const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&startTime=${expiryMs}&limit=1`;
        const res  = await fetch(url);
        const data = await res.json();
        if (data[0]) closePrice = parseFloat(data[0][4]); // candle close price
      } catch (e) {
        console.error(`[settle] ${sym} Binance API fallback failed:`, e.message);
      }
    }

    if (!closePrice || closePrice <= 0) {
      console.warn(`[settle] ${sym} no price available, skipping`);
      _pendingSettle.delete(key);
      continue;
    }

    if (!bySymbol.has(sym)) bySymbol.set(sym, { closePrice, trades: [] });
    bySymbol.get(sym).trades.push({
      userId:     t.userId,
      tradeId:    t.tradeId,
      closePrice,
      type:       t.type || '',
      amount:     t.amount || 0,
    });
  }

  // Settle করো
  await Promise.allSettled([...bySymbol.entries()].map(async ([symbol, { closePrice, trades }]) => {
    console.log(`[settle] ${symbol} due=${trades.length} closePrice=${closePrice}`);
    await _batchSettleAndBroadcast(symbol, trades, closePrice);
  }));

  // 30s পরে pending guard clear
  const keys = due.map(([key]) => key);
  setTimeout(() => keys.forEach(k => _pendingSettle.delete(k)), 30000);
}

// ══════════════════════════════════════════════════════════════════
// RTDB settlement_queue থেকে also settle (double safety)
// ══════════════════════════════════════════════════════════════════
async function _settleDueFromRTDB() {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const snap   = await db.ref('settlement_queue').once('value');
    if (!snap.exists()) return;

    const due = [];
    snap.forEach(candleSnap => {
      const candleTime = parseInt(candleSnap.key);
      if (candleTime > nowSec) return;
      candleSnap.forEach(userSnap => {
        const userId = userSnap.key;
        userSnap.forEach(tradeSnap => {
          const t   = tradeSnap.val();
          const key = `${userId}/${tradeSnap.key}`;
          if (_rtdbSettledKeys.has(key)) return;
          if (_pendingSettle.has(key)) return;

          const sym  = (t.symbol || '').toUpperCase();
          const feed = (t.feedType || '').toLowerCase();
          const isReal  = feed === 'binance' || (!sym.includes('OTC') && !sym.includes('BDT') && feed !== 'otc' && feed !== 'usdtbdt-engine');
          const isForex = feed === 'forex';
          if (!isReal && !isForex) return;
          if (t.accountType !== 'live') return;

          due.push({ key, userId, tradeId: tradeSnap.key, symbol: t.symbol, feedType: feed, type: t.type || '', amount: t.amount || 0 });
        });
      });
    });

    if (due.length === 0) return;

    due.forEach(t => { _rtdbSettledKeys.add(t.key); _pendingSettle.add(t.key); });

    const bySymbol = new Map();
    for (const t of due) {
      const sym = (t.symbol || '').toUpperCase();
      const feed = (t.feedType || '').toLowerCase();
      let closePrice = feed === 'forex' ? (_forexPrices[sym.replace('/', '')] || 0) : (_binancePrices[sym] || 0);

      if (!closePrice || closePrice <= 0) {
        try {
          const res  = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
          const data = await res.json();
          closePrice = parseFloat(data.price) || 0;
        } catch (_) {}
      }
      if (!closePrice || closePrice <= 0) { _pendingSettle.delete(t.key); continue; }

      if (!bySymbol.has(sym)) bySymbol.set(sym, { closePrice, trades: [] });
      bySymbol.get(sym).trades.push({ userId: t.userId, tradeId: t.tradeId, closePrice, type: t.type, amount: t.amount });
    }

    await Promise.allSettled([...bySymbol.entries()].map(async ([symbol, { closePrice, trades }]) => {
      console.log(`[rtdb-settle] ${symbol} due=${trades.length} closePrice=${closePrice}`);
      await _batchSettleAndBroadcast(symbol, trades, closePrice);
    }));

    setTimeout(() => due.forEach(t => _pendingSettle.delete(t.key)), 30000);
  } catch (e) {
    console.error('[rtdb-settle] error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════
// HTTP SERVER — health check + admin endpoints
// ══════════════════════════════════════════════════════════════════
function _readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

const BAL_KEY = (uid) => `gv:bal:${uid}`;

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET / — health check ──────────────────────────────────────
  if (req.method === 'GET' && req.url === '/') {
    const cryptoCount = Object.keys(_binancePrices).length;
    const forexCount  = Object.keys(_forexPrices).length;
    const active      = _activeTradesMemory.size;
    res.writeHead(200);
    res.end(`GoldVest Real Server ✅\nCrypto prices: ${cryptoCount}\nForex prices: ${forexCount}\nActive trades: ${active}`);
    return;
  }

  // ── POST /admin-credit ────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/admin-credit') {
    try {
      const body = await _readBody(req);
      const { uid, amount, adminSecret } = body;
      if (adminSecret !== (process.env.ADMIN_SECRET || 'raduan14261')) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return;
      }
      if (!uid || !amount || amount <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid params' })); return;
      }
      const balKey = BAL_KEY(uid);
      const newBal = await redisPub.incrbyfloat(balKey, parseFloat(amount.toFixed(4)));
      await redisPub.set(`gv:dirty:${uid}`, '1');
      console.log(`[admin-credit] uid=${uid} amount=${amount} newBal=${newBal}`);
      res.writeHead(200); res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));
    } catch (e) {
      console.error('[admin-credit] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /admin-deduct ────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/admin-deduct') {
    try {
      const body = await _readBody(req);
      const { uid, amount, adminSecret } = body;
      if (adminSecret !== (process.env.ADMIN_SECRET || 'raduan14261')) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return;
      }
      if (!uid || !amount || amount <= 0) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid params' })); return;
      }
      const balKey = BAL_KEY(uid);
      const newBal = await redisPub.incrbyfloat(balKey, -parseFloat(amount.toFixed(4)));
      await redisPub.set(`gv:dirty:${uid}`, '1');
      console.log(`[admin-deduct] uid=${uid} amount=${amount} newBal=${newBal}`);
      res.writeHead(200); res.end(JSON.stringify({ success: true, newBalance: parseFloat(newBal) }));
    } catch (e) {
      console.error('[admin-deduct] error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
}).listen(process.env.PORT || 3001, () => {
  console.log(`[server] GoldVest Real Server listening on port ${process.env.PORT || 3001}`);
});

// ══════════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════════
_startBinanceWS();
_startTwelveDataWS();
_startTradeTracking();

// Main tick
setInterval(() => {
  _settleDueTrades().catch(e => console.error('[tick-settle] error:', e.message));
}, TICK_MS);

// RTDB double-safety tick (every 5s)
setInterval(() => {
  _settleDueFromRTDB().catch(e => console.error('[rtdb-tick] error:', e.message));
}, 5000);

console.log('[startup] GoldVest Real Market Server started');
