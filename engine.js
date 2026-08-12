'use strict';

/**
 * engine.js — Fair Synthetic OTC Price Engine
 *
 * Features:
 *   1. Volatility memory / clustering
 *   2. Fish-tail rhythmic movement
 *   3. Persistent speed state
 *   4. Run / retrace / rest phases
 *   5. Heavy-tail price jumps
 *   6. Session-based volatility
 *   7. Pip-aware rounding
 *   8. Natural micro movement
 *
 * IMPORTANT:
 *   - No trade-direction manipulation
 *   - No payout targeting
 *   - No hidden win-rate targeting
 *   - No settlement-specific bias
 *
 * API:
 *   createState(price, decimals)
 *   nextPrice(state, now, overrides)
 *   nextDelay(state, overrides)
 *   sessionMul(timestamp, amount)
 *   CFG
 */

const num = (v, d) =>
  (v === undefined || v === '' || isNaN(+v)) ? d : +v;


/* ================================================================
   CONFIG
================================================================ */

const CFG = {

  // Base movement relative to current price
  unit: num(process.env.ENG_UNIT, 0.000018),

  // Volatility memory
  volMem: num(process.env.ENG_VOL_MEM, 0.994),
  volAmp: num(process.env.ENG_VOL_AMP, 0.28),

  // Movement phases
  runLen: num(process.env.ENG_RUN_LEN, 8),
  restLen: num(process.env.ENG_REST_LEN, 5),

  // Retracement
  retr: num(process.env.ENG_RETR, 0.40),

  // Large jump probability (%)
  jump: num(process.env.ENG_JUMP, 1.8),

  // Tick timing
  gapMs: num(process.env.ENG_GAP_MS, 500),
  spdVar: num(process.env.ENG_SPD_VAR, 0.72),

  // Session volatility
  session: num(process.env.ENG_SESSION, 0.55),

  // Maximum single-tick movement
  maxStep: num(process.env.ENG_MAX_STEP, 0.0015),

  // Fish-tail settings
  tailEnabled:
    String(process.env.ENG_TAIL_ENABLED ?? 'true') !== 'false',

  tailAmpMin:
    num(process.env.ENG_TAIL_AMP_MIN, 0.20),

  tailAmpMax:
    num(process.env.ENG_TAIL_AMP_MAX, 1.00),

  tailFreqMin:
    num(process.env.ENG_TAIL_FREQ_MIN, 0.55),

  tailFreqMax:
    num(process.env.ENG_TAIL_FREQ_MAX, 1.40),

  tailStrength:
    num(process.env.ENG_TAIL_STRENGTH, 0.85),

  // Visible pause
  pauseChance:
    num(process.env.ENG_PAUSE_CHANCE, 0.30),

  pauseMinMs:
    num(process.env.ENG_PAUSE_MIN_MS, 250),

  pauseMaxMs:
    num(process.env.ENG_PAUSE_MAX_MS, 800),

  // Natural micro movement
  microMove:
    num(process.env.ENG_MICRO_MOVE, 0.18),
};


/* ================================================================
   DECIMAL / PIP HELPERS
================================================================ */

function _fitDecimals(price, given) {
  return given;
}


function _tickScale(price, decimals) {

  const step = Math.pow(10, -decimals);

  const want = price * 0.000012;

  if (want >= step * 0.9) {
    return 1;
  }

  return Math.min(
    3,
    (step * 0.9) / Math.max(want, 1e-12)
  );
}


/* ================================================================
   STATE
================================================================ */

function createState(price, decimals = 5) {

  return {

    price,
    decimals,

    tickScale:
      _tickScale(price, decimals),

    // Volatility
    vol: 1,

    // Phase
    phase: 'rest',
    left: 3,

    // Natural directional momentum
    dir: Math.random() < 0.5 ? 1 : -1,

    // Excitement / momentum
    excite: 0,

    // Retracement
    runStart: price,
    retrTarget: 0,
    retrDone: 0,
    retrLeft0: 1,
    retrFast: false,

    // Long-term local regime
    regimeDir:
      Math.random() < 0.5 ? 1 : -1,

    regimeLeft:
      200 + ((Math.random() * 500) | 0),

    // Pause
    hardPauseUntil: 0,

    // Persistent speed
    speed: 1,

    // ============================================================
    // FISH TAIL STATE
    // ============================================================

    tailPhase:
      Math.random() * Math.PI * 2,

    tailFreq:
      CFG.tailFreqMin +
      Math.random() *
      (CFG.tailFreqMax - CFG.tailFreqMin),

    tailAmp:
      CFG.tailAmpMin +
      Math.random() *
      (CFG.tailAmpMax - CFG.tailAmpMin),

    tailTargetAmp:
      CFG.tailAmpMin +
      Math.random() *
      (CFG.tailAmpMax - CFG.tailAmpMin),

    tailStrength: 0,

    lastNow: Date.now(),
  };
}


