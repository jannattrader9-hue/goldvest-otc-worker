/**
 * engine2.js — GoldVest OTC price engine (SIMPLE JUMP VERSION)
 * ═══════════════════════════════════════════════════════════════════════
 * User এর স্পষ্ট নির্দেশ — "শুধু লাফিয়ে লাফিয়ে চলবে, জাম্প করে করে"।
 *
 * আগের engine.js এ phase (run/retrace/rest), regime (speed-state),
 * momentum-tracking, mid-burst-trigger ইত্যাদি অনেক স্তর ছিল — প্রতিটা
 * আলাদাভাবে ঠিক মনে হলেও একসাথে মিলিয়ে বারবার অপ্রত্যাশিত ফলাফল
 * (glide, দোলনি, অতিরিক্ত/অপ্রতুল jump) দিচ্ছিল।
 *
 * এই সংস্করণ সম্পূর্ণ ভিন্ন, ইচ্ছাকৃতভাবে সরল দর্শন মেনে চলে:
 *   প্রতিটা tick = একটা স্বাধীন সিদ্ধান্ত (কোনো phase/state-machine নেই)
 *   ১. এলোমেলো দিক (up/down, সামান্য persistent bias)
 *   ২. এলোমেলো মাপ (heavy-tail — বেশিরভাগ ছোট, কদাচিৎ বড়)
 *   ৩. সরাসরি প্রয়োগ — কোনো glide/interpolation/retrace-logic নেই
 *
 * এটাই ঠিক real market tick data এর কাছাকাছি চরিত্র — tick-to-tick
 * প্রায় independent, শুধু small persistence bias (momentum) থাকে।
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

const CFG = {
  unit: num(process.env.ENG2_UNIT, 0.00003),
  gapMs: num(process.env.ENG2_GAP_MS, 350),
  dirPersistence: num(process.env.ENG2_DIR_PERSIST, 0.12),
  pSmall:  num(process.env.ENG2_P_SMALL,  0.55),
  pMedium: num(process.env.ENG2_P_MEDIUM, 0.35),
  maxStep: num(process.env.ENG2_MAX_STEP, 0.002),
  session: num(process.env.ENG2_SESSION, 0.35),
  anchorBand:     num(process.env.ENG2_ANCHOR_BAND,     0.06),
  anchorStrength: num(process.env.ENG2_ANCHOR_STRENGTH, 0.00005),
};

function sessionMul(t, amt) {
  const d = new Date(t);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const curve = 0.55
    + 0.75 * Math.exp(-Math.pow((h - 13) / 5.5, 2))
    + 0.35 * Math.exp(-Math.pow((h - 8.5) / 2.2, 2));
  return 1 + (curve - 1) * amt;
}

function _fitDecimals(price, given) {
  return given;
}

function _tickScale(price, decimals) {
  const step = Math.pow(10, -decimals);
  const want = price * 0.000012;
  if (want >= step * 0.9) return 1;
  return Math.min(3, (step * 0.9) / Math.max(want, 1e-12));
}

function createState(price, decimals = 5) {
  decimals = _fitDecimals(price, decimals);
  return {
    price,
    decimals,
    tickScale: _tickScale(price, decimals),
    referencePrice: 0,
    lastDir: Math.random() < 0.5 ? 1 : -1,
  };
}

function nextPrice(st, now = Date.now(), over) {
  const c = over ? { ...CFG, ...over } : CFG;
  const base = st.price * c.unit * (st.tickScale || 1);
  const sm = sessionMul(now, c.session);

  const dir = (Math.random() < 0.5 + (st.lastDir * c.dirPersistence * 0.5)) ? 1 : -1;
  st.lastDir = dir;

  const r = Math.random();
  let mag;
  if (r < c.pSmall) {
    mag = 0.15 + Math.random() * 0.6;
  } else if (r < c.pSmall + c.pMedium) {
    mag = 0.6 + Math.pow(Math.random(), -0.35) * 0.9;
  } else {
    mag = 2 + Math.pow(Math.random(), -0.5) * 4;
  }

  let delta = dir * base * mag * sm;

  if (st.referencePrice > 0) {
    const refDiff = (st.referencePrice - st.price) / st.referencePrice;
    if (Math.abs(refDiff) > c.anchorBand) {
      const pull = (refDiff - Math.sign(refDiff) * c.anchorBand) * c.anchorStrength;
      delta += st.price * pull;
    }
  }

  const cap = st.price * c.maxStep;
  delta = Math.max(-cap, Math.min(cap, delta));

  st.price = Math.max(st.price + delta, 1e-8);
  st.price = Number(st.price.toFixed(st.decimals));

  return st.price;
}

function nextDelay(st, over, now = Date.now()) {
  const c = over ? { ...CFG, ...over } : CFG;
  let g = c.gapMs;

  const roll = Math.random();
  if (roll < 0.15) g *= 0.4;
  else if (roll > 0.85) g *= 1.8;
  g *= 0.7 + Math.random() * 0.6;

  return Math.max(120, Math.min(2000, g));
}

module.exports = { createState, nextPrice, nextDelay, sessionMul, CFG };
