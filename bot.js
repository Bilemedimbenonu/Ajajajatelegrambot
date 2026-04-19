// =======================
// 🔥 FINAL SNIPER + TREND BOT (40 COIN)
// =======================

// ===== ENV =====
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID;

const ALLOWLIST_RAW =
  process.env.ALLOWLIST ||
  "BTCUSDT,ETHUSDT,SOLUSDT";

// ===== CONFIG =====
const SCAN_INTERVAL = 60000; // 60 sn
const MIN_SCORE = 7.0;

// ===== PARSE =====
const ALLOWLIST = ALLOWLIST_RAW.split(",")
  .map(x => x.trim())
  .filter(Boolean);

// ===== LOG =====
console.log("🚀 BOT STARTED");
console.log("COINS:", ALLOWLIST.length);

// ===== TELEGRAM =====
async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text
    })
  });
}

// ===== FETCH KLINES =====
async function getKlines(symbol, interval="5m") {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=50`
    );
    return await res.json();
  } catch {
    return null;
  }
}

// ===== INDICATORS =====
function ema(data, len=20) {
  const k = 2/(len+1);
  let ema = data[0];
  for(let i=1;i<data.length;i++){
    ema = data[i]*k + ema*(1-k);
  }
  return ema;
}

function rsi(data, len=14) {
  let gains=0, losses=0;
  for(let i=1;i<=len;i++){
    const diff = data[i]-data[i-1];
    if(diff>=0) gains+=diff;
    else losses+=Math.abs(diff);
  }
  const rs = gains/(losses||1);
  return 100-(100/(1+rs));
}

// ===== ANALYZE =====
function analyze(closes) {
  const last = closes[closes.length-1];
  const prev = closes[closes.length-2];

  const ema20 = ema(closes,20);
  const rsiVal = rsi(closes,14);

  let trendScore = 0;
  let sniperScore = 0;
  let side = "NONE";

  // ===== TREND =====
  if(last > ema20) {
    trendScore += 3;
    side = "LONG";
  } else {
    trendScore += 3;
    side = "SHORT";
  }

  if(side==="LONG" && rsiVal > 55) trendScore+=2;
  if(side==="SHORT" && rsiVal < 45) trendScore+=2;

  // ===== SNIPER =====
  if(Math.abs(last-prev)/prev > 0.002) sniperScore+=3;

  if(side==="LONG" && rsiVal > 50) sniperScore+=2;
  if(side==="SHORT" && rsiVal < 50) sniperScore+=2;

  const total = trendScore + sniperScore;

  return {
    side,
    score: total,
    ema20,
    rsiVal,
    price: last
  };
}

// ===== SCAN =====
async function scan() {
  console.log("🔍 SCAN START");

  let sent = 0;

  for(const symbol of ALLOWLIST) {
    try {
      const klines = await getKlines(symbol);
      if(!klines || !Array.isArray(klines)) continue;

      const closes = klines.map(k=>Number(k[4]));

      const data = analyze(closes);

      if(data.score < MIN_SCORE) continue;

      if(sent >= 3) break;

      const entry = data.price;
      const stop = data.side==="LONG"
        ? entry*0.995
        : entry*1.005;

      const tp1 = data.side==="LONG"
        ? entry*1.005
        : entry*0.995;

      const msg =
`🔥 ${symbol}
Mode: SNIPER + TREND
Side: ${data.side}
Score: ${data.score}/10

Entry: ${entry.toFixed(4)}
Stop: ${stop.toFixed(4)}
TP1: ${tp1.toFixed(4)}

Decision: ENTER`;

      await sendTelegram(msg);

      console.log("✅ SIGNAL:", symbol);

      sent++;

    } catch(e) {
      console.log("ERROR:", symbol);
    }
  }

  console.log("✅ SCAN END");
}

// ===== START =====
async function start() {
  await sendTelegram("🚀 BOT LIVE - SNIPER + TREND");

  await scan();

  setInterval(scan, SCAN_INTERVAL);
}

start();
