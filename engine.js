/**
 * otc-candle-engine.js — Forex/Quotex-style OTC price generator
 * ────────────────────────────────────────────────────────────
 * প্রতিটা tick independent random walk। বেশিরভাগ ছোট নড়াচড়া,
 * মাঝেমধ্যে বড়। কোনো phase/regime/pause-logic নেই — একদম সহজ।
 */

'use strict';

function createState(price, decimals = 5) {
  return { price, decimals };
}

function nextPrice(state) {
  const unit = state.price * 0.00002;   // এক tick এর typical মাপ
  const dir = Math.random() < 0.5 ? 1 : -1;

  const r = Math.random();
  let mag;
  if (r < 0.6) mag = 0.2 + Math.random() * 0.8;          // ছোট (৬০%)
  else if (r < 0.92) mag = 1 + Math.random() * 2;         // মাঝারি (৩২%)
  else mag = 3 + Math.random() * 6;                        // বড় (৮%)

  const delta = dir * unit * mag;
  state.price = Math.max(state.price + delta, 1e-8);
  state.price = Number(state.price.toFixed(state.decimals));
  return state.price;
}

function nextDelay() {
  return 150 + Math.random() * 300;   // ১৫০-৪৫০ms
}

module.exports = { createState, nextPrice, nextDelay };
