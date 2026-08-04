/**
 * engine.js — GoldVest OTC tick engine
 * ═══════════════════════════════════════════════════════════════════════
 * পরীক্ষিত মডেল (tick-v1) হুবহু এখানে আনা হয়েছে। otc-server.js বড় হয়ে
 * যাওয়ায় দামের physics আলাদা রাখা হলো — otc-server শুধু এটাকে ডাকে।
 *
 * বাস্তব FX/গোল্ড বাজারের যে ধর্মগুলো বসানো:
 *   ১. অস্থিরতার স্মৃতি — বাজার একবার অস্থির হলে কিছুক্ষণ অস্থিরই থাকে
 *      (এটাই candle গুলোকে আলাদা আকারের করে; না থাকলে সব একরকম = robotic)
 *   ২. ঝলক / শ্বাস / ছোট পা — একটানা গড়ায় না, খণ্ড খণ্ড চলে
 *   ৩. ফিরতি টান — দ্রুত ঝাঁপের পর দাম আংশিক ফিরে আসে
 *   ৪. গুচ্ছ ঝলক — একটা ঝলকের পর পরেরটা তাড়াতাড়ি আসে
 *   ৫. ভারী লেজ — কদাচিৎ হঠাৎ বড় লাফ
 *   ৬. bid-ask কাঁপুনি — দিকহীন ছোট লাফ
 *   ৭. pip ধাপ — দাম নির্দিষ্ট ধাপে লাফায়
 *   ৮. দিনের ছন্দ — লন্ডন/নিউইয়র্ক সময়ে উত্তাল, এশীয় সময়ে ঝিমানো
 *
 * পরীক্ষায় মাপা ফল (৯২% payout): সব সময়সীমায় জয়ের হার ৪৮.৭–৫১.১%,
 * candle বৈচিত্র্য ০.৪৪। ব্রেক-ইভেন ৫২.১% — তাই নিরাপদ প্রান্তে।
 *
 * ⚠ এই ফাইলের সংখ্যা বদলালে জয়ের হার বদলে যেতে পারে। বদলানোর আগে
 *   tick-v1.html এ একই মান দিয়ে পরীক্ষা করে নিও।
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

/* ── টিউনিং — পরীক্ষায় যে মানগুলো পাস করেছে ─────────────────────────
   env দিয়ে বদলানো যায়, তাই কোড ছোঁয়া ছাড়াই Railway থেকে টিউন করা যাবে। */
const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

const CFG = {
  volMem:  num(process.env.ENG_VOL_MEM,  0.994),  // অস্থিরতার স্মৃতির দৈর্ঘ্য
  volAmp:  num(process.env.ENG_VOL_AMP,  0.38),   // ওঠানামার মাত্রা
  volSpd:  num(process.env.ENG_VOL_SPD,  0.75),   // অস্থিরতা কতটা গতি বদলায়
  // জমাট অবস্থা — দাম প্রায় থেমে থাকে, তারপর আবার চলা শুরু
  freezeMin: num(process.env.ENG_FRZ_MIN, 1000),  // ন্যূনতম ১s
  freezeMax: num(process.env.ENG_FRZ_MAX, 4000),  // সর্বোচ্চ ৪s (hard limit)
  freezeGap: num(process.env.ENG_FRZ_GAP, 0.28),  // কত ঘন ঘন জমাট আসে
  runLen:  num(process.env.ENG_RUN_LEN,  3),      // ঝলকের গড় tick
  restLen: num(process.env.ENG_REST_LEN, 2),      // শ্বাসের গড় tick — ছোট, ঝলকই প্রধান
  clust:   num(process.env.ENG_CLUST,    0.45),   // ঝলক গুচ্ছ হওয়া
  retr:    num(process.env.ENG_RETR,     0.20),   // ফিরতি টান — সর্বোচ্চ ২০%
  jump:    num(process.env.ENG_JUMP,     1.8),    // হঠাৎ বড় লাফ %
  spread:  num(process.env.ENG_SPREAD,   0),      // bid-ask কাঁপুনি — ০ = দোলাদুলি নেই
  bias:    num(process.env.ENG_BIAS,     0.012),  // trend পক্ষপাত (কমানো — লম্বা সময়সীমায় মার্জিন বাড়াতে)
  session: num(process.env.ENG_SESSION,  0.55),   // দিনের ছন্দ
  gapMs:   num(process.env.ENG_GAP_MS,   420),    // গড় tick ব্যবধান (vol দিয়ে ভাগ হয়)
  spdVar:  num(process.env.ENG_SPD_VAR,  0.72),   // গতির তারতম্য
  // গতির মেজাজ — প্রতি ২-৩ সেকেন্ডে গতি বদলায়
  moodMin: num(process.env.ENG_MOOD_MIN, 2000),  // মেজাজ কত কম সময় থাকে
  moodMax: num(process.env.ENG_MOOD_MAX, 3500),  // কত বেশি
  moodAmp: num(process.env.ENG_MOOD_AMP, 0.85),  // কতটা দ্রুত/ধীর হয়
  unit:    num(process.env.ENG_UNIT,     0.00004),// pip-ঘেঁষা একক (দামের অনুপাতে)
  maxStep: num(process.env.ENG_MAX_STEP, 0.0015), // safety clamp ±০.১৫%/tick
  // admin নিয়ন্ত্রণ (otc-server থেকে প্রতি tick এ পাঠানো হয়)
  forceDir:      0,     // manual mode: 1 = up, -1 = down, 0 = auto
  trendStrength: 0.6,   // manual mode এ দিকের জোর
};

