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

/* পরীক্ষার পাতার স্লাইডারের মান — হুবহু একই */
const CFG = {
  unit:    num(process.env.ENG_UNIT,     0.0000075),  // base একক (দামের অনুপাতে)
  volMem:  num(process.env.ENG_VOL_MEM,  0.994),    // অস্থিরতার স্মৃতি
  volAmp:  num(process.env.ENG_VOL_AMP,  0.28),     // ওঠানামার মাত্রা
  runLen:  num(process.env.ENG_RUN_LEN,  6),        // ঝলকের গড় tick
  restLen: num(process.env.ENG_REST_LEN, 5),        // শ্বাসের গড় tick
  clust:   num(process.env.ENG_CLUST,    0.45),     // ঝলক গুচ্ছ হওয়া
  retr:    num(process.env.ENG_RETR,     0.40),     // ফিরতি টান
  jump:    num(process.env.ENG_JUMP,     1.8),      // হঠাৎ বড় লাফ %
  spread:  num(process.env.ENG_SPREAD,   1.0),      // bid-ask কাঁপুনি
  gapMs:   num(process.env.ENG_GAP_MS,   170),      // গড় tick ব্যবধান
  spdVar:  num(process.env.ENG_SPD_VAR,  0.72),     // গতির তারতম্য
  bias:    num(process.env.ENG_BIAS,     0.018),     // trend পক্ষপাত
  session: num(process.env.ENG_SESSION,  0.55),     // দিনের ছন্দ
  maxStep: num(process.env.ENG_MAX_STEP, 0.0015),   // safety ±০.১৫%/tick

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
  return {
    price,
    decimals: _fitDecimals(price, decimals),
    vol: 1,                                   // চলতি অস্থিরতা
    phase: 'rest',
    left: 3,
    dir: 1,
    excite: 0,                                // ঝলকের পর উত্তেজনা
    runStart: price,
    retrTarget: 0,
    retrLeft0: 1,
    retrFast: false,
    retrDone: 0,
    regimeDir: Math.random() < 0.5 ? 1 : -1,
    regimeLeft: 200 + ((Math.random() * 500) | 0),
  };
}

/** অধিবেশনের গুণক — UTC ঘণ্টা অনুযায়ী */
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
 * @param {object} st    createState() এর অবস্থা
 * @param {number} now   বর্তমান সময় (ms)
 * @param {object} [over] override — admin নিয়ন্ত্রণ, volatility ইত্যাদি
 */
