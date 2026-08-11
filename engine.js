/**
 * engine.js
 * GoldVest OTC / Forex-style DEMO price simulation engine
 *
 * লক্ষ্য:
 * - discrete tick-by-tick movement
 * - medium tick dominant
 * - tiny tick কম
 * - occasional large jump
 * - direction persistence
 * - natural reversal / retrace
 * - gradual speed transition
 * - slow / normal / fast / burst regimes
 * - controlled pause
 * - volatility clustering
 * - candle-level structure
 *
 * NOTE:
 * এটি market-behaviour simulation-এর জন্য।
 * Trade outcome / payout manipulation এখানে নেই।
 */

'use strict';

/* ============================================================
 * Helpers
 * ============================================================ */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const rand = (lo = 0, hi = 1) =>
  lo + Math.random() * (hi - lo);

const chance = p => Math.random() < p;

function weightedChoice(items) {
  const total = items.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;

  for (const item of items) {
    r -= item.w;
    if (r <= 0) return item.v;
  }

  return items[items.length - 1].v;
}

/*
 * Smooth random number around 1.
 * Extreme value কম, মাঝারি variation বেশি।
 */
function smoothNoise(amount = 0.15) {
  return 1 + rand(-amount, amount);
}

/*
 * Positive heavy-ish distribution.
 * Infinite tail নয়, কারণ chart simulator-এ absurd jump চাই না।
 */
function mediumHeavy() {
  const r = Math.random();

  if (r < 0.10) {
    // small
    return rand(0.35, 0.70);
  }

  if (r < 0.78) {
    // DOMINANT MEDIUM
    return rand(0.85, 1.35);
  }

  if (r < 0.95) {
    // medium-large
    return rand(1.35, 2.10);
  }

  // rare large
  return rand(2.10, 3.60);
}


/* ============================================================
 * Configuration
 * ============================================================ */

const CFG = {

  /*
   * Base price movement.
   *
   * 0.000018 = পুরোনো base-এর কাছাকাছি।
   * বেশি বড় tick চাইলে 0.000022 - 0.000028 পর্যন্ত পরীক্ষা করা যায়।
   */
  unit: num(process.env.ENG_UNIT, 0.000022),

  /*
   * Volatility memory
   *
   * কাছাকাছি থাকলে movement smooth থাকবে।
   */
  volMem: num(process.env.ENG_VOL_MEM, 0.985),

  volAmp: num(process.env.ENG_VOL_AMP, 0.20),

  /*
   * Direction persistence.
   *
   * এক tick পরেই direction পাল্টাবে না।
   */
  directionPersistence:
    num(process.env.ENG_DIRECTION_PERSISTENCE, 0.86),

  /*
   * Run duration.
   *
   * একটা direction সাধারণত কয়েকটি tick ধরে চলবে।
   */
  runMin: num(process.env.ENG_RUN_MIN, 3),
  runMax: num(process.env.ENG_RUN_MAX, 11),

  /*
   * Retrace probability.
   */
  retraceProbability:
    num(process.env.ENG_RETRACE_PROB, 0.28),

  /*
   * Retrace কতটা মূল movement ফেরত নেবে।
   */
  retraceMin:
    num(process.env.ENG_RETRACE_MIN, 0.20),

  retraceMax:
    num(process.env.ENG_RETRACE_MAX, 0.68),

  /*
   * Tiny tick probability.
   *
   * তোমার আগের engine-এর বড় সমস্যা ছিল tiny tick বেশি।
   * এখানে অনেক কম।
   */
  tinyTickProbability:
    num(process.env.ENG_TINY_PROB, 0.10),

  /*
   * Medium tick dominant.
   */
  mediumTickProbability:
    num(process.env.ENG_MEDIUM_PROB, 0.68),

  /*
   * Large tick probability.
   */
  largeTickProbability:
    num(process.env.ENG_LARGE_PROB, 0.18),

  /*
   * Rare jump.
   */
  jumpProbability:
    num(process.env.ENG_JUMP_PROB, 0.035),

  /*
   * Maximum single-tick movement.
   */
  maxStep:
    num(process.env.ENG_MAX_STEP, 0.0018),

  /*
   * Base tick interval.
   */
  gapMs:
    num(process.env.ENG_GAP_MS, 320),

  /*
   * Speed variation.
   */
  speedVariation:
    num(process.env.ENG_SPEED_VARIATION, 0.22),

  /*
   * Visible pause probability.
   */
  pauseProbability:
    num(process.env.ENG_PAUSE_PROB, 0.10),

  pauseMin:
    num(process.env.ENG_PAUSE_MIN, 250),

  pauseMax:
    num(process.env.ENG_PAUSE_MAX, 900),

  /*
   * Long pause is much rarer.
   */
  longPauseProbability:
    num(process.env.ENG_LONG_PAUSE_PROB, 0.025),

  /*
   * Direction reversal while running.
   *
   * খুব বেশি নয়।
   */
  reversalProbability:
    num(process.env.ENG_REVERSAL_PROB, 0.065),

  /*
   * Volatility regimes.
   */
  regimeMin:
    num(process.env.ENG_REGIME_MIN, 15),

  regimeMax:
    num(process.env.ENG_REGIME_MAX, 45),

  /*
   * Optional long-term reference.
   *
   * Demo simulationকে runaway হওয়া থেকে বাঁচায়।
   */
  anchorBand:
    num(process.env.ENG_ANCHOR_BAND, 0.08),

  anchorStrength:
    num(process.env.ENG_ANCHOR_STRENGTH, 0.000015),

  /*
   * Session effect.
   */
  session:
    num(process.env.ENG_SESSION, 0.35),

  /*
   * Optional external direction.
   *
   * এটি visual/demo testing-এর জন্য।
   */
  forceDir: 0,

  trendStrength:
    num(process.env.ENG_TREND_STRENGTH, 0.20)
};


