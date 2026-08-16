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

// [PENDING INDEX] সব pending reservation এর একটাই sorted-set index।
// score = কখন এটাকে orphan ধরে ফেরত দেওয়া যাবে (ms epoch)।
//
// কেন index দরকার: আগে sweep প্রতি বার Redis SCAN দিয়ে পুরো keyspace
// ঘুরে প্রতিটা key তে HGET+TTL করত — user সংখ্যার সাথে খরচ রৈখিকভাবে
// বাড়ত, তাই sweep কে বিরল (৩০s) রাখতে হয়েছিল, আর সেই কারণেই বেশির
// ভাগ orphan ধরাই পড়ত না। ZSET এ সরাসরি "কারা মেয়াদোত্তীর্ণ" জানা
// যায় একটা কলেই — তাই ঘন ঘন (২s) চালানো যায়, খরচ প্রায় স্থির।
const PENDING_ZSET = 'gv:reserve:pending';

// Reservation-hash এর TTL এর চেয়ে index এন্ট্রি একটু বেশি সময় রাখি,
// নইলে hash মুছে যাওয়ার পর টাকা ফেরত দেওয়ার আর কোনো উপায় থাকে না।
// (নিচে reserve এর সময় hash এর TTL ও এই মার্জিন ধরে বসানো হয়।)
const ORPHAN_GRACE_SEC = 5;

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
    numberOfKeys: 3,
    // KEYS[1] = balance key, KEYS[2] = reservation key, KEYS[3] = pending index
    // ARGV[1] = amount, ARGV[2] = reservation TTL (sec), ARGV[3] = entryPrice,
    // ARGV[4] = entryTimeMs, ARGV[5] = balKey (string, sweep এর জন্য সংরক্ষণ),
    // ARGV[6] = reservationId, ARGV[7] = orphanAt (ms epoch — এর পরে sweep ফেরত দেবে)
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
      -- pending index এ যোগ — sweep এখান থেকেই সরাসরি orphan খুঁজে পাবে,
      -- SCAN ছাড়াই। reserve, index-এন্ট্রি ও balance-deduct তিনটাই একই
      -- Lua তে, তাই মাঝপথে server মরলেও অসম্পূর্ণ অবস্থা তৈরি হয় না।
      redis.call('ZADD', KEYS[3], ARGV[7], ARGV[6])
      return {1, nb}
    `,
  });

  // [ATOMIC EXECUTE] reservation কে "confirmed" করে — এই মুহূর্তে balance
  // আগেই deduct হয়ে গেছে (reserve-time এ), তাই এখানে শুধু status বদলাই
  // (pending → executed), যাতে caller নিশ্চিত হয় ঠিক কোন reservation
  // execute হলো, duplicate-execute (frontend দুইবার confirm পাঠালে)
  // থেকে রক্ষা পাওয়া যায়।
  redisPub.defineCommand('gvExecuteReservation', {
    numberOfKeys: 2,
    // KEYS[1] = reservation key, KEYS[2] = pending index
    // ARGV[1] = reservationId
    lua: `
      local st = redis.call('HGET', KEYS[1], 'status')
      if st == false then return 0 end        -- reservation নেই/expire হয়ে গেছে
      if st ~= 'pending' then return 0 end     -- আগেই executed/released
      redis.call('HSET', KEYS[1], 'status', 'executed')
      -- index থেকে সরিয়ে দিই — trade সফলভাবে বসে গেছে, sweep এর আর
      -- কোনো কাজ নেই। এটাই ভুয়া refund ঠেকানোর মূল লাইন।
      redis.call('ZREM', KEYS[2], ARGV[1])
      return 1
    `,
  });

  // [ATOMIC RELEASE] ব্যবহারকারী trade বাতিল করলে বা timeout এ — reserved
  // balance ফেরত দেওয়া। শুধু 'pending' status এ থাকলেই ফেরত হবে, ইতিমধ্যে
  // executed হলে ফেরত দেওয়া ভুল হবে (টাকা তখন legitimately deducted)।
  redisPub.defineCommand('gvReleaseReservation', {
    numberOfKeys: 3,
    // KEYS[1] = reservation key, KEYS[2] = balance key, KEYS[3] = pending index
    // ARGV[1] = reservationId
    lua: `
      local st = redis.call('HGET', KEYS[1], 'status')
      if st == false then
        -- hash মুছে গেছে (TTL) কিন্তু index এ রয়ে গেছে — টাকা ফেরত
        -- দেওয়ার তথ্য আর নেই, তাই index পরিষ্কার করে 0 ফেরত দিই।
        -- এমনটা ঘটলে sweep interval খুব বড়, log এ ধরা পড়বে।
        redis.call('ZREM', KEYS[3], ARGV[1])
        return -1
      end
      if st ~= 'pending' then
        redis.call('ZREM', KEYS[3], ARGV[1])
        return 0
      end
      local amt = redis.call('HGET', KEYS[1], 'amount')
      redis.call('INCRBYFLOAT', KEYS[2], amt)
      redis.call('EXPIRE', KEYS[2], 3600)
      redis.call('HSET', KEYS[1], 'status', 'released')
      redis.call('ZREM', KEYS[3], ARGV[1])
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

  // orphanAt — এই মুহূর্তের পরে reservation টা এখনো 'pending' থাকলে
  // ধরে নেওয়া হবে /place-trade কখনো সম্পূর্ণ হয়নি, তাই টাকা ফেরত।
  // ৩ সেকেন্ড রাখা হয়েছে: একটা সফল /place-trade মিলিসেকেন্ডেই execute
  // পর্যন্ত পৌঁছে যায়, তাই ৩ সেকেন্ড যথেষ্ট উদার — ধীর নেটওয়ার্কেও
  // বৈধ trade ভুল করে refund হবে না।
  const orphanAt = Date.now() + 3000;

  // hash এর TTL index এর সময়সীমার চেয়ে বেশি — নইলে sweep যখন orphan
  // ধরতে যাবে তখন hash উধাও থাকতে পারে, আর amount না জানলে টাকা ফেরত
  // দেওয়াই সম্ভব হতো না।
  const hashTtl = RESERVATION_TTL_SEC + ORPHAN_GRACE_SEC;

  const [ok, newBalRaw] = await redisPub.gvReserveBalance(
    balKey, resKey, PENDING_ZSET,
    String(amount), String(hashTtl),
    String(entryPrice), String(entryTimeMs), balKey,
    reservationId, String(orphanAt)
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
  const result = await redisPub.gvExecuteReservation(resKey, PENDING_ZSET, reservationId);
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
  const result = await redisPub.gvReleaseReservation(resKey, balKey, PENDING_ZSET, reservationId);
  return result === 1;
}

