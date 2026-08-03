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
  volAmp:  num(process.env.ENG_VOL_AMP,  0.28),   // ওঠানামার মাত্রা
  runLen:  num(process.env.ENG_RUN_LEN,  6),      // ঝলকের গড় tick
  restLen: num(process.env.ENG_REST_LEN, 5),      // শ্বাসের গড় tick
  clust:   num(process.env.ENG_CLUST,    0.45),   // ঝলক গুচ্ছ হওয়া
  retr:    num(process.env.ENG_RETR,     0.40),   // ফিরতি টান
  jump:    num(process.env.ENG_JUMP,     1.8),    // হঠাৎ বড় লাফ %
  spread:  num(process.env.ENG_SPREAD,   1.0),    // bid-ask কাঁপুনি
  bias:    num(process.env.ENG_BIAS,     0.02),   // trend পক্ষপাত
  session: num(process.env.ENG_SESSION,  0.55),   // দিনের ছন্দ
  gapMs:   num(process.env.ENG_GAP_MS,   320),    // গড় tick ব্যবধান
  spdVar:  num(process.env.ENG_SPD_VAR,  0.72),   // গতির তারতম্য
  unit:    num(process.env.ENG_UNIT,     0.00004),// pip-ঘেঁষা একক (দামের অনুপাতে)
  maxStep: num(process.env.ENG_MAX_STEP, 0.0015), // safety clamp ±০.১৫%/tick
};

/**
 * একটা market এর জন্য নতুন engine অবস্থা।
 * @param {number} price  শুরুর দাম
 * @param {number} decimals  দামের দশমিক ঘর (pip ধাপের জন্য)
 */
function createState(price, decimals = 5) {
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
function nextPrice(st, now = Date.now(), over) {
  const c = over ? { ...CFG, ...over } : CFG;
  const base = st.price * c.unit;

  /* ── ১. অস্থিরতার স্মৃতি ── */
  const shock = (Math.random() - 0.5) * c.volAmp;
  st.vol = st.vol * c.volMem + (1 - c.volMem) * (1 + shock * 3);
  st.vol = Math.max(0.25, Math.min(4.5, st.vol));

  /* ── ২. উত্তেজনা ধীরে শান্ত হয় (গুচ্ছ ঝলক) ── */
  st.excite *= 0.93;

  /* ── ৩. পর্ব বদল ── */
  if (--st.left <= 0) {
    if (st.phase === 'run') {
      st.excite = Math.min(1, st.excite + 0.55);
      // ফিরতি টান — ঝলকে যতটা গেছে তার একাংশ ফেরত
      const moved = st.price - st.runStart;
      st.retrTarget = -moved * (c.retr * (0.55 + Math.random() * 0.85));
      st.retrLeft0 = 2 + ((Math.random() * 4) | 0);
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
      st.phase = 'step';
      st.left = 1 + ((Math.random() * 4) | 0);
    } else {
      st.phase = 'run';
      // দৈর্ঘ্য heavy-tail — বেশিরভাগ ছোট, কদাচিৎ অনেক লম্বা
      const u = Math.random();
      st.left = Math.max(2, Math.round(c.runLen * Math.pow(u, -0.45) * 0.6));
      const b = st.regimeDir * c.bias;
      st.dir = Math.random() < 0.5 + b ? 1 : -1;
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
    delta = (Math.random() - 0.5) * base * c.spread * st.vol * sm;
  } else {
    delta = st.dir * base * (1.0 + Math.random() * 1.6) * st.vol * sm;
  }

  /* ── ৫. ভারী লেজ ── */
  if (Math.random() * 100 < c.jump) {
    const mag = base * (4 + Math.pow(Math.random(), -0.5) * 3) * st.vol;
    delta += (Math.random() < 0.5 ? 1 : -1) * mag;
    st.excite = Math.min(1, st.excite + 0.7);
    st.vol = Math.min(4.5, st.vol * 1.25);
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
  let g = c.gapMs;

  g *= st.phase === 'run' ? 0.5 : st.phase === 'rest' ? 1.4 : 1;
  g *= 1 - 0.6 * st.excite * c.spdVar;          // উত্তেজনায় দ্রুত

  const roll = Math.random();
  if (roll < 0.12 * c.spdVar) g *= 0.22;        // ঝাঁক — খুব দ্রুত
  else if (roll < 0.20 * c.spdVar) g *= 0.45;
  else if (roll > 1 - 0.07 * c.spdVar) g *= 2.4; // হঠাৎ থমকে যাওয়া

  g *= 0.6 + Math.random() * 0.8;
  return Math.max(35, g);
}

module.exports = { createState, nextPrice, nextDelay, sessionMul, CFG };
