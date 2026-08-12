'use strict';

/**
 * engine.js
 * ------------------------------------------------------------
 * FIXED-SPEED VISUAL MARKET SIMULATOR
 *
 * Demo / paper-trading / chart-animation use only.
 *
 * Behaviour:
 *   - Fixed tick interval
 *   - Fixed movement speed in every phase
 *   - Fixed fish-tail frequency
 *   - Fixed fish-tail amplitude
 *   - No random acceleration/deceleration
 *   - Occasional visual pause: 0.5s–3.0s
 *   - Decimal-aware visible minimum movement
 *
 * IMPORTANT:
 * This module must not be used as a real-money settlement,
 * payout, or trade-outcome engine.
 * ------------------------------------------------------------
 */

const num = (v, d) =>
  v === undefined ||
  v === '' ||
  Number.isNaN(Number(v))
    ? d
    : Number(v);


/* ============================================================
   CONFIG
============================================================ */

const CFG = {

  /* ----------------------------------------------------------
     FIXED CLOCK
     ---------------------------------------------------------- */

  // 500ms = 2 ticks/sec = 120 ticks/min
  gapMs: num(
    process.env.ENG_GAP_MS,
    500
  ),


  /* ----------------------------------------------------------
     FIXED MOVEMENT
     ---------------------------------------------------------- */

  // Base movement relative to price.
  unit: num(
    process.env.ENG_UNIT,
    0.000018
  ),

  // Fixed movement multiplier.
  movementSpeed: num(
    process.env.ENG_MOVEMENT_SPEED,
    1.0
  ),


  /* ----------------------------------------------------------
     VISIBLE MOVEMENT
     ---------------------------------------------------------- */

  // Minimum visible movement in pips.
  minVisiblePips: num(
    process.env.ENG_MIN_VISIBLE_PIPS,
    1
  ),


  /* ----------------------------------------------------------
     FISH TAIL
     ---------------------------------------------------------- */

  tailEnabled:
    String(
      process.env.ENG_TAIL_ENABLED ?? 'true'
    ) !== 'false',

  // NEVER changes during runtime.
  tailFreq: num(
    process.env.ENG_TAIL_FREQ,
    0.85
  ),

  // NEVER changes during runtime.
  tailAmp: num(
    process.env.ENG_TAIL_AMP,
    0.65
  ),

  // Fixed contribution of the fish motion.
  tailStrength: num(
    process.env.ENG_TAIL_STRENGTH,
    0.35
  ),


  /* ----------------------------------------------------------
     VISUAL PAUSE
     ---------------------------------------------------------- */

  pauseEnabled:
    String(
      process.env.ENG_PAUSE_ENABLED ?? 'true'
    ) === 'true',

  // Probability checked only after a normal movement cycle.
  pauseChance: num(
    process.env.ENG_PAUSE_CHANCE,
    0.08
  ),

  // Never below this.
  pauseMinMs: num(
    process.env.ENG_PAUSE_MIN_MS,
    500
  ),

  // Never above this.
  pauseMaxMs: num(
    process.env.ENG_PAUSE_MAX_MS,
    3000
  ),


  /* ----------------------------------------------------------
     NATURAL DIRECTION
     ---------------------------------------------------------- */

  // Direction can change, but SPEED does not.
  directionChangeChance: num(
    process.env.ENG_DIRECTION_CHANGE_CHANCE,
    0.18
  ),


  /* ----------------------------------------------------------
     SAFETY
     ---------------------------------------------------------- */

  maxStepPercent: num(
    process.env.ENG_MAX_STEP,
    0.0015
  )
};


/* ============================================================
   DECIMAL HELPERS
============================================================ */

function pipSize(decimals) {
  return Math.pow(
    10,
    -decimals
  );
}


function roundPrice(
  price,
  decimals
) {
  return Number(
    Number(price).toFixed(
      decimals
    )
  );
}


