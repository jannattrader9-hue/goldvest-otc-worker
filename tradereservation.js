/**
 * tradereservation.js — Balance Reservation Logic
 * ═══════════════════════════════════════════════════════════════════════
 * সমস্যা: user click করলে সেই মুহূর্তে chart এর animation (queue-based,
 * demo-verified smooth) তখনও নতুন tick এর দিকে glide করে থাকতে পারে —
 * তাই backend এর latest tick price ব্যবহার করলেও, chart তখনো visually
 * সেই দাম দেখাচ্ছে না। Trade-line সাথে সাথে বসালে "প্রাইজ এক জায়গায়,
 * ট্রেড আরেক জায়গায়" দেখাত।
 *
 * সমাধান (user এর design, Quotex এর screenshot দিয়ে verified pattern):
 *   ১. Click এর মুহূর্তে balance অবিভাজ্যভাবে (atomic) "reserve" হয় —
 *      Deduct না, কিন্তু সেই amount future trade-এর জন্য আলাদা করে রাখা
 *      হয়, তাই দ্বিতীয় trade এই balance আবার ব্যবহার করতে পারবে না।
 *   ২. Frontend যখন জানায় chart visually সেই reserved price এ পৌঁছেছে
 *      (animation শেষ), তখনই "execute" — actual deduct + trade "live"।
 *   ৩. Timeout safety — frontend কখনো execute-signal না পাঠালে (network
 *      issue, tab বন্ধ ইত্যাদি), reservation নিজে থেকেই TTL দিয়ে expire
 *      হয়ে যায়, টাকা কখনো চিরকাল আটকে থাকে না।
 *
 * Security — কেন এটা নিরাপদ (frontend কে বিশ্বাস করা হয় না):
 *   • Reserve ও Execute — দুটোই Redis Lua script দিয়ে atomic, ১০০টা
 *     simultaneous click এলেও Redis single-threaded ভাবে সেগুলো এক
 *     এক করে process করে — race condition সম্ভব না।
 *   • Frontend শুধু "execute করো" বলতে পারে, কত টাকা/কোন দামে সেটা
 *     backend আগেই (reserve-time এ) ঠিক করে ফেলেছে — frontend সেই মান
 *     বদলাতে পারে না।
 *   • Reservation-ID server-generated (client guess করতে পারবে না)।
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');

const RESERVATION_TTL_SEC = 10;   // এই সময়ের মধ্যে execute না হলে auto-release
const RES_KEY = (reservationId) => `gv:reserve:${reservationId}`;

/**
 * Redis client এ প্রয়োজনীয় Lua-script গুলো register করে। otc-server.js
 * এর startup এ একবার কল করতে হবে (অন্য defineCommand কলগুলোর পাশে)।
 */
function registerReservationCommands(redisPub) {
  // [ATOMIC RESERVE] balance check + reserve — একটাই Redis operation এ।
  // এই মুহূর্তে actual balance থেকে deduct করা হয় (তাই দ্বিতীয় click
  // আর এই টাকা দেখতে পাবে না — double-spend প্রতিরোধ), কিন্তু trade
  // এখনো "pending" — আলাদা reservation-hash এ track হয়, যেটা পরে
  // execute (confirm) বা release (বাতিল/timeout) হতে পারে।
  redisPub.defineCommand('gvReserveBalance', {
    numberOfKeys: 2,
    // KEYS[1] = balance key, KEYS[2] = reservation key
    // ARGV[1] = amount, ARGV[2] = reservation TTL (sec), ARGV[3] = entryPrice,
    // ARGV[4] = entryTimeMs, ARGV[5] = balKey (string, sweep এর জন্য সংরক্ষণ)
    lua: `
      local bal = redis.call('GET', KEYS[1])
      if bal == false then return {-1, '0'} end
      local b = tonumber(bal)
      local amt = tonumber(ARGV[1])
      if b < amt then return {0, bal} end
      local nb = redis.call('INCRBYFLOAT', KEYS[1], -amt)
      redis.call('EXPIRE', KEYS[1], 3600)
      -- reservation hash এ trade এর বিস্তারিত জমা রাখি — balKey ও রাখা
      -- হলো, যাতে sweep (orphan-cleanup) নিজে থেকেই সঠিক balance এ
      -- ফেরত দিতে পারে, আলাদা lookup ছাড়াই।
      redis.call('HSET', KEYS[2], 'amount', ARGV[1], 'entryPrice', ARGV[3], 'entryTimeMs', ARGV[4], 'balKey', ARGV[5], 'status', 'pending')
      redis.call('EXPIRE', KEYS[2], ARGV[2])
      return {1, nb}
    `,
  });

  // [ATOMIC EXECUTE] reservation কে "confirmed" করে — এই মুহূর্তে balance
  // আগেই deduct হয়ে গেছে (reserve-time এ), তাই এখানে শুধু status বদলাই
  // (pending → executed), যাতে caller নিশ্চিত হয় ঠিক কোন reservation
  // execute হলো, duplicate-execute (frontend দুইবার confirm পাঠালে)
  // থেকে রক্ষা পাওয়া যায়।
  redisPub.defineCommand('gvExecuteReservation', {
    numberOfKeys: 1,
    lua: `
      local st = redis.call('HGET', KEYS[1], 'status')
      if st == false then return 0 end        -- reservation নেই/expire হয়ে গেছে
      if st ~= 'pending' then return 0 end     -- আগেই executed/released
      redis.call('HSET', KEYS[1], 'status', 'executed')
      return 1
    `,
  });

  // [ATOMIC RELEASE] ব্যবহারকারী trade বাতিল করলে বা timeout এ — reserved
  // balance ফেরত দেওয়া। শুধু 'pending' status এ থাকলেই ফেরত হবে, ইতিমধ্যে
  // executed হলে ফেরত দেওয়া ভুল হবে (টাকা তখন legitimately deducted)।
  redisPub.defineCommand('gvReleaseReservation', {
    numberOfKeys: 2,
    // KEYS[1] = reservation key, KEYS[2] = balance key
    lua: `
      local st = redis.call('HGET', KEYS[1], 'status')
      if st == false then return 0 end
      if st ~= 'pending' then return 0 end
      local amt = redis.call('HGET', KEYS[1], 'amount')
      redis.call('INCRBYFLOAT', KEYS[2], amt)
      redis.call('EXPIRE', KEYS[2], 3600)
      redis.call('HSET', KEYS[1], 'status', 'released')
      return 1
    `,
  });
}

