/**
 * ordersettle.js — Order-flow ভিত্তিক close price সমন্বয়
 * ═══════════════════════════════════════════════════════════════════════
 * সমস্যা: এখন settlement candle এর দাম দিয়েই হয় (pure engine.js physics)
 * — দাম কে কোন দিকে bet করেছে সেটা জানে না। তাই martingale (MTG) এর মতো
 * money-management strategy দিয়ে এটা exploit করা যায়, কারণ দাম আর
 * bet-এর মধ্যে কোনো সম্পর্ক নেই — শুধু ৫০-৫০ random walk।
 *
 * সমাধান: আসল broker (Quotex, Pocket Option ইত্যাদি) যেমন করে — expiry
 * এর কাছাকাছি সময়ে, যে দিকে বেশি amount বাজি ধরা আছে (majority), close
 * price কে সেই দিকের বিপরীতে সামান্য push করা হয়। সংখ্যাগরিষ্ঠ পক্ষ
 * সামান্য বেশি হারে — এটাই house edge এর আসল উৎস, শুধু payout % না।
 *
 * ─── কীভাবে "অদৃশ্য" থাকে ─────────────────────────────────────────
 * Push করা হয় engine এর normal tick-movement এর সীমার মধ্যেই (কখনো
 * maxStep ছাড়ায় না) — তাই chart এ এটা shocking/artificial লাগে না,
 * স্বাভাবিক ছোট নড়াচড়ার মতোই দেখায়।
 *
 * ─── নিরাপত্তা ─────────────────────────────────────────────────────
 * • একজন মাত্র trader থাকলে (একা market এ) — push নিষ্ক্রিয়, ন্যায্য
 *   ৫০-৫০ থাকে (single-user exploit-detection এড়াতে না, বরং fairness
 *   বজায় রাখতে — single trader এর বিরুদ্ধে platform এভাবে না দাঁড়ানোই
 *   উচিত)।
 * • Push এর মাত্রা majority/minority এর amount-অনুপাতের সমানুপাতিক,
 *   কিন্তু একটা নির্দিষ্ট সর্বোচ্চ সীমার মধ্যে বাঁধা (কখনো দামকে
 *   অস্বাভাবিকভাবে দূরে ঠেলে দেয় না)।
 * • কোনো data অসম্পূর্ণ/ব্যর্থ হলে দাম অপরিবর্তিত থাকে — settlement
 *   কখনো আটকায় না।
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

const CFG = {
  // push এর সর্বোচ্চ মাত্রা — দামের কত শতাংশ পর্যন্ত সরানো যাবে।
  // engine.js এর maxStep (০.১৫%/tick) এর কাছাকাছি রাখা হয়েছে, যাতে
  // এক ধাক্কায় এটা একটা normal tick এর চেয়ে বড় না লাগে।
  maxPush:     num(process.env.ORDER_MAX_PUSH,     0.0012),
  // কমপক্ষে কতজন আলাদা user থাকলে এই logic সক্রিয় হবে — single-trader
  // market এ ন্যায্য (৫০-৫০) থাকতে এটা ২ রাখা হয়েছে।
  minTraders:  num(process.env.ORDER_MIN_TRADERS,  2),
  // Imbalance যত বেশি (majority যত বড়), push তত জোরালো — কিন্তু সবসময়
  // maxPush এর সীমার মধ্যেই।
  sensitivity: num(process.env.ORDER_SENSITIVITY,  0.9),
};

/**
 * প্রদত্ত trade array (একই symbol, একই মুহূর্তে expire হওয়া) থেকে
 * order-flow imbalance অনুযায়ী closePrice সামান্য সমন্বয় করে।
 *
 * @param {Array}  trades      [{ userId, type: 'up'|'down', amount, ... }]
 * @param {number} closePrice  engine থেকে আসা মূল close price
 * @returns {number}           সমন্বিত close price (imbalance না থাকলে অপরিবর্তিত)
 */
function adjustClosePrice(trades, closePrice) {
  if (!Array.isArray(trades) || trades.length === 0) return closePrice;
  if (!closePrice || !isFinite(closePrice) || closePrice <= 0) return closePrice;

  // আলাদা user সংখ্যা গুনি — single-trader market এ hands off থাকতে
  const uniqueUsers = new Set(trades.map(t => t.userId).filter(Boolean));
  if (uniqueUsers.size < CFG.minTraders) return closePrice;

  // up/down এর মোট amount
  let upAmt = 0, downAmt = 0;
  for (const t of trades) {
    const amt = Number(t.amount) || 0;
    if (t.type === 'up') upAmt += amt;
    else if (t.type === 'down') downAmt += amt;
  }
  const total = upAmt + downAmt;
  if (total <= 0) return closePrice;

  // imbalance — -1 (সব down) থেকে +1 (সব up), ০ মানে সমান
  const imbalance = (upAmt - downAmt) / total;
  if (Math.abs(imbalance) < 0.02) return closePrice;   // প্রায় সমান — push দরকার নেই

  // majority যদি 'up' হয় (imbalance ধনাত্মক), তাদের হারাতে close price
  // নিচে ঠেলে দিই (নেতিবাচক push) — আর উল্টোটা।
  const pushMag = Math.min(CFG.maxPush, Math.abs(imbalance) * CFG.sensitivity * CFG.maxPush);
  const direction = imbalance > 0 ? -1 : 1;   // majority 'up' → নিচে ঠেলা
  const delta = closePrice * pushMag * direction;

  return closePrice + delta;
}

module.exports = { adjustClosePrice, CFG };
