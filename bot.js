const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const TREND_TF = process.env.TREND_TF || "15m";
const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);

const MIN_SCORE_SNIPER = parseFloat(process.env.MIN_SCORE_SNIPER || "5.2");
const MIN_SCORE_TREND = parseFloat(process.env.MIN_SCORE_TREND || "4.4");
const MIN_RR = parseFloat(process.env.MIN_RR || "1.35");

const BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com"
];

const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.replace(/\s+/g, "").toUpperCase())
  .filter(Boolean);

let activeTrade = null;

console.log("🔥 V11 BALANCED HYBRID PRO START");
console.log("COIN COUNT:", COINS.length);

async function fetchJson(path) {
  for (const base of BASES) {
    try {
      const r = await fetch(base + path);
      if (!r.ok) continue;
      return await r.json();
    } catch {}
  }
  return null;
}

async function klines(symbol, tf = ENTRY_TF, limit = 120) {
  return fetchJson(`/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`);
}

async function price(symbol) {
  const d = await fetchJson(`/fapi/v1/ticker/price?symbol=${symbol}`);
  return d?.price ? Number(d.price) : null;
}

function closes(d) { return d.map(x => Number(x[4])); }
function opens(d) { return d.map(x => Number(x[1])); }
function highs(d) { return d.map(x => Number(x[2])); }
function lows(d) { return d.map(x => Number(x[3])); }
function volumes(d) { return d.map(x => Number(x[5])); }

function avg(a) {
  if (!a.length) return 0;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function ema(arr, p) {
  const k = 2 / (p + 1);
  let e = arr[0];
  return arr.map(v => e = v * k + e * (1 - k));
}

function atr(d, period = 14) {
  const h = highs(d), l = lows(d), c = closes(d);
  const tr = [];
  for (let i = 1; i < d.length; i++) {
    tr.push(Math.max(
      h[i] - l[i],
      Math.abs(h[i] - c[i - 1]),
      Math.abs(l[i] - c[i - 1])
    ));
  }
  return avg(tr.slice(-period));
}

function rr(entry, stop, tp) {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  return Math.abs(tp - entry) / risk;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

async function send(msg) {
  if (!TG_TOKEN || !CHAT_ID) {
    console.log("TELEGRAM ENV MISSING");
    return false;
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
    });

    const t = await r.text();
    console.log("TELEGRAM:", t);
    return r.ok;
  } catch (e) {
    console.log("TELEGRAM ERROR:", e.message);
    return false;
  }
}

function signalText(s) {
  return `🔥 ${s.mode} SIGNAL

Coin: ${s.coin}
Side: ${s.side}
Score: ${s.score.toFixed(1)}/10
RR: ${s.rr.toFixed(2)}

Entry: ${fmt(s.entry)}
Stop: ${fmt(s.stop)}
TP1: ${fmt(s.tp1)}
TP2: ${fmt(s.tp2)}

${s.mode === "SNIPER" ? "SNIPER = ANA SETUP" : "TREND = KUCUK BOY / IZLE"}`;
}