/* ================================================================
   SESSION VOLATILITY
================================================================ */

function sessionMul(t, amt) {

  const d = new Date(t);

  const h =
    d.getUTCHours() +
    d.getUTCMinutes() / 60;

  const curve =
    0.55 +

    0.75 *
    Math.exp(
      -Math.pow((h - 13) / 5.5, 2)
    ) +

    0.35 *
    Math.exp(
      -Math.pow((h - 8.5) / 2.2, 2)
    );

  return 1 + (curve - 1) * amt;
}


/* ================================================================
   FISH TAIL
================================================================ */

function updateFishTail(st, now) {

  if (!CFG.tailEnabled) {
    st.tailStrength = 0;
    return 0;
  }

  const previous =
    st.lastNow || now;

  const dt =
    Math.max(
      0.01,
      Math.min(
        0.5,
        (now - previous) / 1000
      )
    );

  st.lastNow = now;


  /*
   * Slowly change amplitude.
   *
   * This prevents:
   *
   *     strong
   *     weak
   *     strong
   *     weak
   *
   * on every single tick.
   */

  if (Math.random() < 0.035) {

    st.tailTargetAmp =
      CFG.tailAmpMin +
      Math.random() *
      (CFG.tailAmpMax - CFG.tailAmpMin);
  }


  st.tailAmp +=
    (
      st.tailTargetAmp -
      st.tailAmp
    ) *
    Math.min(
      1,
      dt * 1.8
    );


  /*
   * Frequency changes slowly too.
   */

  if (Math.random() < 0.025) {

    st.tailFreq =
      CFG.tailFreqMin +
      Math.random() *
      (
        CFG.tailFreqMax -
        CFG.tailFreqMin
      );
  }


  /*
   * Main phase.
   */

  st.tailPhase +=
    2 *
    Math.PI *
    st.tailFreq *
    dt;


  if (st.tailPhase > Math.PI * 2) {

    st.tailPhase -=
      Math.PI * 2;
  }


  /*
   * Three waves combined.
   *
   * wave1 = primary tail
   * wave2 = asymmetric secondary motion
   * wave3 = slow body drift
   */

  const wave1 =
    Math.sin(st.tailPhase);

  const wave2 =
    Math.sin(
      st.tailPhase * 2.07 +
      0.8
    ) * 0.28;

  const wave3 =
    Math.sin(
      st.tailPhase * 0.47 -
      1.2
    ) * 0.12;


  const wave =
    (
      wave1 +
      wave2 +
      wave3
    ) *
    st.tailAmp;


  /*
   * Different phase = different tail intensity.
   */

  const desiredStrength =
    st.phase === 'run'
      ? 1.0
      : st.phase === 'retrace'
        ? 0.70
        : 0.12;


  st.tailStrength +=
    (
      desiredStrength -
      st.tailStrength
    ) *
    Math.min(
      1,
      dt * 3
    );


  return (
    wave *
    st.tailStrength *
    CFG.tailStrength
  );
}


/* ================================================================
   RANDOM RUN LENGTH
================================================================ */

function randomRunLength(c) {

  const u = Math.random();

  return Math.max(
    2,
    Math.round(
      c.runLen *
      Math.pow(u, -0.45) *
      0.6
    )
  );
}


/* ================================================================
   START NEW RUN
================================================================ */

