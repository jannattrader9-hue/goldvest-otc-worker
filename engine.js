'use strict';

/**
 * engine.js — Fair Synthetic OTC Price Engine
 *
 * FIXED-SPEED VERSION
 *
 * ---------------------------------------------------------------
 * Tick timing
 * ---------------------------------------------------------------
 *
 * Every tick happens at exactly the same interval.
 *
 * Default:
 *
 *     500ms = 2 ticks / second
 *     120 ticks / minute
 *
 * No random speed.
 * No burst acceleration.
 * No random delay.
 *
 * ---------------------------------------------------------------
 * Fish-tail movement
 * ---------------------------------------------------------------
 *
 * The price moves forward while oscillating with a fixed-frequency
 * fish-tail pattern.
 *
 * Frequency and amplitude remain constant.
 *
 * ---------------------------------------------------------------
 * API
 * ---------------------------------------------------------------
 *
 * createState(price, decimals)
 * nextPrice(state, now, overrides)
 * nextDelay(state, overrides)
 * sessionMul(timestamp, amount)
 * CFG
 *
 * ---------------------------------------------------------------
 * IMPORTANT
 * ---------------------------------------------------------------
 *
 * This is a synthetic/fair price model.
 * It contains no payout targeting, trade-result targeting,
 * hidden win-rate targeting, or settlement manipulation.
 *
 */

const num = (v, d) =>
  (
    v === undefined ||
    v === '' ||
    isNaN(+v)
  )
    ? d
    : +v;


/* ================================================================
   CONFIG
================================================================ */

const CFG = {

  /*
   * Base price movement.
   */
  unit:
    num(
      process.env.ENG_UNIT,
      0.000018
    ),


  /*
   * Volatility memory.
   */
  volMem:
    num(
      process.env.ENG_VOL_MEM,
      0.994
    ),

  volAmp:
    num(
      process.env.ENG_VOL_AMP,
      0.28
    ),


  /*
   * Movement phases.
   */
  runLen:
    num(
      process.env.ENG_RUN_LEN,
      8
    ),

  restLen:
    num(
      process.env.ENG_REST_LEN,
      5
    ),


  /*
   * Retracement strength.
   */
  retr:
    num(
      process.env.ENG_RETR,
      0.40
    ),


  /*
   * Occasional large movement.
   */
  jump:
    num(
      process.env.ENG_JUMP,
      1.8
    ),


  /*
   * ============================================================
   * FIXED TICK SPEED
   * ============================================================
   *
   * 500ms:
   *
   * 2 ticks / second
   * 120 ticks / minute
   *
   * Change this ONE value if you want another fixed speed.
   */

  gapMs:
    num(
      process.env.ENG_GAP_MS,
      500
    ),


  /*
   * Session volatility.
   */
  session:
    num(
      process.env.ENG_SESSION,
      0.55
    ),


  /*
   * Maximum movement per tick.
   */
  maxStep:
    num(
      process.env.ENG_MAX_STEP,
      0.0015
    ),


  /*
   * ============================================================
   * FIXED FISH-TAIL SETTINGS
   * ============================================================
   *
   * These values DO NOT change randomly.
   */

  tailEnabled:
    String(
      process.env.ENG_TAIL_ENABLED ?? 'true'
    ) !== 'false',


  /*
   * Fixed oscillation frequency.
   */
  tailFreq:
    num(
      process.env.ENG_TAIL_FREQ,
      0.85
    ),


  /*
   * Fixed amplitude.
   */
  tailAmp:
    num(
      process.env.ENG_TAIL_AMP,
      0.65
    ),


  /*
   * Overall strength of tail.
   */
  tailStrength:
    num(
      process.env.ENG_TAIL_STRENGTH,
      0.85
    ),


  /*
   * Pause is also disabled by default.
   *
   * The clock NEVER stops.
   */
  pauseEnabled:
    String(
      process.env.ENG_PAUSE_ENABLED ?? 'false'
    ) === 'true',


  pauseChance:
    num(
      process.env.ENG_PAUSE_CHANCE,
      0.30
    ),


  pauseMinMs:
    num(
      process.env.ENG_PAUSE_MIN_MS,
      250
    ),


  pauseMaxMs:
    num(
      process.env.ENG_PAUSE_MAX_MS,
      800
    ),


  /*
   * Tiny natural movement during rest.
   */
  microMove:
    num(
      process.env.ENG_MICRO_MOVE,
      0.18
    )
};


