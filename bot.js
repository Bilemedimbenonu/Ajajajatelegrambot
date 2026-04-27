const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;

let symbols = [];

console.log("🔥 FINAL OKX SNIPER+TREND BOT START");

// ================= OKX FETCH =================
async function getOKXSymbols() {
  try {
    const res = await fetch("https://www.okx.com/api/v5/public/instruments?instType=SWAP");
    const json = await res.json();

    symbols = json.data
      .filter(s => s.ctValCcy === "USDT")
      .map(s => s.instId.replace("-", ""));

    console.log("COIN COUNT:", symbols.length);
  } catch (e) {
    console.log("SYMBOL LOAD FAIL", e.message);
  }
}

async function getKlines(symbol, tf = "5m") {
  try {
    const instId = symbol.replace("USDT", "-USDT-SWAP");

    const res = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${tf}&limit=100`);
    const json = await res.json();

    if (!json.data) return null;

    return json.data.reverse().map(x => ({
      open: parseFloat(x[1]),
      high: parseFloat(x[2]),
      low: parseFloat(x[3]),
      close: parseFloat(x[4]),
      volume: parseFloat(x[5])
    }));

  } catch {
    return null;
  }
}

// ================= INDICATORS =================
function ema(arr, p) {
  let k = 2 / (p + 1);
  let out = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    out.push(arr[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function rr(entry, stop, tp) {
  return Math.abs(tp - entry) / Math.abs(entry - stop);
}

// ================= SIGNAL =================
async function checkSymbol(symbol) {
  const data = await getKlines(symbol, "5m");
  if (!data || data.length < 50) return null;

  const closes = data.map(x => x.close);
  const highs = data.map(x => x.high);
  const lows = data.map(x => x.low);
  const vols = data.map(x => x.volume);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const last = closes.at(-1);
  const prev = closes.at(-2);

  const avgVol = avg(vols.slice(-20));
  const volNow = vols.at(-1);

  const volumeSpike = volNow > avgVol * 1.3;
  if (!volumeSpike) return null;

  const trendUp = ema20.at(-1) > ema50.at(-1);
  const trendDown = ema20.at(-1) < ema50.at(-1);

  const recentHigh = Math.max(...highs.slice(-10));
  const recentLow = Math.min(...lows.slice(-10));

  // ================= SNIPER =================
  if (trendUp && prev < ema20.at(-2) && last > ema20.at(-1)) {

    const entry = last;
    const stop = recentLow;
    const tp1 = entry + (entry - stop) * 1.2;
    const tp2 = entry + (entry - stop) * 2.2;

    const r = rr(entry, stop, tp2);
    if (r < 2.0) return null;

    return {
      mode: "SNIPER",
      side: "LONG",
      symbol,
      entry,
      stop,
      tp1,
      tp2,
      rr: r
    };
  }

  if (trendDown && prev > ema20.at(-2) && last < ema20.at(-1)) {

    const entry = last;
    const stop = recentHigh;
    const tp1 = entry - (stop - entry) * 1.2;
    const tp2 = entry - (stop - entry) * 2.2;

    const r = rr(entry, stop, tp2);
    if (r < 2.0) return null;

    return {
      mode: "SNIPER",
      side: "SHORT",
      symbol,
      entry,
      stop,
      tp1,
      tp2,
      rr: r
    };
  }

  // ================= TREND =================
  if (trendUp && last > recentHigh) {

    const entry = last;
    const stop = recentLow;
    const tp1 = entry + (entry - stop) * 1.0;
    const tp2 = entry + (entry - stop) * 1.8;

    const r = rr(entry, stop, tp2);
    if (r < 1.8) return null;

    return {
      mode: "TREND",
      side: "LONG",
      symbol,
      entry,
      stop,
      tp1,
      tp2,
      rr: r
    };
  }

  if (trendDown && last < recentLow) {

    const entry = last;
    const stop = recentHigh;
    const tp1 = entry - (stop - entry) * 1.0;
    const tp2 = entry - (stop - entry) * 1.8;

    const r = rr(entry, stop, tp2);
    if (r < 1.8) return null;

    return {
      mode: "TREND",
      side: "SHORT",
      symbol,
      entry,
      stop,
      tp1,
      tp2,
      rr: r
    };
  }

  return null;
}

// ================= TELEGRAM =================
async function send(msg) {
  if (!TG_TOKEN || !CHAT_ID) return;

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg
    })
  });
}

// ================= MAIN =================
async function run() {

  let best = null;

  for (const s of symbols) {
    const sig = await checkSymbol(s);
    if (!sig) continue;

    console.log("CANDIDATE:", sig.symbol, sig.mode, sig.rr.toFixed(2));

    if (!best || sig.rr > best.rr) best = sig;
  }

  if (!best) {
    console.log("NO SIGNAL");
    return;
  }

  const msg = `
🔥 ${best.mode} SIGNAL

Coin: ${best.symbol}
Side: ${best.side}

Entry: ${best.entry.toFixed(4)}
Stop: ${best.stop.toFixed(4)}
TP1: ${best.tp1.toFixed(4)}
TP2: ${best.tp2.toFixed(4)}

RR: ${best.rr.toFixed(2)}
`;

  console.log("SIGNAL:", best.symbol, best.mode);
  await send(msg);
}

// ================= LOOP =================
(async () => {
  await getOKXSymbols();

  while (true) {
    try {
      await run();
    } catch (e) {
      console.log("ERROR:", e.message);
    }

    await new Promise(r => setTimeout(r, LOOP_MS));
  }
})();
