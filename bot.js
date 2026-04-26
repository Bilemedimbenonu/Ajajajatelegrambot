const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const LOOP_MS = parseInt(process.env.LOOP_MS || "90000", 10);
const DUPLICATE_TTL_MS = parseInt(process.env.DUPLICATE_TTL_MS || "2700000", 10);

const MIN_SCORE_SNIPER = parseFloat(process.env.MIN_SCORE_SNIPER || "6.5");
const MIN_SCORE_TREND = parseFloat(process.env.MIN_SCORE_TREND || "5.5");
const MIN_RR_SNIPER = parseFloat(process.env.MIN_RR_SNIPER || "1.7");
const MIN_RR_TREND = parseFloat(process.env.MIN_RR_TREND || "1.4");

const BASE_URLS = [
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com"
];

const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

let activeTrade = null;
const lastSignalAt = new Map();
const badSymbols = new Set();

console.log("V9 SMART EXIT BOT STARTED");
console.log("COIN COUNT:", COINS.length);

async function fetchJson(path) {
  for (const base of BASE_URLS) {
    try {
      const res = await fetch(base + path);
      if (!res.ok) continue;
      return await res.json();
    } catch {}
  }
  return null;
}

async function fetchKlines(symbol, tf = ENTRY_TF, limit = 120) {
  if (badSymbols.has(symbol)) return null;
  const data = await fetchJson(`/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`);
  if (!Array.isArray(data) || data.length < 30) {
    badSymbols.add(symbol);
    return null;
  }
  return data;
}

async function fetchPrice(symbol) {
  const data = await fetchJson(`/fapi/v1/ticker/price?symbol=${symbol}`);
  const p = parseFloat(data?.price);
  return Number.isFinite(p) ? p : null;
}

function arrClose(d) { return d.map(x => +x[4]); }
function arrOpen(d) { return d.map(x => +x[1]); }
function arrHigh(d) { return d.map(x => +x[2]); }
function arrLow(d) { return d.map(x => +x[3]); }
function arrVol(d) { return d.map(x => +x[5]); }

