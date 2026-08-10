/**
 * mtgguard.js — Single-trader market এ martingale (MTG) pattern detection
 * ═══════════════════════════════════════════════════════════════════════
 * সমস্যা: ordersettle.js এর majority-loses logic শুধু 2+ ভিন্ন trader
 * থাকলে কাজ করে (fairness এর জন্য single trader কে unfair treatment না
 * দিতে)। কিন্তু ঠিক single-trader অবস্থাতেই MTG সবচেয়ে কার্যকর, কারণ
 * কোনো counter-force নেই — user amount বাড়িয়ে/বারবার trade করে
 * নিশ্চিত লাভের চেষ্টা করতে পারে।
 *
 * সমাধান: প্রতিটা user এর সাম্প্রতিক trade history (direction, win/loss,
 * amount) থেকে "risk score" বের করি — pattern যত স্পষ্ট (repeat + বাড়তি
 * amount + সাম্প্রতিক loss), tilt তত বেশি, কিন্তু সবসময় ছোট সীমার
 * মধ্যে। এটা কখনো single trade কে guaranteed করে না (predictable হলে
 * ধরা পড়বে) — শুধু repeated martingale attempt এ গড়ে সুবিধা কমায়।
 *
 * ─── Signal যা দেখা হয় ─────────────────────────────────────────────
 * ১. Repeat — same direction পরপর কতবার (amount না বাড়লেও এটা signal)
 * ২. Amount growth — বর্তমান trade আগেরটার চেয়ে কত গুণ বড়
 * ৩. Recent loss — এই streak এ কতগুলো loss হয়েছে
 *
 * ─── নিরাপত্তা ─────────────────────────────────────────────────────
 * • Tilt সবসময় ordersettle.js এর মতোই pip-ভিত্তিক, ছোট সীমায় বাঁধা
 * • ১-২টা trade এ কার্যকর প্রভাব নেই (repeat কম), শুধু ৩+ streak এ
 *   ধীরে বাড়ে
 * • কোনো data না থাকলে (নতুন user) tilt = ০
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

const CFG = {
  maxTiltPips:   num(process.env.MTG_MAX_TILT_PIPS,   3),    // সর্বোচ্চ কত pip tilt (ordersettle এর maxPushPips এর অর্ধেক — আরও রক্ষণশীল)
  historyLen:    num(process.env.MTG_HISTORY_LEN,     5),    // প্রতি user কতগুলো সাম্প্রতিক trade মনে রাখবে
  minRepeat:     num(process.env.MTG_MIN_REPEAT,      3),    // কমপক্ষে কতবার same-direction repeat হলে tilt শুরু হবে
  repeatWeight:  num(process.env.MTG_REPEAT_WEIGHT,   0.15), // প্রতি repeat এ কত weight যোগ হয়
  growthWeight:  num(process.env.MTG_GROWTH_WEIGHT,   0.10), // amount growth এর weight
  entryTTL:      num(process.env.MTG_ENTRY_TTL_MS,    3600000), // ১ ঘণ্টা — এর বেশি পুরনো history উপেক্ষা
};

// userId → [{ dir, win, amount, ts }, ...]  (সর্বোচ্চ historyLen টা)
const _userHistory = new Map();

/** নতুন trade-এর ফলাফল রেকর্ড — settlement শেষে ডাকতে হবে */
/**
 * নতুন trade placement এ ডাকা হয় (settlement এ না — win/loss তথ্য
 * otc-server.js এর কাছে সহজলভ্য না, সেটা redis-settler.js এ আলাদা
 * process এ ঠিক হয়)। তাই শুধু direction+amount দিয়ে pattern দেখি —
 * repeat ও amount-growth ই মূল signal, win/loss আসলে শুধু score
 * সামান্য modify করত, বাধ্যতামূলক না।
 */
function recordResult(userId, dir, win, amount) {
  if (!userId || !dir) return;
  let arr = _userHistory.get(userId);
  if (!arr) { arr = []; _userHistory.set(userId, arr); }
  arr.push({ dir, win: !!win, amount: Number(amount) || 0, ts: Date.now() });
  if (arr.length > CFG.historyLen) arr.shift();

  // memory bound — খুব পুরনো user entry ছাঁটা (simple, প্রতি ১০০০ call এ একবার)
  if (_userHistory.size > 5000 && Math.random() < 0.01) {
    const cutoff = Date.now() - CFG.entryTTL * 4;
    for (const [uid, h] of _userHistory) {
      if (!h.length || h[h.length - 1].ts < cutoff) _userHistory.delete(uid);
    }
  }
}

/**
 * এই user এর সাম্প্রতিক history দেখে risk-tilt বের করে — কতটা এই
 * trade টা "martingale pattern"-এর মতো লাগছে।
 *
 * @returns {number} tiltPips — ০ (কোনো pattern নেই) থেকে maxTiltPips
 */
function _riskScore(userId, dir, amount) {
  const arr = _userHistory.get(userId);
  if (!arr || arr.length === 0) return 0;

  const cutoff = Date.now() - CFG.entryTTL;
  const recent = arr.filter(e => e.ts >= cutoff);
  if (recent.length === 0) return 0;

  // পিছন থেকে same-direction কতবার টানা চলছে (dir field দিয়ে, amount
  // বাড়ুক বা না বাড়ুক — এটাই "শুধু click করা" কেসও ধরে)
  let repeat = 0;
  let lossCount = 0;
  let lastAmount = null;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].dir !== dir) break;
    repeat++;
    if (!recent[i].win) lossCount++;
    if (lastAmount === null) lastAmount = recent[i].amount;
  }
  if (repeat < CFG.minRepeat) return 0;

  // amount growth factor — বর্তমান amount আগেরটার তুলনায় কত গুণ
  const growthFactor = (lastAmount && lastAmount > 0)
    ? Math.max(0, Math.min(2, (amount / lastAmount) - 1))   // ০-২ এর মধ্যে বাঁধা
    : 0;

  const lossRatio = lossCount / repeat;   // এই streak এ কতটা loss-heavy

  const score = (repeat - CFG.minRepeat + 1) * CFG.repeatWeight
              + growthFactor * CFG.growthWeight
              + lossRatio * 0.1;

  return Math.min(1, Math.max(0, score));
}

/**
 * Single-trader market এ ব্যবহারের জন্য — ছোট tilt সহ close price।
 * @param {number} closePrice
 * @param {number} decimals
 * @param {string} userId
 * @param {string} dir        'up' | 'down'
 * @param {number} amount
 */
function applyTilt(closePrice, decimals, userId, dir, amount) {
  if (!closePrice || !isFinite(closePrice) || closePrice <= 0) return closePrice;
  if (!userId || (dir !== 'up' && dir !== 'down')) return closePrice;

  const score = _riskScore(userId, dir, amount);
  if (score <= 0) return closePrice;

  const dec = (typeof decimals === 'number' && decimals > 0) ? decimals : 5;
  const pip = Math.pow(10, -dec);
  const tiltPips = score * CFG.maxTiltPips;
  const direction = dir === 'up' ? -1 : 1;   // trader 'up' এ থাকলে নিচে ঠেলা

  return closePrice + pip * tiltPips * direction;
}

module.exports = { recordResult, applyTilt, CFG };
