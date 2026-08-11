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
  unit:    num(process.env.ENG_UNIT,     0.000018),  // base একক (দামের অনুপাতে)
  volMem:  num(process.env.ENG_VOL_MEM,  0.994),    // অস্থিরতার স্মৃতি
  volAmp:  num(process.env.ENG_VOL_AMP,  0.28),     // ওঠানামার মাত্রা
  runLen:  num(process.env.ENG_RUN_LEN,  6),        // ঝলকের গড় tick
  restLen: num(process.env.ENG_REST_LEN, 5),        // শ্বাসের গড় tick
  clust:   num(process.env.ENG_CLUST,    0.45),     // ঝলক গুচ্ছ হওয়া
  retr:    num(process.env.ENG_RETR,     0.40),     // ফিরতি টান
  jump:    num(process.env.ENG_JUMP,     1.8),      // হঠাৎ বড় লাফ %
  spread:  num(process.env.ENG_SPREAD,   1.0),      // bid-ask কাঁপুনি
  gapMs:   num(process.env.ENG_GAP_MS,   320),      // গড় tick ব্যবধান
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
    tickScale: _tickScale(price, decimals),
    referencePrice: 0,   // [REFERENCE ANCHOR] otc-server সেট করবে; ০ মানে কোনো anchor নেই
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
    hardPauseUntil: 0,   // [VISIBLE PAUSE] এই timestamp পর্যন্ত সম্পূর্ণ static থাকবে
    impulseCount: 0,      // [IMPULSE-PULLBACK] burst এর মূল দিকে টানা কতগুলো tick গেছে
    speed: 1,              // [SPEED STATE] persistent, ধীরে বদলায় — sudden jump না
    speedRegime: 'normal', // [SPEED REGIME] slow/normal/fast/burst — কয়েক tick ধরে থাকে
    speedRegimeLeft: 8,     // এই regime এ আর কতগুলো tick বাকি
    recentMag: 0,           // [MOMENTUM MEMORY] সাম্প্রতিক tick-magnitude এর গড় (EMA)
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
  const base = st.price * c.unit * (st.tickScale || 1);

  /* ── ১. অস্থিরতার স্মৃতি ── */
  const shock = (Math.random() - 0.5) * c.volAmp;
  st.vol = st.vol * c.volMem + (1 - c.volMem) * (1 + shock * 3);
  st.vol = Math.max(0.25, Math.min(4.5, st.vol));

  /* ── ২. উত্তেজনা ধীরে শান্ত হয় ── */
  st.excite *= 0.93;

  /* ── ৩. পর্ব বদল ──
     [RANDOM RETRACE TIMING] আগে retrace সবসময় burst এর ঠিক শেষে শুরু
     হত — timing predictable ছিল, শুধু frequency (৫০%) এলোমেলো করাই
     যথেষ্ট ছিল না। user burst চলতে দেখলেই বুঝত "শেষ হলেই retrace
     আসবে কিনা"। এখন run phase এর প্রতিটা tick এ (মাঝপথেও) সামান্য
     সম্ভাবনা থাকে retrace শুরু হওয়ার — কখনো শুরুতে, কখনো মাঝে, কখনো
     শেষেও, কখনো একদমই না। কোনো fixed trigger-point নেই। */
  let _midBurstRetrace = false;
  if (st.phase === 'run' && st.left > 1) {
    // প্রতি tick এ ছোট সম্ভাবনা — গড়ে burst এর কোনো এক এলোমেলো
    // মুহূর্তে ট্রিগার হবে, শেষের অপেক্ষা না করেই।
    if (Math.random() < 0.04) _midBurstRetrace = true;
  }

  // [PAUSE TIMER FIX] rest phase এ আগে st.left (tick-count) আর
  // hardPauseUntil (time) — দুটো independent countdown একসাথে চলত।
  // st.left অনেক দ্রুত (মাত্র ১-৬ tick) ফুরিয়ে যেত, তাই আসল pause
  // duration (০.৮-৪s) শেষ হওয়ার অনেক আগেই নতুন phase এ চলে যেত।
  // এখন rest এ থাকাকালীন phase বদল শুধু hardPauseUntil সময় শেষ
  // হলেই হবে, st.left কে বাধ্যতামূলক না রেখে।
  const _restDone = st.phase === 'rest' && (!st.hardPauseUntil || now >= st.hardPauseUntil);
  const _shouldTransition = st.phase === 'rest' ? _restDone : (_midBurstRetrace || --st.left <= 0);

  if (_shouldTransition) {
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
      // [MOVEMENT-DEPENDENT RETRACE] আগে fixed ৫৫% ছিল, তাই প্রতিটা
      // burst এর পরে প্রায় একই ধরনের decision-structure দেখা যেত।
      // এখন কতদূর movement হয়েছে (moved) আর কত excited state (st.excite)
      // দুটোই মিলিয়ে probability ঠিক হয় — ছোট movement এ কম retrace
      // (trend continue করার সম্ভাবনা বেশি), বড়/দ্রুত movement এ বেশি
      // retrace (real market এর মতো "বেশি গেলে বেশি ফেরত" প্রবণতা)।
      const _movedPct = Math.min(1, Math.abs(moved) / (st.price * 0.003));
      // [REDUCED RETRACE] GPT এর real-Quotex-video analysis অনুযায়ী —
      // burst যতদূর গিয়েছিল retrace প্রায় সেই একই মাপে ফিরে আসাটাই
      // "যায়-তারপর-ফিরে আসে" zig-zag ভাব তৈরি করছিল, যদিও frequency
      // এলোমেলো ছিল। এখন base probability অনেক কমানো হলো, যাতে
      // momentum/persistent direction (continue করা) predominant হয়,
      // retrace শুধু কদাচিৎ (বড় movement এর পরেই বেশি)।
      const _retraceProb = 0.18 + _movedPct * 0.22 + st.excite * 0.10;
      const _wantRetrace = Math.random() < _retraceProb;
      if (_wantRetrace && Math.abs(st.retrTarget) > 1e-12 && c.retr > 0) {
        st.phase = 'retrace';
        st.left = st.retrLeft0;
      } else if (_midBurstRetrace) {
        // [FIX] mid-burst ট্রিগার হলে short-circuit (||) এর কারণে
        // --st.left আদৌ চলেনি, তাই left অপরিবর্তিতই আছে — কিছু করার
        // দরকার নেই, burst এমনিই তার বাকি left নিয়ে চলতে থাকবে।
      } else {
        const rest = Math.max(0, c.restLen * (1 - st.excite * c.clust));
        st.phase = 'rest';
        st.left = 1 + ((Math.random() * (rest + 1)) | 0);
        // [QUOTEX RHYTHM] Quotex এ প্রতি 1m candle এ ৩০-৪০ বার সম্পূর্ণ
        // static pause দেখা যায় (০.৮-৪s প্রতিটা) — প্রায় প্রতিটা burst
        // এর পরেই একটা করে। তাই এটা rare event না, বরং প্রতিটা rest
        // এই এখন সময়-ভিত্তিক duration সেট হয় (নিচে nextPrice এ
        // hardPauseUntil ব্যবহার হয়)।
        // [FIX] আগে প্রতিটা rest এই unconditionally hard-pause হত —
        // GPT observation অনুযায়ী chart এ "প্রাণ কমে যাওয়ার" মতো
        // ঘন ঘন freeze দেখাচ্ছিল। এখন শুধু ~৪৫% rest এ visible pause,
        // duration ও কমানো (৩০০-৯০০ms), বাকি সময় rest এ থাকলেও
        // engine স্বাভাবিক ছোট movement চালিয়ে যাবে।
        if (Math.random() < 0.18) {
          st.hardPauseUntil = now + (300 + Math.random() * 600);
        }
      }
    } else if (st.phase === 'retrace') {
      // [NO FIXED SEQUENCE] আগে retrace শেষে সবসময় rest হত (১০০%) —
      // এটাও একটা predictable rhythm ছিল: "retrace থামলেই দাম থমকে
      // যাবে"। এখন ~৬৫% সময় rest, বাকি ~৩৫% সময় সরাসরি নতুন burst
      // শুরু হয় (কোনো বিরতি ছাড়াই) — sequence টাই আর নিশ্চিত থাকে না।
      if (Math.random() < 0.40) {
        const rest = Math.max(0, c.restLen * (1 - st.excite * c.clust));
        st.phase = 'rest';
        st.left = 1 + ((Math.random() * (rest + 1)) | 0);
        // [QUOTEX RHYTHM] এখানেও একই — প্রতিটা rest এই duration সেট
        // [FIX] আগে প্রতিটা rest এই unconditionally hard-pause হত —
        // GPT observation অনুযায়ী chart এ "প্রাণ কমে যাওয়ার" মতো
        // ঘন ঘন freeze দেখাচ্ছিল। এখন শুধু ~৪৫% rest এ visible pause,
        // duration ও কমানো (৩০০-৯০০ms), বাকি সময় rest এ থাকলেও
        // engine স্বাভাবিক ছোট movement চালিয়ে যাবে।
        if (Math.random() < 0.18) {
          st.hardPauseUntil = now + (300 + Math.random() * 600);
        }
      } else {
        st.phase = 'run';
        const u = Math.random();
        st.left = Math.max(2, Math.round(c.runLen * Math.pow(u, -0.45) * 0.6));
        const b2 = c.forceDir ? c.forceDir * (0.10 + c.trendStrength * 0.22)
                              : st.regimeDir * c.bias;
        st.dir = Math.random() < 0.5 + b2 ? 1 : -1;
        st.runStart = st.price;
      }
    } else if (st.phase === 'rest') {
      // [NO WAVE] 'step' পর্ব (দিকহীন কাঁপুনি) বাদ — ওটাই ঢেউয়ের ভাব
      // দিত। শ্বাসের পর সরাসরি নতুন ঝলক।
      // [NO FIXED SEQUENCE] rest শেষে আগে সবসময় (১০০%) সরাসরি run
      // হত। এখন ~৮৫% সময় run, বাকি ~১৫% সময় rest নিজেই আরেকটু বাড়ে
      // (আরেকটা ছোট বিরতি) — শ্বাসের দৈর্ঘ্যও অনির্দিষ্ট থাকে।
      if (Math.random() < 0.92) {
        st.phase = 'run';
        st.left = 2 + ((Math.random() * 5) | 0);
        const b1 = c.forceDir ? c.forceDir * (0.10 + c.trendStrength * 0.22)
                              : st.regimeDir * c.bias;
        st.dir = Math.random() < 0.5 + b1 ? 1 : -1;
        st.runStart = st.price;
      } else {
        st.left = 1 + ((Math.random() * 3) | 0);   // rest এ আরেকটু থাকা
      }
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

  // [MICRO-MOVEMENT PAUSE] আগে hard-pause এ delta সম্পূর্ণ ০ ছিল —
  // GPT এর observation অনুযায়ী এটা "artificial" লাগতে পারে, real
  // market এ pause মানে সবসময় absolute zero না, মাঝে মাঝে খুবই ছোট
  // [PURE STATIC PAUSE] micro-tick জিটার সরানো হলো — user চায় কোনো
  // দোলনি না। Hard-pause এখন সম্পূর্ণ static (delta=0), যেটাই "থেমে
  // যাওয়া" এর সবচেয়ে পরিষ্কার visual।
  if (st.hardPauseUntil && now < st.hardPauseUntil) {
    st.price = Number(st.price.toFixed(st.decimals));
    return st.price;
  }

  if (st.phase === 'retrace') {
    // [NO GLIDE] আগে remain/st.left দিয়ে target এর দিকে সমানভাবে
    // ভাগ হয়ে এগোত — এটাই predictable "গড়িয়ে ফিরে আসা" (glide)
    // ভাব দিত, কারণ প্রতিটা tick নিশ্চিতভাবে target এর কাছাকাছি
    // যেত। এখন run phase এর মতোই independent heavy-tail tick —
    // শুধু দিক retrTarget এর দিকে, মাপ প্রতিবার নতুন এলোমেলো।
    // শেষ পায়ে বাকিটুকু মিটিয়ে দেয়, যাতে target ঠিক মতো পৌঁছায়।
    const remain = st.retrTarget - (st.retrDone || 0);
    if (st.left <= 1 || Math.sign(remain) === 0) {
      delta = remain;                                    // শেষ পা — বাকিটুকু
    } else {
      const retrDir = Math.sign(st.retrTarget);
      const _r = Math.random();
      let mag;
      if (_r < 0.25)      mag = 0.05 + Math.random() * 0.25;
      else if (_r < 0.85) mag = 0.3 + Math.pow(Math.random(), -0.35) * 0.6;
      else                mag = 1.5 + Math.pow(Math.random(), -0.5) * 2;
      // [NO MICRO-REVERSE] এখানেও micro-reverse সরানো হলো — retrace
      // এর প্রতিটা tick সরাসরি retrDir এর দিকে যাবে, কোনো এলোমেলো
      // বিপরীত জিটার/দোলনি নেই।
      delta = retrDir * base * Math.min(4, mag) * st.vol;
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
    // [CONTEXT-DEPENDENT MAGNITUDE] শুধু independent random draw না —
    // speed regime আর সাম্প্রতিক magnitude (recentMag, EMA) দুটোই
    // মিলিয়ে distribution shift হয়। burst/fast regime এ বড় jump এর
    // সম্ভাবনা বাড়ে, slow regime এ ছোট jump এর সম্ভাবনা বাড়ে —
    // "speed আর jump-size একসাথে couple করা" এই GPT observation
    // অনুযায়ী।
    const _regimeBoost = st.speedRegime === 'burst' ? 0.20
                        : st.speedRegime === 'fast'  ? 0.10
                        : st.speedRegime === 'slow'  ? -0.12
                        : 0;
    const _r = Math.random() - _regimeBoost;
    let mag;
    // [MEDIUM DOMINANT] GPT এর video-observation — "সবচেয়ে বেশি
    // থাকে মাঝারি জাম্প টিক টু টিক", flat/near-zero tick কে baseline
    // বানানো উচিত না। আগে flat ২৫%, এখন ১২% — medium এখন dominant।
    if (_r < 0.12)      mag = 0.15 + Math.random() * 0.55;                  // প্রায়-flat (কম, কিন্তু আরও বৈচিত্র্যময়)
    else if (_r < 0.88) mag = 0.5 + Math.pow(Math.random(), -0.35) * 0.7;   // মাঝারি (dominant)
    else                mag = 1.5 + Math.pow(Math.random(), -0.5) * 2;      // বড় লাফ
    // সাম্প্রতিক বড় jump এর পরে সামান্য recovery bias — একটানা অনেক
    // বড় jump না হয়ে মাঝেমধ্যে ছোট হয়ে "শ্বাস" নেয়
    if (st.recentMag > 3) mag *= 0.7;
    st.recentMag = st.recentMag * 0.8 + mag * 0.2;   // EMA আপডেট
    // [NO MICRO-REVERSE] আগে প্রতিটা tick এ কিছু সম্ভাবনায় বিপরীত
    // দিকে যেত (micro-reverse/jitter) — এটাই "দোলনি/gorano" তৈরি
    // করছিল (1.08489 → 1.08491 → 1.08489 এর মতো up-down-up-down)।
    // User স্পষ্টভাবে চেয়েছে: প্রতিটা tick শুধু st.dir এর দিকেই
    // যাক (A→Z clean jump), direction change শুধু phase-transition
    // এ (নতুন burst/retrace শুরু) হবে, প্রতি-tick এলোমেলো না।
    delta = st.dir * base * Math.min(8, mag) * st.vol * sm;
    // [MIN-PIP GUARD] বড়-magnitude দামে (যেমন ১৪০০+, যেখানে ২ দশমিক
    // ঘর হয়) base/pip অনুপাত ছোট হয়ে যেত, তাই "প্রায়-flat" tick round
    // হয়ে প্রায়ই ০-১ pip এ নেমে আসত — সেটাই "1417.35 ↔ 1417.34" এর
    // মতো অর্থহীন দোলা তৈরি করছিল। ন্যূনতম ২ pip নিশ্চিত করা হলো,
    // যাতে প্রতিটা visible movement অন্তত সামান্য অর্থবহ হয়।
    const _minPip = Math.pow(10, -st.decimals) * 2;
    if (delta !== 0 && Math.abs(delta) < _minPip) {
      delta = Math.sign(delta) * _minPip;
    }
  }

  /* ── ৫. ভারী লেজ — শুধু active movement (run/retrace) এ, rest/
     hard-pause এ প্রযোজ্য না (ওখানে আলাদাভাবে handle হয়) ── */
  if (st.phase !== 'rest' && Math.random() * 100 < c.jump) {
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

  /* ── [REFERENCE ANCHOR] দূরে সরে গেলে মৃদু টান ──────────────────
     anchorBand এর মধ্যে থাকলে সম্পূর্ণ নিষ্ক্রিয় (কিছুই যোগ হয় না)।
     দূরে গেলে ফারাকের সমানুপাতে (কিন্তু অত্যন্ত ছোট গুণক দিয়ে) delta
     তে সামান্য যোগ হয় — কয়েক ঘণ্টা/দিন ধরে ধীরে reference এর দিকে
     নিয়ে যায়। এক tick এ প্রভাব maxStep এর অনেক নিচে, তাই কোনো trade
     duration এ দিক বোঝার সুযোগ থাকে না। */
  if (st.referencePrice > 0) {
    const refDiff = (st.referencePrice - st.price) / st.referencePrice;
    if (Math.abs(refDiff) > c.anchorBand) {
      const pull = (refDiff - Math.sign(refDiff) * c.anchorBand) * c.anchorStrength;
      delta += st.price * pull;
    }
  }

  /* ── safety clamp ── */
  const cap = st.price * c.maxStep;
  delta = Math.max(-cap, Math.min(cap, delta));

  st.price = Math.max(st.price + delta, 1e-8);

  /* ── ৬. pip ধাপ ──
     [CLEAN ROUND] Math.round(price*q)/q মাঝে মাঝে floating-point এ
     সামান্য garbage রেখে দিতে পারে (যেমন 1.08551000000000002) —
     display এ toFixed করলে সেটা দেখা যায় না, কিন্তু raw value
     store/compare (settlement এ isTie চেক) এ mismatch তৈরি করতে
     পারে। toFixed().Number() round-trip দিয়ে সেই garbage সম্পূর্ণ
     সরিয়ে দেওয়া হচ্ছে — user client এ যা দেখে, server এ ঠিক
     সেই clean সংখ্যাই store/compare হবে। */
  const q = Math.pow(10, st.decimals);
  st.price = Number(st.price.toFixed(st.decimals));

  return st.price;
}

/**
 * পরের tick কত ms পরে — পরীক্ষার পাতার হুবহু একই ছন্দ।
 * ঝলকে দ্রুত, শ্বাসে ধীর, উত্তেজনায় আরও দ্রুত; মাঝে মাঝে ঝাঁক বা
 * হঠাৎ থমকে যাওয়া।
 */
function nextDelay(st, over, now = Date.now()) {
  const c = over ? { ...CFG, ...over } : CFG;

  // [VISIBLE PAUSE] hard-pause চলাকালীন ছোট, নিয়মিত gap — দাম বদলাবে
  // না ঠিকই (nextPrice এ static থাকে), কিন্তু UI প্রতি tick এ চেক
  // করে যাবে যাতে pause শেষ হওয়া মাত্র normal movement সাথে সাথে
  // আবার শুরু হয়, বাড়তি দেরি না হয়।
  // [FIX] আগে এখানে সরাসরি Date.now() ছিল, nextPrice() এর now
  // parameter এর সাথে সামঞ্জস্যহীন — simulation/testing এ regime
  // ও pause-timer ভুলভাবে stuck হয়ে যেত। এখন consistent parameter।
  if (st.hardPauseUntil && now < st.hardPauseUntil) {
    return 150;
  }

  let g = c.gapMs;

  // [SPEED REGIME] আগে speed প্রতি tick এ নিজে থেকে multiply হত —
  // technically persistent হলেও প্রতি tick এ নতুন probability-check
  // হওয়ায় "SLOW SLOW SLOW → FAST FAST FAST" এর মতো কয়েক tick ধরে
  // স্থির থাকা regime তৈরি হচ্ছিল না, বরং প্রায় প্রতি tick এই
  // এলোমেলো ওঠানামা করত। এখন একটা discrete named regime আছে
  // (slow/normal/fast/burst) যেটা কয়েকটা tick ধরে বহাল থাকে, তারপর
  // নতুন regime এ পরিবর্তন হয়।
  const _SPEED_REGIMES = {
    slow:   1.6,
    normal: 1.0,
    fast:   0.55,
    burst:  0.28,
  };
  // [TRANSITION MATRIX] GPT এর দ্বিতীয় analysis অনুযায়ী — শুধু
  // "fast এর পরে recovery বেশি" এই একমুখী rule যথেষ্ট না, প্রতিটা
  // regime-pair এর নিজস্ব probability দরকার। যেমন slow→slow বেশি
  // (persistent calm), burst→burst কম (burst বেশিক্ষণ টেকে না)।
  const _TRANSITIONS = {
    slow:   { slow: 0.45, normal: 0.35, fast: 0.15, burst: 0.05 },
    normal: { slow: 0.20, normal: 0.40, fast: 0.30, burst: 0.10 },
    fast:   { slow: 0.15, normal: 0.35, fast: 0.35, burst: 0.15 },
    burst:  { slow: 0.10, normal: 0.30, fast: 0.35, burst: 0.25 },
  };
  const _DURATIONS = {
    slow:   [8, 18],
    normal: [6, 14],
    fast:   [4, 10],
    burst:  [2, 6],
  };
  if (--st.speedRegimeLeft <= 0) {
    const probs = _TRANSITIONS[st.speedRegime] || _TRANSITIONS.normal;
    const r = Math.random();
    let acc = 0, next = 'normal';
    for (const [name, p] of Object.entries(probs)) {
      acc += p;
      if (r < acc) { next = name; break; }
    }
    st.speedRegime = next;
    const [lo, hi] = _DURATIONS[next] || [5, 12];
    st.speedRegimeLeft = lo + ((Math.random() * (hi - lo + 1)) | 0);
  }
  st.speed = _SPEED_REGIMES[st.speedRegime];

  g *= st.phase === 'run' ? 0.5
     : st.phase === 'rest' ? 1.4
     : st.phase === 'retrace' ? (st.retrFast ? 0.45 : 1.05)   // দ্রুত/ধীর ফেরত
     : 1;
  g *= 1 - 0.6 * st.excite * c.spdVar;          // উত্তেজনায় দ্রুত
  g *= st.speed;                                 // regime-based speed প্রয়োগ

  // ছোট ফ্রেম-টু-ফ্রেম variation, কিন্তু regime নিজে বদলায় না
  g *= 0.85 + Math.random() * 0.3;
  // [SPEED FIX] আগে floor ৩৫ms ছিল — burst-regime + run-phase একসাথে
  // compound হয়ে effective gap মাত্র ৬০ms (~১৭ tick/সেকেন্ড) হয়ে
  // যেত, যেটা গড় tick-rate কে টেনে অনেক নিচে নামাচ্ছিল, তাই "speed
  // নেই, real market এর মতো লাগছে না" — কারণ real market এ কখনোই
  // sustained ১৭/সেকেন্ড এর মতো দ্রুত ধারাবাহিকভাবে চলে না। Floor
  // বাড়িয়ে ১২০ms করা হলো, যাতে সব regime/phase মিলিয়েও কখনো
  // অবাস্তব দ্রুত না হয়।
  return Math.max(120, Math.min(2500, g));
}

module.exports = { createState, nextPrice, nextDelay, sessionMul, CFG };