function avg(a) {
  if (!a.length) return 0;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function atr(d, period = 14) {
  const h = arrHigh(d), l = arrLow(d), c = arrClose(d);
  const trs = [];
  for (let i = 1; i < d.length; i++) {
    trs.push(Math.max(
      h[i] - l[i],
      Math.abs(h[i] - c[i - 1]),
      Math.abs(l[i] - c[i - 1])
    ));
  }
  return avg(trs.slice(-period));
}

function rr(entry, stop, tp) {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  return Math.abs(tp - entry) / risk;
}

function clamp(n) {
  return Math.max(0, Math.min(10, n));
}

function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function duplicate(key) {
  const t = lastSignalAt.get(key);
  return t && Date.now() - t < DUPLICATE_TTL_MS;
}

function mark(key) {
  lastSignalAt.set(key, Date.now());
}

async function checkSniper(symbol) {
  const d = await fetchKlines(symbol, ENTRY_TF, 120);
  if (!d) return null;

  const c = arrClose(d), o = arrOpen(d), h = arrHigh(d), l = arrLow(d), v = arrVol(d);
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  const a = atr(d);

  const last = c.at(-1);
  const prev = c.at(-2);
  const prevOpen = o.at(-2);
  const prevHigh = h.at(-2);
  const prevLow = l.at(-2);
  const prev2 = c.at(-3);

  if (!a || a / last * 100 < 0.22) return null;

  const avgVol = avg(v.slice(-21, -1));
  const volSpike = v.at(-1) > avgVol * 1.12 || v.at(-2) > avgVol * 1.12;
  if (!volSpike) return null;

  const trendLong = e20.at(-1) > e50.at(-1);
  const trendShort = e20.at(-1) < e50.at(-1);

  const recentHigh = Math.max(...h.slice(-12, -3));
  const recentLow = Math.min(...l.slice(-12, -3));

  const sweepLong = l.at(-3) < recentLow && prev > recentLow;
  const sweepShort = h.at(-3) > recentHigh && prev < recentHigh;

  const body = Math.abs(prev - prevOpen);
  const range = Math.max(prevHigh - prevLow, 0.0000001);
  const bodyRatio = body / range;

  const confirmLong = prev > prevOpen && bodyRatio >= 0.35;
  const confirmShort = prev < prevOpen && bodyRatio >= 0.35;

  const nearEma = Math.abs(last - e20.at(-1)) / last < 0.008;
  const displacement = Math.abs(prev - prev2);

  let longScore = 0;
  longScore += trendLong ? 2.5 : 0;
  longScore += sweepLong ? 1.5 : 0;
  longScore += confirmLong ? 1.2 : 0;
  longScore += nearEma ? 0.8 : 0;
  longScore += volSpike ? 1 : 0;
  longScore += displacement > a * 0.45 ? 1 : 0;

  let shortScore = 0;
  shortScore += trendShort ? 2.5 : 0;
  shortScore += sweepShort ? 1.5 : 0;
  shortScore += confirmShort ? 1.2 : 0;
  shortScore += nearEma ? 0.8 : 0;
  shortScore += volSpike ? 1 : 0;
  shortScore += displacement > a * 0.45 ? 1 : 0;

  longScore = clamp(longScore);
  shortScore = clamp(shortScore);

  if (longScore >= MIN_SCORE_SNIPER && trendLong && sweepLong && confirmLong) {
    const entry = last;
    const stop = Math.min(prevLow, recentLow) - a * 0.45;
    const tp1 = entry + (entry - stop) * 1.0;
    const tp2 = entry + (entry - stop) * 1.8;
    const R = rr(entry, stop, tp2);
    if (R < MIN_RR_SNIPER) return null;
    return { mode: "SNIPER", coin: symbol, side: "LONG", score: longScore, entry, stop, tp1, tp2, rr: R };
  }

  if (shortScore >= MIN_SCORE_SNIPER && trendShort && sweepShort && confirmShort) {
    const entry = last;
    const stop = Math.max(prevHigh, recentHigh) + a * 0.45;
    const tp1 = entry - (stop - entry) * 1.0;
    const tp2 = entry - (stop - entry) * 1.8;
    const R = rr(entry, stop, tp2);
    if (R < MIN_RR_SNIPER) return null;
    return { mode: "SNIPER", coin: symbol, side: "SHORT", score: shortScore, entry, stop, tp1, tp2, rr: R };
  }

  return null;
}

async function checkTrend(symbol) {
  const d = await fetchKlines(symbol, ENTRY_TF, 100);
  if (!d) return null;

  const c = arrClose(d), h = arrHigh(d), l = arrLow(d), v = arrVol(d);
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  const a = atr(d);

  const last = c.at(-1);
  if (!a || a / last * 100 < 0.22) return null;

  const avgVol = avg(v.slice(-21, -1));
  const volSpike = v.at(-1) > avgVol * 1.15;
  if (!volSpike) return null;

  const trendLong = e20.at(-1) > e50.at(-1);
  const trendShort = e20.at(-1) < e50.at(-1);

  const prevHigh = Math.max(...h.slice(-8, -1));
  const prevLow = Math.min(...l.slice(-8, -1));

  let longScore = 0;
  longScore += trendLong ? 3 : 0;
  longScore += last > prevHigh ? 2 : 0;
  longScore += volSpike ? 1 : 0;

  let shortScore = 0;
  shortScore += trendShort ? 3 : 0;
  shortScore += last < prevLow ? 2 : 0;
  shortScore += volSpike ? 1 : 0;

  longScore = clamp(longScore);
  shortScore = clamp(shortScore);

  if (longScore >= MIN_SCORE_TREND) {
    const entry = last;
    const stop = prevLow;
    const tp1 = entry + (entry - stop) * 0.8;
    const tp2 = entry + (entry - stop) * 1.4;
    const R = rr(entry, stop, tp2);
    if (R < MIN_RR_TREND) return null;
    return { mode: "TREND", coin: symbol, side: "LONG", score: longScore, entry, stop, tp1, tp2, rr: R };
  }

  if (shortScore >= MIN_SCORE_TREND) {
    const entry = last;
    const stop = prevHigh;
    const tp1 = entry - (stop - entry) * 0.8;
    const tp2 = entry - (stop - entry) * 1.4;
    const R = rr(entry, stop, tp2);
    if (R < MIN_RR_TREND) return null;
    return { mode: "TREND", coin: symbol, side: "SHORT", score: shortScore, entry, stop, tp1, tp2, rr: R };
  }

  return null;
}

function formatSignal(s) {
  const note = s.mode === "SNIPER"
    ? "SNIPER = ANA SETUP"
    : "TREND = KUCUK BOY / IZLE";

  return `🔥 ${s.mode} SIGNAL

Coin: ${s.coin}
Side: ${s.side}
Confidence: ${s.score.toFixed(1)}/10

Entry: ${fmt(s.entry)}
Stop: ${fmt(s.stop)}
TP1: ${fmt(s.tp1)}
TP2: ${fmt(s.tp2)}
RR: ${s.rr.toFixed(2)}

${note}`;
}

function formatExit(t, price, state, reason) {
  return `🔴 SMART EXIT

Type: ${t.mode}
Coin: ${t.coin}
Side: ${t.side}
State: ${state}

Entry: ${fmt(t.entry)}
Live: ${fmt(price)}
Stop: ${fmt(t.stop)}
TP1: ${fmt(t.tp1)}
TP2: ${fmt(t.tp2)}

Reason: ${reason}`;
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text })
  });

  const out = await res.text();
  console.log("TELEGRAM:", out);
  return res.ok;
}

