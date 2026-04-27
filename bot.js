const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;

const BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com"
];

let COINS = [];
let activeTrade = null;

console.log("🚀 AUTO MARKET SCANNER START");

async function fetchJson(path) {
  for (const base of BASES) {
    try {
      const r = await fetch(base + path);
      if (!r.ok) continue;
      return await r.json();
    } catch {}
  }
  return null;
}

// 🔥 TÜM USDT FUTURES COINLERİ ÇEK
async function loadAllCoins() {
  const data = await fetchJson("/fapi/v1/exchangeInfo");
  if (!data) {
    console.log("❌ COIN LOAD FAILED");
    return;
  }

  COINS = data.symbols
    .filter(s => s.contractType === "PERPETUAL")
    .filter(s => s.symbol.endsWith("USDT"))
    .map(s => s.symbol);

  console.log("✅ AUTO COIN COUNT:", COINS.length);
}

async function klines(symbol) {
  return fetchJson(`/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=100`);
}

function closes(d) { return d.map(x => Number(x[4])); }
function highs(d) { return d.map(x => Number(x[2])); }
function lows(d) { return d.map(x => Number(x[3])); }
function volumes(d) { return d.map(x => Number(x[5])); }

function avg(a) {
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function rr(entry, stop, tp) {
  return Math.abs(tp - entry) / Math.abs(entry - stop);
}

async function send(msg) {
  if (!TG_TOKEN || !CHAT_ID) return;

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg
    })
  });
}

async function scan() {
  let checked = 0;
  let dataFail = 0;
  let found = null;

  for (const coin of COINS) {
    checked++;

    const d = await klines(coin);
    if (!Array.isArray(d) || d.length < 50) {
      dataFail++;
      continue;
    }

    const c = closes(d);
    const h = highs(d);
    const l = lows(d);
    const v = volumes(d);

    const last = c.at(-1);
    const prev = c.at(-2);

    const high = Math.max(...h.slice(-10, -1));
    const low = Math.min(...l.slice(-10, -1));

    const volNow = v.at(-1);
    const volAvg = avg(v.slice(-20, -1));

    // 🔥 BASİT AMA ETKİLİ BREAKOUT
    if (last > high && volNow > volAvg) {
      const stop = low;
      const tp = last + (last - stop) * 1.5;

      if (rr(last, stop, tp) > 1.3) {
        found = {
          coin,
          side: "LONG",
          entry: last,
          stop,
          tp
        };
        break;
      }
    }

    if (last < low && volNow > volAvg) {
      const stop = high;
      const tp = last - (stop - last) * 1.5;

      if (rr(last, stop, tp) > 1.3) {
        found = {
          coin,
          side: "SHORT",
          entry: last,
          stop,
          tp
        };
        break;
      }
    }
  }

  console.log("DEBUG:", { checked, dataFail });

  if (found) {
    console.log("🔥 SIGNAL:", found.coin);

    await send(`🔥 SIGNAL

${found.coin}
${found.side}

Entry: ${found.entry}
Stop: ${found.stop}
TP: ${found.tp}`);

    activeTrade = found;
  } else {
    console.log("NO SIGNAL");
  }
}

async function main() {
  await loadAllCoins();

  while (true) {
    try {
      await scan();
    } catch (e) {
      console.log("ERROR:", e.message);
    }

    await new Promise(r => setTimeout(r, LOOP_MS));
  }
}

main();