/**
 * একটা market এর জন্য নতুন engine অবস্থা।
 * @param {number} price  শুরুর দাম
 * @param {number} decimals  দামের দশমিক ঘর (pip ধাপের জন্য)
 */
/* [DECIMALS] দশমিক ঘর দামের সাথে মানানসই কিনা যাচাই।
   সমস্যা: কিছু market এ দাম ছোট কিন্তু দশমিক কম (যেমন NZD/USD 0.59 এ
   ৪ ঘর), তখন এক pip ধাপ engine এর গড় পায়ের চেয়ে বড় হয়ে যেত আর দাম
   প্রায় নড়ত না (৬০s এ ৪ বার)। এখন ন্যূনতম ঘর হিসাব করে নেওয়া হয়,
   যাতে এক ধাপ দামের ~০.০০১% এর কাছাকাছি থাকে — সব market এ সমান
   মসৃণ চলাচল। */
function _fitDecimals(price, given) {
  if (!isFinite(price) || price <= 0) return given;
  // এক ধাপ যেন দামের ০.০০২% এর বেশি না হয়
  const need = Math.ceil(Math.log10(1 / (price * 0.00002)));
  return Math.min(8, Math.max(given, need));
}

function createState(price, decimals = 5) {
  decimals = _fitDecimals(price, decimals);
  return {
    price,
    decimals,
    vol: 1,                                   // চলতি অস্থিরতা (স্মৃতিসম্পন্ন)
    phase: 'rest',
    left: 3,
    dir: 1,
    excite: 0,                                // ঝলকের পর উত্তেজনা
    runStart: price,
    retrTarget: 0,
    retrLeft0: 1,
    retrFast: false,
    runSpd: 1,             // চলতি ঝলকের নিজস্ব গতি — প্রতি ঝলকে নতুন
    mood: 1,               // চলতি গতির মেজাজ (১ = স্বাভাবিক)
    moodUntil: 0,          // এই সময় পর্যন্ত এই মেজাজ
    frozenUntil: 0,        // এই সময় পর্যন্ত জমাট
    nextFreezeAt: 0,       // পরের জমাট কখন
    regimeDir: Math.random() < 0.5 ? 1 : -1,
    regimeLeft: 200 + ((Math.random() * 400) | 0),
  };
}

/**
 * দিনের ছন্দ — UTC ঘণ্টা অনুযায়ী সক্রিয়তার গুণক।
 * লন্ডন (৭-১৬) ও নিউইয়র্ক (১৩-২১) মিলে সবচেয়ে উত্তাল; এশীয় সময়ে ঝিমানো।
 */
function sessionMul(t, amt) {
  const d = new Date(t);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const curve = 0.55
    + 0.75 * Math.exp(-Math.pow((h - 13) / 5.5, 2))     // লন্ডন+নিউইয়র্ক overlap
    + 0.35 * Math.exp(-Math.pow((h - 8.5) / 2.2, 2));   // লন্ডন খোলা
  return 1 + (curve - 1) * amt;
}

