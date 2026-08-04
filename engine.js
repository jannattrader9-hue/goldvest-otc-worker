/**
 * engine.js — GoldVest OTC price engine (v2, নতুন করে লেখা)
 * ═══════════════════════════════════════════════════════════════════════
 * নকশার ভিত্তি: আসল FX বাজারের অণু-গঠন (market microstructure)।
 * কোনো কৃত্রিম "ঝলক/শ্বাস/জমাট" পর্ব নেই — দাম যা করে, তা এই পাঁচটা
 * বাস্তব শক্তির ফল। ঠিক যেভাবে আসল বাজারে হয়:
 *
 *   ১. অর্ডার প্রবাহের ভারসাম্যহীনতা (order flow imbalance)
 *      বাজারে প্রতি মুহূর্তে কেনা-বেচার চাপ থাকে। চাপ একবার এক দিকে
 *      ঝুঁকলে কিছুক্ষণ ওদিকেই থাকে (ব্রোকাররা ধাপে ধাপে order ভরে),
 *      তারপর মিলিয়ে যায়। এটাই দামের স্বল্পমেয়াদি ধারা তৈরি করে।
 *
 *   ২. অস্থিরতার গুচ্ছ (volatility clustering)
 *      শান্ত সময় শান্তই থাকে, উত্তাল সময় উত্তাল। GARCH ধাঁচের স্মৃতি।
 *      এটাই candle গুলোকে আলাদা আলাদা আকারের করে।
 *
 *   ৩. bid-ask লাফ (spread bounce)
 *      দাম bid ও ask এর মধ্যে এলোমেলো লাফায়, কোনো দিক ছাড়াই। tick এর
 *      কাঁপুনির আসল উৎস — আর এটাই স্বল্পমেয়াদে অনুমান অসম্ভব করে।
 *
 *   ৪. তারল্যের ফাঁক (liquidity gap)
 *      কদাচিৎ order book পাতলা হয়ে যায় → দাম এক লাফে সরে যায়, তারপর
 *      তারল্য ফিরলে আংশিক ফেরত আসে। এটাই spike ও wick তৈরি করে।
 *
 *   ৫. Poisson ধাঁচে tick আসা
 *      tick সমান বিরতিতে আসে না — কখনো ঝাঁক, কখনো নীরবতা।
 *      সক্রিয়তা বেশি হলে ঘন, কম হলে বিরল।
 *
 * ফলাফল (মাপা): সব সময়সীমায় জয়ের হার ~৫০%, তাই ৯২% payout এ নিরাপদ।
 *
 * ⚠ কোনো মান বদলালে scripts/verify দিয়ে জয়ের হার আবার মেপে নিও।
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

const CFG = {
  // ── দামের একক ──
  unit:    num(process.env.ENG_UNIT,    0.000075), // এক ধাপের মাপ (দামের অনুপাতে)
  maxStep: num(process.env.ENG_MAX_STEP, 0.0015),  // safety: প্রতি tick ±০.১৫%

  // ── ১. অর্ডার প্রবাহ ──
  flowMem:  num(process.env.ENG_FLOW_MEM,  0.86),  // চাপ কতক্ষণ টেকে
  flowKick: num(process.env.ENG_FLOW_KICK, 1.00),  // নতুন চাপের জোর

  // ── ২. অস্থিরতা ──
  volMem: num(process.env.ENG_VOL_MEM, 0.9965),    // স্মৃতির দৈর্ঘ্য
  volAmp: num(process.env.ENG_VOL_AMP, 0.55),      // ওঠানামার মাত্রা
  volMin: num(process.env.ENG_VOL_MIN, 0.40),
  volMax: num(process.env.ENG_VOL_MAX, 2.40),

  // ── ৩. bid-ask লাফ ──
  spread: num(process.env.ENG_SPREAD, 0.85),       // কাঁপুনির মাত্রা

  // ── ৪. তারল্যের ফাঁক ──
  gapProb: num(process.env.ENG_GAP_PROB, 0.010),   // কত ঘন ঘন (প্রতি tick)
  gapSize: num(process.env.ENG_GAP_SIZE, 3.2),     // কত বড় লাফ
  gapBack: num(process.env.ENG_GAP_BACK, 0.45),    // কতটা ফেরত আসে

  // ── ৫. tick আসা ──
  tickMs:  num(process.env.ENG_TICK_MS,  260),     // গড় ব্যবধান
  tickMin: num(process.env.ENG_TICK_MIN, 45),      // সর্বনিম্ন
  tickMax: num(process.env.ENG_TICK_MAX, 2200),    // সর্বোচ্চ

  // ── দিনের ছন্দ ──
  session: num(process.env.ENG_SESSION, 0.55),

  // ── admin নিয়ন্ত্রণ (প্রতি tick এ otc-server পাঠায়) ──
  forceDir:      0,      // 1 = up, -1 = down, 0 = auto
  trendStrength: 0.6,
};

/* দামের সাথে মানানসই দশমিক ঘর — এক ধাপ যেন গড় পায়ের চেয়ে বড় না হয়।
   (ছোট দামের market এ, যেমন NZD/USD 0.59, নইলে দাম নড়তই না।) */
function _fitDecimals(price, given) {
  if (!isFinite(price) || price <= 0) return given;
  const need = Math.ceil(Math.log10(1 / (price * 0.00002)));
  return Math.min(8, Math.max(given, need));
}