/* ============================================================
 * Session multiplier
 * ============================================================ */

function sessionMul(t, amount) {

  const d = new Date(t);

  const h =
    d.getUTCHours() +
    d.getUTCMinutes() / 60;

  /*
   * Asia = relatively quiet
   * London = active
   * NY overlap = active
   *
   * এটি শুধু volatility multiplier।
   */
  const london =
    Math.exp(-Math.pow((h - 8.5) / 2.4, 2));

  const ny =
    Math.exp(-Math.pow((h - 13.5) / 4.5, 2));

  const curve =
    0.72 +
    0.40 * london +
    0.65 * ny;

  return 1 + (curve - 1) * amount;
}


/* ============================================================
 * Regime definitions
 * ============================================================ */

const SPEED_REGIMES = {

  slow: {
    multiplier: 1.45,
    vol: 0.72
  },

  normal: {
    multiplier: 1.00,
    vol: 1.00
  },

  fast: {
    multiplier: 0.67,
    vol: 1.22
  },

  burst: {
    multiplier: 0.42,
    vol: 1.55
  }
};


/*
 * Speed transition matrix.
 *
 * লক্ষ্য:
 *
 * slow
 *   ↓
 * normal
 *   ↓
 * fast
 *   ↓
 * burst
 *   ↓
 * fast / normal
 *
 * অর্থাৎ প্রতি tick-এ speed dice-roll করবে না।
 */
const SPEED_TRANSITIONS = {

  slow: [
    { v: 'slow',   w: 55 },
    { v: 'normal', w: 35 },
    { v: 'fast',   w: 9  },
    { v: 'burst',  w: 1  }
  ],

  normal: [
    { v: 'slow',   w: 22 },
    { v: 'normal', w: 52 },
    { v: 'fast',   w: 23 },
    { v: 'burst',  w: 3  }
  ],

  fast: [
    { v: 'slow',   w: 8  },
    { v: 'normal', w: 38 },
    { v: 'fast',   w: 43 },
    { v: 'burst',  w: 11 }
  ],

  burst: [
    { v: 'slow',   w: 3  },
    { v: 'normal', w: 30 },
    { v: 'fast',   w: 52 },
    { v: 'burst',  w: 15 }
  ]
};


/* ============================================================
 * State creation
 * ============================================================ */

