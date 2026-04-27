const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);

const MIN_SCORE = parseFloat(process.env.MIN_SCORE || "5.0");
const MIN_RR = parseFloat(process.env.MIN_RR || "1.25");

const OKX_BASE = "https://www.okx.com";

const COINS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","ADAUSDT","DOGEUSDT",
  "AVAXUSDT","LINKUSDT","DOTUSDT","ATOMUSDT","INJUSDT","NEARUSDT","APTUSDT",
  "OPUSDT","ARBUSDT","SEIUSDT","SUIUSDT","LTCUSDT","BCHUSDT","ICPUSDT",
  "STXUSDT","THETAUSDT","ALGOUSDT","VETUSDT","XLMUSDT","HBARUSDT",
  "EGLDUSDT","AXSUSDT","SANDUSDT","MANAUSDT","GALAUSDT","APEUSDT",
  "PEPEUSDT","FLOKIUSDT","BLURUSDT","ENSUSDT","CHZUSDT","CRVUSDT",
  "RUNEUSDT","IMXUSDT","GMXUSDT","LDOUSDT","MINAUSDT","SNXUSDT",
  "DYDXUSDT","ZILUSDT","1INCHUSDT","KAVAUSDT","ROSEUSDT","CELOUSDT",
  "QTUMUSDT","ONTUSDT"
];

let activeTrade = null;

console.log("🔥 OKX V11 SCANNER START");
console.log("COIN COUNT:", COINS.length);

function toOkxSymbol(symbol) {
  return symbol.replace("USDT", "-USDT-SWAP");
}

async function fetchJson(path) {
  try {
    const r = await fetch(OKX_BASE + path, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!r.ok) {
      console.log("OKX FETCH FAIL:", r.status, path);
      return null;
    }

    return await r.json();
  } catch (e) {
    console.log("OKX FETCH ERROR:", e.message);
    return null;
  }
}

async function klines(symbol) {
  const instId = toOkxSymbol(symbol);
  const d = await fetchJson(`/api/v5/market/candles?instId=${instId}&bar=${ENTRY_TF}&limit=120`);

  if (!d || d.code !== "0" || !Array.isArray(d.data)) return null;

  return d.data
    .slice()
    .reverse()
    .map(x => ({
      open: Number(x[1]),
      high: Number(x[2]),
      low: Number(x[3]),
      close: Number(x[4]),
      volume: Number(x[5])
    }));
}

async function price(symbol) {
  const instId = toOkxSymbol(symbol);
  const d = await fetchJson(`/api/v5/market/ticker?instId=${instId}`);

  if (!d || d.code !== "0" || !d.data?.[0]?.last) return null;

  return Number(d.data[0].last);
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
  return `🔥 OKX DATA SIGNAL

Coin: ${s.coin}
Side: ${s.side}
Score: ${s.score.toFixed(1)}/10
RR: ${s.rr.toFixed(2)}

Entry: ${fmt(s.entry)}
Stop: ${fmt(s.stop)}
TP: ${fmt(s.tp)}

Not: Veri OKX, işlem açacaksan Binance fiyatını kontrol et.`;
}

async function scan(symbol, debug) {
  debug.checked++;

  const d = await klines(symbol);

  if (!Array.isArray(d) || d.length < 60) {
    debug.dataFail++;
    return null;
  }

  const c = d.map(x => x.close);
  const h = d.map(x => x.high);
  const l = d.map(x => x.low);
  const v = d.map(x => x.volume);

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
    console.log(symbol, "CANDIDATE", "L:", longScore.toFixed(1), "S:", shortScore.toFixed(1));
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

  for (const symbol of COINS) {
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
