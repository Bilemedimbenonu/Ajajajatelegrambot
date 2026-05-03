const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;
const COOLDOWN_MS = 7200000;

const MIN_SCORE = 7.4;
const MIN_RR = 1.6;

const TURTLE_LEN = 20;
const MAX_HOLD_MIN = 90;

const OKX = "https://www.okx.com";

const COINS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT",
  "XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT",
  "ATOMUSDT","NEARUSDT","APTUSDT","ARBUSDT","OPUSDT","INJUSDT",
  "SUIUSDT","SEIUSDT","MATICUSDT","ICPUSDT","AAVEUSDT","UNIUSDT",
  "RUNEUSDT","IMXUSDT","LDOUSDT","STXUSDT","ENSUSDT","FILUSDT"
];

const lastSignal = new Map();

console.log("🔥 V23 TURTLE SCALP HYBRID START");

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

function avg(a) {
  if (!a.length) return 0;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function ema(arr, p) {
  const k = 2 / (p + 1);
  let e = arr[0];
  return arr.map(v => e = v * k + e * (1 - k));
}

function atr(d, p = 14) {
  const tr = [];
  for (let i = 1; i < d.length; i++) {
    tr.push(Math.max(
      d[i].h - d[i].l,
      Math.abs(d[i].h - d[i - 1].c),
      Math.abs(d[i].l - d[i - 1].c)
    ));
  }
  return avg(tr.slice(-p));
}

function rr(entry, stop, tp) {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  return Math.abs(tp - entry) / risk;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  return Number(n).toFixed(4);
}

function candleQuality(d, side) {
  const x = d.at(-1);
  const range = Math.max(x.h - x.l, 0.0000001);
  const body = Math.abs(x.c - x.o);
  const upper = x.h - Math.max(x.c, x.o);
  const lower = Math.min(x.c, x.o) - x.l;

  if (body / range < 0.42) return false;

  if (side === "LONG") {
    if (x.c <= x.o) return false;
    if (upper / range > 0.38) return false;
  }

  if (side === "SHORT") {
    if (x.c >= x.o) return false;
    if (lower / range > 0.38) return false;
  }

  return true;
}

function scoreCalc({ R, volRatio, turtleBreak, trendOk, candleOk, atrOk }) {
  let s = 0;

  if (turtleBreak) s += 2.4;
  if (trendOk) s += 1.8;
  if (candleOk) s += 1.5;
  if (atrOk) s += 1.0;

  if (volRatio >= 2.0) s += 2.0;
  else if (volRatio >= 1.5) s += 1.5;
  else if (volRatio >= 1.25) s += 1.0;

  if (R >= 2.0) s += 1.3;
  else if (R >= 1.6) s += 0.9;

  return Math.min(10, Number(s.toFixed(1)));
}

function isDuplicate(sym, side) {
  const key = `${sym}:${side}`;
  const t = lastSignal.get(key);
  return t && Date.now() - t < COOLDOWN_MS;
}

function mark(sym, side) {
  lastSignal.set(`${sym}:${side}`, Date.now());
}

async function send(msg) {
  if (!TG_TOKEN || !CHAT_ID) {
    console.log("TELEGRAM ENV MISSING");
    return false;
  }

  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
  });

  const t = await r.text();
  console.log("TELEGRAM:", t);
  return r.ok;
}

