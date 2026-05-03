const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;
const COOLDOWN_MS = 7200000;

const MIN_SCORE = 7.4;
const MIN_RR = 1.5;

const OKX = "https://www.okx.com";

const COINS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT",
  "XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT",
  "ATOMUSDT","NEARUSDT","APTUSDT","ARBUSDT","OPUSDT","INJUSDT",
  "SUIUSDT","SEIUSDT","MATICUSDT","ICPUSDT","AAVEUSDT","UNIUSDT",
  "RUNEUSDT","IMXUSDT","LDOUSDT","STXUSDT","ENSUSDT","FILUSDT"
];

const lastSignal = new Map();

console.log("🔥 V26 MB FAILURE SYSTEM START");

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

function std(a) {
  const m = avg(a);
  return Math.sqrt(avg(a.map(x => (x - m) ** 2)));
}

function bb(closes, p = 20, mult = 2) {
  const s = closes.slice(-p);
  const mid = avg(s);
  const dev = std(s);

  return {
    upper: mid + dev * mult,
    mid,
    lower: mid - dev * mult
  };
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

function adx(d, p = 14) {
  if (d.length < p + 2) return 0;

  const tr = [];
  const plus = [];
  const minus = [];

  for (let i = 1; i < d.length; i++) {
    const up = d[i].h - d[i - 1].h;
    const down = d[i - 1].l - d[i].l;

    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);

    tr.push(Math.max(
      d[i].h - d[i].l,
      Math.abs(d[i].h - d[i - 1].c),
      Math.abs(d[i].l - d[i - 1].c)
    ));
  }

  const trAvg = avg(tr.slice(-p));
  if (!trAvg) return 0;

  const pdi = 100 * avg(plus.slice(-p)) / trAvg;
  const mdi = 100 * avg(minus.slice(-p)) / trAvg;

  return Math.abs(pdi - mdi) / Math.max(pdi + mdi, 0.000001) * 100;
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

function reactionCandle(d, side) {
  const x = d.at(-1);
  const range = Math.max(x.h - x.l, 0.0000001);
  const body = Math.abs(x.c - x.o);
  const upper = x.h - Math.max(x.c, x.o);
  const lower = Math.min(x.c, x.o) - x.l;

  if (body / range < 0.35) return false;

  if (side === "LONG") {
    if (x.c <= x.o) return false;
    if (lower / range < 0.20) return false;
    if (upper / range > 0.45) return false;
  }

  if (side === "SHORT") {
    if (x.c >= x.o) return false;
    if (upper / range < 0.20) return false;
    if (lower / range > 0.45) return false;
  }

  return true;
}

function scoreCalc({ R, volRatio, adxVal, failure, reaction, mbDistance }) {
  let s = 0;

  if (failure) s += 2.5;
  if (reaction) s += 2.0;

  if (R >= 2.0) s += 1.5;
  else if (R >= 1.5) s += 1.0;

  if (volRatio >= 1.7) s += 1.5;
  else if (volRatio >= 1.25) s += 1.0;

  if (adxVal >= 14 && adxVal <= 28) s += 1.5;
  else if (adxVal < 14) s += 0.5;

  if (mbDistance <= 0.35) s += 1.0;

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
  if (!Array.isArray(d5) || d5.length < 80) return null;

  const c = d5.map(x => x.c);
  const v = d5.map(x => x.v);

  const last = c.at(-1);
  const prev = c.at(-2);
  const prev2 = c.at(-3);

  const band = bb(c, 20, 2);
  const a = atr(d5, 14);
  const adxVal = adx(d5, 14);

  if (!a || (a / last) * 100 < 0.08) return null;

  // Mean reversion sistemi: çok güçlü trendde işlem açma.
  if (adxVal > 30) return null;

  const volNow = v.at(-1);
  const volAvg = avg(v.slice(-20, -1));
  const volRatio = volNow / volAvg;

  if (volRatio < 1.10) return null;

  const mb = band.mid;
  const mbDistance = Math.abs(last - mb) / last * 100;

  // LONG FAILURE:
  // Satıcılar MB altına iter, ama aşağıda kalamaz; son mum MB üstüne reclaim eder.
  const recentBelowMB = d5.slice(-6, -1).some(x => x.c < mb);
  const failedDown =
    recentBelowMB &&
    prev < mb &&
    last > mb &&
    last > prev &&
    last > prev2 &&
    reactionCandle(d5, "LONG");

  if (failedDown) {
    const entry = last;
    const stop = Math.min(...d5.slice(-8).map(x => x.l)) - a * 0.25;

    // Hedef: MB reclaim sonrası kısa devam. Çok uzak hedef kovalamıyoruz.
    const tp1 = entry + (entry - stop) * 0.8;
    const tp2 = entry + (entry - stop) * 1.6;
    const R = rr(entry, stop, tp2);

    if (R < MIN_RR) return null;
    if (isDuplicate(sym, "LONG")) return null;

    const score = scoreCalc({
      R,
      volRatio,
      adxVal,
      failure: true,
      reaction: true,
      mbDistance
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
      adx: adxVal,
      volRatio,
      mb
    };
  }

  // SHORT FAILURE:
  // Alıcılar MB üstüne iter, ama yukarıda kalamaz; son mum MB altına reject eder.
  const recentAboveMB = d5.slice(-6, -1).some(x => x.c > mb);
  const failedUp =
    recentAboveMB &&
    prev > mb &&
    last < mb &&
    last < prev &&
    last < prev2 &&
    reactionCandle(d5, "SHORT");

  if (failedUp) {
    const entry = last;
    const stop = Math.max(...d5.slice(-8).map(x => x.h)) + a * 0.25;

    const tp1 = entry - (stop - entry) * 0.8;
    const tp2 = entry - (stop - entry) * 1.6;
    const R = rr(entry, stop, tp2);

    if (R < MIN_RR) return null;
    if (isDuplicate(sym, "SHORT")) return null;

    const score = scoreCalc({
      R,
      volRatio,
      adxVal,
      failure: true,
      reaction: true,
      mbDistance
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
      adx: adxVal,
      volRatio,
      mb
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
      sig.score,
      "ADX:",
      sig.adx.toFixed(1)
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

  const sent = await send(`🎯 V26 MB FAILURE SIGNAL

${best.sym} ${best.side}
Güven: ${best.score}/10
RR: ${best.rr.toFixed(2)}
ADX: ${best.adx.toFixed(1)}
Volume: ${best.volRatio.toFixed(2)}x

MB: ${fmt(best.mb)}
Entry: ${fmt(best.entry)}
TP1: ${fmt(best.tp1)}
TP2: ${fmt(best.tp2)}
Stop: ${fmt(best.stop)}

Logic: MB kırılım denedi → tutunamadı → ters yönde reaction
Not: Mean reversion scalp. Güçlü trendde işlem açmaz.`);

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