async function scanSniper(symbol, debug) {
  debug.checked++;

  const d = await klines(symbol, ENTRY_TF, 120);
  if (!Array.isArray(d) || d.length < 60) {
    debug.dataFail++;
    return null;
  }

  const c = closes(d), o = opens(d), h = highs(d), l = lows(d), v = volumes(d);
  const last = c.at(-1);
  const prev = c.at(-2);
  const prevOpen = o.at(-2);
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  const a = atr(d);

  if (!a || (a / last) * 100 < 0.12) {
    debug.volatilityFail++;
    return null;
  }

  const recentHigh = Math.max(...h.slice(-13, -1));
  const recentLow = Math.min(...l.slice(-13, -1));

  const volNow = v.at(-1);
  const volAvg = avg(v.slice(-21, -1));
  const volumeOk = volNow > volAvg * 0.95;

  const trendLong = e20.at(-1) > e50.at(-1);
  const trendShort = e20.at(-1) < e50.at(-1);

  const nearHigh = last >= recentHigh * 0.985;
  const nearLow = last <= recentLow * 1.015;

  const breakoutLong = last > recentHigh;
  const breakoutShort = last < recentLow;

  const momentumLong = last > prev;
  const momentumShort = last < prev;

  const body = Math.abs(prev - prevOpen);
  const range = Math.max(h.at(-2) - l.at(-2), 0.0000001);
  const bodyOk = body / range >= 0.22;

  let longScore = 0;
  let shortScore = 0;

  if (trendLong) longScore += 1.8;
  if (trendShort) shortScore += 1.8;

  if (nearHigh) longScore += 1.0;
  if (nearLow) shortScore += 1.0;

  if (breakoutLong) longScore += 1.5;
  if (breakoutShort) shortScore += 1.5;

  if (volumeOk) {
    longScore += 0.8;
    shortScore += 0.8;
  }

  if (momentumLong) longScore += 0.7;
  if (momentumShort) shortScore += 0.7;

  if (last > e20.at(-1)) longScore += 0.7;
  if (last < e20.at(-1)) shortScore += 0.7;

  if (bodyOk) {
    longScore += 0.5;
    shortScore += 0.5;
  }

  if (longScore >= 3 || shortScore >= 3) {
    debug.candidates++;
    console.log(symbol, "CANDIDATE", "LONG:", longScore.toFixed(1), "SHORT:", shortScore.toFixed(1));
  }

  if (longScore >= MIN_SCORE_SNIPER && trendLong && nearHigh && momentumLong && bodyOk) {
    const entry = last;
    const stop = Math.min(...l.slice(-8, -1)) - a * 0.25;
    const tp1 = entry + (entry - stop) * 0.8;
    const tp2 = entry + (entry - stop) * 1.45;
    const R = rr(entry, stop, tp2);

    if (R < MIN_RR) {
      debug.rrFail++;
      return null;
    }

    debug.sniperPassed++;
    return { mode: "SNIPER", coin: symbol, side: "LONG", score: longScore, entry, stop, tp1, tp2, rr: R };
  }

  if (shortScore >= MIN_SCORE_SNIPER && trendShort && nearLow && momentumShort && bodyOk) {
    const entry = last;
    const stop = Math.max(...h.slice(-8, -1)) + a * 0.25;
    const tp1 = entry - (stop - entry) * 0.8;
    const tp2 = entry - (stop - entry) * 1.45;
    const R = rr(entry, stop, tp2);

    if (R < MIN_RR) {
      debug.rrFail++;
      return null;
    }

    debug.sniperPassed++;
    return { mode: "SNIPER", coin: symbol, side: "SHORT", score: shortScore, entry, stop, tp1, tp2, rr: R };
  }

  debug.scoreFail++;
  return null;
}

async function scanTrend(symbol, debug) {
  const d = await klines(symbol, TREND_TF, 120);
  if (!Array.isArray(d) || d.length < 60) return null;

  const c = closes(d), h = highs(d), l = lows(d), v = volumes(d);
  const last = c.at(-1);
  const prev = c.at(-3);
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  const a = atr(d);

  if (!a || (a / last) * 100 < 0.10) return null;

  const volOk = v.at(-1) > avg(v.slice(-21, -1)) * 0.95;
  const trendLong = e20.at(-1) > e50.at(-1);
  const trendShort = e20.at(-1) < e50.at(-1);

  const high8 = Math.max(...h.slice(-9, -1));
  const low8 = Math.min(...l.slice(-9, -1));

  let longScore = 0;
  let shortScore = 0;

  if (trendLong) longScore += 2.0;
  if (trendShort) shortScore += 2.0;

  if (last > prev) longScore += 0.8;
  if (last < prev) shortScore += 0.8;

  if (last > high8 * 0.995) longScore += 1.2;
  if (last < low8 * 1.005) shortScore += 1.2;

  if (volOk) {
    longScore += 0.7;
    shortScore += 0.7;
  }

  if (longScore >= MIN_SCORE_TREND && trendLong && last > e20.at(-1)) {
    const entry = last;
    const stop = Math.min(...l.slice(-8, -1)) - a * 0.15;
    const tp1 = entry + (entry - stop) * 0.7;
    const tp2 = entry + (entry - stop) * 1.25;
    const R = rr(entry, stop, tp2);

    if (R < MIN_RR) {
      debug.rrFail++;
      return null;
    }

    debug.trendPassed++;
    return { mode: "TREND", coin: symbol, side: "LONG", score: longScore, entry, stop, tp1, tp2, rr: R };
  }

  if (shortScore >= MIN_SCORE_TREND && trendShort && last < e20.at(-1)) {
    const entry = last;
    const stop = Math.max(...h.slice(-8, -1)) + a * 0.15;
    const tp1 = entry - (stop - entry) * 0.7;
    const tp2 = entry - (stop - entry) * 1.25;
    const R = rr(entry, stop, tp2);

    if (R < MIN_RR) {
      debug.rrFail++;
      return null;
    }

    debug.trendPassed++;
    return { mode: "TREND", coin: symbol, side: "SHORT", score: shortScore, entry, stop, tp1, tp2, rr: R };
  }

  return null;
}

