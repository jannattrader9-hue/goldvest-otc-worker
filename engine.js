/**
 * engine.js — GoldVest OTC price engine (Modified with Fakeout/Whipsaw Logic)
 * ═══════════════════════════════════════════════════════════════════════
 * ফেকআউট (Fakeout) আপডেট: 
 * সাধারণ run এর পাশাপাশি প্রায় ৪০% সময় মার্কেট মূল ট্রেন্ডের উল্টো দিকে 
 * (fakeout) গিয়ে ধোঁকা দেবে এবং শেষে প্রচণ্ড বেগে (snapback) সঠিক দিকে 
 * লাফিয়ে ফিরে আসবে। এর ফলে কোনো স্ট্র্যাটেজি নির্দিষ্ট প্যাটার্ন ধরতে পারবে না।
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

const CFG = {
  unit:    num(process.env.ENG_UNIT,     0.0000075),
  volMem:  num(process.env.ENG_VOL_MEM,  0.994),
  volAmp:  num(process.env.ENG_VOL_AMP,  0.28),
  runLen:  num(process.env.ENG_RUN_LEN,  6),
  restLen: num(process.env.ENG_REST_LEN, 5),
  clust:   num(process.env.ENG_CLUST,    0.45),
  retr:    num(process.env.ENG_RETR,     0.40),
  jump:    num(process.env.ENG_JUMP,     1.8),
  spread:  num(process.env.ENG_SPREAD,   1.0),
  gapMs:   num(process.env.ENG_GAP_MS,   170),
  spdVar:  num(process.env.ENG_SPD_VAR,  0.72),
  bias:    num(process.env.ENG_BIAS,     0.008),
  session: num(process.env.ENG_SESSION,  0.55),
  maxStep: num(process.env.ENG_MAX_STEP, 0.0015),

  anchorBand:     num(process.env.ENG_ANCHOR_BAND,     0.06),
  anchorStrength: num(process.env.ENG_ANCHOR_STRENGTH, 0.00005),

  forceDir: 0,
  trendStrength: 0.6,
};

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
  return {
    price,
    decimals,
    tickScale: _tickScale(price, decimals),
    referencePrice: 0,
    vol: 1,
    phase: 'rest',
    left: 3,
    dir: 1,
    excite: 0,
    runStart: price,
    retrTarget: 0,
    retrLeft0: 1,
    retrFast: false,
    retrDone: 0,
    regimeDir: Math.random() < 0.5 ? 1 : -1,
    regimeLeft: 200 + ((Math.random() * 500) | 0),
  };
}

function sessionMul(t, amt) {
  const d = new Date(t);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const curve = 0.55
    + 0.75 * Math.exp(-Math.pow((h - 13) / 5.5, 2))
    + 0.35 * Math.exp(-Math.pow((h - 8.5) / 2.2, 2));
  return 1 + (curve - 1) * amt;
}

function nextPrice(st, now = Date.now(), over) {
  const c = over ? { ...CFG, ...over } : CFG;
  const base = st.price * c.unit * (st.tickScale || 1);

  const shock = (Math.random() - 0.5) * c.volAmp;
  st.vol = st.vol * c.volMem + (1 - c.volMem) * (1 + shock * 3);
  st.vol = Math.max(0.25, Math.min(4.5, st.vol));

  st.excite *= 0.93;

  if (--st.left <= 0) {
    if (st.phase === 'run' || st.phase === 'snapback') {
      st.excite = Math.min(1, st.excite + 0.55);
      const moved = st.price - st.runStart;
      st.retrTarget = -moved * (c.retr * (0.55 + Math.random() * 0.85));
      st.retrFast = Math.random() < 0.5;
      st.retrLeft0 = st.retrFast ? (1 + ((Math.random() * 2) | 0))
                                 : (2 + ((Math.random() * 3) | 0));
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
    } else if (st.phase === 'fakeout') {
      // ফেকআউট শেষ! এবার প্রচণ্ড বেগে মূল ট্রেন্ডের দিকে লাফ দেবে (snapback)
      st.phase = 'snapback';
      st.left = 2 + ((Math.random() * 3) | 0); 
      st.dir = st.regimeDir; 
      st.vol = Math.min(4.5, st.vol * 2.5); 
      st.runStart = st.price;
    } else {
      // rest শেষ হওয়ার পর নতুন মুভমেন্ট (এখানে ৪০% সময় ফেকআউট হবে)
      const isFakeout = Math.random() < 0.40; 

      if (isFakeout) {
        st.phase = 'fakeout';
        st.left = 4 + ((Math.random() * 6) | 0); // বেশ কিছুক্ষণ উল্টো দিকে যাবে
        st.dir = -st.regimeDir; // মূল ট্রেন্ডের ঠিক উল্টো দিক
        st.runStart = st.price;
      } else {
        st.phase = 'run';
        const u = Math.random();
        st.left = Math.max(2, Math.round(c.runLen * Math.pow(u, -0.45) * 0.6));
        const b = c.forceDir
          ? c.forceDir * (0.10 + c.trendStrength * 0.22)
          : st.regimeDir * c.bias;
        st.dir = Math.random() < 0.5 + b ? 1 : -1;
        st.runStart = st.price;
      }
    }
  }

  const sm = sessionMul(now, c.session);
  let delta;

  if (st.phase === 'retrace') {
    const remain = st.retrTarget - (st.retrDone || 0);
    if (st.left <= 1) {
      delta = remain;
    } else {
      const share = remain / st.left;
      const mag = 0.45 + Math.pow(Math.random(), -0.42) * 0.75;
      delta = share * Math.min(3.2, mag);
      if (Math.abs((st.retrDone || 0) + delta) > Math.abs(st.retrTarget)) delta = remain;
    }
    st.retrDone = (st.retrDone || 0) + delta;
  } else if (st.phase === 'rest') {
    delta = 0;
  } else if (st.phase === 'step') {
    delta = (Math.random() - 0.5) * base * c.spread * st.vol * sm;
  } else if (st.phase === 'snapback') {
    // ফেকআউট শেষে স্ন্যাপব্যাকের বিশাল লাফ (উইক বা শ্যাডো তৈরি করার জন্য)
    const mag = 1.5 + Math.pow(Math.random(), -0.5) * 1.5;
    delta = st.dir * base * Math.min(10, mag) * st.vol * sm;
  } else {
    // সাধারণ run বা fakeout এর গতি
    const mag = 0.45 + Math.pow(Math.random(), -0.42) * 0.75;
    delta = st.dir * base * Math.min(6, mag) * st.vol * sm;
  }

  if (Math.random() * 100 < c.jump) {
    const mag = base * (4 + Math.pow(Math.random(), -0.5) * 3) * st.vol;
    delta += (Math.random() < 0.5 ? 1 : -1) * mag;
    st.excite = Math.min(1, st.excite + 0.7);
    st.vol = Math.min(4.5, st.vol * 1.25);
  }

  if (--st.regimeLeft <= 0) {
    st.regimeDir = Math.random() < 0.5 ? 1 : -1;
    st.regimeLeft = 200 + ((Math.random() * 500) | 0);
  }

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

  const q = Math.pow(10, st.decimals);
  st.price = Math.round(st.price * q) / q;

  return st.price;
}

function nextDelay(st, over) {
  const c = over ? { ...CFG, ...over } : CFG;
  let g = c.gapMs;

  // ফেকআউট হলে run এর মতই গতি থাকবে, আর snapback এর সময় ভয়ানক ফাস্ট হবে
  g *= (st.phase === 'run' || st.phase === 'fakeout') ? 0.5
     : st.phase === 'snapback' ? 0.25 
     : st.phase === 'rest' ? 1.4
     : st.phase === 'retrace' ? (st.retrFast ? 0.45 : 1.05)
     : 1;
  
  g *= 1 - 0.6 * st.excite * c.spdVar;

  const roll = Math.random();
  if (roll < 0.12 * c.spdVar) g *= 0.22;
  else if (roll < 0.20 * c.spdVar) g *= 0.45;
  else if (roll > 1 - 0.07 * c.spdVar) g *= 2.4;

  g *= 0.6 + Math.random() * 0.8;
  return Math.max(35, g);
}

module.exports = { createState, nextPrice, nextDelay, sessionMul, CFG };