/* ================================================================
   DECIMAL / PIP
================================================================ */

function _fitDecimals(price, given) {
  return given;
}


function _tickScale(price, decimals) {

  const step =
    Math.pow(
      10,
      -decimals
    );


  const want =
    price * 0.000012;


  if (
    want >=
    step * 0.9
  ) {

    return 1;
  }


  return Math.min(
    3,
    (
      step * 0.9
    ) /
    Math.max(
      want,
      1e-12
    )
  );
}


/* ================================================================
   CREATE STATE
================================================================ */

function createState(
  price,
  decimals = 5
) {

  return {

    price,

    decimals,

    tickScale:
      _tickScale(
        price,
        decimals
      ),


    /*
     * Volatility.
     */
    vol: 1,


    /*
     * Phase.
     */
    phase: 'run',

    left: 3,


    /*
     * Direction.
     */
    dir:
      Math.random() < 0.5
        ? 1
        : -1,


    /*
     * Excitement.
     */
    excite: 0,


    /*
     * Run information.
     */
    runStart:
      price,


    /*
     * Retracement.
     */
    retrTarget: 0,

    retrDone: 0,

    retrLeft0: 1,

    retrFast: false,


    /*
     * Local regime.
     */
    regimeDir:
      Math.random() < 0.5
        ? 1
        : -1,


    regimeLeft:
      200 +
      (
        Math.random() *
        500
      ) | 0,


    /*
     * Optional pause.
     */
    hardPauseUntil: 0,


    /*
     * ============================================================
     * FIXED FISH TAIL
     * ============================================================
     */

    tailPhase:
      Math.random() *
      Math.PI *
      2,


    /*
     * NEVER changes.
     */
    tailFreq:
      CFG.tailFreq,


    /*
     * NEVER changes.
     */
    tailAmp:
      CFG.tailAmp,


    /*
     * NEVER changes.
     */
    tailStrength:
      CFG.tailStrength,


    /*
     * Fixed clock reference.
     */
    lastNow:
      Date.now()
  };
}


/* ================================================================
   SESSION MULTIPLIER
================================================================ */

function sessionMul(
  t,
  amt
) {

  const d =
    new Date(t);


  const h =
    d.getUTCHours() +
    d.getUTCMinutes() /
    60;


  const curve =
    0.55 +

    0.75 *
    Math.exp(
      -Math.pow(
        (h - 13) /
        5.5,
        2
      )
    ) +

    0.35 *
    Math.exp(
      -Math.pow(
        (h - 8.5) /
        2.2,
        2
      )
    );


  return (
    1 +
    (
      curve - 1
    ) *
    amt
  );
}


/* ================================================================
   FIXED FISH TAIL
================================================================ */

