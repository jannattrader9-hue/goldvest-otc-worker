/**
 * engine.js — GoldVest OTC price engine (v2)
 * ═══════════════════════════════════════════════════════════════════════
 * আসল FX বাজার যে নিয়মে চলে, সেই নিয়মেই দাম তৈরি করে। আগের সংস্করণে
 * "ঝলক / শ্বাস / জমাট" এর মত ধাপ হাতে বানানো ছিল — সেটা বাদ। এবার দাম
 * চলে বাজারের প্রকৃত কারণ থেকে, তাই কোনো ছক চোখে ধরা পড়ে না।
 *
 * ─── কোন নীতিগুলো বসানো ────────────────────────────────────────────
 *
 * ১. অর্ডার-প্রবাহের ভারসাম্যহীনতা (order flow imbalance)
 *    দাম নড়ে কারণ কেনা বা বেচার চাপ বেশি পড়ে। চাপ এলোমেলোভাবে আসে,
 *    কিন্তু কিছুক্ষণ রেশ থেকে যায় — তাই ছোট ছোট ধারা তৈরি হয়।
 *
 * ২. অস্থিরতার গুচ্ছ (volatility clustering — GARCH)
 *    আজকের ধাক্কা পরের কিছুক্ষণের অস্থিরতা বাড়ায়। এটাই candle গুলোকে
 *    আলাদা আকারের করে; না থাকলে সব candle একরকম দেখাত।
 *
 * ৩. বাজার-নির্মাতার মজুত (inventory)
 *    দাম এক দিকে বেশি সরলে নির্মাতার মজুত ভারী হয়, তখন সে উল্টো দিকে
 *    দর দেয় — দাম আংশিক ফিরে আসে। এটাই retracement এর আসল কারণ, আর
 *    এটাই দিককে অনুমান-অযোগ্য রাখে।
 *
 * ৪. তারল্য ঘন-পাতলা (liquidity depth)
 *    বইয়ের গভীরতা কমলে একই চাপে দাম অনেক বেশি লাফায়। তাই মাঝে মাঝে
 *    হঠাৎ বড় লাফ — আলাদা করে "spike" বানাতে হয় না।
 *
 * ৫. স্টপ ঝাঁক (stop cascade)
 *    দাম স্তর ভাঙলে জমে থাকা stop-loss একসাথে চালু হয়ে দ্রুত কয়েক ধাপ
 *    ঠেলে দেয়, তারপর থেমে যায়।
 *
 * ৬. গোল সংখ্যার টান (round-number magnetism)
 *    গোল সংখ্যার কাছে জমা order দাম কিছুক্ষণ ধরে রাখে।
 *
 * ৭. অধিবেশনের ছন্দ — লন্ডন/নিউইয়র্কে উত্তাল, এশীয় সময়ে ঝিমানো।
 *
 * ৮. pip ধাপ — দাম ধারাবাহিক নয়, নির্দিষ্ট ধাপে লাফায়।
 *
 * ─── নিরাপত্তা ─────────────────────────────────────────────────────
 * ৯২% payout এ ব্রেক-ইভেন ৫২.১%। চাপের রেশ অল্পক্ষণ থাকে আর মজুতের টান
 * তাকে ভারসাম্যে ফেরায়, তাই কোনো সময়সীমাতেই দিক অনুমান করে জেতা যায় না।
 *
 * ⚠ কোনো সংখ্যা বদলালে জয়ের হার বদলাতে পারে — বদলানোর আগে মেপে নিও।
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

const CFG = {
  // এক ধাপের আনুমানিক মাপ (দামের অনুপাতে)
  unit:      num(process.env.ENG_UNIT,      0.000035),

  // ১. অর্ডার-প্রবাহ
  flowMem:   num(process.env.ENG_FLOW_MEM,  0.72),   // চাপের রেশ
  flowAmp:   num(process.env.ENG_FLOW_AMP,  1.00),   // চাপের মাত্রা

  // ২. অস্থিরতার গুচ্ছ
  volMem:    num(process.env.ENG_VOL_MEM,   0.995),
  volAmp:    num(process.env.ENG_VOL_AMP,   0.40),
  volMin:    num(process.env.ENG_VOL_MIN,   0.40),
  volMax:    num(process.env.ENG_VOL_MAX,   2.40),

  // ৩. মজুতের টান
  invPull:   num(process.env.ENG_INV_PULL,  0.055),
  invMem:    num(process.env.ENG_INV_MEM,   0.988),

  // ৪. তারল্য
  liqMem:    num(process.env.ENG_LIQ_MEM,   0.93),
  liqDepth:  num(process.env.ENG_LIQ_DEPTH, 0.55),

  // ৫. স্টপ ঝাঁক
  stopOdds:  num(process.env.ENG_STOP_ODDS, 0.006),
  stopSize:  num(process.env.ENG_STOP_SIZE, 3.2),

  // ৬. গোল সংখ্যার টান
  roundPull: num(process.env.ENG_ROUND,     0.30),

  // ৭. অধিবেশন
  session:   num(process.env.ENG_SESSION,   0.50),

  // ঝোঁক — খুব মৃদু, নইলে অনুমানযোগ্য
  bias:      num(process.env.ENG_BIAS,      0.010),
  biasMem:   num(process.env.ENG_BIAS_MEM,  0.9995),

  // tick এর ছন্দ
  gapMs:     num(process.env.ENG_GAP_MS,    170),
  gapVar:    num(process.env.ENG_GAP_VAR,   0.80),

  // নিরাপত্তা
  maxStep:   num(process.env.ENG_MAX_STEP,  0.0015),  // ±০.১৫%/tick

  // admin (otc-server প্রতি tick এ পাঠায়)
  forceDir: 0,
  trendStrength: 0.6,
};

/* দামের সাথে মানানসই দশমিক ঘর — ছোট দামের market এ এক ধাপ যেন পায়ের
   চেয়ে বড় হয়ে না যায় (নইলে দাম প্রায় নড়ত না)। */
