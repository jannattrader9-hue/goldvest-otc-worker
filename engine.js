/**
 * engine.js
 * GoldVest OTC / chart price simulation engine
 *
 * লক্ষ্য:
 * - 5s chart এ দ্রুত tick
 * - medium tick প্রধান
 * - বড় tick আগের চেয়ে বেশি দৃশ্যমান
 * - ছোট tick কম
 * - speed persistent, কিন্তু smooth
 * - discrete jump, glide নয়
 * - random direction + momentum
 *
 * এটি chart/market simulation-এর জন্য।
 * Real-money outcome manipulate করার settlement logic এখানে নেই.
 */

'use strict';

const num = (v, d) =>
  (v === undefined || v === '' || isNaN(+v) ? d : +v);


/* ============================================================
   CONFIG
   ============================================================ */

const CFG = {

  /* Base movement */
  unit: num(
    process.env.ENG_UNIT,
    0.000018
  ),

  /* Volatility memory */
  volMem: num(
    process.env.ENG_VOL_MEM,
    0.992
  ),

  volAmp: num(
    process.env.ENG_VOL_AMP,
    0.34
  ),

  /* Phase lengths */
  runLen: num(
    process.env.ENG_RUN_LEN,
    10
  ),

  restLen: num(
    process.env.ENG_REST_LEN,
    3
  ),

  clust: num(
    process.env.ENG_CLUST,
    0.55
  ),

  retr: num(
    process.env.ENG_RETR,
    0.35
  ),

  /* Larger movement */
  jump: num(
    process.env.ENG_JUMP,
    2.5
  ),

  spread: num(
    process.env.ENG_SPREAD,
    0.8
  ),

  /*
   * Faster default tick.
   *
   * Old:
   * 500ms
   *
   * New:
   * 260ms
   */
  gapMs: num(
    process.env.ENG_GAP_MS,
    260
  ),

  /*
   * Speed variation
   */
  spdVar: num(
    process.env.ENG_SPD_VAR,
    0.82
  ),

  bias: num(
    process.env.ENG_BIAS,
    0.006
  ),

  session: num(
    process.env.ENG_SESSION,
    0.55
  ),

  /*
   * Safety:
   * Maximum movement per tick.
   *
   * Raised slightly because medium/big ticks
   * otherwise get clipped too often.
   */
  maxStep: num(
    process.env.ENG_MAX_STEP,
    0.0022
  ),


  /* ========================================================
     ANCHOR
     ======================================================== */

  anchorBand: num(
    process.env.ENG_ANCHOR_BAND,
    0.06
  ),

  anchorStrength: num(
    process.env.ENG_ANCHOR_STRENGTH,
    0.00005
  ),


  /* Admin controls */

  forceDir: 0,

  trendStrength: 0.6
};


/* ============================================================
   DECIMAL HANDLING
   ============================================================ */

function _fitDecimals(price, given) {
  return given;
}


/* ============================================================
   TICK SCALE
   ============================================================ */

function _tickScale(price, decimals) {

  const step =
    Math.pow(10, -decimals);

  const want =
    price * 0.000012;

  if (want >= step * 0.9) {
    return 1;
  }

  return Math.min(
    3,
    (step * 0.9) /
      Math.max(want, 1e-12)
  );
}


/* ============================================================
   STATE
   ============================================================ */

function createState(
  price,
  decimals = 5
) {

  return {

    price,

    decimals,

    tickScale:
      _tickScale(price, decimals),

    referencePrice: 0,

    vol: 1,

    phase: 'rest',

    left: 2,

    dir: 1,

    excite: 0,

    runStart: price,

    retrTarget: 0,

    retrLeft0: 1,

    retrFast: false,

    retrDone: 0,

    regimeDir:
      Math.random() < 0.5
        ? 1
        : -1,

    regimeLeft:
      200 +
      ((Math.random() * 500) | 0),

    hardPauseUntil: 0,

    impulseCount: 0,

    /*
     * Persistent speed.
     *
     * 1 = normal
     * <1 = faster
     * >1 = slower
     */
    speed: 1,

    /*
     * Persistent movement energy.
     * Helps prevent every tick from looking identical.
     */
    momentum: 0,

    /*
     * Last movement direction.
     */
    lastDir: 1
  };
}


/* ============================================================
   SESSION MULTIPLIER
   ============================================================ */

