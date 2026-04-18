const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

console.log("BOT STARTED");

async function fetchKlines(symbol, interval = "5m") {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=50`;
    const res = await fetch(url);

    if (!res.ok) {
      console.log(`Fetch failed: ${symbol} ${interval} ${res.status}`);
      return null;
    }

    const data = await res.json();

    if (!Array.isArray(data)) return null;
    if (data.length < 2) return null;
    if (!Array.isArray(data[0])) return null;

    return data;
  } catch (e) {
    console.log("fetchKlines error:", symbol, e?.message || e);
    return null;
  }
}

function calcMomentum(data) {
  if (!data || !Array.isArray(data)) return 0;
  if (data.length < 2) return 0;

  const lastCandle = data[data.length - 1];
  const prevCandle = data[data.length - 2];

  if (!lastCandle || !prevCandle) return 0;
  if (!Array.isArray(lastCandle) || !Array.isArray(prevCandle)) return 0;
  if (lastCandle.length < 5 || prevCandle.length < 5) return 0;

  const last = parseFloat(lastCandle[4]);
  const prev = parseFloat(prevCandle[4]);

  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return 0;

  return ((last - prev) / prev) * 100;
}

async function checkCoin(symbol) {
  const data = await fetchKlines(symbol, "5m");
  if (!data) return null;

  const mom = calcMomentum(data);

  if (mom > 0.1) {
    return {
      coin: symbol,
      side: "LONG",
      score: mom.toFixed(2)
    };
  }

  if (mom < -0.1) {
    return {
      coin: symbol,
      side: "SHORT",
      score: mom.toFixed(2)
    };
  }

  return null;
}

async function sendTelegram(msg) {
  if (!TG_TOKEN || !CHAT_ID) {
    console.log("Missing TG_BOT_TOKEN or TG_CHAT_ID");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: msg
      })
    });

    const text = await res.text();
    console.log("Telegram response:", text);
  } catch (e) {
    console.log("Telegram send error:", e?.message || e);
  }
}

async function run() {
  console.log("RUN START");

  await sendTelegram("TEST MESAJI GELDI");

  if (!COINS.length) {
    console.log("COIN_LIST is empty");
    return;
  }

  for (const coin of COINS) {
    const signal = await checkCoin(coin);

    if (signal) {
      const msg = `🔥 SIGNAL
${signal.coin}
${signal.side}
Score: ${signal.score}`;

      console.log("Signal found:", msg);
      await sendTelegram(msg);
    } else {
      console.log("No signal:", coin);
    }
  }

  console.log("RUN END");
}

async function main() {
  if (!TG_TOKEN || !CHAT_ID || COINS.length === 0) {
    console.log("Missing TG_BOT_TOKEN / TG_CHAT_ID / COIN_LIST");
    process.exit(1);
  }

  while (true) {
    await run();
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

main().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
