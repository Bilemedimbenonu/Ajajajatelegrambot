// =====================================
// FINAL ELITE BOT
// Strict Trend + Sniper Scanner
// Railway / Node 18+
// =====================================

// ---------- ENV ----------
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID;

const DEFAULT_COINS =
  "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LINKUSDT,TRXUSDT,MATICUSDT,TONUSDT,SHIBUSDT,APTUSDT,NEARUSDT,OPUSDT,ARBUSDT,INJUSDT,ATOMUSDT,FTMUSDT,SUIUSDT,SEIUSDT,PEPEUSDT,FLOKIUSDT,ORDIUSDT,IMXUSDT,LDOUSDT,RUNEUSDT,GALAUSDT,SANDUSDT,MANAUSDT,AXSUSDT,CHZUSDT,UNIUSDT,AAVEUSDT,CRVUSDT,ENSUSDT,BLURUSDT,DYDXUSDT,JUPUSDT";

const RAW_ALLOWLIST = process.env.ALLOWLIST;
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 60000);
const MIN_SCORE = Number(process.env.MIN_SCORE || 7.5);
const MAX_ALERTS_PER_SCAN = Number(process.env.MAX_ALERTS_PER_SCAN || 2);
const SIGNAL_COOLDOWN_MS = Number(process.env.SIGNAL_COOLDOWN_MS || 45 * 60 * 1000);
const MIN_NOTIONAL_FILTER = Number(process.env.MIN_NOTIONAL_FILTER || 0); // placeholder for future use

const ALLOWLIST = (RAW_ALLOWLIST && RAW_ALLOWLIST.trim().length > 10
  ? RAW_ALLOWLIST
  : DEFAULT_COINS)
  .split(",")
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

// ---------- STARTUP LOG ----------
console.log("🚀 ELITE BOT STARTED");
console.log("TOKEN:", TELEGRAM_BOT_TOKEN ? "OK" : "MISSING");
console.log("CHAT ID:", TELEGRAM_CHAT_ID ? "OK" : "MISSING");
console.log("ENV ALLOWLIST:", RAW_ALLOWLIST || "NOT FOUND -> USING DEFAULT 40");
console.log("COINS:", ALLOWLIST.length);
console.log("SCAN_INTERVAL_MS:", SCAN_INTERVAL_MS);
console.log("MIN_SCORE:", MIN_SCORE);
console.log("MAX_ALERTS_PER_SCAN:", MAX_ALERTS_PER_SCAN);

// ---------- STATE ----------
const lastSignalMap = new Map();

// ---------- HELPERS ----------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function avg(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function isValidNumber(v) {
  return Number.isFinite(v) && !Number.isNaN(v);
}

function pctChange(a, b) {
  if (!isValidNumber(a) || !isValidNumber(b) || b === 0) return 0;
  return ((a - b) / b) * 100;
}

// ---------- TELEGRAM ----------
async function sendTelegram(text) {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.log("❌ Telegram env missing. Message skipped.");
      return;
    }

    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text
      })
    });

    const data = await res.json();
    console.log("📨 Telegram response:", data);
  } catch (err) {
    console.error("❌ Telegram error:", err);
  }
}

// ---------- DATA ----------
async function getKlines(symbol, interval = "5m", limit = 150) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!Array.isArray(data)) {
      console.log(`❌ Invalid klines for ${symbol} ${interval}:`, data);
      return null;
    }

    return data.map(k => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6]
    }));
  } catch (err) {
    console.log(`❌ Klines fetch failed for ${symbol} ${interval}`);
    return null;
  }
}

// ---------- INDICATORS ----------
function ema(values, length = 20) {
  if (!Array.isArray(values) || values.length < length) return null;

  const k = 2 / (length + 1);
  let current = avg(values.slice(0, length));

  for (let i = length; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
  }

  return current;
}

