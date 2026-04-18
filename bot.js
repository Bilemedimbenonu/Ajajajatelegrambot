const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const TREND_TF = process.env.TREND_TF || "15m";
const HTF = process.env.HTF || "1h";

console.log("BOT STARTED");

async function fetchKlines(symbol, interval = "5m", limit = 80) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);

    if (!res.ok) {
      console.log(`Fetch failed: ${symbol} ${interval} ${res.status}`);
      return null;
    }

    const data = await res.json();

    if (!Array.isArray(data)) return null;
    if (data.length < 10) return null;
    if (!Array.isArray(data[0])) return null;

    return data;
  } catch (e) {
    console.log("fetchKlines error:", symbol, e?.message || e);
    return null;
  }
}

function closes(data) {
  return data.map(x => parseFloat(x[4]));
}

function highs(data) {
  return data.map(x => parseFloat(x[2]));
}

function lows(data) {
  return data.map(x => parseFloat(x[3]));
}

function volumes(data) {
  return data.map(x => parseFloat(x[5]));
}

function avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];

  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }

  return out;
}

function pctMove(from, to) {
  if (!from || !Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return ((to - from) / from) * 100;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function getMomentumFromData(data, lookback = 2) {
  if (!data || data.length <= lookback) return 0;
  const c = closes(data);
  const last = c.at(-1);
  const prev = c.at(-1 - lookback);
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return 0;
  return pctMove(prev, last);
}

async function getBTCBias() {
  const trendData = await fetchKlines("BTCUSDT", TREND_TF, 80);
  const htfData = await fetchKlines("BTCUSDT", HTF, 80);

  if (!trendData || !htfData) {
    return { bias: "MIX", momentum: 0 };
  }

  const cTrend = closes(trendData);
  const cHtf = closes(htfData);

  const ema20Trend = ema(cTrend, 20);
  const ema50Trend = ema(cTrend, 50);
  const ema20Htf = ema(cHtf, 20);
  const ema50Htf = ema(cHtf, 50);

  const trendLong = ema20Trend.at(-1) > ema50Trend.at(-1);
  const trendShort = ema20Trend.at(-1) < ema50Trend.at(-1);
  const htfLong = ema20Htf.at(-1) > ema50Htf.at(-1);
  const htfShort = ema20Htf.at(-1) < ema50Htf.at(-1);

  let bias = "MIX";
  if (trendLong && htfLong) bias = "LONG";
  if (trendShort && htfShort) bias = "SHORT";

  const momentum = Math.abs(getMomentumFromData(trendData, 3));

  return { bias, momentum };
}

async function checkSniper(symbol, btc) {
  const [entryData, trendData, htfData] = await Promise.all([
    fetchKlines(symbol, ENTRY_TF, 80),
    fetchKlines(symbol, TREND_TF, 80),
    fetchKlines(symbol, HTF, 80)
  ]);

  if (!entryData || !trendData || !htfData) return null;
  if (btc.bias === "MIX") return null;

  const c = closes(entryData);
  const h = highs(entryData);
  const l = lows(entryData);
  const v = volumes(entryData);

  const cTrend = closes(trendData);
  const cHtf = closes(htfData);

  const ema20Entry = ema(c, 20);
  const ema20Trend = ema(cTrend, 20);
  const ema50Trend = ema(cTrend, 50);
  const ema20Htf = ema(cHtf, 20);
  const ema50Htf = ema(cHtf, 50);

  const last = c.at(-1);
  const prev = c.at(-2);
  const prev2 = c.at(-3);

  const lastHigh = h.at(-1);
  const prevHigh = h.at(-2);
  const prev2High = h.at(-3);

  const lastLow = l.at(-1);
  const prevLow = l.at(-2);
  const prev2Low = l.at(-3);

  const avgVol = avg(v.slice(-20, -1));
  const volNow = v.at(-1);
  const volumeSpike = volNow > avgVol * 1.15;

  const trendLong = ema20Trend.at(-1) > ema50Trend.at(-1) && ema20Htf.at(-1) > ema50Htf.at(-1);
  const trendShort = ema20Trend.at(-1) < ema50Trend.at(-1) && ema20Htf.at(-1) < ema50Htf.at(-1);

  const nearEma = Math.abs(last - ema20Entry.at(-1)) / last < 0.006;

  // sweep mantığı
  const sweepLong = prev2Low < Math.min(...l.slice(-10, -3)) && prev2 > prev2Low;
  const sweepShort = prev2High > Math.max(...h.slice(-10, -3)) && prev2 < prev2High;

  // continuation
  const contLong = last > prev && lastLow > prevLow;
  const contShort = last < prev && lastHigh < prevHigh;

  // wick filtresi
  const upperWick = lastHigh - last;
  const lowerWick = last - lastLow;
  const range = Math.max(lastHigh - lastLow, 0.0000001);

  let score = 0;

  if (btc.bias === "LONG" && trendLong) {
    if (nearEma) score += 2;
    if (volumeSpike) score += 2;
    if (sweepLong) score += 2;
    if (contLong) score += 2;
    if (upperWick < range * 0.35) score += 1;
    if (getMomentumFromData(entryData, 2) > 0.08) score += 1;

    if (score >= 7) {
      return {
        mode: "SNIPER",
        coin: symbol,
        side: "LONG",
        score,
        entry: last,
        stop: prevLow,
        tp1: last * 1.006,
        tp2: last * 1.012,
      };
    }
  }

  if (btc.bias === "SHORT" && trendShort) {
    if (nearEma) score += 2;
    if (volumeSpike) score += 2;
    if (sweepShort) score += 2;
    if (contShort) score += 2;
    if (lowerWick < range * 0.35) score += 1;
    if (getMomentumFromData(entryData, 2) < -0.08) score += 1;

    if (score >= 7) {
      return {
        mode: "SNIPER",
        coin: symbol,
        side: "SHORT",
        score,
        entry: last,
        stop: prevHigh,
        tp1: last * 0.994,
        tp2: last * 0.988,
      };
    }
  }

  return null;
}

async function checkTrend(symbol, btc) {
  const [entryData, trendData, htfData] = await Promise.all([
    fetchKlines(symbol, ENTRY_TF, 60),
    fetchKlines(symbol, TREND_TF, 60),
    fetchKlines(symbol, HTF, 60)
  ]);

  if (!entryData || !trendData || !htfData) return null;
  if (btc.bias === "MIX") return null;

  const c = closes(entryData);
  const h = highs(entryData);
  const l = lows(entryData);
  const v = volumes(entryData);

  const cTrend = closes(trendData);
  const cHtf = closes(htfData);

  const ema20Entry = ema(c, 20);
  const ema20Trend = ema(cTrend, 20);
  const ema50Trend = ema(cTrend, 50);
  const ema20Htf = ema(cHtf, 20);
  const ema50Htf = ema(cHtf, 50);

  const last = c.at(-1);
  const prevHigh5 = Math.max(...h.slice(-6, -1));
  const prevLow5 = Math.min(...l.slice(-6, -1));
  const volNow = v.at(-1);
  const avgVol = avg(v.slice(-20, -1));

  const trendLong = ema20Trend.at(-1) > ema50Trend.at(-1) && ema20Htf.at(-1) > ema50Htf.at(-1);
  const trendShort = ema20Trend.at(-1) < ema50Trend.at(-1) && ema20Htf.at(-1) < ema50Htf.at(-1);

  const momentum = getMomentumFromData(entryData, 3);
  const nearEma = Math.abs(last - ema20Entry.at(-1)) / last < 0.02;

  let score = 0;

  if (btc.bias === "LONG" && trendLong) {
    if (last > prevHigh5) score += 3;
    if (volNow > avgVol * 1.2) score += 2;
    if (momentum > 0.12) score += 2;
    if (nearEma) score += 1;

    if (score >= 6) {
      return {
        mode: "TREND",
        coin: symbol,
        side: "LONG",
        score,
        entry: last,
        stop: prevLow5,
        tp1: last * 1.005,
        tp2: last * 1.01,
      };
    }
  }

  if (btc.bias === "SHORT" && trendShort) {
    if (last < prevLow5) score += 3;
    if (volNow > avgVol * 1.2) score += 2;
    if (momentum < -0.12) score += 2;
    if (nearEma) score += 1;

    if (score >= 6) {
      return {
        mode: "TREND",
        coin: symbol,
        side: "SHORT",
        score,
        entry: last,
        stop: prevHigh5,
        tp1: last * 0.995,
        tp2: last * 0.99,
      };
    }
  }

  return null;
}

function formatSignal(sig, btc) {
  const sizeNote = sig.mode === "TREND" ? "Small size only" : "Main setup";
  return `🔥 ${sig.mode} SIGNAL

Coin: ${sig.coin}
Side: ${sig.side}
Score: ${sig.score}

Entry: ${fmt(sig.entry)}
Stop: ${fmt(sig.stop)}
TP1: ${fmt(sig.tp1)}
TP2: ${fmt(sig.tp2)}

BTC Bias: ${btc.bias}
BTC Mom: ${btc.momentum.toFixed(2)}%

${sizeNote}`;
}

async function sendTelegram(msg) {
  if (!TG_TOKEN || !CHAT_ID) {
    console.log("Missing TG_BOT_TOKEN or TG_CHAT_ID");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: msg
      })
    });

    const text = await res.text();
    console.log("Telegram response:", text);
  } catch (e) {
    console.log("Telegram send error:", e?.message || e);
  }
}