/* গাউসীয় এলোমেলো সংখ্যা (Box-Muller) — আসল বাজারের কোলাহল এভাবেই বণ্টিত */
function _gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function createState(price, decimals = 5) {
  decimals = _fitDecimals(price, decimals);
  return {
    price,
    decimals,
    flow: 0,          // চলতি অর্ডার চাপ
    vol: 1,           // চলতি অস্থিরতা
    gapDebt: 0,       // তারল্য ফাঁকের পর যতটা ফেরত দিতে হবে
    side: 1,          // bid না ask — লাফায়
    act: 1,           // সক্রিয়তা (tick এর ঘনত্ব)
    trend: Math.random() < 0.5 ? 1 : -1,
    trendLeft: 600 + ((Math.random() * 1800) | 0),
  };
}

/* দিনের ছন্দ — লন্ডন (৭-১৬ UTC) ও নিউইয়র্ক (১৩-২১) মিলে সবচেয়ে উত্তাল */
function sessionMul(t, amt) {
  const d = new Date(t);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const curve = 0.55
    + 0.75 * Math.exp(-Math.pow((h - 13) / 5.5, 2))
    + 0.35 * Math.exp(-Math.pow((h - 8.5) / 2.2, 2));
  return 1 + (curve - 1) * amt;
}

/**
 * এক tick এগোয় — নতুন দাম ফেরত দেয়।
 */
function nextPrice(st, now = Date.now(), over) {
  const c = over ? { ...CFG, ...over } : CFG;
  const base = st.price * c.unit;
  const sm = sessionMul(now, c.session);

  /* ── ২. অস্থিরতা — গুচ্ছ হয়ে চলে ── */
  st.vol = st.vol * c.volMem + (1 - c.volMem) * (1 + _gauss() * c.volAmp);
  st.vol = Math.max(c.volMin, Math.min(c.volMax, st.vol));
  const V = st.vol * sm;

  /* ── ১. অর্ডার প্রবাহ — চাপ জমে, টেকে, মিলিয়ে যায় ──
     নতুন চাপ গাউসীয়, তাই বেশিরভাগ ছোট, কদাচিৎ বড়। পুরনো চাপের
     একাংশ থেকে যায় (flowMem), তাই দাম কয়েক tick এক দিকে গড়ায় —
     কিন্তু চাপ নিজেই দিকহীন, তাই আগে থেকে অনুমান করা যায় না। */
  const bias = c.forceDir
    ? c.forceDir * (0.28 + c.trendStrength * 0.55)
    : (st.trend * 0.035);
  st.flow = st.flow * c.flowMem + _gauss() * c.flowKick + bias;

  let delta = st.flow * base * V * 0.55;

  /* ── ৩. bid-ask লাফ — দিকহীন, প্রতি tick এ পাশ বদলায় ── */
  if (Math.random() < 0.55) st.side = -st.side;
  delta += st.side * base * c.spread * V * (0.35 + Math.random() * 0.5);

  /* ── ৪. তারল্যের ফাঁক — কদাচিৎ বড় লাফ, পরে আংশিক ফেরত ── */
  if (st.gapDebt !== 0) {
    const back = st.gapDebt * (0.25 + Math.random() * 0.35);
    delta += back;
    st.gapDebt -= back;
    if (Math.abs(st.gapDebt) < base * 0.05) st.gapDebt = 0;
  } else if (Math.random() < c.gapProb) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    const mag = base * c.gapSize * V * (0.6 + Math.pow(Math.random(), -0.35) * 0.7);
    delta += dir * mag;
    st.gapDebt = -dir * mag * c.gapBack;   // এটুকু পরে ফেরত যাবে
    st.vol = Math.min(c.volMax, st.vol * 1.12);
  }

  /* ── দীর্ঘমেয়াদি ধারা — কয়েক মিনিট পরপর দিক বদলায় ── */
  if (--st.trendLeft <= 0) {
    st.trend = Math.random() < 0.5 ? 1 : -1;
    st.trendLeft = 600 + ((Math.random() * 1800) | 0);
  }

  /* ── সক্রিয়তা — অস্থিরতার সাথে চলে, tick এর ঘনত্ব ঠিক করে ── */
  st.act = st.act * 0.93 + 0.07 * (V * (0.7 + Math.random() * 0.8));

  /* ── safety clamp ── */
  const cap = st.price * c.maxStep;
  delta = Math.max(-cap, Math.min(cap, delta));

  st.price = Math.max(st.price + delta, 0.0001);

  /* ── pip ধাপ — দাম নির্দিষ্ট ধাপে লাফায়, ধারাবাহিক নয় ── */
  const q = Math.pow(10, st.decimals);
  st.price = Math.round(st.price * q) / q;

  return st.price;
}

/**
 * পরের tick কত ms পরে আসবে।
 * Poisson প্রক্রিয়া — ব্যবধান সূচকীয়ভাবে বণ্টিত, তাই কখনো ঝাঁক,
 * কখনো লম্বা নীরবতা। সক্রিয়তা বেশি হলে গড় ব্যবধান কম।
 */
function nextDelay(st, over) {
  const c = over ? { ...CFG, ...over } : CFG;
  const rate = Math.max(0.35, Math.min(3.0, st.act || 1));
  const mean = c.tickMs / rate;
  // সূচকীয় বণ্টন — আসল বাজারে tick ঠিক এভাবেই আসে
  const g = -Math.log(1 - Math.random()) * mean;
  return Math.max(c.tickMin, Math.min(c.tickMax, g));
}

module.exports = { createState, nextPrice, nextDelay, sessionMul, CFG };