function createState(price, decimals = 5) {

  const direction =
    Math.random() < 0.5 ? -1 : 1;

  const speedRegime =
    weightedChoice([
      { v: 'slow',   w: 15 },
      { v: 'normal', w: 60 },
      { v: 'fast',   w: 20 },
      { v: 'burst',  w: 5 }
    ]);

  return {

    price: Number(price),

    decimals,

    tickScale: 1,

    referencePrice: 0,

    /*
     * Current volatility.
     */
    vol: 1,

    /*
     * Direction.
     */
    dir: direction,

    /*
     * Current run.
     */
    runLeft:
      Math.floor(rand(
        CFG.runMin,
        CFG.runMax + 1
      )),

    runStart: Number(price),

    /*
     * Recent movement.
     */
    recentMove: 0,

    recentMagnitude: 1,

    /*
     * Momentum.
     */
    momentum: 0,

    /*
     * Speed.
     */
    speedRegime,

    speedRegimeLeft:
      Math.floor(rand(6, 16)),

    speed: SPEED_REGIMES[speedRegime].multiplier,

    /*
     * Pause.
     */
    pauseUntil: 0,

    /*
     * Retrace.
     */
    retraceActive: false,

    retraceRemaining: 0,

    retraceTotal: 0,

    retraceDir: 0,

    /*
     * Volatility regime.
     */
    volatilityRegime:
      Math.random() < 0.65
        ? 'normal'
        : 'active',

    volatilityRegimeLeft:
      Math.floor(rand(
        CFG.regimeMin,
        CFG.regimeMax
      )),

    /*
     * Candle statistics.
     */
    candleOpen: Number(price),

    candleHigh: Number(price),

    candleLow: Number(price),

    candleTicks: 0,

    /*
     * Last tick metadata.
     *
     * Debug / chart instrumentation-এর জন্য useful.
     */
    lastTick = undefined,

    lastDelay: CFG.gapMs,

    lastTimestamp: Date.now()
  };
}


/* ============================================================
 * Fix object shorthand issue
 * ============================================================ */

function normalizeState(st) {

  if (!st.lastTick) {

    st.lastTick = {
      delta: 0,
      magnitude: 0,
      direction: 0,
      type: 'init',
      speedRegime: st.speedRegime
    };
  }

  return st;
}


/* ============================================================
 * Tick magnitude
 * ============================================================ */

function chooseMagnitude(st, session) {

  const regime =
    SPEED_REGIMES[st.speedRegime] ||
    SPEED_REGIMES.normal;

  /*
   * Dominant medium tick.
   *
   * Tiny = 10%
   * Medium = 68%
   * Large = 18%
   * Remaining = rare jump handled separately
   */
  const r = Math.random();

  let magnitude;
  let type;

  if (r < CFG.tinyTickProbability) {

    magnitude =
      rand(0.35, 0.70);

    type = 'small';

  } else if (
    r <
    CFG.tinyTickProbability +
    CFG.mediumTickProbability
  ) {

    /*
     * MAIN MOVEMENT
     */
    magnitude =
      rand(0.82, 1.38);

    type = 'medium';

  } else if (
    r <
    CFG.tinyTickProbability +
    CFG.mediumTickProbability +
    CFG.largeTickProbability
  ) {

    magnitude =
      rand(1.35, 2.20);

    type = 'large';

  } else {

    magnitude =
      rand(1.00, 1.70);

    type = 'medium';
  }

  /*
   * Fast regime slightly increases movement.
   */
  magnitude *= regime.vol;

  /*
   * Session multiplier.
   */
  magnitude *= session;

  /*
   * Recent huge movement-এর পরে immediate huge movement
   * হওয়ার probability কম।
   */
  if (st.recentMagnitude > 2.2) {

    magnitude *=
      rand(0.72, 0.94);
  }

  /*
   * Speed regime এবং magnitude loosely coupled,
   * কিন্তু completely deterministic নয়।
   */
  if (st.speedRegime === 'burst') {

    magnitude *=
      rand(1.08, 1.28);

  } else if (st.speedRegime === 'fast') {

    magnitude *=
      rand(1.02, 1.12);

  } else if (st.speedRegime === 'slow') {

    magnitude *=
      rand(0.82, 0.96);
  }

  return {
    magnitude: clamp(magnitude, 0.20, 3.8),
    type
  };
}


/* ============================================================
 * Direction decision
 * ============================================================ */

