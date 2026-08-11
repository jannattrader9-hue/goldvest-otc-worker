// VISUAL-ONLY MARKET SIMULATOR
// No trade settlement, payout logic, win/loss targeting or outcome control.

const CFG = {
  unit: 0.000018,

  // Price movement
  mediumTickMin: 1.8,
  mediumTickMax: 4.5,

  smallTickProbability: 0.18,
  mediumTickProbability: 0.70,
  largeTickProbability: 0.12,

  // Direction persistence
  directionPersistence: 0.82,

  // Speed
  baseGapMs: 420,
  minGapMs: 90,
  maxGapMs: 1100,

  // Speed changes gradually instead of jumping
  speedDrift: 0.08,

  // Volatility changes gradually
  volatilityMemory: 0.985,

  // Occasional larger movement
  largeTickMultiplier: 1.8,

  // Hard anti-jitter protection
  maxDirectionChanges: 3,
  directionWindow: 8
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function createState(price, decimals = 5) {
  return {
    price,
    decimals,

    direction: Math.random() < 0.5 ? 1 : -1,

    volatility: 1,

    // Persistent speed
    speed: 1,

    // Direction history
    directionHistory: [],

    // Last movement
    lastDelta: 0,

    // Prevent repeated tiny reversals
    reversalCooldown: 0
  };
}

function chooseMagnitude(st) {
  const r = Math.random();

  let magnitude;

  if (r < CFG.smallTickProbability) {
    // Small tick
    magnitude = rand(0.7, 1.6);

  } else if (r < CFG.smallTickProbability + CFG.mediumTickProbability) {
    // MAIN CASE:
    // Most ticks should be medium.
    magnitude = rand(
      CFG.mediumTickMin,
      CFG.mediumTickMax
    );

  } else {
    // Occasional larger tick
    magnitude = rand(4.5, 7.0) *
                CFG.largeTickMultiplier;
  }

  return magnitude * st.volatility;
}

function chooseDirection(st) {
  // Cooldown prevents rapid flip-flopping
  if (st.reversalCooldown > 0) {
    st.reversalCooldown--;
    return st.direction;
  }

  // Strong persistence
  if (Math.random() < CFG.directionPersistence) {
    return st.direction;
  }

  // Change direction
  st.direction *= -1;

  st.reversalCooldown = 1 + Math.floor(Math.random() * 2);

  return st.direction;
}

function nextPrice(st) {

  // Slowly changing volatility
  const volatilityTarget = rand(0.85, 1.20);

  st.volatility =
    st.volatility * CFG.volatilityMemory +
    volatilityTarget * (1 - CFG.volatilityMemory);

  st.volatility = clamp(
    st.volatility,
    0.70,
    1.45
  );

  const direction = chooseDirection(st);
  const magnitude = chooseMagnitude(st);

  const base = st.price * CFG.unit;

  let delta =
    direction *
    base *
    magnitude;

  // Prevent microscopic movement
  const pip = Math.pow(10, -st.decimals);

  if (Math.abs(delta) < pip) {
    delta = direction * pip;
  }

  // Prevent absurd single-tick movement
  const maximum =
    st.price * 0.00035;

  delta = clamp(
    delta,
    -maximum,
    maximum
  );

  st.lastDelta = delta;
  st.price += delta;

  // Clean decimal value
  st.price = Number(
    st.price.toFixed(st.decimals)
  );

  st.directionHistory.push(direction);

  if (st.directionHistory.length > CFG.directionWindow) {
    st.directionHistory.shift();
  }

  return st.price;
}

function nextDelay(st) {

  // Gradual speed drift.
  // No 0.65x / 1.45x sudden jumps.
  const drift =
    rand(
      -CFG.speedDrift,
      CFG.speedDrift
    );

  st.speed += drift;

  st.speed = clamp(
    st.speed,
    0.65,
    1.55
  );

  let gap =
    CFG.baseGapMs / st.speed;

  // Small natural timing variation
  gap *= rand(0.90, 1.10);

  return clamp(
    gap,
    CFG.minGapMs,
    CFG.maxGapMs
  );
}

module.exports = {
  createState,
  nextPrice,
  nextDelay,
  CFG
};