function sessionMul(t, amt) {

  const d = new Date(t);

  const h =
    d.getUTCHours() +
    d.getUTCMinutes() / 60;

  const curve =
    0.55
    +
    0.75 *
      Math.exp(
        -Math.pow(
          (h - 13) / 5.5,
          2
        )
      )
    +
    0.35 *
      Math.exp(
        -Math.pow(
          (h - 8.5) / 2.2,
          2
        )
      );

  return 1 +
    (curve - 1) *
    amt;
}


/* ============================================================
   MEDIUM / LARGE TICK DISTRIBUTION
   ============================================================ */

/*
 * IMPORTANT:
 *
 * Previous distribution:
 *
 * 25% tiny
 * 60% normal
 * 15% large
 *
 * New distribution:
 *
 * 10% tiny
 * 58% medium
 * 22% large
 * 10% very-large
 *
 * So medium movement becomes the visual "default".
 */

function movementMagnitude() {

  const r = Math.random();

  /*
   * 10%:
   * tiny movement
   */
  if (r < 0.10) {

    return (
      0.10 +
      Math.random() * 0.30
    );
  }


  /*
   * 58%:
   * MEDIUM movement
   *
   * This is the main category.
   */
  if (r < 0.68) {

    return (
      0.75 +
      Math.random() * 0.90
    );
  }


  /*
   * 22%:
   * large movement
   */
  if (r < 0.90) {

    return (
      1.60 +
      Math.random() * 1.80
    );
  }


  /*
   * 10%:
   * very large movement
   */
  return (
    3.20 +
    Math.random() * 3.20
  );
}


/* ============================================================
   DIRECTION
   ============================================================ */

