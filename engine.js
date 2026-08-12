'use strict';

const CFG = {
  // প্রতি tick ঠিক 200ms
  gapMs: 200,

  // প্রতিটি tick-এ fixed price step
  stepSize: 0.01,

  // display precision
  decimals: 2,

  // শুধু visual pause
  pauseEnabled: true,
  pauseChance: 0.08,
  pauseMinMs: 500,
  pauseMaxMs: 3000
};

function createState(price, decimals = CFG.decimals) {
  return {
    price: Number(price.toFixed(decimals)),
    decimals,

    // +1 = উপরে, -1 = নিচে
    direction: Math.random() < 0.5 ? 1 : -1,

    pauseUntil: 0
  };
}

function nextPrice(st, now = Date.now()) {

  // pause চললে price একদম নড়বে না
  if (st.pauseUntil && now < st.pauseUntil) {
    return st.price;
  }

  st.pauseUntil = 0;

  // EXACT fixed movement
  st.price +=
    st.direction * CFG.stepSize;

  st.price = Number(
    st.price.toFixed(st.decimals)
  );

  // শুধু direction বদলাবে,
  // speed বা tick interval বদলাবে না
  if (Math.random() < 0.15) {
    st.direction *= -1;
  }

  // মাঝে মাঝে 0.5–3s visual pause
  if (
    CFG.pauseEnabled &&
    Math.random() < CFG.pauseChance
  ) {
    const duration =
      CFG.pauseMinMs +
      Math.random() *
      (
        CFG.pauseMaxMs -
        CFG.pauseMinMs
      );

    st.pauseUntil = now + duration;
  }

  return st.price;
}

function nextDelay() {
  // ALWAYS 200ms
  return 200;
}

function isPaused(st, now = Date.now()) {
  return (
    st.pauseUntil > now
  );
}

module.exports = {
  createState,
  nextPrice,
  nextDelay,
  isPaused,
  CFG
};