function chooseDirection(st) {

  /*
   * Current direction ধরে রাখার probability।
   */
  let keepProbability =
    CFG.directionPersistence;

  /*
   * Strong momentum থাকলে আরও persistence।
   */
  if (Math.abs(st.momentum) > 0.65) {

    keepProbability += 0.07;
  }

  /*
   * Run শেষের দিকে reversal-এর chance সামান্য বাড়ে।
   */
  if (st.runLeft <= 2) {

    keepProbability -= 0.10;
  }

  /*
   * Random reversal।
   */
  if (
    chance(CFG.reversalProbability) &&
    Math.abs(st.momentum) > 0.15
  ) {

    return -st.dir;
  }

  /*
   * Mostly continue.
   */
  if (Math.random() < keepProbability) {

    return st.dir;
  }

  /*
   * Otherwise নতুন direction।
   */
  return Math.random() < 0.5 ? -1 : 1;
}


/* ============================================================
 * Start new directional run
 * ============================================================ */

function startRun(st, externalDirection = 0) {

  if (externalDirection) {

    st.dir =
      externalDirection > 0
        ? 1
        : -1;

  } else {

    st.dir =
      chooseDirection(st);
  }

  st.runLeft =
    Math.floor(
      rand(
        CFG.runMin,
        CFG.runMax + 1
      )
    );

  st.runStart = st.price;

  /*
   * Slight momentum boost.
   */
  st.momentum =
    st.momentum * 0.72 +
    st.dir * rand(0.18, 0.35);
}


/* ============================================================
 * Start retrace
 * ============================================================ */

function maybeStartRetrace(st) {

  const moved =
    st.price - st.runStart;

  if (Math.abs(moved) <= 0) {
    return false;
  }

  /*
   * Large move = somewhat higher retrace chance.
   */
  const moveRatio =
    Math.min(
      1,
      Math.abs(moved) /
      Math.max(
        st.price * 0.001,
        1e-12
      )
    );

  let probability =
    CFG.retraceProbability +
    moveRatio * 0.12;

  probability =
    clamp(probability, 0.05, 0.48);

  if (!chance(probability)) {

    return false;
  }

  /*
   * কতটা ফেরত যাবে।
   */
  const fraction =
    rand(
      CFG.retraceMin,
      CFG.retraceMax
    );

  st.retraceTotal =
    Math.abs(moved) * fraction;

  st.retraceRemaining =
    st.retraceTotal;

  st.retraceDir =
    moved > 0 ? -1 : 1;

  st.retraceActive = true;

  /*
   * Retrace momentum damp.
   */
  st.momentum *= 0.35;

  return true;
}


/* ============================================================
 * Volatility update
 * ============================================================ */

function updateVolatility(st) {

  /*
   * Small stochastic shock.
   */
  const shock =
    rand(
      -CFG.volAmp,
      CFG.volAmp
    );

  const target =
    1 + shock;

  st.vol =
    st.vol * CFG.volMem +
    target * (1 - CFG.volMem);

  /*
   * Regime.
   */
  if (--st.volatilityRegimeLeft <= 0) {

    st.volatilityRegime =
      chance(0.65)
        ? 'normal'
        : 'active';

    st.volatilityRegimeLeft =
      Math.floor(
        rand(
          CFG.regimeMin,
          CFG.regimeMax
        )
      );
  }

  if (
    st.volatilityRegime === 'active'
  ) {

    st.vol =
      Math.min(
        2.2,
        st.vol * 1.04
      );

  } else {

    st.vol =
      Math.max(
        0.60,
        st.vol * 0.995
      );
  }

  st.vol =
    clamp(
      st.vol,
      0.55,
      2.4
    );
}


/* ============================================================
 * Speed state update
 * ============================================================ */

function updateSpeed(st) {

  if (--st.speedRegimeLeft > 0) {
    return;
  }

  const current =
    st.speedRegime;

  const choices =
    SPEED_TRANSITIONS[current] ||
    SPEED_TRANSITIONS.normal;

  st.speedRegime =
    weightedChoice(choices);

  const durationTable = {

    slow: [8, 20],

    normal: [7, 18],

    fast: [5, 13],

    burst: [2, 7]
  };

  const range =
    durationTable[st.speedRegime] ||
    durationTable.normal;

  st.speedRegimeLeft =
    Math.floor(
      rand(
        range[0],
        range[1] + 1
      )
    );

  /*
   * Speed doesn't instantly teleport.
   * Move toward target.
   */
  st.speed =
    SPEED_REGIMES[
      st.speedRegime
    ].multiplier;
}