function updateFishTail(
  st,
  now
) {

  if (
    !CFG.tailEnabled
  ) {

    return 0;
  }


  /*
   * ============================================================
   * FIXED TIME STEP
   * ============================================================
   *
   * The tail advances according to elapsed time.
   *
   * Frequency is fixed.
   *
   * There is NO random frequency change.
   */

  const previous =
    st.lastNow ||
    now;


  const dt =
    Math.max(
      0.001,
      (
        now -
        previous
      ) / 1000
    );


  st.lastNow =
    now;


  /*
   * Main fish-tail wave.
   */

  st.tailPhase +=
    2 *
    Math.PI *
    st.tailFreq *
    dt;


  /*
   * Keep phase small.
   */

  if (
    st.tailPhase >
    Math.PI * 2
  ) {

    st.tailPhase -=
      Math.PI * 2;
  }


  /*
   * ============================================================
   * MULTI-WAVE FISH TAIL
   * ============================================================
   *
   * Primary wave
   * Secondary wave
   * Body movement
   *
   * All frequencies are fixed.
   */

  const wave1 =
    Math.sin(
      st.tailPhase
    );


  const wave2 =
    Math.sin(
      st.tailPhase *
      2.07 +
      0.8
    ) *
    0.28;


  const wave3 =
    Math.sin(
      st.tailPhase *
      0.47 -
      1.2
    ) *
    0.12;


  const wave =
    (
      wave1 +
      wave2 +
      wave3
    ) *
    st.tailAmp;


  /*
   * Phase intensity.
   *
   * The speed remains fixed.
   * Only the contribution to price differs.
   */

  let phaseStrength;


  if (
    st.phase === 'run'
  ) {

    phaseStrength = 1.0;

  } else if (
    st.phase === 'retrace'
  ) {

    phaseStrength = 0.70;

  } else {

    phaseStrength = 0.12;
  }


  return (
    wave *
    phaseStrength *
    st.tailStrength
  );
}


/* ================================================================
   RANDOM RUN LENGTH
================================================================ */

function randomRunLength(c) {

  const u =
    Math.random();


  return Math.max(
    2,
    Math.round(
      c.runLen *
      Math.pow(
        u,
        -0.45
      ) *
      0.6
    )
  );
}


/* ================================================================
   START RUN
================================================================ */

function startRun(
  st,
  c
) {

  st.phase =
    'run';


  st.left =
    randomRunLength(c);


  st.dir =
    Math.random() < 0.5
      ? 1
      : -1;


  st.runStart =
    st.price;
}


/* ================================================================
   START REST
================================================================ */

function startRest(
  st,
  now,
  c
) {

  st.phase =
    'rest';


  st.left =
    1 +
    (
      Math.random() *
      (c.restLen + 1)
    ) | 0;


  /*
   * Pause disabled by default.
   *
   * Even if enabled, this does NOT affect
   * nextDelay(). The clock remains fixed.
   */

  if (
    c.pauseEnabled &&
    Math.random() <
    c.pauseChance
  ) {

    const duration =
      c.pauseMinMs +
      Math.random() *
      (
        c.pauseMaxMs -
        c.pauseMinMs
      );


    st.hardPauseUntil =
      now +
      duration;

  } else {

    st.hardPauseUntil =
      0;
  }
}


/* ================================================================
   START RETRACE
================================================================ */

function startRetrace(
  st,
  c
) {

  const moved =
    st.price -
    st.runStart;


  st.retrTarget =
    -moved *
    (
      c.retr *
      (
        0.55 +
        Math.random() *
        0.85
      )
    );


  st.retrDone =
    0;


  st.retrFast =
    Math.random() <
    0.5;


  st.retrLeft0 =
    st.retrFast
      ? 1 +
        (
          Math.random() *
          2
        ) | 0

      : 2 +
        (
          Math.random() *
          3
        ) | 0;


  st.left =
    st.retrLeft0;


  if (
    Math.abs(
      st.retrTarget
    ) >
    1e-12
  ) {

    st.phase =
      'retrace';

  } else {

    startRest(
      st,
      Date.now(),
      c
    );
  }
}


/* ================================================================
   PHASE UPDATE
================================================================ */