/**
 * এক tick এগোয় — নতুন দাম ফেরত দেয়।
 * @param {object} st  createState() থেকে পাওয়া অবস্থা
 * @param {number} now  বর্তমান সময় (ms)
 * @param {object} [over]  ঐচ্ছিক — নির্দিষ্ট market এর জন্য CFG override
 */
/* প্রতিটা ঝলকের নিজস্ব গতি — একটা ঝলক ঝড়ের মত, পরেরটা আলস্যভরে।
   তিন ভাগে: ধীর (৩০%), স্বাভাবিক (৪৫%), ঝড় (২৫%)।
   শুধু tick এর ব্যবধান বদলায় — পায়ের আকার নয়, তাই candle এর মাপ
   ও জয়ের হার অপরিবর্তিত থাকে। */
function _runSpeed() {
  const r = Math.random();
  if (r < 0.30) return 0.35 + Math.random() * 0.30;   // ধীর — থেমে থেমে
  if (r < 0.75) return 0.85 + Math.random() * 0.55;   // স্বাভাবিক
  return 2.2 + Math.random() * 1.8;                   // ঝড় — ১০০ গতি
}

function nextPrice(st, now = Date.now(), over) {
  const c = over ? { ...CFG, ...over } : CFG;
  const base = st.price * c.unit;

  /* ══ [FREEZE] জমাট অবস্থা ═══════════════════════════════════════════
     আসল বাজারে দাম মাঝে মাঝে কয়েক সেকেন্ড একদম থেমে থাকে (কোনো order
     আসে না), তারপর আবার চলা শুরু। আগে vol কম হলেও ছোট ছোট নড়াচড়া
     চলতেই থাকত — সেটাই "সবসময় নড়ছে" ভাব দিত।

     জমাটে দাম প্রায় স্থির, তবে কদাচিৎ ১ ধাপ নড়ে — একদম মৃত না, আর
     trade একই দামে শেষ হলে settler এমনিতেই পুরো টাকা ফেরত দেয়।
     দৈর্ঘ্য ১-৭ সেকেন্ড, hard limit ছাড়ায় না।
     ══════════════════════════════════════════════════════════════════ */
  /* ══ [MOOD] গতির মেজাজ ═════════════════════════════════════════════
     প্রতি ২-৩.৫ সেকেন্ডে একটা নতুন গুণক ঠিক হয় — কখনো দ্রুত, কখনো ধীর।
     এটা পর্বের (ঝলক/ফেরত/শ্বাস) নিজস্ব গতির উপরে বসে, তাই একই ধরনের
     ঝলকও কখনো ঝড়ের মত, কখনো আলস্যভরে চলে। ১ মিনিটের candle এ ~২০-৩০
     বার গতি বদলায়।

     শুধু সময় বদলায়, দিক নয় — তাই জয়ের হারে প্রভাব পড়ে না। ══ */
  if (now >= st.moodUntil) {
    const r = Math.random();
    // অসম বণ্টন: বেশিরভাগ মাঝারি, কদাচিৎ খুব দ্রুত বা খুব ধীর
    st.mood = Math.pow(2, (r * 2 - 1) * c.moodAmp);
    st.moodUntil = now + c.moodMin + Math.random() * (c.moodMax - c.moodMin);
  }

  if (!st.nextFreezeAt) st.nextFreezeAt = now + 2000 + Math.random() * 8000;

  if (now < st.frozenUntil) {
    // জমাট চলছে — কদাচিৎ এক ধাপ, নইলে একদম স্থির
    if (Math.random() < 0.06) {
      const q0 = Math.pow(10, st.decimals);
      st.price = Math.round((st.price + (Math.random() < 0.5 ? 1 : -1) / q0) * q0) / q0;
    }
    return st.price;
  }

  if (now >= st.nextFreezeAt) {
    // শান্ত বাজারে জমাট বেশি, উত্তালে কম
    if (Math.random() < c.freezeGap / Math.max(0.35, st.vol)) {
      const dur = c.freezeMin + Math.random() * (c.freezeMax - c.freezeMin);
      st.frozenUntil = now + Math.min(c.freezeMax, dur);
      // জমাটের পর দিক নতুন করে ঠিক হয় — নইলে "জমাটের আগে যেদিকে যাচ্ছিল
      // সেদিকেই যাবে" ধরে ৫s trade জেতা যেত (মাপা হয়েছিল ৫৩.৪%)।
      st.phase = 'rest'; st.left = 1;
      st.excite = 0;
      st.regimeDir = Math.random() < 0.5 ? 1 : -1;
      st.retrTarget = 0;
      // জমাট শুরুর আগে দাম কিছুটা ফিরিয়ে আনি — জমাটের আগের ও পরের
      // চলাচল যেন এক সরলরেখা না হয় (নইলে ৫s এ দিক অনুমান করা যেত)।
      const back = (st.price - st.runStart) * (0.65 + Math.random() * 0.25);
      if (isFinite(back)) {
        const q1 = Math.pow(10, st.decimals);
        st.price = Math.round((st.price - back) * q1) / q1;
        st.runStart = st.price;
      }
    }
    // পরের যাচাই জমাট শেষ হওয়ার পরে — নইলে দুটো জমাট জুড়ে গিয়ে
    // ৭ সেকেন্ডের সীমা ছাড়িয়ে যেত
    st.nextFreezeAt = Math.max(now, st.frozenUntil) + 1500 + Math.random() * 5000;
  }

  /* ── ১. অস্থিরতার স্মৃতি ── */
  const shock = (Math.random() - 0.5) * c.volAmp;
  st.vol = st.vol * c.volMem + (1 - c.volMem) * (1 + shock * 3);
  st.vol = Math.max(0.35, Math.min(2.6, st.vol));   // সীমা কমানো — নইলে vol ছাদে আটকে candle বিশাল হত

  /* ── ২. উত্তেজনা ধীরে শান্ত হয় (গুচ্ছ ঝলক) ── */
  st.excite *= 0.93;

  /* ── ৩. পর্ব বদল ── */
  if (--st.left <= 0) {
    if (st.phase === 'run') {
      st.excite = Math.min(1, st.excite + 0.55);
      // ফিরতি টান — ঝলকে যতটা গেছে তার একাংশ ফেরত
      const moved = st.price - st.runStart;
      // [ADMIN] manual mode এ ফিরতি টান কম — নইলে পক্ষপাতী দিক মুছে যেত
      // আর admin এর নির্দেশ কাজ করত না।
      const rf = c.forceDir ? c.retr * (1 - c.trendStrength * 0.75) : c.retr;
      // ফেরতের পরিমাণ ১% থেকে সর্বোচ্চ retr (২০%) পর্যন্ত এলোমেলো —
      // কখনো প্রায় পুরোটাই ধরে রাখে, কখনো এক-পঞ্চমাংশ ছেড়ে দেয়।
      // অস্থিরতার স্মৃতি মিশিয়ে: শান্ত বাজারে ফেরত বেশি (দাম ফিরে আসে),
      // উত্তাল বাজারে কম (চলাচল ধরে রাখে) — আসল বাজারের ধর্ম।
      const volFade = 1 / (1 + (st.vol - 1) * 0.45);
      const frac = (0.01 + Math.random() * (rf - 0.01)) * Math.max(0.35, Math.min(1.6, volFade));
      st.retrTarget = -moved * frac;
      // ফেরতের গতি — কখনো ঝট করে (২ tick), কখনো ধীরে গড়িয়ে (৭ tick)।
      // শুরুতেই ঠিক হয়, পুরো ফেরত জুড়ে একই থাকে, তাই চলাচল মসৃণ।
      const fast = Math.random() < 0.45;
      // ফেরত ছোট (১-২০%) হলে অল্প tick এই শেষ — নইলে সময়ের বড় অংশ
      // ফেরতেই চলে যেত আর ঝলক কম দেখা যেত।
      st.retrLeft0 = fast ? (1 + ((Math.random() * 2) | 0))     // দ্রুত: ১-২
                          : (2 + ((Math.random() * 3) | 0));    // ধীরে: ২-৪
      st.retrFast = fast;
      if (Math.abs(st.retrTarget) > 1e-12 && c.retr > 0) {
        st.phase = 'retrace';
        st.left = st.retrLeft0;
      } else {
        const rest = Math.max(0, c.restLen * (1 - st.excite * c.clust) / Math.max(0.4, st.vol));
        st.phase = 'rest';
        st.left = 1 + ((Math.random() * (rest + 1)) | 0);
      }
    } else if (st.phase === 'retrace') {
      // ফেরতের পর প্রায়ই সরাসরি আরেকটা ছোট ঝলক (২-৩ tick) — শ্বাস ছাড়াই।
      // এতে চলাচল বেশি জীবন্ত লাগে, প্রতিবার থেমে যায় না।
      // Quotex এর মত — ফেরতের পর প্রায় সবসময়ই নতুন ঝলক, খুব কম সময় থামে
      if (Math.random() < 0.80) {
        st.phase = 'run';
        st.left = 2 + ((Math.random() * 2) | 0);
        const b2 = (c.forceDir ? c.forceDir * (0.15 + c.trendStrength * 0.35)
                               : st.regimeDir * c.bias);
        st.dir = Math.random() < 0.5 + b2 ? 1 : -1;   // দিক নতুন করে
        st.runSpd = _runSpeed();                      // এই ঝলকের নিজস্ব গতি
        st.runStart = st.price;
      } else {
        const rest = Math.max(0, c.restLen * (1 - st.excite * c.clust) / Math.max(0.4, st.vol));
        st.phase = 'rest';
        st.left = 1 + ((Math.random() * (rest + 1)) | 0);
      }
    } else if (st.phase === 'rest') {
      // [NO WOBBLE] আগে এখানে 'step' পর্ব ছিল — দিকহীন ছোট নড়াচড়া, যা
      // দোলাদুলির মত লাগত। এখন শ্বাসের পর সরাসরি নতুন ঝলক।
      st.phase = 'run';
      const u0 = Math.random();
      st.left = 2 + ((Math.random() * 5) | 0);   // ঝলক ২-৬ tick এলোমেলো
      // [FIX] এখানেও admin এর দিক মানতে হবে — আগে শুধু regime দেখত, তাই
      // manual mode এর অর্ধেক ঝলক নির্দেশ উপেক্ষা করত।
      const b0 = (c.forceDir ? c.forceDir * (0.15 + c.trendStrength * 0.35)
                             : st.regimeDir * c.bias);
      st.dir = Math.random() < 0.5 + b0 ? 1 : -1;
      st.runStart = st.price;
    } else {
      st.phase = 'run';
      // দৈর্ঘ্য heavy-tail — বেশিরভাগ ছোট, কদাচিৎ অনেক লম্বা
      const u = Math.random();
      st.left = 2 + ((Math.random() * 5) | 0);   // ঝলক ২-৬ tick এলোমেলো
      // [ADMIN] manual mode এ admin এর দিক মানা হয় — trendStrength যত বেশি
      // তত জোরালো পক্ষপাত (০.৬ হলে ~৮০% ঝলক ওই দিকে)
      const b = (c.forceDir ? c.forceDir * (0.15 + c.trendStrength * 0.35)
                            : st.regimeDir * c.bias);
      st.dir = Math.random() < 0.5 + b ? 1 : -1;
      st.runSpd = _runSpeed();                        // এই ঝলকের নিজস্ব গতি
      st.runStart = st.price;
    }
  }

  const sm = sessionMul(now, c.session);
  let delta;

  if (st.phase === 'retrace') {
    delta = (st.retrTarget / st.retrLeft0) * (0.6 + Math.random() * 0.8);
  } else if (st.phase === 'rest') {
    delta = 0;                                          // একদম স্থির
  } else if (st.phase === 'step') {
    delta = (Math.random() - 0.5) * base * c.spread * st.vol * sm;   // spread=0 হলে ০
  } else {
    delta = st.dir * base * (1.0 + Math.random() * 1.6) * st.vol * sm;
  }

  /* ── ৫. ভারী লেজ ── */
  if (Math.random() * 100 < c.jump) {
    // [WICK] লাফ ছোট করা — আগে এক tick এ candle এর ৮০% পর্যন্ত লাফাত,
    // তাই প্রায় প্রতি candle এ বড় wick তৈরি হত। এখন লাফ মাঝারি, আর
    // ঝলকের দিকেই বেশি ঝোঁকে (এলোমেলো spike কম)।
    const mag = base * (1.8 + Math.pow(Math.random(), -0.3) * 1.2) * st.vol;
    const jd  = Math.random() < 0.65 ? st.dir : (Math.random() < 0.5 ? 1 : -1);
    delta += jd * mag;
    st.excite = Math.min(1, st.excite + 0.7);
    st.vol = Math.min(2.6, st.vol * 1.10);   // লাফের পর vol সামান্য বাড়ে (আগে ১.২৫ — জমে ছাদে উঠত)
  }

  /* ── regime — কয়েক মিনিট পরপর দিক বদলায় ── */
  if (--st.regimeLeft <= 0) {
    st.regimeDir = Math.random() < 0.5 ? 1 : -1;
    st.regimeLeft = 200 + ((Math.random() * 500) | 0);
  }

  /* ── safety clamp — প্রতি tick এ সর্বোচ্চ ±০.১৫% ── */
  const cap = st.price * c.maxStep;
  delta = Math.max(-cap, Math.min(cap, delta));

  st.price = Math.max(st.price + delta, 0.0001);

  /* ── ৭. pip ধাপ — দাম নির্দিষ্ট ধাপে লাফায় ── */
  const q = Math.pow(10, st.decimals);
  st.price = Math.round(st.price * q) / q;

  return st.price;
}