async function updateActiveTrade() {
  if (!activeTrade) return;

  const p = await price(activeTrade.coin);
  if (!p) return;

  if (activeTrade.side === "LONG") {
    if (p >= activeTrade.tp2) {
      await send(`🟢 TP2 HIT\n${activeTrade.coin} LONG\nLive: ${fmt(p)}`);
      activeTrade = null;
      return;
    }

    if (p <= activeTrade.stop) {
      await send(`🔴 STOP HIT\n${activeTrade.coin} LONG\nLive: ${fmt(p)}`);
      activeTrade = null;
      return;
    }

    if (!activeTrade.tp1Hit && p >= activeTrade.tp1) {
      activeTrade.tp1Hit = true;
      activeTrade.stop = activeTrade.entry;
      await send(`🟡 TP1 HIT / STOP BE\n${activeTrade.coin} LONG\nLive: ${fmt(p)}`);
    }
  }

  if (activeTrade.side === "SHORT") {
    if (p <= activeTrade.tp2) {
      await send(`🟢 TP2 HIT\n${activeTrade.coin} SHORT\nLive: ${fmt(p)}`);
      activeTrade = null;
      return;
    }

    if (p >= activeTrade.stop) {
      await send(`🔴 STOP HIT\n${activeTrade.coin} SHORT\nLive: ${fmt(p)}`);
      activeTrade = null;
      return;
    }

    if (!activeTrade.tp1Hit && p <= activeTrade.tp1) {
      activeTrade.tp1Hit = true;
      activeTrade.stop = activeTrade.entry;
      await send(`🟡 TP1 HIT / STOP BE\n${activeTrade.coin} SHORT\nLive: ${fmt(p)}`);
    }
  }
}

async function run() {
  console.log("RUN");

  if (!COINS.length) {
    console.log("COIN_LIST EMPTY");
    return;
  }

  await updateActiveTrade();

  if (activeTrade) {
    console.log("ACTIVE:", activeTrade.coin, activeTrade.side);
    return;
  }

  const debug = {
    checked: 0,
    dataFail: 0,
    volatilityFail: 0,
    candidates: 0,
    scoreFail: 0,
    rrFail: 0,
    sniperPassed: 0,
    trendPassed: 0
  };

  let bestSniper = null;
  let bestTrend = null;

  for (const coin of COINS) {
    const s = await scanSniper(coin, debug);
    if (s && (!bestSniper || s.score > bestSniper.score || (s.score === bestSniper.score && s.rr > bestSniper.rr))) {
      bestSniper = s;
    }

    const t = await scanTrend(coin, debug);
    if (t && (!bestTrend || t.score > bestTrend.score || (t.score === bestTrend.score && t.rr > bestTrend.rr))) {
      bestTrend = t;
    }
  }

  console.log("DEBUG:", debug);
  console.log("BEST SNIPER:", bestSniper ? `${bestSniper.coin} ${bestSniper.side} ${bestSniper.score.toFixed(1)} RR:${bestSniper.rr.toFixed(2)}` : "NONE");
  console.log("BEST TREND:", bestTrend ? `${bestTrend.coin} ${bestTrend.side} ${bestTrend.score.toFixed(1)} RR:${bestTrend.rr.toFixed(2)}` : "NONE");

  const best = bestSniper || bestTrend;

  if (!best) {
    console.log("NO SIGNAL");
    return;
  }

  const sent = await send(signalText(best));

  if (sent) {
    activeTrade = {
      ...best,
      tp1Hit: false,
      createdAt: Date.now()
    };

    console.log("SIGNAL SENT:", best.coin, best.side);
  }
}

async function main() {
  if (!TG_TOKEN || !CHAT_ID || !COINS.length) {
    console.log("ENV ERROR: TG_BOT_TOKEN / TG_CHAT_ID / COIN_LIST");
    return;
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