function rsi(values, length = 14) {
  if (!Array.isArray(values) || values.length < length + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / length;
  let avgLoss = losses / length;

  for (let i = length + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = ((avgGain * (length - 1)) + gain) / length;
    avgLoss = ((avgLoss * (length - 1)) + loss) / length;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function atr(klines, length = 14) {
  if (!Array.isArray(klines) || klines.length < length + 1) return null;

  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high;
    const l = klines[i].low;
    const pc = klines[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  return avg(trs.slice(-length));
}

// ---------- ANALYSIS ----------
function analyzeTrend(klines5m, klines15m) {
  const closes5 = klines5m.map(x => x.close);
  const closes15 = klines15m.map(x => x.close);
  const vols5 = klines5m.map(x => x.volume);

  const price5 = closes5.at(-1);
  const price15 = closes15.at(-1);

  const ema20_5 = ema(closes5, 20);
  const ema20_15 = ema(closes15, 20);

  const rsi5 = rsi(closes5, 14);
  const rsi15 = rsi(closes15, 14);

  const mom5 = pctChange(closes5.at(-1), closes5.at(-4));
  const mom15 = pctChange(closes15.at(-1), closes15.at(-4));

  const lastVol = vols5.at(-1);
  const avgVol = avg(vols5.slice(-11, -1));
  const volumeBoost = avgVol > 0 ? lastVol / avgVol : 0;

  if (![price5, price15, ema20_5, ema20_15, rsi5, rsi15, mom5, mom15, volumeBoost].every(isValidNumber)) {
    return null;
  }

  let side = "NONE";
  let score = 0;
  const reasons = [];

  if (price5 > ema20_5 && price15 > ema20_15) {
    side = "LONG";
    score += 3.0;
    reasons.push("5m+15m above EMA20");
  } else if (price5 < ema20_5 && price15 < ema20_15) {
    side = "SHORT";
    score += 3.0;
    reasons.push("5m+15m below EMA20");
  } else {
    return {
      side: "NONE",
      score: 0,
      reasons: ["Trend mismatch across timeframes"]
    };
  }

  if (side === "LONG" && rsi5 >= 56) {
    score += 1.0;
    reasons.push("RSI 5m strong");
  }
  if (side === "LONG" && rsi15 >= 54) {
    score += 1.0;
    reasons.push("RSI 15m strong");
  }
  if (side === "SHORT" && rsi5 <= 44) {
    score += 1.0;
    reasons.push("RSI 5m weak");
  }
  if (side === "SHORT" && rsi15 <= 46) {
    score += 1.0;
    reasons.push("RSI 15m weak");
  }

  if (side === "LONG" && mom5 > 0.10) {
    score += 0.75;
    reasons.push("5m momentum positive");
  }
  if (side === "LONG" && mom15 > 0.20) {
    score += 0.75;
    reasons.push("15m momentum positive");
  }
  if (side === "SHORT" && mom5 < -0.10) {
    score += 0.75;
    reasons.push("5m momentum negative");
  }
  if (side === "SHORT" && mom15 < -0.20) {
    score += 0.75;
    reasons.push("15m momentum negative");
  }

  if (volumeBoost >= 1.15) {
    score += 0.75;
    reasons.push("Volume expansion");
  }

  return {
    side,
    score,
    price: price5,
    ema20_5,
    ema20_15,
    rsi5,
    rsi15,
    mom5,
    mom15,
    volumeBoost,
    reasons
  };
}

function analyzeSniper(klines5m, trendSide) {
  const closes = klines5m.map(x => x.close);
  const highs = klines5m.map(x => x.high);
  const lows = klines5m.map(x => x.low);
  const opens = klines5m.map(x => x.open);
  const volumes = klines5m.map(x => x.volume);

  const lastClose = closes.at(-1);
  const prevClose = closes.at(-2);
  const lastOpen = opens.at(-1);
  const lastHigh = highs.at(-1);
  const lastLow = lows.at(-1);

  const prevHigh = highs.at(-2);
  const prevLow = lows.at(-2);
  const lastVol = volumes.at(-1);
  const avgVol = avg(volumes.slice(-11, -1));
  const volBoost = avgVol > 0 ? lastVol / avgVol : 0;
  const bodyPct = Math.abs((lastClose - lastOpen) / lastOpen) * 100;
  const wickUp = Math.abs(lastHigh - Math.max(lastOpen, lastClose));
  const wickDown = Math.abs(Math.min(lastOpen, lastClose) - lastLow);
  const candleRange = lastHigh - lastLow || 1;
  const atrVal = atr(klines5m, 14);

  if (![lastClose, prevClose, lastOpen, prevHigh, prevLow, volBoost, bodyPct, candleRange, atrVal].every(isValidNumber)) {
    return null;
  }

  let side = "NONE";
  let score = 0;
  const reasons = [];

  const bullishReclaim = lastLow < prevLow && lastClose > prevClose && lastClose > lastOpen;
  const bearishReclaim = lastHigh > prevHigh && lastClose < prevClose && lastClose < lastOpen;

  if (trendSide === "LONG" && bullishReclaim) {
    side = "LONG";
    score += 2.25;
    reasons.push("Liquidity sweep reclaim long");
  }

  if (trendSide === "SHORT" && bearishReclaim) {
    side = "SHORT";
    score += 2.25;
    reasons.push("Liquidity sweep reclaim short");
  }

  if (trendSide === "LONG" && side === "LONG" && bodyPct >= 0.18) {
    score += 0.75;
    reasons.push("Strong bullish body");
  }

  if (trendSide === "SHORT" && side === "SHORT" && bodyPct >= 0.18) {
    score += 0.75;
    reasons.push("Strong bearish body");
  }

  if (volBoost >= 1.20) {
    score += 0.75;
    reasons.push("Sniper volume confirmation");
  }

  if (atrVal > 0) {
    const moveVsAtr = Math.abs(lastClose - prevClose) / atrVal;
    if (moveVsAtr >= 0.20) {
      score += 0.5;
      reasons.push("Impulse vs ATR");
    }
  }

  if (side === "LONG" && wickDown / candleRange > 0.35) {
    score += 0.5;
    reasons.push("Long lower wick reclaim");
  }

  if (side === "SHORT" && wickUp / candleRange > 0.35) {
    score += 0.5;
    reasons.push("Short upper wick reclaim");
  }

  return {
    side,
    score,
    volBoost,
    bodyPct,
    reasons
  };
}

function combineSignals(trend, sniper) {
  if (!trend || trend.side === "NONE") return null;

  let side = trend.side;
  let score = trend.score;
  let mode = "TREND";
  const reasons = [...(trend.reasons || [])];

  if (sniper && sniper.side === trend.side && sniper.side !== "NONE") {
    score += sniper.score + 0.75;
    mode = "TREND + SNIPER";
    reasons.push(...(sniper.reasons || []));
    reasons.push("Trend/Sniper alignment");
  } else if (sniper && sniper.side !== "NONE" && sniper.side !== trend.side) {
    score -= 2.0;
    mode = "CONFLICT";
    reasons.push("Sniper conflict");
  }

  return {
    side,
    score,
    mode,
    price: trend.price,
    trend,
    sniper,
    reasons
  };
}

// ---------- TRADE PLAN ----------
function buildTradePlan(side, entry, klines5m) {
  const atrVal = atr(klines5m, 14);
  if (!isValidNumber(entry) || !isValidNumber(atrVal)) return null;

  let stop, tp1, tp2;

  if (side === "LONG") {
    stop = entry - atrVal * 0.9;
    tp1 = entry + atrVal * 0.9;
    tp2 = entry + atrVal * 1.8;
  } else {
    stop = entry + atrVal * 0.9;
    tp1 = entry - atrVal * 0.9;
    tp2 = entry - atrVal * 1.8;
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp1 - entry);
  const rr = risk > 0 ? reward / risk : 0;

  return {
    entry: round(entry, 4),
    stop: round(stop, 4),
    tp1: round(tp1, 4),
    tp2: round(tp2, 4),
    rr: round(rr, 2),
    atr: round(atrVal, 4)
  };
}

// ---------- DEDUPE ----------
function shouldSkipSignal(symbol, side) {
  const key = `${symbol}_${side}`;
  const lastTs = lastSignalMap.get(key);
  if (!lastTs) return false;
  return (Date.now() - lastTs) < SIGNAL_COOLDOWN_MS;
}

function markSignal(symbol, side) {
  const key = `${symbol}_${side}`;
  lastSignalMap.set(key, Date.now());
}

// ---------- MAIN SCAN ----------
async function scan() {
  console.log("🔍 SCAN START");
  let sentCount = 0;

  for (const symbol of ALLOWLIST) {
    if (sentCount >= MAX_ALERTS_PER_SCAN) break;

    try {
      console.log(`➡️ Checking ${symbol}`);

      const [klines5m, klines15m] = await Promise.all([
        getKlines(symbol, "5m", 150),
        getKlines(symbol, "15m", 150)
      ]);

      if (!klines5m || !klines15m) {
        console.log(`⚠️ Missing klines: ${symbol}`);
        continue;
      }

      const trend = analyzeTrend(klines5m, klines15m);
      if (!trend || trend.side === "NONE") {
        console.log(`- Trend rejected: ${symbol}`);
        continue;
      }

      const sniper = analyzeSniper(klines5m, trend.side);
      const combined = combineSignals(trend, sniper);

      if (!combined) {
        console.log(`- Combined rejected: ${symbol}`);
        continue;
      }

      console.log(`📊 ${symbol} | side=${combined.side} | mode=${combined.mode} | score=${round(combined.score, 2)}`);

      if (combined.mode === "CONFLICT") {
        console.log(`- Conflict skip: ${symbol}`);
        continue;
      }

      if (combined.score < MIN_SCORE) {
        console.log(`- Score too low: ${symbol} ${round(combined.score, 2)}`);
        continue;
      }

      if (shouldSkipSignal(symbol, combined.side)) {
        console.log(`- Cooldown skip: ${symbol} ${combined.side}`);
        continue;
      }

      const plan = buildTradePlan(combined.side, combined.price, klines5m);
      if (!plan) {
        console.log(`- Plan build failed: ${symbol}`);
        continue;
      }

      if (plan.rr < 1.0) {
        console.log(`- RR too low: ${symbol} rr=${plan.rr}`);
        continue;
      }

      const msg =
`🔥 ${symbol}
Mode: ${combined.mode}
Side: ${combined.side}
Score: ${round(combined.score, 1)}/10

Entry: ${plan.entry}
Stop: ${plan.stop}
TP1: ${plan.tp1}
TP2: ${plan.tp2}
RR: ${plan.rr}

Decision: ENTER`;

      await sendTelegram(msg);
      markSignal(symbol, combined.side);

      console.log(`✅ SIGNAL SENT: ${symbol} ${combined.side} score=${round(combined.score, 2)}`);
      sentCount++;

      await sleep(500);
    } catch (err) {
      console.error(`❌ Scan error on ${symbol}:`, err);
    }
  }

  console.log("✅ SCAN END");
}

// ---------- START ----------
async function start() {
  await sendTelegram(`🚀 BOT LIVE | COINS: ${ALLOWLIST.length} | MODE: ELITE TREND + SNIPER`);
  await scan();
  setInterval(scan, SCAN_INTERVAL_MS);
}

start();