/**
 * পরের tick কত ms পরে আসবে।
 * আসল FX এ tick গুচ্ছ হয়ে আসে — কয়েকটা প্রায় একসাথে, তারপর নীরবতা।
 */
function nextDelay(st, over) {
  const c = over ? { ...CFG, ...over } : CFG;

  // জমাট অবস্থায় tick ধীরে — নইলে একই দাম বারবার পাঠিয়ে bandwidth নষ্ট হত
  // জমাটে tick ধীরে — তবে খুব ধীর নয়, নইলে গোটা মিনিটের tick হার
  // নেমে যেত (জমাট সময়ের ~২০% হলেও tick এর বড় অংশ খেয়ে ফেলত)।
  if (Date.now() < st.frozenUntil) return 260 + Math.random() * 260;

  let g = c.gapMs;

  // [MOOD] গতির মেজাজ — মেজাজ যত বড়, tick তত দ্রুত।
  // মেজাজের গড় প্রভাব ১ এ রাখতে normalize করা হয়, নইলে গড় ব্যবধান
  // বেড়ে গিয়ে tick হার অর্ধেকে নেমে যেত।
  // মেজাজ এখন মৃদু — প্রতিটা ঝলকের নিজস্ব গতিই প্রধান নিয়ন্ত্রক
  const MOOD_NORM = 1.08;
  g /= Math.max(0.6, Math.min(1.7, (st.mood || 1))) / MOOD_NORM;

  /* [VOL↔SPEED] আসল বাজারে অস্থিরতা বাড়লে শুধু পা বড় হয় না — tick ও
     ঘন আসে। আগে দুটো আলাদা ছিল, তাই বড় candle ও ধীর গতিতে তৈরি হত এবং
     সব সময় একই গতি মনে হত। এখন vol বেশি হলে ব্যবধান কমে যায়:
     vol ২.৫ → প্রায় অর্ধেক ব্যবধান, vol ০.৪ → দ্বিগুণ। */
  g /= Math.pow(Math.max(0.3, st.vol), c.volSpd * 0.5);

  // ঝলকের নিজস্ব গতি — এই ঝলকটা ধীরে না ঝড়ের মত যাবে
  const rs = Math.max(0.3, Math.min(4, st.runSpd || 1));
  g *= st.phase === 'run' ? 0.5 / rs
     : st.phase === 'rest' ? 1.4
     : st.phase === 'retrace' ? (st.retrFast ? 0.55 : 1.15) / Math.sqrt(rs)  // ফেরতেও কিছুটা
     : 1;
  g *= 1 - 0.6 * st.excite * c.spdVar;          // উত্তেজনায় দ্রুত

  // এলোমেলো ঝাঁক মৃদু — নইলে ঝলকের নিজস্ব গতি ঢাকা পড়ে যেত
  const roll = Math.random();
  if (roll < 0.08) g *= 0.55;
  else if (roll > 0.94) g *= 1.6;

  g *= 0.82 + Math.random() * 0.36;
  return Math.max(28, g);
}

module.exports = { createState, nextPrice, nextDelay, sessionMul, CFG };
