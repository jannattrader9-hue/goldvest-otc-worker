/**
 * engine.js — GoldVest OTC price engine
 * ═══════════════════════════════════════════════════════════════════════
 * candle.html পরীক্ষার পাতার মডেল হুবহু এখানে আনা হয়েছে — যেটা দেখে
 * পছন্দ করা হয়েছিল। কোনো সূত্র বদলানো হয়নি, শুধু server এ চালানোর
 * উপযোগী করে সাজানো।
 *
 * ─── কী কী স্তর ────────────────────────────────────────────────────
 * ১. অস্থিরতার স্মৃতি — বাজার একবার অস্থির হলে কিছুক্ষণ অস্থিরই থাকে।
 *    এটাই candle গুলোকে আলাদা আকারের করে।
 * ২. উত্তেজনা — ঝলকের পর কিছুক্ষণ tick ঘন আসে (গুচ্ছ ঝলক)।
 * ৩. পর্ব — ঝলক / ফিরতি টান / শ্বাস / ছোট পা, চক্রাকারে।
 * ৪. bid-ask কাঁপুনি — ছোট পায়ের পর্বে দিকহীন লাফ।
 * ৫. ভারী লেজ — কদাচিৎ বড় লাফ, তারপর উত্তেজনা বাড়ে।
 * ৬. pip ধাপ — দাম নির্দিষ্ট ধাপে লাফায়।
 * ৭. regime — কয়েক মিনিট পরপর মৃদু ঝোঁক বদলায়।
 * ৮. অধিবেশন — লন্ডন/নিউইয়র্কে উত্তাল, এশীয় সময়ে ঝিমানো।
 *
 * ─── tick এর ছন্দ ──────────────────────────────────────────────────
 * ঝলকে দ্রুত, শ্বাসে ধীর, উত্তেজনায় আরও দ্রুত। মাঝে মাঝে কয়েকটা tick
 * প্রায় একসাথে (ঝাঁক), আবার কদাচিৎ হঠাৎ থমকে যাওয়া। এটাই "কখনো ফাস্ট,
 * কখনো ধীর — পালস ফলো করে চলা" ভাব দেয়।
 *
 * ─── নিরাপত্তা ─────────────────────────────────────────────────────
 * ৯২% payout এ ব্রেক-ইভেন ৫২.১%। সব সময়সীমায় জয়ের হার ওই সীমার নিচে
 * থাকতে হবে — কোনো সংখ্যা বদলালে আগে মেপে নিও।
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

/**
 * অধিবেশনের গুণক — UTC ঘণ্টা অনুযায়ী। [BACKWARD-COMPAT STUB]
 * সরলীকৃত (demo-matched) nextPrice/nextDelay এই function ব্যবহার
 * করে না, কিন্তু otc-server.js বা অন্য caller যদি এখনো import করে
 * থাকে, তাহলে undefined-crash এড়াতে এটা রাখা হলো — no-op (সবসময় ১
 * রিটার্ন করে, কোনো session-multiplier প্রভাব ফেলে না)।
 */
function sessionMul(t, amt) {
  return 1;
}