function nextPrice(st, now = Date.now(), over) {
  const c = over ? { ...CFG, ...over } : CFG;
  const base = st.price * c.unit;

  /* ── ১. অস্থিরতার স্মৃতি ── */
  const shock = (Math.random() - 0.5) * c.volAmp;
  st.vol = st.vol * c.volMem + (1 - c.volMem) * (1 + shock * 3);
  st.vol = Math.max(0.25, Math.min(4.5, st.vol));

  /* ── ২. উত্তেজনা ধীরে শান্ত হয় ── */
  st.excite *= 0.93;

  /* ── ৩. পর্ব বদল ── */
  if (--st.left <= 0) {
    if (st.phase === 'run') {
      st.excite = Math.min(1, st.excite + 0.55);
      // ফিরতি টান — ঝলকে যতটা গেছে তার একাংশ ফেরত
      const moved = st.price - st.runStart;
      st.retrTarget = -moved * (c.retr * (0.55 + Math.random() * 0.85));
      // [BACK LIKE RUN] ফেরতও ঝলকের মতোই — কখনো ১ লাফে ঝট করে, কখনো
      // ৩-৪ লাফে ধাপে ধাপে। দৈর্ঘ্য ও গতি প্রতিবার নতুন করে ঠিক হয়,
      // তাই ফেরত আর একঘেয়ে টান নয়।
      st.retrFast = Math.random() < 0.5;
      st.retrLeft0 = st.retrFast ? (1 + ((Math.random() * 2) | 0))   // ঝট করে
                                 : (2 + ((Math.random() * 3) | 0));  // ধাপে ধাপে
      st.retrDone = 0;
      if (Math.abs(st.retrTarget) > 1e-12 && c.retr > 0) {
        st.phase = 'retrace';
        st.left = st.retrLeft0;
      } else {
        const rest = Math.max(0, c.restLen * (1 - st.excite * c.clust));
        st.phase = 'rest';
        st.left = 1 + ((Math.random() * (rest + 1)) | 0);
      }
    } else if (st.phase === 'retrace') {
      const rest = Math.max(0, c.restLen * (1 - st.excite * c.clust));
      st.phase = 'rest';
      st.left = 1 + ((Math.random() * (rest + 1)) | 0);
    } else if (st.phase === 'rest') {
      // [NO WAVE] 'step' পর্ব (দিকহীন কাঁপুনি) বাদ — ওটাই ঢেউয়ের ভাব
      // দিত। শ্বাসের পর সরাসরি নতুন ঝলক।
      st.phase = 'run';
      st.left = 2 + ((Math.random() * 5) | 0);
      const b1 = c.forceDir ? c.forceDir * (0.10 + c.trendStrength * 0.22)
                            : st.regimeDir * c.bias;
      st.dir = Math.random() < 0.5 + b1 ? 1 : -1;
      st.runStart = st.price;
    } else {
      st.phase = 'run';
      // দৈর্ঘ্য heavy-tail — বেশিরভাগ ছোট, কদাচিৎ অনেক লম্বা
      const u = Math.random();
      st.left = Math.max(2, Math.round(c.runLen * Math.pow(u, -0.45) * 0.6));
      // admin manual mode হলে তার দিক, নইলে regime এর মৃদু পক্ষপাত
      const b = c.forceDir
        ? c.forceDir * (0.10 + c.trendStrength * 0.22)
        : st.regimeDir * c.bias;
      st.dir = Math.random() < 0.5 + b ? 1 : -1;
      st.runStart = st.price;
    }
  }

  const sm = sessionMul(now, c.session);
  let delta;

  if (st.phase === 'retrace') {
    // প্রতিটা পা আলাদা মাপের (ঝলকের মতোই ভারী-লেজ), কিন্তু মোট ফেরত
    // লক্ষ্য ছাড়ায় না — শেষ পায়ে বাকিটুকু মিটিয়ে দেয়।
    const remain = st.retrTarget - (st.retrDone || 0);
    if (st.left <= 1) {
      delta = remain;                                    // শেষ পা — বাকিটুকু
    } else {
      const share = remain / st.left;
      const mag = 0.45 + Math.pow(Math.random(), -0.42) * 0.75;
      delta = share * Math.min(3.2, mag);
      // লক্ষ্য পেরিয়ে গেলে থামি
      if (Math.abs((st.retrDone || 0) + delta) > Math.abs(st.retrTarget)) delta = remain;
    }
    st.retrDone = (st.retrDone || 0) + delta;
  } else if (st.phase === 'rest') {
    delta = 0;                                       // একদম স্থির
  } else if (st.phase === 'step') {
    /* ── ৪. bid-ask কাঁপুনি ── */
    delta = (Math.random() - 0.5) * base * c.spread * st.vol * sm;
  } else {
    // [JUMP] পায়ের মাপ ভারী-লেজ — বেশিরভাগ মাঝারি, কদাচিৎ অনেক বড়।
    // সমান মাপের পা হলে চলাচল যান্ত্রিক ও অনুমানযোগ্য লাগত।
    const mag = 0.45 + Math.pow(Math.random(), -0.42) * 0.75;
    delta = st.dir * base * Math.min(6, mag) * st.vol * sm;
  }

  /* ── ৫. ভারী লেজ ── */
  if (Math.random() * 100 < c.jump) {
    const mag = base * (4 + Math.pow(Math.random(), -0.5) * 3) * st.vol;
    delta += (Math.random() < 0.5 ? 1 : -1) * mag;
    st.excite = Math.min(1, st.excite + 0.7);
    st.vol = Math.min(4.5, st.vol * 1.25);
  }

  /* ── ৭. regime — কয়েক মিনিট পরপর ঝোঁক বদলায় ── */
  if (--st.regimeLeft <= 0) {
    st.regimeDir = Math.random() < 0.5 ? 1 : -1;
    st.regimeLeft = 200 + ((Math.random() * 500) | 0);
  }

  /* ── safety clamp ── */
  const cap = st.price * c.maxStep;
  delta = Math.max(-cap, Math.min(cap, delta));

  st.price = Math.max(st.price + delta, 1e-8);

  /* ── ৬. pip ধাপ ── */
  const q = Math.pow(10, st.decimals);
  st.price = Math.round(st.price * q) / q;

  return st.price;
}

/**
 * পরের tick কত ms পরে — পরীক্ষার পাতার হুবহু একই ছন্দ।
 * ঝলকে দ্রুত, শ্বাসে ধীর, উত্তেজনায় আরও দ্রুত; মাঝে মাঝে ঝাঁক বা
 * হঠাৎ থমকে যাওয়া।
 */
function nextDelay(st, over) {
  const c = over ? { ...CFG, ...over } : CFG;
  let g = c.gapMs;

  g *= st.phase === 'run' ? 0.5
     : st.phase === 'rest' ? 1.4
     : st.phase === 'retrace' ? (st.retrFast ? 0.45 : 1.05)   // দ্রুত/ধীর ফেরত
     : 1;
  g *= 1 - 0.6 * st.excite * c.spdVar;          // উত্তেজনায় দ্রুত

  const roll = Math.random();
  if (roll < 0.12 * c.spdVar) g *= 0.22;        // ঝাঁক — খুব দ্রুত
  else if (roll < 0.20 * c.spdVar) g *= 0.45;
  else if (roll > 1 - 0.07 * c.spdVar) g *= 2.4; // হঠাৎ থমকে যাওয়া

  g *= 0.6 + Math.random() * 0.8;
  return Math.max(35, g);
}

module.exports = { createState, nextPrice, nextDelay, sessionMul, CFG };