function chooseDirection(st, c) {

  let bias = 0;

  /*
   * Admin direction.
   */
  if (c.forceDir) {

    bias =
      c.forceDir *
      (
        0.10 +
        c.trendStrength * 0.22
      );

  } else {

    /*
     * Regime direction.
     */
    bias =
      st.regimeDir *
      c.bias;
  }


  /*
   * Momentum creates short-term persistence.
   *
   * Not a fixed sequence.
   */
  const momentumBias =
    st.momentum * 0.12;


  const probability =
    0.5 +
    bias +
    momentumBias;


  const dir =
    Math.random() < probability
      ? 1
      : -1;


  return dir;
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
      ? { ...CFG, ...over }
      : CFG;


  /* ----------------------------------------------------------
     Base unit
     ---------------------------------------------------------- */

  const base =
    st.price *
    c.unit *
    (st.tickScale || 1);


  /* ----------------------------------------------------------
     Volatility memory
     ---------------------------------------------------------- */

  const shock =
    (Math.random() - 0.5) *
    c.volAmp;


  st.vol =
    st.vol * c.volMem +
    (1 - c.volMem) *
      (1 + shock * 3);


  st.vol =
    Math.max(
      0.35,
      Math.min(4.5, st.vol)
    );


  /* ----------------------------------------------------------
     Excitement decay
     ---------------------------------------------------------- */

  st.excite *= 0.94;


  /* ----------------------------------------------------------
     Momentum decay
     ---------------------------------------------------------- */

  st.momentum *= 0.94;

  st.momentum =
    Math.max(
      -1,
      Math.min(1, st.momentum)
    );


  /* ----------------------------------------------------------
     MID-BURST RETRACE
     ---------------------------------------------------------- */

  let midBurstRetrace = false;

  if (
    st.phase === 'run' &&
    st.left > 2
  ) {

    /*
     * Low probability.
     *
     * No fixed "after X ticks reverse".
     */
    if (
      Math.random() <
      0.025 +
      st.excite * 0.025
    ) {

      midBurstRetrace = true;
    }
  }


  /* ----------------------------------------------------------
     REST TIMER
     ---------------------------------------------------------- */

  const restDone =
    st.phase === 'rest' &&
    (
      !st.hardPauseUntil ||
      now >= st.hardPauseUntil
    );


  const shouldTransition =
    st.phase === 'rest'
      ? restDone
      : (
          midBurstRetrace ||
          --st.left <= 0
        );


  /* ==========================================================
     PHASE TRANSITION
     ========================================================== */

  if (shouldTransition) {


    /* --------------------------------------------------------
       RUN -> RETRACE / REST
       -------------------------------------------------------- */

    if (st.phase === 'run') {

      st.excite =
        Math.min(
          1,
          st.excite + 0.40
        );


      const moved =
        st.price -
        st.runStart;


      st.retrTarget =
        -moved *
        (
          c.retr *
          (
            0.45 +
            Math.random() * 0.75
          )
        );


      /*
       * Retrace speed variation.
       */
      st.retrFast =
        Math.random() < 0.65;


      st.retrLeft0 =
        st.retrFast

          ? (
              1 +
              ((Math.random() * 3) | 0)
            )

          : (
              2 +
              ((Math.random() * 4) | 0)
            );


      st.retrDone = 0;


      /*
       * Movement-dependent retrace probability.
       */
      const movedPct =
        Math.min(
          1,
          Math.abs(moved) /
            (
              st.price *
              0.0025
            )
        );


      const retraceProb =
        0.28 +
        movedPct * 0.32 +
        st.excite * 0.12;


      const wantRetrace =
        Math.random() <
        retraceProb;


      if (
        wantRetrace &&
        Math.abs(st.retrTarget) > 1e-12 &&
        c.retr > 0
      ) {

        st.phase = 'retrace';

        st.left =
          st.retrLeft0;

      } else {

        /*
         * Go rest.
         */
        const rest =
          Math.max(
            0,
            c.restLen *
              (
                1 -
                st.excite *
                c.clust
              )
          );


        st.phase = 'rest';

        st.left =
          1 +
          (
            Math.random() *
            (rest + 1)
          | 0
          );


        /*
         * Visible pause is now less common.
         */
        if (
          Math.random() < 0.30
        ) {

          st.hardPauseUntil =
            now +
            (
              180 +
              Math.random() * 420
            );
        }
      }
    }


    /* --------------------------------------------------------
       RETRACE -> RUN / REST
       -------------------------------------------------------- */

    else if (
      st.phase === 'retrace'
    ) {

      /*
       * Sometimes continue immediately.
       */
      if (
        Math.random() < 0.72
      ) {

        st.phase = 'run';


        const u =
          Math.random();


        st.left =
          Math.max(
            2,
            Math.round(
              c.runLen *
              Math.pow(
                u,
                -0.40
              ) *
              0.55
            )
          );


        st.dir =
          chooseDirection(
            st,
            c
          );


        st.runStart =
          st.price;

      } else {

        st.phase = 'rest';

        st.left =
          1 +
          (
            Math.random() *
            3
          | 0
          );


        if (
          Math.random() < 0.25
        ) {

          st.hardPauseUntil =
            now +
            (
              180 +
              Math.random() * 420
            );
        }
      }
    }


    /* --------------------------------------------------------
       REST -> RUN
       -------------------------------------------------------- */

    else if (
      st.phase === 'rest'
    ) {

      /*
       * Mostly resume movement.
       */
      if (
        Math.random() < 0.94
      ) {

        st.phase = 'run';


        st.left =
          3 +
          (
            Math.random() * 6
          | 0
          );


        st.dir =
          chooseDirection(
            st,
            c
          );


        st.runStart =
          st.price;

      } else {

        /*
         * Another short rest.
         */
        st.left =
          1 +
          (
            Math.random() * 2
          | 0
          );
      }
    }


    /* --------------------------------------------------------
       FALLBACK
       -------------------------------------------------------- */

    else {

      st.phase = 'run';


      st.left =
        3 +
        (
          Math.random() * 5
        | 0
        );


      st.dir =
        chooseDirection(
          st,
          c
        );


      st.runStart =
        st.price;
    }
  }


  /* ==========================================================
     HARD PAUSE
     ========================================================== */

  if (
    st.hardPauseUntil &&
    now < st.hardPauseUntil
  ) {

    /*
     * Mostly static.
     *
     * Occasionally one very small visible tick.
     */
    if (
      Math.random() < 0.18
    ) {

      const pip =
        Math.pow(
          10,
          -st.decimals
        );


      const micro =
        (
          Math.random() < 0.5
            ? 1
            : -1
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


  /* ==========================================================
     SESSION
     ========================================================== */

  const sm =
    sessionMul(
      now,
      c.session
    );


  let delta = 0;


  /* ==========================================================
     RETRACE
     ========================================================== */

  if (
    st.phase === 'retrace'
  ) {

    const remain =
      st.retrTarget -
      (st.retrDone || 0);


    if (
      st.left <= 1 ||
      Math.sign(remain) === 0
    ) {

      delta = remain;

    } else {

      const retrDir =
        Math.sign(
          st.retrTarget
        );


      /*
       * Medium / large retrace.
       */
      const mag =
        movementMagnitude();


      /*
       * Reverse retrace occasionally.
       */
      const reverseProb =
        0.10 +
        st.excite * 0.10;


      const microDir =
        Math.random() <
        reverseProb

          ? -retrDir
          : retrDir;


      delta =
        microDir *
        base *
        Math.min(
          7,
          mag
        ) *
        st.vol *
        sm;


      /*
       * Don't overshoot target.
       */
      if (
        Math.abs(
          (st.retrDone || 0) +
          delta
        ) >
        Math.abs(
          st.retrTarget
        )
      ) {

        delta = remain;
      }
    }


    st.retrDone =
      (st.retrDone || 0) +
      delta;
  }


  /* ==========================================================
     REST
     ========================================================== */

  else if (
    st.phase === 'rest'
  ) {

    /*
     * Rest is no longer a giant wave-like
     * movement. Mostly zero.
     */
    delta = 0;


    /*
     * Small chance of micro tick.
     */
    if (
      Math.random() < 0.12
    ) {

      const pip =
        Math.pow(
          10,
          -st.decimals
        );


      delta =
        (
          Math.random() < 0.5
            ? -1
            : 1
        ) *
        pip;
    }
  }


  /* ==========================================================
     RUN
     ========================================================== */

  else {

    /*
     * Main movement.
     *
     * Medium tick dominates.
     */
    let mag =
      movementMagnitude();


    /*
     * Volatility amplifies movement.
     */
    mag *=
      (
        0.82 +
        st.vol * 0.28
      );


    /*
     * Excited market:
     * slightly bigger movement.
     */
    mag *=
      (
        1 +
        st.excite * 0.30
      );


    /*
     * Occasionally direction changes.
     *
     * No fixed 3/4 tick sequence.
     */
    const reverseProb =
      0.10 +
      st.excite * 0.16 +
      Math.random() * 0.06;


    let moveDir =
      st.dir;


    if (
      Math.random() <
      reverseProb
    ) {

      moveDir =
        -st.dir;

    } else {

      /*
       * Keep previous direction.
       */
      moveDir =
        st.dir;
    }


    /*
     * Update momentum.
     */
    st.momentum +=
      moveDir * 0.16;


    st.momentum =
      Math.max(
        -1,
        Math.min(
          1,
          st.momentum
        )
      );


    /*
     * Final movement.
     */
    delta =
      moveDir *
      base *
      Math.min(
        8,
        mag
      ) *
      st.vol *
      sm;


    /*
     * Minimum visible movement.
     *
     * At least 2 pips.
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


    /*
     * Remember direction.
     */
    st.lastDir =
      moveDir;
  }


  /* ==========================================================
     HEAVY TAIL / BIG JUMP
     ========================================================== */

  if (
    st.phase !== 'rest' &&
    Math.random() * 100 <
    c.jump
  ) {

    /*
     * Large but not absurd.
     */
    const bigMag =
      base *
      (
        5 +
        Math.random() * 7
      ) *
      st.vol;


    /*
     * Big movement generally follows
     * current momentum more often than not.
     */
    let bigDir;


    if (
      Math.random() < 0.68
    ) {

      bigDir =
        st.lastDir;

    } else {

      bigDir =
        Math.random() < 0.5
          ? 1
          : -1;
    }


    delta +=
      bigDir *
      bigMag;


    /*
     * Increase excitation.
     */
    st.excite =
      Math.min(
        1,
        st.excite + 0.55
      );


    st.vol =
      Math.min(
        4.5,
        st.vol * 1.16
      );
  }


  /* ==========================================================
     REGIME
     ========================================================== */

  if (
    --st.regimeLeft <= 0
  ) {

    st.regimeDir =
      Math.random() < 0.5
        ? 1
        : -1;


    st.regimeLeft =
      200 +
      (
        Math.random() * 500
      | 0
      );
  }


  /* ==========================================================
     REFERENCE ANCHOR
     ========================================================== */

  if (
    st.referencePrice > 0
  ) {

    const refDiff =
      (
        st.referencePrice -
        st.price
      ) /
      st.referencePrice;


    if (
      Math.abs(refDiff) >
      c.anchorBand
    ) {

      const pull =
        (
          refDiff -
          Math.sign(refDiff) *
          c.anchorBand
        ) *
        c.anchorStrength;


      delta +=
        st.price *
        pull;
    }
  }


  /* ==========================================================
     SAFETY CLAMP
     ========================================================== */

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


  /* ==========================================================
     APPLY
     ========================================================== */

  st.price =
    Math.max(
      st.price + delta,
      1e-8
    );


  /* ==========================================================
     ROUND
     ========================================================== */

  st.price =
    Number(
      st.price.toFixed(
        st.decimals
      )
    );


  return st.price;
}


/* ============================================================
   NEXT DELAY
   ============================================================ */

function nextDelay(
  st,
  over
) {

  const c =
    over
      ? { ...CFG, ...over }
      : CFG;


  /* ----------------------------------------------------------
     Visible pause
     ---------------------------------------------------------- */

  if (
    st.hardPauseUntil &&
    Date.now() <
    st.hardPauseUntil
  ) {

    /*
     * Still poll quickly.
     */
    return 100;
  }


  /* ----------------------------------------------------------
     Base gap
     ---------------------------------------------------------- */

  let g =
    c.gapMs;


  /* ----------------------------------------------------------
     Persistent speed
     * 
     * Old:
     * random delay every tick
     *
     * New:
     * persistent speed state
     * gradually changes
     * ------------------------------------------------------- */

  const speedRoll =
    Math.random();


  if (
    speedRoll < 0.08
  ) {

    /*
     * sudden acceleration
     */
    st.speed *=
      0.60;

  } else if (
    speedRoll < 0.16
  ) {

    /*
     * sudden slowdown
     */
    st.speed *=
      1.30;

  } else {

    /*
     * smooth drift
     */
    st.speed *=
      (
        0.94 +
        Math.random() * 0.12
      );
  }


  /*
   * Faster overall.
   *
   * 0.40 = very fast
   * 1.00 = normal
   * 1.60 = slow
   */
  st.speed =
    Math.max(
      0.40,
      Math.min(
        1.65,
        st.speed
      )
    );


  /* ----------------------------------------------------------
     Phase multiplier
     ---------------------------------------------------------- */

  if (
    st.phase === 'run'
  ) {

    /*
     * Fast active movement.
     */
    g *= 0.62;

  } else if (
    st.phase === 'rest'
  ) {

    /*
     * Slower when resting.
     */
    g *= 1.35;

  } else if (
    st.phase === 'retrace'
  ) {

    /*
     * Fast or medium retrace.
     */
    g *=
      st.retrFast
        ? 0.58
        : 0.85;

  } else {

    g *= 0.8;
  }


  /* ----------------------------------------------------------
     Excitement -> speed
     ---------------------------------------------------------- */

  g *=
    1 -
    (
      0.62 *
      st.excite *
      c.spdVar
    );


  /* ----------------------------------------------------------
     Persistent speed
     ---------------------------------------------------------- */

  g *=
    st.speed;


  /* ----------------------------------------------------------
     Burst clusters
     ---------------------------------------------------------- */

  const roll =
    Math.random();


  /*
   * Very fast tick cluster.
   *
   * Around 40-90ms.
   */
  if (
    roll <
    0.18 *
    c.spdVar
  ) {

    g *=
      0.22;


  /*
   * Fast tick.
   */
  } else if (
    roll <
    0.34 *
    c.spdVar
  ) {

    g *=
      0.42;


  /*
   * Slight slowdown.
   */
  } else if (
    roll >
    0.96
  ) {

    g *=
      1.8;
  }


  /* ----------------------------------------------------------
     Small natural variation
     ---------------------------------------------------------- */

  g *=
    0.78 +
    Math.random() * 0.44;


  /*
   * Final limits.
   *
   * This makes 5-second chart substantially
   * more active than the old 500ms setup.
   */
  return Math.max(
    40,
    Math.min(
      900,
      g
    )
  );
}


/* ============================================================
   EXPORT
   ============================================================ */

module.exports = {

  createState,

  nextPrice,

  nextDelay,

  sessionMul,

  CFG
};