/* পরীক্ষার পাতার স্লাইডারের মান — হুবহু একই */
const CFG = {
  unit:    num(process.env.ENG_UNIT,     0.000018),  // base একক (দামের অনুপাতে)
  volMem:  num(process.env.ENG_VOL_MEM,  0.994),    // অস্থিরতার স্মৃতি
  volAmp:  num(process.env.ENG_VOL_AMP,  0.28),     // ওঠানামার মাত্রা
  runLen:  num(process.env.ENG_RUN_LEN,  8),        // ঝলকের গড় tick
  restLen: num(process.env.ENG_REST_LEN, 5),        // শ্বাসের গড় tick
  clust:   num(process.env.ENG_CLUST,    0.45),     // ঝলক গুচ্ছ হওয়া
  retr:    num(process.env.ENG_RETR,     0.40),     // ফিরতি টান
  jump:    num(process.env.ENG_JUMP,     1.8),      // হঠাৎ বড় লাফ %
  spread:  num(process.env.ENG_SPREAD,   1.0),      // bid-ask কাঁপুনি
  gapMs:   num(process.env.ENG_GAP_MS,   500),      // গড় tick ব্যবধান
  spdVar:  num(process.env.ENG_SPD_VAR,  0.72),     // গতির তারতম্য
  bias:    num(process.env.ENG_BIAS,     0.008),     // trend পক্ষপাত
  session: num(process.env.ENG_SESSION,  0.55),     // দিনের ছন্দ
  maxStep: num(process.env.ENG_MAX_STEP, 0.0015),   // safety ±০.১৫%/tick

  // [REFERENCE ANCHOR] দাম সময়ের সাথে real-world থেকে দূরে সরে না যায়
  // তার জন্য মৃদু, দীর্ঘমেয়াদী টান। কাছাকাছি (anchorBand এর মধ্যে)
  // থাকলে সম্পূর্ণ নিষ্ক্রিয় — স্বাভাবিক random walk। দূরে গেলে খুব
  // ধীরে টান শুরু হয়, কোনো ৫s/৬০s trade এ দিক বোঝা যাবে না এমন
  // মৃদুতায় (Quotex এর মত ~১-২% এর মধ্যে থাকে, তাই আমরাও একই লক্ষ্যে)।
  anchorBand:     num(process.env.ENG_ANCHOR_BAND,     0.06),   // ৬% এর মধ্যে — কোনো টান নেই
  anchorStrength: num(process.env.ENG_ANCHOR_STRENGTH, 0.00005), // দূরে হলে কত মৃদু টান

  // admin (otc-server প্রতি tick এ পাঠায়)
  forceDir: 0,
  trendStrength: 0.6,
};

/* ⚠ দশমিক ঘর কখনো market এর নিজের ঘরের চেয়ে বেশি করা যাবে না।
   আগে ছোট দামের market এ ঘর বাড়ানো হত (দাম যাতে নড়ে), কিন্তু তাতে
   পর্দায় দেখানো দাম আর settlement এর দাম আলাদা হয়ে যেত — user দেখত
   "একই দাম" অথচ ভেতরে আলাদা, তাই refund এর বদলে loss হত; আবার কখনো
   দেখানো দিকের উল্টো ফল আসত।

   এখন ঘর হুবহু market এর মতোই। ছোট দামের market এ দাম যাতে তবু নড়ে,
   তার সমাধান পায়ের মাপে (নিচে scaleForTick) — ঘর বাড়িয়ে নয়। */
function _fitDecimals(price, given) {
  return given;
}

/* এক pip ধাপ পায়ের চেয়ে বড় হলে দাম নড়ত না। তাই ওই market এ পায়ের
   মাপ বাড়িয়ে দিই — অন্তত ২-৩ ধাপ যেন হয়। দেখানো দাম অপরিবর্তিত থাকে। */
function _tickScale(price, decimals) {
  const step = Math.pow(10, -decimals);        // এক ধাপ (pip)
  const want = price * 0.000012;               // পায়ের স্বাভাবিক মাপ
  if (want >= step * 0.9) return 1;            // ধাপ যথেষ্ট সূক্ষ্ম
  /* ধাপ মোটা (যেমন USD/INR এ ২ ঘর) — পা একটু বড় করি যাতে দাম নড়ে,
     কিন্তু ৩ গুণের বেশি নয়, নইলে candle অস্বাভাবিক বড় হত। এই market
     গুলোতে দাম কম বার বদলাবে — সেটাই স্বাভাবিক, কারণ আসল বাজারেও
     মোটা ধাপের instrument কম নড়ে। */
  return Math.min(3, (step * 0.9) / Math.max(want, 1e-12));
}

/** নতুন market এর অবস্থা */
function createState(price, decimals = 5) {
  return {
    price,
    decimals,
    referencePrice: 0,   // [REFERENCE ANCHOR] otc-server সেট করবে; ০ মানে কোনো anchor নেই
    // [TICK IDENTITY] প্রতিটা tick এর জন্য monotonic, unique id — entry/
    // settlement এর জন্য tick-history তে lookup করতে দরকার (tickhistory.js)।
    tickId: 0,
  };
}