function _fitDecimals(price, given) {
  if (!isFinite(price) || price <= 0) return given;
  const need = Math.ceil(Math.log10(1 / (price * 0.00002)));
  return Math.min(8, Math.max(given, need));
}

/** নতুন market এর অবস্থা */
function createState(price, decimals = 5) {
  decimals = _fitDecimals(price, decimals);
  return {
    price,
    decimals,
    flow: 0,          // চলতি অর্ডার-চাপ
    vol: 1,           // চলতি অস্থিরতা
    liq: 1,           // তারল্যের গভীরতা (কম = পাতলা = বড় লাফ)
    drift: 0,         // দীর্ঘমেয়াদি মৃদু ঝোঁক
    stopLeft: 0,      // স্টপ ঝাঁক আর কত tick
    stopDir: 1,
    anchor: price,    // মজুত হিসাবের চলমান ভিত্তি
  };
}

/** অধিবেশনের গুণক — UTC ঘণ্টা অনুযায়ী */
function sessionMul(t, amt) {
  const d = new Date(t);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const curve = 0.55
    + 0.80 * Math.exp(-Math.pow((h - 13.5) / 5.0, 2))   // লন্ডন + নিউইয়র্ক
    + 0.30 * Math.exp(-Math.pow((h - 8.0) / 2.0, 2))    // লন্ডন খোলা
    + 0.15 * Math.exp(-Math.pow((h - 1.0) / 2.5, 2));   // টোকিও
  return 1 + (curve - 1) * amt;
}

/* গাউসীয় এলোমেলো — আসল বাজারের চাপ এভাবেই বণ্টিত */
function _gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * এক tick এগোয় — নতুন দাম ফেরত দেয়।
 * @param {object} st    createState() এর অবস্থা
 * @param {number} now   বর্তমান সময় (ms)
 * @param {object} [over] override — admin নিয়ন্ত্রণ, volatility ইত্যাদি
 */