/**
 * নতুন trade-reservation তৈরি — click হওয়ার সাথে সাথেই কল হয়।
 * @returns {Promise<{ok: number, newBalance: number, reservationId: string|null}>}
 */
async function reserveTradeBalance(redisPub, balKey, amount, entryPrice, entryTimeMs) {
  const reservationId = crypto.randomBytes(16).toString('hex');   // client guess করতে পারবে না
  const resKey = RES_KEY(reservationId);

  const [ok, newBalRaw] = await redisPub.gvReserveBalance(
    balKey, resKey, String(amount), String(RESERVATION_TTL_SEC),
    String(entryPrice), String(entryTimeMs), balKey
  );

  return {
    ok,
    newBalance: parseFloat(newBalRaw) || 0,
    reservationId: ok === 1 ? reservationId : null,
  };
}

/**
 * Frontend থেকে "chart visually reserved price এ পৌঁছেছে" signal এলে
 * কল হয় — reservation কে চূড়ান্ত (executed) করে।
 * @returns {Promise<boolean>} সফল হলে true
 */
async function executeReservation(redisPub, reservationId) {
  if (!reservationId || typeof reservationId !== 'string') return false;
  const resKey = RES_KEY(reservationId);
  const result = await redisPub.gvExecuteReservation(resKey);
  return result === 1;
}

/**
 * User trade বাতিল করলে বা কোনো কারণে execute না হলে — reserved balance
 * ফেরত দেয়। TTL এমনিতেই ১০ সেকেন্ড পরে reservation expire করে দেবে,
 * কিন্তু balance তখনও ফেরত পাওয়ার জন্য explicit release call দরকার
 * (TTL শুধু reservation-hash মুছে দেয়, balance নিজে থেকে ফেরত আসে না)।
 */
async function releaseReservation(redisPub, reservationId, balKey) {
  if (!reservationId || typeof reservationId !== 'string') return false;
  const resKey = RES_KEY(reservationId);
  const result = await redisPub.gvReleaseReservation(resKey, balKey);
  return result === 1;
}

/**
 * [CLEANUP SAFETY NET] TTL দিয়ে reservation-hash নিজে থেকেই মুছে যায়,
 * কিন্তু সেই সময় balance ফেরত দেওয়ার কেউ থাকে না যদি frontend
 * execute/release কখনোই না পাঠায় (যেমন user tab বন্ধ করে দিলো)।
 * এই function periodic ভাবে চালিয়ে সেই "orphaned" reservation গুলো
 * খুঁজে balance ফেরত দেওয়া যায়। otc-server.js এ প্রতি কয়েক সেকেন্ডে
 * cron/interval দিয়ে চালানো উচিত।
 *
 * নোট: এটা Redis SCAN দিয়ে reservation-key খোঁজে, production এ বড়
 * key-space এ এটা costly হতে পারে — তাই বিরল, low-frequency তে চালানো
 * উচিত (যেমন প্রতি ৩০ সেকেন্ডে একবার)।
 */
async function sweepExpiredReservations(redisPub) {
  let cursor = '0';
  let cleaned = 0;
  do {
    const [nextCursor, keys] = await redisPub.scan(cursor, 'MATCH', 'gv:reserve:*', 'COUNT', 100);
    cursor = nextCursor;
    for (const key of keys) {
      const status = await redisPub.hget(key, 'status');
      if (status !== 'pending') continue;
      const ttl = await redisPub.ttl(key);
      // TTL প্রায় শেষের দিকে (২ সেকেন্ডের কম বাকি) মানে সম্ভবত orphaned —
      // এখনই release করে দিই, TTL দিয়ে key নিজে expire হওয়ার অপেক্ষা না করে
      if (ttl >= 0 && ttl < 2) {
        const balKey = await redisPub.hget(key, 'balKey');
        if (balKey) {
          const released = await redisPub.gvReleaseReservation(key, balKey);
          if (released === 1) cleaned++;
        }
      }
    }
  } while (cursor !== '0');
  return cleaned;
}

module.exports = {
  registerReservationCommands,
  reserveTradeBalance,
  executeReservation,
  releaseReservation,
  sweepExpiredReservations,
  RESERVATION_TTL_SEC,
};