/**
 * এক tick এগোয় — নতুন দাম ফেরত দেয়।
 * [DEMO-MATCHED — সম্পূর্ণ SIMPLIFIED] আগে phase/regime/momentum/
 * speed-state এর জটিল multi-layer system ছিল, যেটা demo
 * (perfict-engine.html) এর সাথে না মিলে ৫s-duration এ measurable
 * bias তৈরি করছিল। এখন সরাসরি demo এর logic — শুধু dir (50/50) +
 * heavy-tail pip-distribution (৩০%/৭০%, user এর নির্দেশ অনুযায়ী)।
 * @param {object} st    createState() এর অবস্থা
 * @param {number} now   বর্তমান সময় (ms) — ব্যবহৃত হয় না এই simplified version এ, backward-compat এর জন্য parameter রাখা হলো
 * @param {object} [over] override — legacy signature compat এর জন্য রাখা, এই simplified version এ ব্যবহৃত হয় না
 */
function nextPrice(st, now = Date.now(), over) {
  const dir = Math.random() < 0.5 ? 1 : -1;

  // [PIP DISTRIBUTION — ৩০%/৭০%, user এর নির্দেশ] ছোট ৩০%, মাঝারি+বড়
  // মিলিয়ে বাকি ৭০% (৩৮%+৩২%)।
  const _r = Math.random();
  let mag;
  if (_r < 0.30)      mag = 1 + Math.random() * 2;    // ছোট: ১-৩ pip (৩০%)
  else if (_r < 0.68) mag = 3 + Math.random() * 9;    // মাঝারি: ৩-১২ pip (৩৮%)
  else                mag = 12 + Math.random() * 10;  // বড়: ১২-২২ pip (৩২%)

  const pip = Math.pow(10, -st.decimals);
  let delta = dir * pip * mag;

  /* ── [REFERENCE ANCHOR] দূরে সরে গেলে মৃদু টান — অপরিবর্তিত রাখা
     হলো, real-world price থেকে বেশি দূরে সরে না যাওয়ার নিরাপত্তার
     জন্য এটা এখনো প্রয়োজনীয়। ── */
  if (st.referencePrice > 0) {
    const refDiff = (st.referencePrice - st.price) / st.referencePrice;
    const anchorBand = 0.06, anchorStrength = 0.00005;
    if (Math.abs(refDiff) > anchorBand) {
      const pull = (refDiff - Math.sign(refDiff) * anchorBand) * anchorStrength;
      delta += st.price * pull;
    }
  }

  st.price = Math.max(st.price + delta, 1e-8);
  st.price = Number(st.price.toFixed(st.decimals));

  st.tickId++;   // [TICK IDENTITY] প্রতিটা নতুন price generate এ monotonic বৃদ্ধি
  return st.price;
}

/**
 * পরের tick কত ms পরে — demo এর সাথে হুবহু, uniform-random ২০০-১০০০ms।
 * [DEMO-MATCHED — SIMPLIFIED] phase/speed-regime/burst-roll এর সব
 * multiplier-layer বাদ, কারণ সেগুলো compressed-distribution তৈরি
 * করছিল (গড় ২০০ms এর কাছে, uniform না)।
 */
function nextDelay(st, over) {
  // [DEMO CADENCE MATCH] আগে এখানে ২০০-১০০০ms ছিল, কিন্তু সেটা
  // tick-থেকে-tick ব্যবধান — আর chartengine.js এর ৩৫০ms glide ওই
  // ব্যবধানের *ভেতরেই* চলত। ফলে ~১৯% ক্ষেত্রে (delay < ৩৫০ms)
  // animation মাঝপথে interrupt হতো, কোনো স্থির pause দেখা যেত না।
  // Demo (Finallyengine.html) এ ক্রম ছিল: delay(২০০-১০০০) → tick →
  // animate(৩৫০) → আবার delay — অর্থাৎ প্রকৃত inter-tick ৫৫০-১৩৫০ms,
  // আর প্রতিটা glide শেষে সবসময় ২০০-১০০০ms একদম স্থির pause।
  // এখানে ৩৫০ যোগ করে ঠিক সেই cadence ফেরানো হলো — এখন সর্বনিম্ন
  // ব্যবধানও (৫৫০ms) animation duration এর চেয়ে বড়, তাই glide
  // কখনো interrupt হয় না (animation compromise হওয়ার সুযোগই নেই)।
  // দিক-নির্বাচন (nextPrice এর ৫০/৫০) এখানে অপরিবর্তিত — তাই সব
  // expiry তেই দাম আগের মতোই সম্পূর্ণ unpredictable থাকে।
  return 550 + Math.random() * 800;
}



module.exports = { createState, nextPrice, nextDelay, sessionMul, CFG };