async function scan(sym) {
  const d5 = await klines(sym, "5m");
  const d15 = await klines(sym, "15m");

  if (!Array.isArray(d5) || !Array.isArray(d15)) return null;
  if (d5.length < 80 || d15.length < 80) return null;

  const c5 = d5.map(x => x.c);
  const c15 = d15.map(x => x.c);
  const v5 = d5.map(x => x.v);

  const last = c5.at(-1);
  const prev = c5.at(-2);

  const e20 = ema(c5, 20);
  const e50 = ema(c5, 50);
  const e20_15 = ema(c15, 20);
  const e50_15 = ema(c15, 50);

  const atrVal = atr(d5, 14);
  if (!atrVal) return null;

  const atrPct = (atrVal / last) * 100;
  if (atrPct < 0.14) return null;

  const volNow = v5.at(-1);
  const volAvg = avg(v5.slice(-20, -1));
  const volRatio = volNow / volAvg;

  if (volRatio < 1.25) return null;

  const turtleHigh = Math.max(...d5.slice(-(TURTLE_LEN + 1), -1).map(x => x.h));
  const turtleLow = Math.min(...d5.slice(-(TURTLE_LEN + 1), -1).map(x => x.l));

  const longBreak = last > turtleHigh && prev <= turtleHigh;
  const shortBreak = last < turtleLow && prev >= turtleLow;

  const trendLong = e20.at(-1) > e50.at(-1) && e20_15.at(-1) >= e50_15.at(-1);
  const trendShort = e20.at(-1) < e50.at(-1) && e20_15.at(-1) <= e50_15.at(-1);

  if (longBreak && trendLong && candleQuality(d5, "LONG")) {
    const entry = last;

    const structureStop = Math.min(...d5.slice(-10).map(x => x.l));
    const atrStop = entry - atrVal * 1.2;
    const stop = Math.min(structureStop, atrStop);

    const tp1 = entry + (entry - stop) * 0.8;
    const tp2 = entry + (entry - stop) * 1.7;
    const R = rr(entry, stop, tp2);

    if (R < MIN_RR) return null;
    if (isDuplicate(sym, "LONG")) return null;

    const score = scoreCalc({
      R,
      volRatio,
      turtleBreak: true,
      trendOk: true,
      candleOk: true,
      atrOk: true
    });

    if (score < MIN_SCORE) return null;

    return {
      sym,
      side: "LONG",
      entry,
      stop,
      tp1,
      tp2,
      rr: R,
      score,
      volRatio,
      atrPct,
      turtleLevel: turtleHigh
    };
  }

  if (shortBreak && trendShort && candleQuality(d5, "SHORT")) {
    const entry = last;

    const structureStop = Math.max(...d5.slice(-10).map(x => x.h));
    const atrStop = entry + atrVal * 1.2;
    const stop = Math.max(structureStop, atrStop);

    const tp1 = entry - (stop - entry) * 0.8;
    const tp2 = entry - (stop - entry) * 1.7;
    const R = rr(entry, stop, tp2);

    if (R < MIN_RR) return null;
    if (isDuplicate(sym, "SHORT")) return null;

    const score = scoreCalc({
      R,
      volRatio,
      turtleBreak: true,
      trendOk: true,
      candleOk: true,
      atrOk: true
    });

    if (score < MIN_SCORE) return null;

    return {
      sym,
      side: "SHORT",
      entry,
      stop,
      tp1,
      tp2,
      rr: R,
      score,
      volRatio,
      atrPct,
      turtleLevel: turtleLow
    };
  }

  return null;
}

async function run() {
  console.log("RUN");

  let best = null;
  let checked = 0;
  let candidates = 0;

  for (const s of COINS) {
    checked++;

    const sig = await scan(s);
    if (!sig) continue;

    candidates++;

    console.log(
      "CANDIDATE:",
      sig.sym,
      sig.side,
      "RR:",
      sig.rr.toFixed(2),
      "SCORE:",
      sig.score
    );

    if (!best || sig.score > best.score || (sig.score === best.score && sig.rr > best.rr)) {
      best = sig;
    }
  }

  console.log("CHECKED:", checked, "CANDIDATES:", candidates);

  if (!best) {
    console.log("NO SIGNAL");
    return;
  }

  const sent = await send(`🐢⚡ V23 TURTLE SCALP SIGNAL

${best.sym} ${best.side}
Güven: ${best.score}/10
RR: ${best.rr.toFixed(2)}
Volume: ${best.volRatio.toFixed(2)}x
ATR: ${best.atrPct.toFixed(2)}%

Turtle Level: ${fmt(best.turtleLevel)}
Entry: ${fmt(best.entry)}
TP1: ${fmt(best.tp1)}
TP2: ${fmt(best.tp2)}
Stop: ${fmt(best.stop)}

Max Hold: ${MAX_HOLD_MIN} dk
Logic: Turtle Breakout + Scalp Filter
Not: OKX verisiyle hesaplandı; Binance girişi öncesi fiyat farkını kontrol et.`);

  if (sent) {
    mark(best.sym, best.side);
    console.log("SIGNAL SENT:", best.sym, best.side);
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
