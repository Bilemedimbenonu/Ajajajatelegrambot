const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);

const MIN_SCORE = parseFloat(process.env.MIN_SCORE || "4.8");
const MIN_RR = parseFloat(process.env.MIN_RR || "1.25");

const BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com"
];

const FALLBACK_SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","ADAUSDT","DOGEUSDT",
  "AVAXUSDT","LINKUSDT","DOTUSDT","ATOMUSDT","INJUSDT","NEARUSDT","APTUSDT",
  "OPUSDT","ARBUSDT","SEIUSDT","SUIUSDT","LTCUSDT","BCHUSDT","ICPUSDT",
  "STXUSDT","THETAUSDT","ALGOUSDT","VETUSDT","XLMUSDT","HBARUSDT",
  "EGLDUSDT","AXSUSDT","SANDUSDT","MANAUSDT","GALAUSDT","APEUSDT",
  "PEPEUSDT","FLOKIUSDT","BLURUSDT","ENSUSDT","CHZUSDT","CRVUSDT"
];

let SYMBOLS = [];
let activeTrade = null;

console.log("🔥 AUTO + FALLBACK SCANNER START");

async function fetchJson(path) {
  for (const base of BASES) {
    try {
      const r = await fetch(base + path);
      if (!r.ok) {
        console.log("FETCH FAIL:", base, r.status, path);
        continue;
      }
      return await r.json();
    } catch (e) {
      console.log("FETCH ERROR:", base, e.message);
    }
  }
  return null;
}

async function loadSymbols() {
  const info = await fetchJson("/fapi/v1/exchangeInfo");

  if (info && Array.isArray(info.symbols)) {
    const symbols = info.symbols
      .filter(s =>
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT" &&
        s.status === "TRADING"
      )
      .map(s => s.symbol);

    console.log("AUTO SYMBOL COUNT:", symbols.length);

    if (symbols.length > 0) return symbols;
  }

  console.log("AUTO SYMBOL LOAD FAILED, USING FALLBACK LIST");
  console.log("FALLBACK COUNT:", FALLBACK_SYMBOLS.length);
  return FALLBACK_SYMBOLS;
}

async function klines(symbol) {
  return fetchJson(`/fapi/v1/klines?symbol=${symbol}&interval=${ENTRY_TF}&limit=120`);
}

async function price(symbol) {
  const d = await fetchJson(`/fapi/v1/ticker/price?symbol=${symbol}`);
  return d?.price ? Number(d.price) : null;
}

function closes(d) { return d.map(x => Number(x[4])); }
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
  return `🔥 SIGNAL

Coin: ${s.coin}
Side: ${s.side}
Score: ${s.score.toFixed(1)}/10
RR: ${s.rr.toFixed(2)}

Entry: ${fmt(s.entry)}
Stop: ${fmt(s.stop)}
TP: ${fmt(s.tp)}`;
}