/* ============================================================
 * Pause
 * ============================================================ */

function maybePause(st, now) {

  /*
   * Never pause during an active retrace.
   */
  if (st.retraceActive) {
    return;
  }

  /*
   * Normal pause.
   */
  if (
    chance(CFG.pauseProbability)
  ) {

    let duration =
      rand(
        CFG.pauseMin,
        CFG.pauseMax
      );

    /*
     * Rare longer pause.
     */
    if (
      chance(
        CFG.longPauseProbability
      )
    ) {

      duration =
        rand(
          900,
          1800
        );
    }

    st.pauseUntil =
      now + duration;
  }
}


/* ============================================================
 * Next price
 * ============================================================ */

function nextPrice(
  st,
  now = Date.now(),
  over
) {

  normalizeState(st);

  const c =
    over
      ? { ...CFG, ...over }
      : CFG;

  /*
   * Pause.
   */
  if (
    st.pauseUntil &&
    now < st.pauseUntil
  ) {

    st.lastTimestamp = now;

    st.lastTick = {

      delta: 0,

      magnitude: 0,

      direction: 0,

      type: 'pause',

      speedRegime:
        st.speedRegime
    };

    return st.price;
  }

  /*
   * Pause finished.
   */
  if (
    st.pauseUntil &&
    now >= st.pauseUntil
  ) {

    st.pauseUntil = 0;
  }

  /*
   * Update state.
   */
  updateVolatility(st);

  updateSpeed(st);

  const sm =
    sessionMul(
      now,
      c.session
    );

  /*
   * ----------------------------------------------------------
   * RETRACE
   * ----------------------------------------------------------
   */

  if (st.retraceActive) {

    const remaining =
      st.retraceRemaining;

    /*
     * শেষ tick হলে exact remaining।
     */
    if (
      remaining <=
      st.price * 0.000001
    ) {

      st.retraceActive = false;

      st.retraceRemaining = 0;

      st.lastTick = {

        delta: 0,

        magnitude: 0,

        direction: 0,

        type: 'retrace-end',

        speedRegime:
          st.speedRegime
      };

      return st.price;
    }

    /*
     * Retrace tick size।
     *
     * Medium dominant.
     */
    let mag =
      mediumHeavy();

    mag *=
      st.vol *
      SPEED_REGIMES[
        st.speedRegime
      ].vol;

    /*
     * Don't make retrace glide.
     */
    const base =
      st.price *
      c.unit;

    let delta =
      st.retraceDir *
      base *
      mag;

    /*
     * Don't overshoot retrace target.
     */
    const absDelta =
      Math.min(
        Math.abs(delta),
        remaining
      );

    delta =
      Math.sign(delta) *
      absDelta;

    /*
     * Occasional tiny opposite tick.
     * খুব কম, যাতে shaking না হয়।
     */
    if (
      chance(0.055) &&
      Math.abs(
        st.momentum
      ) < 0.55
    ) {

      delta *= -0.35;
    }

    st.price += delta;

    st.retraceRemaining -=
      Math.abs(delta);

    st.momentum =
      st.momentum * 0.82 +
      st.retraceDir * 0.18;

    st.recentMove = delta;

    st.recentMagnitude =
      Math.abs(delta) /
      Math.max(base, 1e-12);

    st.candleHigh =
      Math.max(
        st.candleHigh,
        st.price
      );

    st.candleLow =
      Math.min(
        st.candleLow,
        st.price
      );

    st.candleTicks++;

    st.lastTimestamp = now;

    st.lastTick = {

      delta,

      magnitude:
        Math.abs(delta),

      direction:
        Math.sign(delta),

      type: 'retrace',

      speedRegime:
        st.speedRegime
    };

    return cleanPrice(
      st.price,
      st.decimals
    );
  }


  /*
   * ----------------------------------------------------------
   * RUN
   * ----------------------------------------------------------
   */

  if (st.runLeft <= 0) {

    /*
     * Run শেষ।
     *
     * Retrace বা নতুন run।
     */
    const didRetrace =
      maybeStartRetrace(st);

    if (!didRetrace) {

      startRun(
        st,
        c.forceDir
      );
    }
  }

  /*
   * Direction.
   */
  let direction;

  if (
    c.forceDir
  ) {

    direction =
      c.forceDir > 0
        ? 1
        : -1;

  } else {

    direction =
      chooseDirection(st);
  }

  st.dir = direction;

  /*
   * Base tick.
   */
  const base =
    st.price *
    c.unit *
    (st.tickScale || 1);

  /*
   * Magnitude.
   */
  const chosen =
    chooseMagnitude(
      st,
      sm
    );

  let magnitude =
    chosen.magnitude;

  let type =
    chosen.type;

  /*
   * ----------------------------------------------------------
   * RARE JUMP
   * ----------------------------------------------------------
   *
   * Rare এবং isolated.
   *
   * প্রতিটি tick-এ jump না।
   */
  if (
    chance(c.jumpProbability)
  ) {

    /*
     * Jump সাধারণত current direction-এ।
     */
    const jumpSize =
      rand(
        2.2,
        3.8
      );

    magnitude =
      Math.max(
        magnitude,
        jumpSize
      );

    type = 'jump';

    /*
     * Jump-এর পরে volatility temporarily বাড়ে।
     */
    st.vol =
      Math.min(
        2.4,
        st.vol * 1.12
      );

    st.momentum =
      st.momentum * 0.80 +
      direction * 0.25;
  }

  /*
   * Price delta.
   */
  let delta =
    direction *
    base *
    magnitude *
    st.vol;

  /*
   * ----------------------------------------------------------
   * OCCASIONAL MICRO-REVERSE
   * ----------------------------------------------------------
   *
   * একেবারে random shaking নয়।
   */
  if (
    chance(0.045) &&
    Math.abs(st.momentum) < 0.70
  ) {

    delta *= -0.35;

    type = 'micro-reverse';
  }

  /*
   * ----------------------------------------------------------
   * MOMENTUM
   * ----------------------------------------------------------
   */

  st.momentum =
    clamp(
      st.momentum * 0.84 +
      Math.sign(delta) * 0.16,
      -1,
      1
    );

  /*
   * ----------------------------------------------------------
   * ANCHOR
   * ----------------------------------------------------------
   *
   * শুধুমাত্র runaway simulator state ঠেকানোর জন্য।
   * Short-term direction targeting নয়।
   */
  if (
    st.referencePrice > 0
  ) {

    const diff =
      (
        st.referencePrice -
        st.price
      ) /
      st.referencePrice;

    if (
      Math.abs(diff) >
      c.anchorBand
    ) {

      const pull =
        diff *
        c.anchorStrength;

      delta +=
        st.price *
        pull;
    }
  }

  /*
   * Safety clamp.
   */
  const cap =
    st.price *
    c.maxStep;

  delta =
    clamp(
      delta,
      -cap,
      cap
    );

  /*
   * Apply.
   */
  st.price =
    Math.max(
      1e-8,
      st.price + delta
    );

  /*
   * Update run.
   */
  st.runLeft--;

  /*
   * Recent movement.
   */
  st.recentMove =
    delta;

  st.recentMagnitude =
    Math.abs(delta) /
    Math.max(base, 1e-12);

  /*
   * Candle.
   */
  st.candleHigh =
    Math.max(
      st.candleHigh,
      st.price
    );

  st.candleLow =
    Math.min(
      st.candleLow,
      st.price
    );

  st.candleTicks++;

  /*
   * Occasionally pause after active movement.
   */
  if (
    st.runLeft <= 0
  ) {

    maybePause(
      st,
      now
    );
  }

  /*
   * Metadata.
   */
  st.lastTimestamp =
    now;

  st.lastTick = {

    delta,

    magnitude:
      Math.abs(delta),

    direction:
      Math.sign(delta),

    type,

    speedRegime:
      st.speedRegime,

    volatility:
      st.vol,

    momentum:
      st.momentum
  };

  return cleanPrice(
    st.price,
    st.decimals
  );
}


