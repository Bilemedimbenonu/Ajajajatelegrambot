const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const COINS = (process.env.COIN_LIST || "").split(",");

async function fetchKlines(symbol, interval = "5m") {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=50`;
    const res = await fetch(url);
    return await res.json();
  } catch (e) {
    return null;
  }
}

function calcMomentum(data) {
  if (!data || data.length < 2) return 0;
  const last = parseFloat(data[data.length - 1][4]);
  const prev = parseFloat(data[data.length - 2][4]);
  return ((last - prev) / prev) * 100;
}

async function checkCoin(symbol) {
  const data = await fetchKlines(symbol);
  if (!data) return null;

  const mom = calcMomentum(data);

  if (mom > 0.2) {
    return {
      coin: symbol,
      side: "LONG",
      score: mom.toFixed(2)
    };
  }

  if (mom < -0.2) {
    return {
      coin: symbol,
      side: "SHORT",
      score: mom.toFixed(2)
    };
  }

  return null;
}

async function sendTelegram(msg) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg
    })
  });
}

async function run() {
  for (let coin of COINS) {
    const signal = await checkCoin(coin);
    if (signal) {
      await sendTelegram(
        `🔥 SIGNAL\n${signal.coin}\n${signal.side}\nScore: ${signal.score}`
      );
    }
  }
}

setInterval(run, 60 * 1000);
run();