function updatePhase(
  st,
  now,
  c
) {

  /*
   * ------------------------------------------------------------
   * REST
   * ------------------------------------------------------------
   */

  if (
    st.phase === 'rest'
  ) {

    const restDone =
      !st.hardPauseUntil ||
      now >=
      st.hardPauseUntil;


    if (!restDone) {

      return;
    }


    st.hardPauseUntil =
      0;


    /*
     * Small chance of another rest.
     */

    if (
      Math.random() <
      0.08
    ) {

      st.left =
        1 +
        (
          Math.random() *
          3
        ) | 0;


      return;
    }


    startRun(
      st,
      c
    );


    return;
  }


  /*
   * ------------------------------------------------------------
   * RETRACE
   * ------------------------------------------------------------
   */

  if (
    st.phase === 'retrace'
  ) {

    st.left--;


    if (
      st.left > 0
    ) {

      return;
    }


    if (
      Math.random() <
      0.60
    ) {

      startRun(
        st,
        c
      );

    } else {

      startRest(
        st,
        now,
        c
      );
    }


    return;
  }


  /*
   * ------------------------------------------------------------
   * RUN
   * ------------------------------------------------------------
   */

  if (
    st.phase === 'run'
  ) {

    const earlyRetrace =
      st.left > 1 &&
      Math.random() <
      0.035;


    st.left--;


    if (
      earlyRetrace ||
      st.left <= 0
    ) {

      st.excite =
        Math.min(
          1,
          st.excite +
          0.55
        );


      const moved =
        st.price -
        st.runStart;


      const movedPct =
        Math.min(
          1,
          Math.abs(moved) /
          Math.max(
            st.price *
            0.003,
            1e-12
          )
        );


      const retraceProbability =
        0.25 +
        movedPct *
        0.35;


      if (
        Math.random() <
        retraceProbability &&
        c.retr > 0
      ) {

        startRetrace(
          st,
          c
        );

      } else {

        startRest(
          st,
          now,
          c
        );
      }
    }
  }
}


