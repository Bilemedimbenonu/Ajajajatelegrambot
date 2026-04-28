const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || "5400000", 10); // 90 dk

const MIN_SCORE = 8.2;
const MIN_RR = 2.6;

const OKX = "https://www.okx.com";

let symbols = [];
const lastSignalAt = new Map();

console.log("🔥 V17 ULTRA NO-LOCK START");

async function fetchJson(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function loadSymbols() {
  const j = await fetchJson(`${OKX}/api/v5/public/instruments?instType=SWAP`);

  if (!j || !Array.isArray(j.data)) {
    console.log("SYMBOL LOAD FAIL");
    return;
  }

  symbols = j.data
    .filter(s => s.instId && s.instId.endsWith("-USDT-SWAP"))
    .map(s => s.instId.replace("-USDT-SWAP", "USDT"));

  console.log("SYMBOLS:", symbols.length);
}

function toOkx(sym) {
  return sym.replace("USDT", "-USDT-SWAP");
}

async function klines(sym, tf = "5m") {
  const j = await fetchJson(
    `${OKX}/api/v5/market/candles?instId=${toOkx(sym)}&bar=${tf}&limit=120`
  );

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

function cleanCandle(d) {
  const x = d.at(-1);
  const range = Math.max(x.h - x.l, 0.0000001);
  const body = Math.abs(x.c - x.o);
  const upper = x.h - Math.max(x.c, x.o);
  const lower = Math.min(x.c, x.o) - x.l;

  if (body / range < 0.35) return false;
  if (upper / range > 0.45) return false;
  if (lower / range > 0.45) return false;

  return true;
}

function calcScore({ R, volRatio, trendStrong, momentum }) {
  let score = 0;

  if (R >= 3.5) score += 3;
  else if (R >= 3.0) score += 2.5;
  else if (R >= 2.6) score += 2;

  if (volRatio >= 2.0) score += 2;
  else if (volRatio >= 1.6) score += 1.5;

  if (trendStrong) score += 2.5;
  if (momentum) score += 1.5;

  score += 1;

  return Math.min(10, Number(score.toFixed(1)));
}

function isDuplicate(sig) {
  const key = `${sig.symbol}:${sig.side}`;
  const last = lastSignalAt.get(key);

  if (!last) return false;

  return Date.now() - last < COOLDOWN_MS;
}

function markSignal(sig) {
  const key = `${sig.symbol}:${sig.side}`;
  lastSignalAt.set(key, Date.now());
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

    const text = await r.text();
    console.log("TELEGRAM:", text);
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

  const e20_5 = ema(c5, 20);
  const e50_5 = ema(c5, 50);
  const e20_15 = ema(c15, 20);
  const e50_15 = ema(c15, 50);

  const last = c5.at(-1);
  const prev = c5.at(-2);
  const prev2 = c5.at(-3);

  const atrVal = atr(d5);
  const volNow = v5.at(-1);
  const volAvg = avg(v5.slice(-20));
  const volRatio = volNow / volAvg;

  if (!atrVal || (atrVal / last) * 100 < 0.25) return null;
  if (volRatio < 1.6) return null;

  const trendUp =
    e20_5.at(-1) > e50_5.at(-1) &&
    e20_15.at(-1) > e50_15.at(-1);

  const trendDown =
    e20_5.at(-1) < e50_5.at(-1) &&
    e20_15.at(-1) < e50_15.at(-1);

  const momentumUp = last > prev && prev > prev2;
  const momentumDown = last < prev && prev < prev2;

  if (trendUp && prev < e20_5.at(-2) && last > e20_5.at(-1) && momentumUp) {
    const entry = last;

    const swingStop = Math.min(...d5.slice(-10).map(x => x.l));
    const atrStop = entry - atrVal * 1.6;
    const stop = Math.min(swingStop, atrStop);

    const tp1 = entry + (entry - stop) * 1.2;
    const tp2 = entry + (entry - stop) * 2.8;

    const R = rr(entry, stop, tp2);
    if (R < MIN_RR) return null;

    const score = calcScore({
      R,
      volRatio,
      trendStrong: true,
      momentum: true
    });

    if (score < MIN_SCORE) return null;

    return {
      mode: "ULTRA SNIPER",
      side: "LONG",
      symbol: sym,
      entry,
      stop,
      tp1,
      tp2,
      rr: R,
      score
    };
  }

  if (trendDown && prev > e20_5.at(-2) && last < e20_5.at(-1) && momentumDown) {
    const entry = last;

    const swingStop = Math.max(...d5.slice(-10).map(x => x.h));
    const atrStop = entry + atrVal * 1.6;
    const stop = Math.max(swingStop, atrStop);

    const tp1 = entry - (stop - entry) * 1.2;
    const tp2 = entry - (stop - entry) * 2.8;

    const R = rr(entry, stop, tp2);
    if (R < MIN_RR) return null;

    const score = calcScore({
      R,
      volRatio,
      trendStrong: true,
      momentum: true
    });

    if (score < MIN_SCORE) return null;

    return {
      mode: "ULTRA SNIPER",
      side: "SHORT",
      symbol: sym,
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
  let duplicates = 0;

  for (const s of symbols) {
    checked++;

    const sig = await scan(s);
    if (!sig) continue;

    if (isDuplicate(sig)) {
      duplicates++;
      continue;
    }

    console.log("CANDIDATE:", sig.symbol, sig.side, "RR:", sig.rr.toFixed(2), "SCORE:", sig.score);

    if (!best || sig.score > best.score || (sig.score === best.score && sig.rr > best.rr)) {
      best = sig;
    }
  }

  console.log("CHECKED:", checked, "DUPLICATES:", duplicates);

  if (!best) {
    console.log("NO SIGNAL");
    return;
  }

  const sent = await send(`🚀 ${best.mode} SIGNAL

${best.symbol} ${best.side}
Score: ${best.score}/10
RR: ${best.rr.toFixed(2)}

Entry: ${fmt(best.entry)}
TP1: ${fmt(best.tp1)}
TP2: ${fmt(best.tp2)}
Stop: ${fmt(best.stop)}

Stop Logic: Hybrid Swing + ATR
Note: Sinyal gönderildi ama bot trade'i aktif saymıyor.`);

  if (sent) {
    markSignal(best);
    console.log("SIGNAL SENT:", best.symbol, best.side);
  }
}

(async () => {
  if (!TG_TOKEN || !CHAT_ID) {
    console.log("ENV ERROR: TG_BOT_TOKEN / TG_CHAT_ID");
    return;
  }

  await loadSymbols();

  if (!symbols.length) {
    console.log("NO SYMBOLS LOADED");
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