/*
 * Determine a movement large enough to be visible at the
 * instrument's displayed precision.
 */
function visibleMinimum(
  price,
  decimals
) {

  const pip =
    pipSize(decimals);

  const configured =
    pip *
    Math.max(
      1,
      CFG.minVisiblePips
    );

  /*
   * Never allow the minimum to exceed the engine's normal
   * movement by an absurd amount.
   */
  const natural =
    Math.abs(
      price *
      CFG.unit
    );


  return Math.max(
    configured,
    natural
  );
}


/* ============================================================
   FISH TAIL
============================================================ */

function fishTail(
  st,
  now
) {

  if (
    !st.tailEnabled
  ) {
    return 0;
  }


  /*
   * Fixed elapsed-time calculation.
   *
   * Frequency is constant.
   * Amplitude is constant.
   */
  const dt =
    Math.max(
      0.001,
      (now - st.lastNow) /
      1000
    );


  st.tailPhase +=
    2 *
    Math.PI *
    st.tailFreq *
    dt;


  /*
   * Keep phase bounded.
   */
  if (
    st.tailPhase >
    Math.PI * 2
  ) {
    st.tailPhase -=
      Math.PI * 2;
  }


  /*
   * Main tail.
   */
  const main =
    Math.sin(
      st.tailPhase
    );


  /*
   * Smaller secondary wave.
   *
   * Its frequency is also FIXED.
   */
  const secondary =
    Math.sin(
      st.tailPhase * 2.0 +
      0.8
    ) *
    0.20;


  return (
    main +
    secondary
  ) *
  st.tailAmp *
  st.tailStrength;
}


/* ============================================================
   STATE
============================================================ */

function createState(
  price,
  decimals = 5
) {

  return {

    price:
      roundPrice(
        price,
        decimals
      ),

    decimals,


    /*
     * Current direction.
     *
     * Direction can change.
     * Speed cannot.
     */
    direction:
      Math.random() < 0.5
        ? 1
        : -1,


    /*
     * Fish-tail phase.
     */
    tailPhase:
      Math.random() *
      Math.PI *
      2,


    /*
     * Copy fixed configuration into state.
     *
     * These are never randomized later.
     */
    tailFreq:
      CFG.tailFreq,

    tailAmp:
      CFG.tailAmp,

    tailStrength:
      CFG.tailStrength,

    tailEnabled:
      CFG.tailEnabled,


    /*
     * Pause.
     */
    pauseUntil: 0,


    /*
     * Fixed clock.
     */
    lastNow:
      Date.now(),


    /*
     * Number of ticks.
     */
    tickCount: 0
  };
}


/* ============================================================
   START VISUAL PAUSE
============================================================ */

function startPause(
  st,
  now,
  c
) {

  if (
    !c.pauseEnabled
  ) {

    st.pauseUntil = 0;
    return;
  }


  /*
   * Random pause occurrence.
   *
   * The pause itself is random.
   * Movement speed is NOT random.
   */
  if (
    Math.random() >=
    c.pauseChance
  ) {

    st.pauseUntil = 0;
    return;
  }


  const min =
    Math.max(
      0,
      c.pauseMinMs
    );


  const max =
    Math.max(
      min,
      Math.min(
        c.pauseMaxMs,
        3000
      )
    );


  const duration =
    min +
    Math.random() *
    (
      max - min
    );


  st.pauseUntil =
    now +
    duration;
}


/* ============================================================
   NEXT PRICE
============================================================ */