/* ============================================================
 * Tick delay
 * ============================================================ */

function nextDelay(
  st,
  over,
  now = Date.now()
) {

  normalizeState(st);

  const c =
    over
      ? { ...CFG, ...over }
      : CFG;

  /*
   * Pause.
   */
  if (
    st.pauseUntil &&
    now < st.pauseUntil
  ) {

    return Math.max(
      80,
      Math.min(
        180,
        st.pauseUntil - now
      )
    );
  }

  /*
   * Base speed.
   */
  const regime =
    SPEED_REGIMES[
      st.speedRegime
    ] ||
    SPEED_REGIMES.normal;

  let gap =
    c.gapMs *
    regime.multiplier;

  /*
   * Volatility slightly changes speed.
   */
  gap *=
    clamp(
      1 /
      Math.sqrt(
        Math.max(
          st.vol,
          0.55
        )
      ),
      0.70,
      1.30
    );

  /*
   * Retrace speed.
   */
  if (
    st.retraceActive
  ) {

    gap *=
      rand(
        0.72,
        1.10
      );
  }

  /*
   * Run generally faster than rest.
   */
  if (
    st.runLeft > 0
  ) {

    gap *=
      rand(
        0.78,
        1.08
      );
  }

  /*
   * Burst = faster.
   */
  if (
    st.speedRegime === 'burst'
  ) {

    gap *=
      rand(
        0.82,
        1.02
      );
  }

  /*
   * Slow regime has less jitter.
   */
  const jitter =
    st.speedRegime === 'slow'
      ? 0.08
      : c.speedVariation;

  gap *=
    1 +
    rand(
      -jitter,
      jitter
    );

  /*
   * Very occasional quick tick.
   *
   * Not too frequent.
   */
  if (
    chance(0.055)
  ) {

    gap *=
      rand(
        0.55,
        0.75
      );
  }

  /*
   * Very occasional slow tick.
   */
  if (
    chance(0.025)
  ) {

    gap *=
      rand(
        1.35,
        1.80
      );
  }

  gap =
    clamp(
      gap,
      55,
      2200
    );

  st.lastDelay =
    gap;

  return Math.round(gap);
}


