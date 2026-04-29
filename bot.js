const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || "5400000", 10);

const MIN_SCORE = 7.2;
const MIN_RR = 2.2;

const OKX = "https://www.okx.com";

const COINS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT",
  "XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT",
  "APTUSDT","OPUSDT","ARBUSDT","INJUSDT","SUIUSDT","SEIUSDT","NEARUSDT","ATOMUSDT","FILUSDT"
];

const lastSignal = new Map();

console.log("🔥 V18.2 PRO RETEST MODE START");

async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function toOkx(sym) {
  return sym.replace("USDT", "-USDT-SWAP");
}

async function klines(sym, tf = "5m") {
  const j = await fetchJson(`${OKX}/api/v5/market/candles?instId=${toOkx(sym)}&bar=${tf}&limit=120`);
  if (!j || j.code !== "0" || !Array.isArray(j.data)) return null;

  return j.data.slice().reverse().map(x => ({
    o: +x[1],
    h: +x[2],
    l: +x[3],
    c: +x[4],
    v: +x[5]
  }));
}

function ema(arr, p) {
  const k = 2 / (p + 1);
  let e = arr[0];
  return arr.map(v => e = v * k + e * (1 - k));
}

function avg(a) {
  if (!a.length) return 0;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function atr(d) {
  const tr = [];
  for (let i = 1; i < d.length; i++) {
    tr.push(Math.max(
      d[i].h - d[i].l,
      Math.abs(d[i].h - d[i - 1].c),
      Math.abs(d[i].l - d[i - 1].c)
    ));
  }
  return avg(tr.slice(-14));
}

function rr(entry, stop, tp) {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  return Math.abs(tp - entry) / risk;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  return Math.abs(n) >= 1 ? n.toFixed(4) : n.toFixed(6);
}

function scoreCalc({ R, volRatio, trend, retest, momentum }) {
  let s = 0;

  if (R >= 3) s += 3;
  else if (R >= 2.5) s += 2.5;
  else if (R >= 2.2) s += 2;

  if (volRatio >= 2) s += 2;
  else if (volRatio >= 1.5) s += 1.5;
  else if (volRatio >= 1.25) s += 1;

  if (trend) s += 2;
  if (retest) s += 1.5;
  if (momentum) s += 1;

  return Math.min(10, Number(s.toFixed(1)));
}

function cleanCandle(d) {
  const x = d.at(-1);
  const range = Math.max(x.h - x.l, 0.0000001);
  const body = Math.abs(x.c - x.o);
  const upper = x.h - Math.max(x.c, x.o);
  const lower = Math.min(x.c, x.o) - x.l;

  if (body / range < 0.20) return false;
  if (upper / range > 0.65) return false;
  if (lower / range > 0.65) return false;

  return true;
}

function isDuplicate(sig) {
  const key = `${sig.symbol}:${sig.side}`;
  const last = lastSignal.get(key);
  return last && Date.now() - last < COOLDOWN_MS;
}

function mark(sig) {
  lastSignal.set(`${sig.symbol}:${sig.side}`, Date.now());
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

async function scan(sym) {
  const d5 = await klines(sym, "5m");
  const d15 = await klines(sym, "15m");

  if (!Array.isArray(d5) || !Array.isArray(d15)) return null;
  if (d5.length < 80 || d15.length < 80) return null;
  if (!cleanCandle(d5)) return null;

  const c5 = d5.map(x => x.c);
  const c15 = d15.map(x => x.c);
  const v5 = d5.map(x => x.v);

  const e20 = ema(c5, 20);
  const e50 = ema(c5, 50);
  const e20_15 = ema(c15, 20);
  const e50_15 = ema(c15, 50);

  const last = c5.at(-1);
  const prev = c5.at(-2);

  const atrVal = atr(d5);
  if (!atrVal || (atrVal / last) * 100 < 0.14) return null;

  const volNow = v5.at(-1);
  const volAvg = avg(v5.slice(-20));
  const volRatio = volNow / volAvg;

  if (volRatio < 1.25) return null;

  const trendUp = e20.at(-1) > e50.at(-1) && e20_15.at(-1) > e50_15.at(-1);
  const trendDown = e20.at(-1) < e50.at(-1) && e20_15.at(-1) < e50_15.at(-1);

  const high = Math.max(...d5.slice(-12, -2).map(x => x.h));
  const low = Math.min(...d5.slice(-12, -2).map(x => x.l));

  const longRetest = trendUp && prev > high && last <= high * 1.004 && last > e20.at(-1);
  const shortRetest = trendDown && prev < low && last >= low * 0.996 && last < e20.at(-1);

  const longMomentum = last > e20.at(-1);
  const shortMomentum = last < e20.at(-1);

  if (longRetest) {
    const entry = last;
    const swingStop = Math.min(...d5.slice(-10).map(x => x.l));
    const atrStop = entry - atrVal * 1.3;
    const stop = Math.min(swingStop, atrStop);

    const tp1 = entry + (entry - stop) * 1.1;
    const tp2 = entry + (entry - stop) * 2.4;
    const R = rr(entry, stop, tp2);

    if (R < MIN_RR) return null;

    const score = scoreCalc({
      R,
      volRatio,
      trend: true,
      retest: true,
      momentum: longMomentum
    });

    if (score < MIN_SCORE) return null;

    return {
      symbol: sym,
      side: "LONG",
      entry,
      stop,
      tp1,
      tp2,
      rr: R,
      score
    };
  }

  if (shortRetest) {
    const entry = last;
    const swingStop = Math.max(...d5.slice(-10).map(x => x.h));
    const atrStop = entry + atrVal * 1.3;
    const stop = Math.max(swingStop, atrStop);

    const tp1 = entry - (stop - entry) * 1.1;
    const tp2 = entry - (stop - entry) * 2.4;
    const R = rr(entry, stop, tp2);

    if (R < MIN_RR) return null;

    const score = scoreCalc({
      R,
      volRatio,
      trend: true,
      retest: true,
      momentum: shortMomentum
    });

    if (score < MIN_SCORE) return null;

    return {
      symbol: sym,
      side: "SHORT",
      entry,
      stop,
      tp1,
      tp2,
      rr: R,
      score
    };
  }

  return null;
}

async function run() {
  console.log("RUN");

  let best = null;
  let checked = 0;
  let dup = 0;

  for (const sym of COINS) {
    checked++;

    const sig = await scan(sym);
    if (!sig) continue;

    if (isDuplicate(sig)) {
      dup++;
      continue;
    }

    console.log("CANDIDATE:", sig.symbol, sig.side, "RR:", sig.rr.toFixed(2), "SCORE:", sig.score);

    if (!best || sig.score > best.score || (sig.score === best.score && sig.rr > best.rr)) {
      best = sig;
    }
  }

  console.log("CHECKED:", checked, "DUP:", dup);

  if (!best) {
    console.log("NO SIGNAL");
    return;
  }

  const sent = await send(`🚀 V18.2 PRO RETEST SIGNAL

${best.symbol} ${best.side}
Score: ${best.score}/10
RR: ${best.rr.toFixed(2)}

Entry: ${fmt(best.entry)}
TP1: ${fmt(best.tp1)}
TP2: ${fmt(best.tp2)}
Stop: ${fmt(best.stop)}

Logic: Breakout → Retest → Confirm
Not: 20x yerine küçük margin / düşük leverage önerilir.`);

  if (sent) {
    mark(best);
    console.log("SIGNAL SENT:", best.symbol, best.side);
  }
}

(async () => {
  if (!TG_TOKEN || !CHAT_ID) {
    console.log("ENV ERROR: TG_BOT_TOKEN / TG_CHAT_ID");
    return;
  }

  while (true) {
    try {
      await run();
    } catch (e) {
      console.log("ERR:", e.message);
    }

    console.log("SLEEPING:", LOOP_MS);
    await new Promise(r => setTimeout(r, LOOP_MS));
  }
})();