function nextPrice(
  st,
  now = Date.now(),
  over
) {

  const c =
    over
      ? {
          ...CFG,
          ...over
        }
      : CFG;


  /*
   * Keep pause duration hard-limited to 3 seconds.
   */
  c.pauseMaxMs =
    Math.min(
      c.pauseMaxMs,
      3000
    );


  /*
   * Time since previous tick.
   */
  const dt =
    Math.max(
      0.001,
      (now - st.lastNow) /
      1000
    );


  st.lastNow =
    now;


  st.tickCount++;


  /* ----------------------------------------------------------
     PAUSE
  ---------------------------------------------------------- */

  if (
    st.pauseUntil &&
    now <
    st.pauseUntil
  ) {

    /*
     * Completely visual pause.
     *
     * No price movement.
     */
    return st.price;
  }


  /*
   * Pause has ended.
   */
  if (
    st.pauseUntil
  ) {

    st.pauseUntil = 0;
  }


  /* ----------------------------------------------------------
     FIXED BASE STEP
  ---------------------------------------------------------- */

  const base =
    st.price *
    c.unit *
    c.movementSpeed;


  /*
   * Fish-tail.
   */
  const tail =
    fishTail(
      st,
      now
    );


  /*
   * Fixed-speed movement.
   *
   * Direction may be positive/negative.
   * Magnitude remains based on the same fixed speed.
   */
  let delta =
    st.direction *
    base;


  /*
   * Fish-tail modifies the path shape,
   * NOT the clock speed.
   */
  delta +=
    base *
    tail;


  /* ----------------------------------------------------------
     VISIBLE MINIMUM
  ---------------------------------------------------------- */

  const minimum =
    visibleMinimum(
      st.price,
      st.decimals
    );


  if (
    Math.abs(delta) <
    minimum
  ) {

    delta =
      Math.sign(
        delta ||
        st.direction
      ) *
      minimum;
  }


  /* ----------------------------------------------------------
     MAXIMUM STEP SAFETY
  ---------------------------------------------------------- */

  const maximum =
    Math.abs(
      st.price *
      c.maxStepPercent
    );


  if (
    Math.abs(delta) >
    maximum
  ) {

    delta =
      Math.sign(delta) *
      maximum;
  }


  /* ----------------------------------------------------------
     APPLY PRICE
  ---------------------------------------------------------- */

  st.price =
    Math.max(
      1e-8,
      st.price +
      delta
    );


  st.price =
    roundPrice(
      st.price,
      st.decimals
    );


  /* ----------------------------------------------------------
     DIRECTION CHANGE
  ---------------------------------------------------------- */

  /*
   * Direction may change between ticks.
   *
   * This does NOT change movement speed.
   */
  if (
    Math.random() <
    c.directionChangeChance
  ) {

    st.direction *= -1;
  }


  /* ----------------------------------------------------------
     RANDOM PAUSE
  ---------------------------------------------------------- */

  /*
   * A pause can start only after a completed movement.
   *
   * Duration:
   *   500ms–3000ms by default.
   */
  startPause(
    st,
    now,
    c
  );


  return st.price;
}


/* ============================================================
   NEXT DELAY
============================================================ */

/**
 * FIXED SPEED.
 *
 * This is intentionally NOT random.
 *
 * If gapMs = 500:
 *
 *   500
 *   500
 *   500
 *   500
 *   ...
 *
 * The same interval is returned for every tick,
 * regardless of direction or phase.
 */

function nextDelay(
  st,
  over
) {

  const c =
    over
      ? {
          ...CFG,
          ...over
        }
      : CFG;


  return Math.max(
    1,
    Math.round(
      c.gapMs
    )
  );
}


/* ============================================================
   PAUSE STATUS
============================================================ */

function isPaused(
  st,
  now = Date.now()
) {

  return Boolean(
    st.pauseUntil &&
    now <
    st.pauseUntil
  );
}


/* ============================================================
   REMAINING PAUSE
============================================================ */

function pauseRemaining(
  st,
  now = Date.now()
) {

  if (
    !isPaused(
      st,
      now
    )
  ) {

    return 0;
  }


  return Math.max(
    0,
    st.pauseUntil -
    now
  );
}


/* ============================================================
   EXPORT
============================================================ */

module.exports = {

  createState,

  nextPrice,

  nextDelay,

  isPaused,

  pauseRemaining,

  fishTail,

  CFG
};