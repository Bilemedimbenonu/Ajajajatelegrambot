const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const TREND_TF = process.env.TREND_TF || "15m";
const HTF = process.env.HTF || "1h";

const MIN_SCORE_SNIPER = parseFloat(process.env.MIN_SCORE_SNIPER || "6");
const MIN_SCORE_TREND = parseFloat(process.env.MIN_SCORE_TREND || "5");

const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);
const DUPLICATE_TTL_MS = parseInt(process.env.DUPLICATE_TTL_MS || "1800000", 10);

const lastSignalAt = new Map();
const activeTrades = new Map();

console.log("V8 PRO BOT STARTED");

async function fetchKlines(symbol, interval = "5m", limit = 120) {
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
    console.log("fetchKlines error:", symbol, interval, e?.message || e);
    return null;
  }
}

async function fetchPrice(symbol) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const p = parseFloat(data.price);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

function closes(data) { return data.map(x => parseFloat(x[4])); }
function opens(data) { return data.map(x => parseFloat(x[1])); }
function highs(data) { return data.map(x => parseFloat(x[2])); }
function lows(data) { return data.map(x => parseFloat(x[3])); }
function volumes(data) { return data.map(x => parseFloat(x[5])); }

function avg(arr) {
  if (!arr?.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(values, period) {
  if (!values?.length) return [];
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
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return 0;
  return ((to - from) / from) * 100;
}

function calcRSI(closesArr, period = 14) {
  if (closesArr.length < period + 1) return [50];

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const d = closesArr[i] - closesArr[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  const out = [50];

  for (let i = period + 1; i < closesArr.length; i++) {
    const d = closesArr[i] - closesArr[i - 1];
    const gain = Math.max(d, 0);
    const loss = Math.max(-d, 0);

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push(100 - (100 / (1 + rs)));
  }

  return out;
}

function atrFromKlines(klines, period = 14) {
  if (!Array.isArray(klines) || klines.length < period + 2) return null;

  const h = highs(klines);
  const l = lows(klines);
  const c = closes(klines);

  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    trs.push(
      Math.max(
        h[i] - l[i],
        Math.abs(h[i] - c[i - 1]),
        Math.abs(l[i] - c[i - 1])
      )
    );
  }

  let atr = avg(trs.slice(0, period));
  for (let i = period; i < trs.length; i++) {
    atr = ((atr * (period - 1)) + trs[i]) / period;
  }
  return atr;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function riskReward(entry, stop, tp2, side) {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp2 - entry);
  if (risk <= 0) return 0;
  return reward / risk;
}

function shouldSkipDuplicate(signalKey) {
  const ts = lastSignalAt.get(signalKey);
  if (!ts) return false;
  return (Date.now() - ts) < DUPLICATE_TTL_MS;
}

function markSignal(signalKey) {
  lastSignalAt.set(signalKey, Date.now());
}

async function getBTCBias() {
  const [trendData, htfData] = await Promise.all([
    fetchKlines("BTCUSDT", TREND_TF, 80),
    fetchKlines("BTCUSDT", HTF, 80),
  ]);

  if (!trendData || !htfData) return { bias: "MIX", momentum: 0 };

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

  const momentum = Math.abs(pctMove(cTrend.at(-10), cTrend.at(-1)));
  return { bias, momentum };
}

async function checkSniper(symbol, btc) {
  try {
    const [entryData, trendData, htfData] = await Promise.all([
      fetchKlines(symbol, ENTRY_TF, 120),
      fetchKlines(symbol, TREND_TF, 120),
      fetchKlines(symbol, HTF, 120),
    ]);

    if (!entryData || !trendData || !htfData) return null;
    if (btc.bias === "MIX" || btc.momentum < 0.05) return null;

    const c = closes(entryData);
    const o = opens(entryData);
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

    const atr = atrFromKlines(entryData, 14);
    if (!atr) return null;

    const last = c.at(-1);
    const prev = c.at(-2);
    const prev2 = c.at(-3);

    const pOpen = o.at(-2);
    const pHigh = h.at(-2);
    const pLow = l.at(-2);
    const ppHigh = h.at(-3);
    const ppLow = l.at(-3);

    const avgVol = avg(v.slice(-20, -1));
    const volNow = v.at(-1);
    const volumeSpike = volNow > avgVol * 1.15;
    if (!volumeSpike) return null;

    const trendLong = ema20Trend.at(-1) > ema50Trend.at(-1) && ema20Htf.at(-1) > ema50Htf.at(-1);
    const trendShort = ema20Trend.at(-1) < ema50Trend.at(-1) && ema20Htf.at(-1) < ema50Htf.at(-1);

    const recentHigh = Math.max(...h.slice(-10, -3));
    const recentLow = Math.min(...l.slice(-10, -3));

    const sweepLong = ppLow < recentLow && prev > recentLow;
    const sweepShort = ppHigh > recentHigh && prev < recentHigh;

    const prevRange = Math.max(pHigh - pLow, 0.0000001);
    const prevBody = Math.abs(prev - pOpen);
    const prevUpper = pHigh - Math.max(pOpen, prev);
    const prevLower = Math.min(pOpen, prev) - pLow;
    const prevBodyRatio = prevBody / prevRange;

    const antiWickLong = prevUpper <= prevRange * 0.35;
    const antiWickShort = prevLower <= prevRange * 0.35;

    const confirmLong = prev > pOpen && prevBodyRatio >= 0.40 && antiWickLong;
    const confirmShort = prev < pOpen && prevBodyRatio >= 0.40 && antiWickShort;

    const reclaimLong = prev > recentLow && prev > ema20Entry.at(-2);
    const reclaimShort = prev < recentHigh && prev < ema20Entry.at(-2);

    const plannedLongEntry = Math.min(last, prev - atr * 0.05);
    const plannedShortEntry = Math.max(last, prev + atr * 0.05);

    const longContinuation = l.at(-1) > pLow && last > prev && last >= plannedLongEntry;
    const shortContinuation = h.at(-1) < pHigh && last < prev && last <= plannedShortEntry;

    const nearEmaLong = Math.abs(plannedLongEntry - ema20Entry.at(-1)) / plannedLongEntry * 100 <= 0.55;
    const nearEmaShort = Math.abs(plannedShortEntry - ema20Entry.at(-1)) / plannedShortEntry * 100 <= 0.55;

    const rsi = calcRSI(c, 14).at(-1);
    const reactionLong = Math.abs(prev - recentLow) / atr;
    const reactionShort = Math.abs(recentHigh - prev) / atr;
    const displacement = Math.abs(prev - prev2);

    let longScore = 0;
    longScore += trendLong ? 3 : 0;
    longScore += btc.bias === "LONG" ? 2 : 0;
    longScore += sweepLong ? 2 : 0;
    longScore += reclaimLong ? 1.5 : 0;
    longScore += confirmLong ? 1.5 : 0;
    longScore += nearEmaLong ? 1 : 0;
    longScore += volumeSpike ? 1 : 0;
    longScore += (rsi >= 40 && rsi <= 65) ? 1 : 0;
    longScore += reactionLong >= 0.8 ? 1 : 0;
    longScore += displacement >= atr * 0.6 ? 1 : 0;

    let shortScore = 0;
    shortScore += trendShort ? 3 : 0;
    shortScore += btc.bias === "SHORT" ? 2 : 0;
    shortScore += sweepShort ? 2 : 0;
    shortScore += reclaimShort ? 1.5 : 0;
    shortScore += confirmShort ? 1.5 : 0;
    shortScore += nearEmaShort ? 1 : 0;
    shortScore += volumeSpike ? 1 : 0;
    shortScore += (rsi >= 35 && rsi <= 60) ? 1 : 0;
    shortScore += reactionShort >= 0.8 ? 1 : 0;
    shortScore += displacement >= atr * 0.6 ? 1 : 0;

    if (
      longScore >= MIN_SCORE_SNIPER &&
      trendLong &&
      btc.bias === "LONG" &&
      sweepLong &&
      reclaimLong &&
      confirmLong &&
      nearEmaLong &&
      longContinuation &&
      (rsi >= 40 && rsi <= 65) &&
      reactionLong >= 0.8 &&
      displacement >= atr * 0.6
    ) {
      const stop = Math.min(ppLow, recentLow) - atr * 0.55;
      const tp1 = plannedLongEntry + (plannedLongEntry - stop) * 1.0;
      const tp2 = plannedLongEntry + (plannedLongEntry - stop) * 2.0;
      const rr = riskReward(plannedLongEntry, stop, tp2, "LONG");
      if (rr < 1.5) return null;

      return {
        mode: "SNIPER",
        coin: symbol,
        side: "LONG",
        score: longScore,
        entry: plannedLongEntry,
        stop,
        tp1,
        tp2,
        rr
      };
    }

    if (
      shortScore >= MIN_SCORE_SNIPER &&
      trendShort &&
      btc.bias === "SHORT" &&
      sweepShort &&
      reclaimShort &&
      confirmShort &&
      nearEmaShort &&
      shortContinuation &&
      (rsi >= 35 && rsi <= 60) &&
      reactionShort >= 0.8 &&
      displacement >= atr * 0.6
    ) {
      const stop = Math.max(ppHigh, recentHigh) + atr * 0.55;
      const tp1 = plannedShortEntry - (stop - plannedShortEntry) * 1.0;
      const tp2 = plannedShortEntry - (stop - plannedShortEntry) * 2.0;
      const rr = riskReward(plannedShortEntry, stop, tp2, "SHORT");
      if (rr < 1.5) return null;

      return {
        mode: "SNIPER",
        coin: symbol,
        side: "SHORT",
        score: shortScore,
        entry: plannedShortEntry,
        stop,
        tp1,
        tp2,
        rr
      };
    }

    return null;
  } catch (e) {
    console.log("checkSniper error:", symbol, e?.message || e);
    return null;
  }
}

async function checkTrend(symbol, btc) {
  try {
    const [entryData, trendData, htfData] = await Promise.all([
      fetchKlines(symbol, ENTRY_TF, 80),
      fetchKlines(symbol, TREND_TF, 80),
      fetchKlines(symbol, HTF, 80)
    ]);

    if (!entryData || !trendData || !htfData) return null;
    if (btc.bias === "MIX" || btc.momentum < 0.05) return null;

    const c = closes(entryData);
    const o = opens(entryData);
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
    const lastOpen = o.at(-1);
    const lastHigh = h.at(-1);
    const lastLow = l.at(-1);

    const prevHigh5 = Math.max(...h.slice(-6, -1));
    const prevLow5 = Math.min(...l.slice(-6, -1));

    const volNow = v.at(-1);
    const avgVol = avg(v.slice(-20, -1));
    const volumeSpike = volNow > avgVol * 1.2;
    if (!volumeSpike) return null;

    const trendLong = ema20Trend.at(-1) > ema50Trend.at(-1) && ema20Htf.at(-1) > ema50Htf.at(-1);
    const trendShort = ema20Trend.at(-1) < ema50Trend.at(-1) && ema20Htf.at(-1) < ema50Htf.at(-1);

    const momentum = pctMove(c.at(-4), last);
    const nearEma = Math.abs(last - ema20Entry.at(-1)) / last < 0.02;

    const candleBody = Math.abs(last - lastOpen);
    const candleRange = Math.max(lastHigh - lastLow, 0.0000001);
    const upperWick = lastHigh - Math.max(last, lastOpen);
    const lowerWick = Math.min(last, lastOpen) - lastLow;

    let longScore = 0;
    let shortScore = 0;

    if (btc.bias === "LONG" && trendLong && last > prevHigh5) longScore += 3;
    if (btc.bias === "SHORT" && trendShort && last < prevLow5) shortScore += 3;

    if (volumeSpike) {
      longScore += 2;
      shortScore += 2;
    }

    if (momentum > 0.12) longScore += 1;
    if (momentum < -0.12) shortScore += 1;

    if (nearEma) {
      longScore += 1;
      shortScore += 1;
    }

    if (candleBody > candleRange * 0.4) {
      longScore += 1;
      shortScore += 1;
    }

    if (upperWick < candleRange * 0.4) longScore += 1;
    if (lowerWick < candleRange * 0.4) shortScore += 1;

    if (longScore >= MIN_SCORE_TREND) {
      const stop = prevLow5;
      const tp1 = last + Math.abs(last - stop) * 0.8;
      const tp2 = last + Math.abs(last - stop) * 1.5;
      const rr = riskReward(last, stop, tp2, "LONG");
      if (rr < 1.3) return null;

      return {
        mode: "TREND",
        coin: symbol,
        side: "LONG",
        score: longScore,
        entry: last,
        stop,
        tp1,
        tp2,
        rr
      };
    }

    if (shortScore >= MIN_SCORE_TREND) {
      const stop = prevHigh5;
      const tp1 = last - Math.abs(stop - last) * 0.8;
      const tp2 = last - Math.abs(stop - last) * 1.5;
      const rr = riskReward(last, stop, tp2, "SHORT");
      if (rr < 1.3) return null;

      return {
        mode: "TREND",
        coin: symbol,
        side: "SHORT",
        score: shortScore,
        entry: last,
        stop,
        tp1,
        tp2,
        rr
      };
    }

    return null;
  } catch (e) {
    console.log("checkTrend error:", symbol, e?.message || e);
    return null;
  }
}

function formatSignal(sig, btc) {
  const sizeNote = sig.mode === "TREND" ? "SMALL SIZE ONLY" : "MAIN SETUP";
  return `🔥 ${sig.mode} SIGNAL

Coin: ${sig.coin}
Side: ${sig.side}
Score: ${sig.score.toFixed(1)}

Entry: ${fmt(sig.entry)}
Stop: ${fmt(sig.stop)}
TP1: ${fmt(sig.tp1)}
TP2: ${fmt(sig.tp2)}
RR: ${sig.rr.toFixed(2)}

BTC Bias: ${btc.bias}
BTC Mom: ${btc.momentum.toFixed(2)}%

${sizeNote}`;
}

function formatExit(trade, price, state, reason) {
  return `🔴 SMART EXIT

Coin: ${trade.coin}
Side: ${trade.side}
State: ${state}

Entry: ${fmt(trade.entry)}
Live: ${fmt(price)}
Stop: ${fmt(trade.stop)}
TP1: ${fmt(trade.tp1)}
TP2: ${fmt(trade.tp2)}

Reason: ${reason}`;
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

async function updateActiveTrades() {
  for (const [key, trade] of activeTrades.entries()) {
    const price = await fetchPrice(trade.coin);
    if (!price) continue;

    let state = "HOLD";
    let reason = "No decisive weakness.";

    if (trade.side === "LONG") {
      if (!trade.tp1Hit && price >= trade.tp1) {
        trade.tp1Hit = true;
        trade.stop = trade.entry;
        state = "CONTINUE";
        reason = "TP1 reached, move stop to break-even.";
      } else if (price <= trade.stop) {
        state = "EXIT";
        reason = "Stop reached.";
      } else if (price >= trade.tp2) {
        state = "EXIT";
        reason = "TP2 reached.";
      }
    } else {
      if (!trade.tp1Hit && price <= trade.tp1) {
        trade.tp1Hit = true;
        trade.stop = trade.entry;
        state = "CONTINUE";
        reason = "TP1 reached, move stop to break-even.";
      } else if (price >= trade.stop) {
        state = "EXIT";
        reason = "Stop reached.";
      } else if (price <= trade.tp2) {
        state = "EXIT";
        reason = "TP2 reached.";
      }
    }

    if (state !== "HOLD" || !trade.lastPreviewSent) {
      await sendTelegram(formatExit(trade, price, state, reason));
      trade.lastPreviewSent = true;
    }

    if (state === "EXIT") {
      activeTrades.delete(key);
    } else {
      activeTrades.set(key, trade);
    }
  }
}

async function run() {
  console.log("RUN START");

  if (!COINS.length) {
    console.log("COIN_LIST is empty");
    return;
  }

  await updateActiveTrades();

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

  const best = bestSniper || bestTrend;
  if (!best) {
    console.log("No signal found in this cycle");
    console.log("RUN END");
    return;
  }

  const signalKey = `${best.mode}:${best.coin}:${best.side}`;
  if (shouldSkipDuplicate(signalKey)) {
    console.log("Duplicate skipped:", signalKey);
    console.log("RUN END");
    return;
  }

  markSignal(signalKey);
  console.log(`Best ${best.mode.toLowerCase()}:`, best.coin);

  await sendTelegram(formatSignal(best, btc));

  activeTrades.set(signalKey, {
    ...best,
    tp1Hit: false,
    lastPreviewSent: false,
    createdAt: Date.now()
  });

  console.log("RUN END");
}

async function main() {
  if (!TG_TOKEN || !CHAT_ID || COINS.length === 0) {
    console.log("Missing TG_BOT_TOKEN / TG_CHAT_ID / COIN_LIST");
    process.exit(1);
  }

  while (true) {
    await run();
    await new Promise(resolve => setTimeout(resolve, LOOP_MS));
  }
}

main().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