async function updateActiveTrade() {
  if (!activeTrade) {
    console.log("NO ACTIVE TRADE");
    return;
  }

  const price = await fetchPrice(activeTrade.coin);
  if (!price) return;

  const d = await fetchKlines(activeTrade.coin, ENTRY_TF, 60);
  const c = d ? arrClose(d) : [];
  const e20 = c.length ? ema(c, 20).at(-1) : null;

  let state = "HOLD";
  let reason = "";

  if (activeTrade.side === "LONG") {
    if (!activeTrade.tp1Hit && price >= activeTrade.tp1) {
      activeTrade.tp1Hit = true;
      activeTrade.stop = activeTrade.entry;
      state = "CONTINUE";
      reason = "TP1 reached, stop moved to break-even.";
    } else if (price <= activeTrade.stop) {
      state = "EXIT";
      reason = "Stop reached.";
    } else if (price >= activeTrade.tp2) {
      state = "EXIT";
      reason = "TP2 reached.";
    } else if (activeTrade.tp1Hit && e20 && price < e20) {
      state = "EXIT";
      reason = "After TP1, price lost EMA20.";
    }
  }

  if (activeTrade.side === "SHORT") {
    if (!activeTrade.tp1Hit && price <= activeTrade.tp1) {
      activeTrade.tp1Hit = true;
      activeTrade.stop = activeTrade.entry;
      state = "CONTINUE";
      reason = "TP1 reached, stop moved to break-even.";
    } else if (price >= activeTrade.stop) {
      state = "EXIT";
      reason = "Stop reached.";
    } else if (price <= activeTrade.tp2) {
      state = "EXIT";
      reason = "TP2 reached.";
    } else if (activeTrade.tp1Hit && e20 && price > e20) {
      state = "EXIT";
      reason = "After TP1, price reclaimed EMA20 against position.";
    }
  }

  if (state !== "HOLD") {
    await sendTelegram(formatExit(activeTrade, price, state, reason));
  }

  if (state === "EXIT") {
    activeTrade = null;
  }
}

async function run() {
  console.log("RUN START");

  await updateActiveTrade();

  if (activeTrade) {
    console.log("ACTIVE TRADE EXISTS, NEW SIGNAL SKIPPED");
    return;
  }

  let bestSniper = null;
  let bestTrend = null;

  for (const coin of COINS) {
    if (badSymbols.has(coin)) continue;

    const s = await checkSniper(coin);
    if (s && (!bestSniper || s.score > bestSniper.score || (s.score === bestSniper.score && s.rr > bestSniper.rr))) {
      bestSniper = s;
    }

    const t = await checkTrend(coin);
    if (t && (!bestTrend || t.score > bestTrend.score || (t.score === bestTrend.score && t.rr > bestTrend.rr))) {
      bestTrend = t;
    }
  }

  console.log("BEST SNIPER:", bestSniper ? `${bestSniper.coin} ${bestSniper.score}/10 RR:${bestSniper.rr.toFixed(2)}` : "NONE");
  console.log("BEST TREND:", bestTrend ? `${bestTrend.coin} ${bestTrend.score}/10 RR:${bestTrend.rr.toFixed(2)}` : "NONE");

  const best = bestSniper || bestTrend;
  if (!best) return;

  const key = `${best.mode}:${best.coin}:${best.side}`;
  if (duplicate(key)) {
    console.log("DUPLICATE SKIPPED:", key);
    return;
  }

  mark(key);

  const sent = await sendTelegram(formatSignal(best));
  if (!sent) return;

  activeTrade = { ...best, tp1Hit: false, createdAt: Date.now() };
  console.log("ACTIVE TRADE OPENED:", activeTrade.coin, activeTrade.side);
}

async function main() {
  if (!TG_TOKEN || !CHAT_ID || !COINS.length) {
    console.log("ENV ERROR: TG_BOT_TOKEN / TG_CHAT_ID / COIN_LIST");
    process.exit(1);
  }

  while (true) {
    try {
      await run();
    } catch (e) {
      console.log("RUN ERROR:", e?.message || e);
    }

    console.log("SLEEPING:", LOOP_MS);
    await new Promise(r => setTimeout(r, LOOP_MS));
  }
}

main();