function nextPrice(st, now = Date.now(), over) {
  const c = over ? { ...CFG, ...over } : CFG;
  const unit = st.price * c.unit;
  const sm = sessionMul(now, c.session);

  /* ── ২. অস্থিরতার গুচ্ছ ── */
  const shock = Math.abs(_gauss());
  st.vol = st.vol * c.volMem + (1 - c.volMem) * (0.55 + shock * c.volAmp * 1.6);
  st.vol = Math.max(c.volMin, Math.min(c.volMax, st.vol));

  /* ── ৪. তারল্য — পাতলা হলে একই চাপে বড় লাফ ── */
  st.liq = st.liq * c.liqMem + (1 - c.liqMem) * (0.55 + Math.random() * 0.9);
  st.liq = Math.max(0.25, Math.min(1.8, st.liq));
  const thin = 1 / Math.max(0.25, st.liq * (1 - c.liqDepth) + c.liqDepth);

  /* ── ঝোঁক — খুব ধীরে বদলায়, খুব মৃদু ── */
  if (Math.random() > c.biasMem) st.drift = Math.random() < 0.5 ? -1 : 1;
  const adminDir = c.forceDir || 0;
  const biasNow = adminDir
    ? adminDir * (0.35 + c.trendStrength * 0.75)   // admin manual mode
    : st.drift * c.bias;

  /* ── ১. অর্ডার-প্রবাহ ── */
  st.flow = st.flow * c.flowMem + _gauss() * c.flowAmp * (1 - c.flowMem) * 3;

  /* ── ৩. মজুতের টান ── */
  st.anchor = st.anchor * c.invMem + st.price * (1 - c.invMem);
  const inv = (st.price - st.anchor) / Math.max(unit, 1e-12);
  const pull = -inv * c.invPull * (adminDir ? 0.25 : 1);

  /* ── ৫. স্টপ ঝাঁক ── */
  if (st.stopLeft <= 0 && Math.random() < c.stopOdds * st.vol) {
    st.stopLeft = 2 + ((Math.random() * 4) | 0);
    st.stopDir = st.flow >= 0 ? 1 : -1;         // যেদিকে চাপ, সেদিকেই ভাঙে
  }
  let stop = 0;
  if (st.stopLeft > 0) {
    st.stopLeft--;
    stop = st.stopDir * c.stopSize * (0.5 + Math.random());
  }

  /* ── সব মিলিয়ে এক ধাপ ── */
  let delta = (st.flow + pull + biasNow * 6 + stop) * unit * st.vol * thin * sm;

  /* ── ৬. গোল সংখ্যার টান ── */
  if (c.roundPull > 0) {
    const gridPx = Math.pow(10, -(st.decimals - 2));
    if (gridPx > 0) {
      const nearest = Math.round(st.price / gridPx) * gridPx;
      const dist = (st.price - nearest) / gridPx;      // −0.5 … +0.5
      if (Math.abs(dist) < 0.30) delta -= dist * gridPx * c.roundPull * 0.5;
    }
  }

  /* ── নিরাপত্তা: প্রতি tick এ সর্বোচ্চ ±০.১৫% ── */
  const cap = st.price * c.maxStep;
  delta = Math.max(-cap, Math.min(cap, delta));

  st.price = Math.max(st.price + delta, 1e-8);

  /* ── ৮. pip ধাপ ── */
  const qz = Math.pow(10, st.decimals);
  st.price = Math.round(st.price * qz) / qz;

  return st.price;
}

/**
 * পরের tick কত ms পরে।
 * আসল বাজারে tick গুচ্ছ হয়ে আসে — অস্থির সময়ে ঘন, শান্ত সময়ে বিরল।
 * ব্যবধান lognormal ধাঁচে: বেশিরভাগ ছোট, কদাচিৎ অনেক বড়।
 */
function nextDelay(st, over) {
  const c = over ? { ...CFG, ...over } : CFG;
  const activity = Math.pow(st.vol, 0.8) *
                   Math.pow(1 / Math.max(0.3, st.liq), 0.3);
  const base = c.gapMs / Math.max(0.35, activity);
  const jitter = Math.exp(_gauss() * c.gapVar * 0.55);
  return Math.max(35, Math.min(2500, base * jitter));
}

module.exports = { createState, nextPrice, nextDelay, sessionMul, CFG };