/* ================================================================
   NEXT PRICE
================================================================ */

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
   * Volatility memory.
   */

  const shock =
    (
      Math.random() -
      0.5
    ) *
    c.volAmp;


  st.vol =
    st.vol *
    c.volMem +

    (
      1 -
      c.volMem
    ) *
    (
      1 +
      shock *
      3
    );


  st.vol =
    Math.max(
      0.25,
      Math.min(
        4.5,
        st.vol
      )
    );


  /*
   * Excitement decay.
   */

  st.excite *=
    0.93;


  /*
   * Phase.
   */

  updatePhase(
    st,
    now,
    c
  );


  /*
   * Fixed fish-tail.
   */

  const tailWave =
    updateFishTail(
      st,
      now
    );


  /*
   * Base price movement.
   */

  const base =
    st.price *
    c.unit *
    (st.tickScale || 1);


  /*
   * Session factor.
   */

  const sm =
    sessionMul(
      now,
      c.session
    );


  let delta =
    0;


  /* ==============================================================
     PAUSE
  ============================================================== */

  if (
    st.hardPauseUntil &&
    now <
    st.hardPauseUntil
  ) {

    /*
     * Clock is still fixed.
     *
     * Price may remain unchanged.
     */

    if (
      Math.random() <
      c.microMove
    ) {

      const pip =
        Math.pow(
          10,
          -st.decimals
        );


      const micro =
        (
          Math.random() <
          0.5
            ? -1
            : 1
        ) *
        pip;


      st.price =
        Number(
          (
            st.price +
            micro
          ).toFixed(
            st.decimals
          )
        );

    } else {

      st.price =
        Number(
          st.price.toFixed(
            st.decimals
          )
        );
    }


    return st.price;
  }


  /* ==============================================================
     RETRACE
  ============================================================== */

  if (
    st.phase === 'retrace'
  ) {

    const remain =
      st.retrTarget -
      st.retrDone;


    if (
      st.left <= 1 ||
      Math.sign(remain) === 0
    ) {

      delta =
        remain;

    } else {

      const retrDir =
        Math.sign(
          st.retrTarget
        );


      const r =
        Math.random();


      let mag;


      if (
        r < 0.25
      ) {

        mag =
          0.05 +
          Math.random() *
          0.25;

      } else if (
        r < 0.85
      ) {

        mag =
          0.30 +
          Math.pow(
            Math.random(),
            -0.35
          ) *
          0.60;

      } else {

        mag =
          1.5 +
          Math.pow(
            Math.random(),
            -0.50
          ) *
          2;
      }


      const reverse =
        Math.random() <
        0.18;


      const direction =
        reverse
          ? -retrDir
          : retrDir;


      delta =
        direction *
        base *
        Math.min(
          4,
          mag
        ) *
        st.vol;


      /*
       * Fixed fish-tail.
       */

      delta +=
        base *
        tailWave *
        st.vol *
        sm *
        0.65;


      /*
       * Target guard.
       */

      if (
        Math.abs(
          st.retrDone +
          delta
        ) >
        Math.abs(
          st.retrTarget
        )
      ) {

        delta =
          remain;
      }
    }


    st.retrDone +=
      delta;
  }


  /* ==============================================================
     REST
  ============================================================== */

  else if (
    st.phase === 'rest'
  ) {

    /*
     * Small breathing movement.
     */

    delta =
      base *
      tailWave *
      0.12 *
      sm;
  }


  /* ==============================================================
     RUN
  ============================================================== */

  else {

    const r =
      Math.random();


    let mag;


    if (
      r < 0.25
    ) {

      mag =
        0.05 +
        Math.random() *
        0.25;

    } else if (
      r < 0.85
    ) {

      mag =
        0.30 +
        Math.pow(
          Math.random(),
          -0.35
        ) *
        0.60;

    } else {

      mag =
        1.5 +
        Math.pow(
          Math.random(),
          -0.50
        ) *
        2;
    }


    /*
     * Natural directional persistence.
     */

    const reverseProbability =
      0.12 +
      st.excite *
      0.18 +
      Math.random() *
      0.10;


    const direction =
      Math.random() <
      reverseProbability
        ? -st.dir
        : st.dir;


    delta =
      direction *
      base *
      Math.min(
        8,
        mag
      ) *
      st.vol *
      sm;


    /*
     * ==========================================================
     * FISH TAIL
     * ==========================================================
     */

    delta +=
      base *
      tailWave *
      st.vol *
      sm;


    /*
     * Minimum visible movement.
     */

    const minPip =
      Math.pow(
        10,
        -st.decimals
      ) *
      2;


    if (
      delta !== 0 &&
      Math.abs(delta) <
      minPip
    ) {

      delta =
        Math.sign(delta) *
        minPip;
    }
  }


  /* ==============================================================
     HEAVY TAIL
  ============================================================== */

  if (
    st.phase !== 'rest' &&
    Math.random() * 100 <
    c.jump
  ) {

    const mag =
      base *
      (
        4 +
        Math.pow(
          Math.random(),
          -0.5
        ) *
        3
      ) *
      st.vol;


    delta +=
      (
        Math.random() <
        0.5
          ? -1
          : 1
      ) *
      mag;


    st.excite =
      Math.min(
        1,
        st.excite +
        0.7
      );


    st.vol =
      Math.min(
        4.5,
        st.vol *
        1.25
      );
  }


  /* ==============================================================
     REGIME
  ============================================================== */

  if (
    --st.regimeLeft <= 0
  ) {

    st.regimeDir =
      Math.random() <
      0.5
        ? 1
        : -1;


    st.regimeLeft =
      200 +
      (
        Math.random() *
        500
      ) | 0;
  }


  /*
   * Small natural regime drift.
   */

  delta +=
    st.regimeDir *
    base *
    0.008 *
    sm;


  /* ==============================================================
     SAFETY CLAMP
  ============================================================== */

  const cap =
    st.price *
    c.maxStep;


  delta =
    Math.max(
      -cap,
      Math.min(
        cap,
        delta
      )
    );


  /*
   * Apply.
   */

  st.price =
    Math.max(
      st.price +
      delta,
      1e-8
    );


  /*
   * Exact market decimals.
   */

  st.price =
    Number(
      st.price.toFixed(
        st.decimals
      )
    );


  return st.price;
}


/* ================================================================
   FIXED NEXT DELAY
================================================================ */

/**
 * IMPORTANT:
 *
 * This function NEVER generates a random delay.
 *
 * If gapMs = 500:
 *
 * 500ms
 * 500ms
 * 500ms
 * 500ms
 * ...
 *
 * forever.
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


  /*
   * Fixed speed.
   */

  return Math.max(
    1,
    Math.round(
      c.gapMs
    )
  );
}


/* ================================================================
   EXPORT
================================================================ */

module.exports = {
  createState,
  nextPrice,
  nextDelay,
  sessionMul,
  CFG
};