function startRun(st, c) {

  st.phase = 'run';

  st.left =
    randomRunLength(c);

  /*
   * Natural local direction.
   *
   * This is not connected to any trade.
   */

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

function startRest(st, now, c) {

  st.phase = 'rest';

  st.left =
    1 +
    ((Math.random() *
      (c.restLen + 1)) | 0);


  if (
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
      now + duration;

  } else {

    st.hardPauseUntil = 0;
  }
}


/* ================================================================
   RETRACE SETUP
================================================================ */

function startRetrace(st, c) {

  const moved =
    st.price -
    st.runStart;

  /*
   * Retracement is based on actual movement.
   * It does not know anything about trades.
   */

  st.retrTarget =
    -moved *
    (
      c.retr *
      (
        0.55 +
        Math.random() * 0.85
      )
    );


  st.retrDone = 0;


  st.retrFast =
    Math.random() < 0.5;


  st.retrLeft0 =
    st.retrFast
      ? 1 + ((Math.random() * 2) | 0)
      : 2 + ((Math.random() * 3) | 0);


  st.left =
    st.retrLeft0;


  if (
    Math.abs(st.retrTarget) >
    1e-12
  ) {

    st.phase = 'retrace';

  } else {

    startRest(st, Date.now(), c);
  }
}


/* ================================================================
   PHASE TRANSITIONS
================================================================ */

function updatePhase(st, now, c) {

  /*
   * REST
   */

  if (st.phase === 'rest') {

    const restDone =
      !st.hardPauseUntil ||
      now >= st.hardPauseUntil;

    if (!restDone) {
      return;
    }

    st.hardPauseUntil = 0;


    /*
     * Sometimes extend the rest.
     */

    if (Math.random() < 0.08) {

      st.left =
        1 +
        ((Math.random() * 3) | 0);

      return;
    }


    startRun(st, c);

    return;
  }


  /*
   * RETRACE
   */

  if (st.phase === 'retrace') {

    if (--st.left > 0) {
      return;
    }


    /*
     * Sometimes immediately continue into
     * another run. Sometimes breathe first.
     */

    if (Math.random() < 0.60) {

      startRun(st, c);

    } else {

      startRest(st, now, c);
    }

    return;
  }


  /*
   * RUN
   */

  if (st.phase === 'run') {

    /*
     * Small probability of early retracement.
     */

    const earlyRetrace =
      st.left > 1 &&
      Math.random() < 0.035;


    if (
      earlyRetrace ||
      --st.left <= 0
    ) {

      st.excite =
        Math.min(
          1,
          st.excite + 0.55
        );


      /*
       * Not every run must retrace.
       */

      const moved =
        st.price -
        st.runStart;

      const movedPct =
        Math.min(
          1,
          Math.abs(moved) /
          Math.max(
            st.price * 0.003,
            1e-12
          )
        );


      const retraceProbability =
        0.25 +
        movedPct * 0.35;


      if (
        Math.random() <
        retraceProbability &&
        c.retr > 0
      ) {

        startRetrace(st, c);

      } else {

        startRest(st, now, c);
      }
    }
  }
}


/* ================================================================
   MAIN PRICE FUNCTION
================================================================ */

function nextPrice(
  st,
  now = Date.now(),
  over
) {

  const c =
    over
      ? { ...CFG, ...over }
      : CFG;


  /*
   * --------------------------------------------------------------
   * VOLATILITY MEMORY
   * --------------------------------------------------------------
   */

  const shock =
    (
      Math.random() -
      0.5
    ) *
    c.volAmp;


  st.vol =
    st.vol * c.volMem +
    (
      1 -
      c.volMem
    ) *
    (
      1 +
      shock * 3
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
   * Excitement decays.
   */

  st.excite *= 0.93;


  /*
   * Update phase.
   */

  updatePhase(
    st,
    now,
    c
  );


  /*
   * Fish-tail wave.
   */

  const tailWave =
    updateFishTail(
      st,
      now
    );


  /*
   * Base tick size.
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


  let delta = 0;


  /* ==============================================================
     HARD PAUSE
  ============================================================== */

  if (
    st.hardPauseUntil &&
    now < st.hardPauseUntil
  ) {

    /*
     * Most pause ticks are static.
     * Some contain tiny natural movement.
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
          Math.random() < 0.5
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


      if (r < 0.25) {

        mag =
          0.05 +
          Math.random() *
          0.25;

      } else if (r < 0.85) {

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
       * Small amount of counter movement.
       */

      const reverse =
        Math.random() < 0.18;


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
       * Fish-tail component.
       */

      delta +=
        base *
        tailWave *
        0.65;


      /*
       * Do not overshoot retracement target.
       */

      if (
        Math.abs(
          (
            st.retrDone ||
            0
          ) +
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


    st.retrDone =
      (
        st.retrDone ||
        0
      ) +
      delta;
  }


  /* ==============================================================
     REST
  ============================================================== */

  else if (
    st.phase === 'rest'
  ) {

    /*
     * Very small breathing movement.
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


    /*
     * Very small
     */

    if (r < 0.25) {

      mag =
        0.05 +
        Math.random() *
        0.25;

    }

    /*
     * Normal
     */

    else if (r < 0.85) {

      mag =
        0.30 +
        Math.pow(
          Math.random(),
          -0.35
        ) *
        0.60;

    }

    /*
     * Larger movement
     */

    else {

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
      st.excite * 0.18 +
      Math.random() * 0.10;


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
     * ============================================================
     * FISH TAIL
     * ============================================================
     *
     * Main directional movement remains intact.
     * Tail produces lateral oscillation around it.
     */

    delta +=
      base *
      tailWave *
      st.vol *
      sm;


    /*
     * Minimum visible pip.
     */

    const minPip =
      Math.pow(
        10,
        -st.decimals
      ) * 2;


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
     HEAVY-TAIL JUMP
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
        Math.random() < 0.5
          ? -1
          : 1
      ) *
      mag;


    st.excite =
      Math.min(
        1,
        st.excite + 0.7
      );


    st.vol =
      Math.min(
        4.5,
        st.vol * 1.25
      );
  }


  /* ==============================================================
     REGIME
  ============================================================== */

  if (--st.regimeLeft <= 0) {

    st.regimeDir =
      Math.random() < 0.5
        ? 1
        : -1;


    st.regimeLeft =
      200 +
      ((Math.random() * 500) | 0);
  }


  /*
   * Small natural directional drift from the current regime.
   *
   * This is a market model characteristic, not a trade-direction
   * control.
   */

  const regimeDrift =
    st.regimeDir *
    base *
    0.008 *
    sm;


  delta +=
    regimeDrift;


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
   * Apply price.
   */

  st.price =
    Math.max(
      st.price + delta,
      1e-8
    );


  /*
   * Clean decimal representation.
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
   NEXT TICK DELAY
================================================================ */

function nextDelay(
  st,
  over
) {

  const c =
    over
      ? { ...CFG, ...over }
      : CFG;


  /*
   * Pause polling.
   */

  if (
    st.hardPauseUntil &&
    Date.now() <
    st.hardPauseUntil
  ) {

    return 150;
  }


  let g =
    c.gapMs;


  /*
   * Persistent speed.
   *
   * This creates:
   *
   * slow
   *   ↓
   * medium
   *   ↓
   * fast
   *   ↓
   * burst
   *   ↓
   * slow
   */

  const sr =
    Math.random();


  if (sr < 0.08) {

    st.speed *= 0.72;

  } else if (sr < 0.16) {

    st.speed *= 1.28;

  } else {

    st.speed *=
      0.94 +
      Math.random() *
      0.12;
  }


  st.speed =
    Math.max(
      0.45,
      Math.min(
        2.2,
        st.speed
      )
    );


  /*
   * Phase speed.
   */

  if (st.phase === 'run') {

    g *= 0.55;

  } else if (
    st.phase === 'rest'
  ) {

    g *= 1.35;

  } else if (
    st.phase === 'retrace'
  ) {

    g *=
      st.retrFast
        ? 0.50
        : 1.05;
  }


  /*
   * Excitement speeds up ticks.
   */

  g *=
    1 -
    0.60 *
    st.excite *
    c.spdVar;


  /*
   * Persistent speed.
   */

  g *=
    st.speed;


  /*
   * Occasional burst clusters.
   */

  const roll =
    Math.random();


  if (
    roll <
    0.08 * c.spdVar
  ) {

    g *= 0.35;

  } else if (
    roll <
    0.15 * c.spdVar
  ) {

    g *= 0.55;

  } else if (
    roll >
    1 -
    0.05 * c.spdVar
  ) {

    g *= 1.8;
  }


  /*
   * Small natural timing variation.
   */

  g *=
    0.75 +
    Math.random() *
    0.50;


  return Math.max(
    35,
    Math.min(
      2500,
      g
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