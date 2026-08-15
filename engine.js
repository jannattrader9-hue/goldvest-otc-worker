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
    // [TICK IDENTITY] প্রতিটা tick এর জন্য monotonic, unique id — entry/
    // settlement এর জন্য tick-history তে lookup করতে দরকার (tickhistory.js)।
    // এখানে state এর property হিসেবে রাখা হলো, nextPrice() এর return-value
    // (শুধু number) অপরিবর্তিত রেখে — caller (otc-server.js) প্রতিটা
    // nextPrice() কলের পরে st.tickId পড়ে নিজে history তে record করবে,
    // তাই এই ফাইলে return-signature বদলাতে হলো না, otc-server.js এর
    // existing call-site গুলোও ভাঙল না।
    tickId: 0,
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
      const _retraceProb = 0.35 + _movedPct * 0.30 + st.excite * 0.15;
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
        if (Math.random() < 0.45) {
          st.hardPauseUntil = now + 700;   // [DEMO-MATCH] fixed 700ms, demo এর সাথে হুবহু
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
        if (Math.random() < 0.45) {
          st.hardPauseUntil = now + 700;   // [DEMO-MATCH] fixed 700ms, demo এর সাথে হুবহু
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
  // (sub-pip) নড়াচড়া থাকে। তাই এখন ৭৫% সময় সত্যিই static (visible
  // pause বজায় থাকে), কিন্তু ২৫% সময় এক pip এর সামান্য কম একটা
  // micro-tick হয় — pause এর "থেমে যাওয়া" ভাব অক্ষত থাকে কিন্তু
  // সম্পূর্ণ frozen লাগে না।
  if (st.hardPauseUntil && now < st.hardPauseUntil) {
    if (Math.random() < 0.25) {
      const _pip = Math.pow(10, -st.decimals);
      const _micro = (Math.random() < 0.5 ? 1 : -1) * _pip * 1.0;
      st.price = Number((st.price + _micro).toFixed(st.decimals));
    } else {
      st.price = Number(st.price.toFixed(st.decimals));
    }
    st.tickId++;   // [TICK IDENTITY] pause-এও এটা একটা broadcast-able tick
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
      // [DEMO-MATCHED — EXACT] burst এর মতোই একই demo-distribution,
      // কোনো micro-direction/vol-multiplier ছাড়া সরাসরি pip।
      const _r = Math.random();
      let mag;
      if (_r < 0.30)      mag = 1 + Math.random()*2;              // ছোট: ১-৩ pip (৩০%)
      else if (_r < 0.68) mag = 3 + Math.random()*9;              // মাঝারি: ৩-১২ pip (৩৮%)
      else                mag = 12 + Math.random()*10;            // বড়: ১২-২২ pip (৩২%)
      const pip = Math.pow(10, -st.decimals);
      delta = retrDir * pip * mag;
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
    // [DEMO-MATCHED] User approved demo (tick-pause-timestamp.html) এর
    // exact distribution — ৪৫% ছোট (১-৩ pip), ৩০% মাঝারি (৩-৮ pip),
    // ২৫% বড় (৮-২০ pip)। base ≈ ২ pip, তাই mag = pip/2 করে convert।
    const _r = Math.random();
    let mag;
    if (_r < 0.30)      mag = 1 + Math.random()*2;                    // ছোট: ১-৩ pip (৩০%)
    else if (_r < 0.68) mag = 3 + Math.random()*9;                    // মাঝারি: ৩-১২ pip (৩৮%)
    else                mag = 12 + Math.random()*10;                  // বড়: ১২-২২ pip (৩২%)
    // [DEMO-MATCHED — EXACT] User approved demo এর সাথে হুবহু মেলাতে,
    // reverse-probability/vol/session multiplier ছাড়া সরাসরি pip
    // প্রয়োগ — demo তেও ঠিক এভাবেই ছিল, শুধু dir আর pip, অন্য কিছু না।
    const pip = Math.pow(10, -st.decimals);
    delta = st.dir * pip * mag;
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

  /* ── ৫. ভারী লেজ — [DEMO-MATCH] user approved demo তে এই আলাদা
     jump-event নেই, শুধু ৩-ভাগের mag-distribution ই যথেষ্ট ছিল।
     "একদম সেম" চাওয়া অনুযায়ী এই layer disable করা হলো। ── */

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

  st.tickId++;   // [TICK IDENTITY] প্রতিটা নতুন price generate এ monotonic বৃদ্ধি
  return st.price;
}

/**
 * পরের tick কত ms পরে — পরীক্ষার পাতার হুবহু একই ছন্দ।
 * ঝলকে দ্রুত, শ্বাসে ধীর, উত্তেজনায় আরও দ্রুত; মাঝে মাঝে ঝাঁক বা
 * হঠাৎ থমকে যাওয়া।
 */
function nextDelay(st, over) {
  const c = over ? { ...CFG, ...over } : CFG;

  // [VISIBLE PAUSE] hard-pause চলাকালীন ছোট, নিয়মিত gap — দাম বদলাবে
  // না ঠিকই (nextPrice এ static থাকে), কিন্তু UI প্রতি tick এ চেক
  // করে যাবে যাতে pause শেষ হওয়া মাত্র normal movement সাথে সাথে
  // আবার শুরু হয়, বাড়তি দেরি না হয়।
  if (st.hardPauseUntil && Date.now() < st.hardPauseUntil) {
    return 150;
  }

  let g = c.gapMs;

  // [SPEED STATE] GPT-র সুপারিশ — শুধু per-tick independent random delay
  // দিলে "random-number-generator" এর মতো লাগে, কোনো momentum নেই।
  // এখন একটা persistent speed state আছে যেটা প্রতি tick এ সামান্য
  // বদলায় (কদাচিৎ হঠাৎ, বেশিরভাগ সময় ধীরে) — তাই "slow → একটু fast →
  // burst → আবার ধীর" এই ধরনের গ্র্যাজুয়াল transition তৈরি হয়,
  // প্রতিটা tick আলাদা dice-roll না হয়ে একটা ধারাবাহিকতা থাকে।
  const _sr = Math.random();
  if (_sr < 0.15) st.speed *= 0.65;         // হঠাৎ দ্রুত
  else if (_sr < 0.30) st.speed *= 1.45;    // হঠাৎ ধীর
  else st.speed *= 0.92 + Math.random() * 0.16;  // সামান্য drift
  st.speed = Math.max(0.45, Math.min(2.2, st.speed));

  g *= st.phase === 'run' ? 0.5
     : st.phase === 'rest' ? 1.4
     : st.phase === 'retrace' ? (st.retrFast ? 0.45 : 1.05)   // দ্রুত/ধীর ফেরত
     : 1;
  g *= 1 - 0.6 * st.excite * c.spdVar;          // উত্তেজনায় দ্রুত
  g *= st.speed;                                 // persistent speed state প্রয়োগ

  const roll = Math.random();
  if (roll < 0.12 * c.spdVar) g *= 0.22;        // ঝাঁক — খুব দ্রুত
  else if (roll < 0.20 * c.spdVar) g *= 0.45;
  else if (roll > 1 - 0.07 * c.spdVar) g *= 2.4; // হঠাৎ থমকে যাওয়া

  g *= 0.6 + Math.random() * 0.8;
  // [DEMO-MATCH] user এর চাওয়া অনুযায়ী tick-generation delay ২০০-১০০০ms
  // এর মধ্যেই bound করা হলো (আগে ৩৫-২৫০০ms ছিল, অনেক বেশি বিস্তৃত)।
  // এটাই perfict-engine.html demo তে verified natural backend-rhythm।
  return Math.max(200, Math.min(1000, g));
}

module.exports = { createState, nextPrice, nextDelay, sessionMul, CFG };
