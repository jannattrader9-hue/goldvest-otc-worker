/**
 * tickhistory.js — Canonical Tick History Storage/Lookup
 * ═══════════════════════════════════════════════════════════════════════
 * দায়িত্ব: শুধু storage আর lookup। tickId generation এই module এর কাজ
 * না — যেখানে tick তৈরি হয় (price-engine) সেখানেই tickId বসবে,
 * এই module শুধু সেই canonical tick সংরক্ষণ করে এবং পরে খুঁজে দেয়।
 *
 * দুটো ব্যবহার:
 *   ENTRY:      findTickById(symbol, tickId) — user যে tick visually
 *               দেখে click করেছে, ঠিক সেই tick এর canonical price।
 *   SETTLEMENT: findLatestTickAtOrBefore(symbol, timestamp) — trade এর
 *               expiryTimestamp এর ঠিক আগে/সময়ে যে সর্বশেষ tick এসেছিল,
 *               সেটাই settlement price। Expiry এর পরে আসা tick কখনো
 *               এই lookup এ আসবে না — deterministic, tamper-proof।
 *
 * Memory-safety: প্রতিটা market symbol এর জন্য একটা bounded circular
 * buffer (max ৫০০০ tick, বা প্রয়োজন অনুযায়ী adjust) — পুরনো tick
 * automatically evict হয়ে যায়, memory-leak হয় না।
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const MAX_TICKS_PER_SYMBOL = 5000;   // আনুমানিক — ৫ tick/সেকেন্ড হলে ~১৭ মিনিট history

// symbol → array of { tickId, timestamp, price } (timestamp অনুযায়ী sorted, ascending)
const _history = new Map();

/**
 * নতুন canonical tick সংরক্ষণ করে। tickId এখানে generate হয় না —
 * caller (price-engine) থেকে already-generated tickId আসবে।
 */
function recordTick(symbol, tickId, timestamp, price) {
  if (!symbol || tickId === undefined || tickId === null || !timestamp || !price) return;

  if (!_history.has(symbol)) _history.set(symbol, []);
  const arr = _history.get(symbol);

  arr.push({ tickId, timestamp, price });

  // bounded buffer — পুরনো tick সরিয়ে দাও (FIFO)
  if (arr.length > MAX_TICKS_PER_SYMBOL) {
    arr.splice(0, arr.length - MAX_TICKS_PER_SYMBOL);
  }
}

/**
 * ENTRY resolution — নির্দিষ্ট tickId এর canonical tick খোঁজে।
 * @returns {{tickId, timestamp, price}|null} পাওয়া না গেলে null —
 *   caller (otc-server.js) কে trade reject করতে হবে, fallback করা যাবে না।
 */
function findTickById(symbol, tickId) {
  const arr = _history.get(symbol);
  if (!arr) return null;
  // সাম্প্রতিক tick-ই বেশি সম্ভাব্য match, তাই পেছন থেকে খোঁজা দ্রুত।
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].tickId === tickId) return arr[i];
  }
  return null;
}

/**
 * SETTLEMENT resolution — নির্দিষ্ট timestamp এর ঠিক আগে/সময়ে যে
 * সর্বশেষ canonical tick এসেছিল, সেটা খোঁজে। Binary-search ব্যবহার
 * করা হয় কারণ history timestamp-sorted (ticks generate হওয়ার ক্রমেই
 * push হয়)।
 * @returns {{tickId, timestamp, price}|null}
 */
function findLatestTickAtOrBefore(symbol, timestamp) {
  const arr = _history.get(symbol);
  if (!arr || arr.length === 0) return null;

  // Binary search — শেষ index যেখানে arr[i].timestamp <= timestamp
  let lo = 0, hi = arr.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].timestamp <= timestamp) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result >= 0 ? arr[result] : null;
}

/**
 * Diagnostic/monitoring — কোনো symbol এর history-buffer এর বর্তমান size।
 */
function getHistorySize(symbol) {
  const arr = _history.get(symbol);
  return arr ? arr.length : 0;
}

/**
 * সব symbol এর history পরিষ্কার করে — টেস্টিং/রিস্টার্টের জন্য।
 */
function clearHistory(symbol) {
  if (symbol) _history.delete(symbol);
  else _history.clear();
}

module.exports = {
  recordTick,
  findTickById,
  findLatestTickAtOrBefore,
  getHistorySize,
  clearHistory,
};