async function run() {
  console.log("RUN START");

  if (!COINS.length) {
    console.log("COIN_LIST is empty");
    return;
  }

  const btc = await getBTCBias();
  console.log("BTC:", btc);

  let bestSniper = null;
  let bestTrend = null;

  for (const coin of COINS) {
    const sniper = await checkSniper(coin, btc);
    if (sniper && (!bestSniper || sniper.score > bestSniper.score)) {
      bestSniper = sniper;
    }

    const trend = await checkTrend(coin, btc);
    if (trend && (!bestTrend || trend.score > bestTrend.score)) {
      bestTrend = trend;
    }

    if (!sniper && !trend) {
      console.log("No signal:", coin);
    }
  }

  if (bestSniper) {
    console.log("Best sniper:", bestSniper.coin);
    await sendTelegram(formatSignal(bestSniper, btc));
  } else if (bestTrend) {
    console.log("Best trend:", bestTrend.coin);
    await sendTelegram(formatSignal(bestTrend, btc));
  } else {
    console.log("No signal found in this cycle");
  }

  console.log("RUN END");
}

async function main() {
  if (!TG_TOKEN || !CHAT_ID || COINS.length === 0) {
    console.log("Missing TG_BOT_TOKEN / TG_CHAT_ID / COIN_LIST");
    process.exit(1);
  }

  while (true) {
    await run();
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

main().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