/**
 * [ORPHAN RECOVERY] pending-index থেকে মেয়াদোত্তীর্ণ reservation খুঁজে
 * টাকা ফেরত দেয়।
 *
 * কেন এটা দরকার (এবং আগের SCAN-ভিত্তিক sweep কেন যথেষ্ট ছিল না):
 *   • আগে প্রতি বার পুরো keyspace SCAN হতো, প্রতিটা key তে HGET+TTL —
 *     user বাড়ার সাথে খরচ রৈখিকভাবে বাড়ত। তাই sweep কে ৩০ সেকেন্ডে
 *     একবার রাখতে হয়েছিল, অথচ reservation বাঁচে মাত্র ১০ সেকেন্ড —
 *     ফলে বেশির ভাগ orphan ধরাই পড়ত না, user এর টাকা হারিয়ে যেত।
 *   • এখন একটাই ZRANGEBYSCORE কল বলে দেয় কারা মেয়াদোত্তীর্ণ। খরচ
 *     প্রায় স্থির, তাই কয়েক সেকেন্ড পর পর চালানো যায় এবং প্রতিটা
 *     orphan নিশ্চিতভাবে ধরা পড়ে।
 *
 * ন্যায্যতা দুই দিকেই রক্ষা পায়:
 *   • trade সফলভাবে বসে গেলে status 'executed' — index এ আর থাকে না,
 *     তাই টাকা ভুল করে ফেরত যায় না (প্ল্যাটফর্মের সুরক্ষা)।
 *   • /place-trade মাঝপথে ব্যর্থ হলে status 'pending' থেকে যায় —
 *     কয়েক সেকেন্ডের মধ্যেই টাকা ফেরত (user এর সুরক্ষা)।
 *
 * @returns {Promise<{released:number, lost:number}>}
 *          released = ফেরত দেওয়া হয়েছে, lost = hash উধাও ছিল বলে
 *          ফেরত দেওয়া যায়নি (এটা ০ এর বেশি হলে interval বড্ড বড়)।
 */
async function sweepExpiredReservations(redisPub, batchLimit = 500) {
  const now = Date.now();
  const ids = await redisPub.zrangebyscore(
    PENDING_ZSET, 0, now, 'LIMIT', 0, batchLimit
  );
  let released = 0, lost = 0;
  for (const reservationId of ids) {
    const resKey = RES_KEY(reservationId);
    const balKey = await redisPub.hget(resKey, 'balKey');
    if (!balKey) {
      // hash নেই — index এন্ট্রি পরিষ্কার করে দিই, নইলে চিরকাল জমতে থাকত
      await redisPub.zrem(PENDING_ZSET, reservationId);
      lost++;
      continue;
    }
    const r = await redisPub.gvReleaseReservation(resKey, balKey, PENDING_ZSET, reservationId);
    if (r === 1) released++;
    else if (r === -1) lost++;
  }
  return { released, lost };
}

module.exports = {
  registerReservationCommands,
  reserveTradeBalance,
  executeReservation,
  releaseReservation,
  sweepExpiredReservations,
  RESERVATION_TTL_SEC,
  PENDING_ZSET,
};