async function scan(symbol, debug) {
  debug.checked++;

  const d = await klines(symbol);

  if (!Array.isArray(d) || d.length < 60) {
    debug.dataFail++;
    return null;
  }

  const c = closes(d);
  const h = highs(d);
  const l = lows(d);
  const v = volumes(d);

  const last = c.at(-1);
  const prev = c.at(-2);

  const e20 = ema(c, 20);
  const e50 = ema(c, 50);

  const recentHigh = Math.max(...h.slice(-13, -1));
  const recentLow = Math.min(...l.slice(-13, -1));

  const volNow = v.at(-1);
  const volAvg = avg(v.slice(-21, -1));

  const trendLong = e20.at(-1) > e50.at(-1);
  const trendShort = e20.at(-1) < e50.at(-1);

  const nearHigh = last >= recentHigh * 0.985;
  const nearLow = last <= recentLow * 1.015;

  const breakoutLong = last > recentHigh;
  const breakoutShort = last < recentLow;

  const volumeOk = volNow > volAvg * 0.95;
  const momentumLong = last > prev;
  const momentumShort = last < prev;

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

  if (longScore >= 3 || shortScore >= 3) {
    debug.candidates++;
  }

  if (longScore >= MIN_SCORE && trendLong && momentumLong && nearHigh) {
    const entry = last;
    const stop = Math.min(...l.slice(-8, -1));
    const tp = entry + (entry - stop) * 1.4;
    const R = rr(entry, stop, tp);

    if (R < MIN_RR) {
      debug.rrFail++;
      return null;
    }

    debug.passed++;

    return {
      coin: symbol,
      side: "LONG",
      score: longScore,
      entry,
      stop,
      tp,
      rr: R
    };
  }

  if (shortScore >= MIN_SCORE && trendShort && momentumShort && nearLow) {
    const entry = last;
    const stop = Math.max(...h.slice(-8, -1));
    const tp = entry - (stop - entry) * 1.4;
    const R = rr(entry, stop, tp);

    if (R < MIN_RR) {
      debug.rrFail++;
      return null;
    }

    debug.passed++;

    return {
      coin: symbol,
      side: "SHORT",
      score: shortScore,
      entry,
      stop,
      tp,
      rr: R
    };
  }

  debug.scoreFail++;
  return null;
}

async function updateTrade() {
  if (!activeTrade) return;

  const p = await price(activeTrade.coin);
  if (!p) return;

  if (activeTrade.side === "LONG") {
    if (p <= activeTrade.stop) {
      await send(`🔴 STOP HIT\n${activeTrade.coin} LONG\nLive: ${fmt(p)}`);
      activeTrade = null;
      return;
    }

    if (p >= activeTrade.tp) {
      await send(`🟢 TP HIT\n${activeTrade.coin} LONG\nLive: ${fmt(p)}`);
      activeTrade = null;
      return;
    }
  }

  if (activeTrade.side === "SHORT") {
    if (p >= activeTrade.stop) {
      await send(`🔴 STOP HIT\n${activeTrade.coin} SHORT\nLive: ${fmt(p)}`);
      activeTrade = null;
      return;
    }

    if (p <= activeTrade.tp) {
      await send(`🟢 TP HIT\n${activeTrade.coin} SHORT\nLive: ${fmt(p)}`);
      activeTrade = null;
      return;
    }
  }
}

async function run() {
  console.log("RUN");

  if (!SYMBOLS.length) {
    SYMBOLS = await loadSymbols();
  }

  if (!SYMBOLS.length) {
    console.log("NO SYMBOLS");
    return;
  }

  await updateTrade();

  if (activeTrade) {
    console.log("ACTIVE:", activeTrade.coin, activeTrade.side);
    return;
  }

  const debug = {
    checked: 0,
    dataFail: 0,
    candidates: 0,
    scoreFail: 0,
    rrFail: 0,
    passed: 0
  };

  let best = null;

  for (const symbol of SYMBOLS) {
    const s = await scan(symbol, debug);

    if (s && (!best || s.score > best.score || (s.score === best.score && s.rr > best.rr))) {
      best = s;
    }
  }

  console.log("DEBUG:", debug);
  console.log("BEST:", best ? `${best.coin} ${best.side} SCORE:${best.score.toFixed(1)} RR:${best.rr.toFixed(2)}` : "NONE");

  if (!best) {
    console.log("NO SIGNAL");
    return;
  }

  const sent = await send(signalText(best));

  if (sent) {
    activeTrade = best;
    console.log("SIGNAL SENT:", best.coin, best.side);
  }
}

async function main() {
  if (!TG_TOKEN || !CHAT_ID) {
    console.log("ENV ERROR: TG_BOT_TOKEN / TG_CHAT_ID");
    return;
  }

  SYMBOLS = await loadSymbols();

  while (true) {
    try {
      await run();
    } catch (e) {
      console.log("RUN ERROR:", e.message);
    }

    console.log("SLEEPING:", LOOP_MS);
    await new Promise(r => setTimeout(r, LOOP_MS));
  }
}

main();
