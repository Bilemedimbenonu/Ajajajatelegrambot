const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const TREND_TF = process.env.TREND_TF || "15m";
const HTF = process.env.HTF || "1h";

const MIN_SCORE_SNIPER = parseFloat(process.env.MIN_SCORE_SNIPER || "7.0");
const MIN_SCORE_TREND = parseFloat(process.env.MIN_SCORE_TREND || "6.0");

const MIN_RR_SNIPER = parseFloat(process.env.MIN_RR_SNIPER || "2.0");
const MIN_RR_TREND = parseFloat(process.env.MIN_RR_TREND || "1.5");

const LOOP_MS = parseInt(process.env.LOOP_MS || "90000", 10);

const BASE = "https://fapi.binance.com";

const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

let activeTrade = null;

console.log("🚀 BOT START");
console.log("COIN COUNT:", COINS.length);

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function klines(symbol, tf) {
  return await fetchJson(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=120`);
}

function closes(k) { return k.map(x => parseFloat(x[4])); }
function highs(k) { return k.map(x => parseFloat(x[2])); }
function lows(k) { return k.map(x => parseFloat(x[3])); }
function volumes(k) { return k.map(x => parseFloat(x[5])); }

function ema(arr, p) {
  const k = 2 / (p + 1);
  let prev = arr[0];
  return arr.map(v => (prev = v * k + prev * (1 - k)));
}

function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

function rr(entry, stop, tp) {
  return Math.abs(tp - entry) / Math.abs(entry - stop);
}

function fmt(n) {
  return n.toFixed(4);
}

async function send(msg) {
  if (!TG_TOKEN || !CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
  });
}

async function scan(symbol) {
  const data = await klines(symbol, ENTRY_TF);
  if (!data) return null;

  const c = closes(data);
  const h = highs(data);
  const l = lows(data);
  const v = volumes(data);

  const last = c.at(-1);

  // 🔥 FIXED BREAKOUT
  const breakoutHigh = Math.max(...h.slice(-11, -1));
  const breakoutLow = Math.min(...l.slice(-11, -1));

  const ema20 = ema(c, 20).at(-1);

  const volNow = v.at(-1);
  const volAvg = avg(v.slice(-20, -1));

  const volumeOk = volNow > volAvg * 1.2;

  let longScore = 0;
  let shortScore = 0;

  if (last > breakoutHigh) longScore += 4;
  if (last < breakoutLow) shortScore += 4;

  if (volumeOk) {
    longScore += 2;
    shortScore += 2;
  }

  if (Math.abs(last - ema20) / last < 0.01) {
    longScore += 1;
    shortScore += 1;
  }

  // DEBUG
  if (longScore > 0 || shortScore > 0) {
    console.log(symbol, "SCORE:", longScore, shortScore);
  }

  if (longScore >= MIN_SCORE_SNIPER) {
    const stop = breakoutLow;
    const tp = last + (last - stop) * 2;

    if (rr(last, stop, tp) < MIN_RR_SNIPER) return null;

    return {
      coin: symbol,
      side: "LONG",
      entry: last,
      stop,
      tp,
      score: longScore
    };
  }

  if (shortScore >= MIN_SCORE_SNIPER) {
    const stop = breakoutHigh;
    const tp = last - (stop - last) * 2;

    if (rr(last, stop, tp) < MIN_RR_SNIPER) return null;

    return {
      coin: symbol,
      side: "SHORT",
      entry: last,
      stop,
      tp,
      score: shortScore
    };
  }

  return null;
}

async function run() {
  console.log("RUN");

  if (!COINS.length) {
    console.log("❌ COIN LIST EMPTY");
    return;
  }

  if (activeTrade) {
    console.log("ACTIVE TRADE WAIT");
    return;
  }

  let best = null;

  for (const coin of COINS) {
    const s = await scan(coin);

    if (s && (!best || s.score > best.score)) {
      best = s;
    }
  }

  if (!best) {
    console.log("NO SIGNAL");
    return;
  }

  console.log("SIGNAL:", best.coin, best.side);

  await send(`🔥 SIGNAL

${best.coin} ${best.side}
Entry: ${fmt(best.entry)}
Stop: ${fmt(best.stop)}
TP: ${fmt(best.tp)}
Score: ${best.score}`);

  activeTrade = best;
}

async function main() {
  while (true) {
    try {
      await run();
    } catch (e) {
      console.log("ERR", e);
    }

    await new Promise(r => setTimeout(r, LOOP_MS));
  }
}

main();