/* ============================================================
 * Candle helper
 * ============================================================ */

function getCandleState(st) {

  return {

    open:
      cleanPrice(
        st.candleOpen,
        st.decimals
      ),

    high:
      cleanPrice(
        st.candleHigh,
        st.decimals
      ),

    low:
      cleanPrice(
        st.candleLow,
        st.decimals
      ),

    close:
      cleanPrice(
        st.price,
        st.decimals
      ),

    ticks:
      st.candleTicks
  };
}


/*
 * Call this whenever a new candle starts.
 */
function resetCandle(
  st,
  open = st.price
) {

  st.candleOpen =
    Number(open);

  st.candleHigh =
    Number(open);

  st.candleLow =
    Number(open);

  st.candleTicks =
    0;
}


/* ============================================================
 * Clean price
 * ============================================================ */

function cleanPrice(
  price,
  decimals
) {

  return Number(
    Number(price)
      .toFixed(decimals)
  );
}


/* ============================================================
 * Debug information
 * ============================================================ */

function getTickInfo(st) {

  return {

    price:
      cleanPrice(
        st.price,
        st.decimals
      ),

    direction:
      st.dir,

    momentum:
      Number(
        st.momentum.toFixed(4)
      ),

    volatility:
      Number(
        st.vol.toFixed(4)
      ),

    speed:
      st.speed,

    speedRegime:
      st.speedRegime,

    speedRegimeLeft:
      st.speedRegimeLeft,

    runLeft:
      st.runLeft,

    retraceActive:
      st.retraceActive,

    retraceRemaining:
      st.retraceRemaining,

    pauseUntil:
      st.pauseUntil,

    lastDelay:
      st.lastDelay,

    lastTick:
      st.lastTick
  };
}


/* ============================================================
 * Exports
 * ============================================================ */

module.exports = {

  CFG,

  createState,

  nextPrice,

  nextDelay,

  sessionMul,

  resetCandle,

  getCandleState,

  getTickInfo,

  cleanPrice
};