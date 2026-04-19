// =======================
// 🚀 FINAL WORKING BOT (BINANCE + FALLBACK)
// =======================

// ===== ENV =====
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID;

const ALLOWLIST_RAW =
  process.env.ALLOWLIST || "BTCUSDT,ETHUSDT,SOLUSDT";

// ===== PARSE =====
const ALLOWLIST = ALLOWLIST_RAW.split(",")
  .map(x => x.trim())
  .filter(Boolean);

// ===== START LOG =====
console.log("🚀 BOT STARTED");
console.log("ALLOWLIST:", ALLOWLIST);
console.log("TOKEN:", TELEGRAM_BOT_TOKEN ? "OK" : "MISSING");
console.log("CHAT ID:", TELEGRAM_CHAT_ID || "MISSING");

// ===== TELEGRAM =====
async function sendTelegram(text) {
  try {
    console.log("📤 Sending:", text);

    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: text
        })
      }
    );

    const data = await res.json();
    console.log("📨 Telegram response:", data);
  } catch (err) {
    console.error("❌ Telegram error:", err);
  }
}

// ===== BINANCE PRICE =====
async function getBinancePrice(symbol) {
  try {
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.lastPrice) return null;

    return Number(data.lastPrice);
  } catch (err) {
    console.log("⚠️ Binance failed:", symbol);
    return null;
  }
}

// ===== COINGECKO FALLBACK =====
async function getCoinGeckoPrice(symbol) {
  try {
    const map = {
      BTCUSDT: "bitcoin",
      ETHUSDT: "ethereum",
      SOLUSDT: "solana"
    };

    const id = map[symbol];
    if (!id) return null;

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data[id]) return null;

    return data[id].usd;
  } catch (err) {
    console.log("⚠️ CoinGecko failed:", symbol);
    return null;
  }
}

// ===== GET PRICE =====
async function getPrice(symbol) {
  let price = await getBinancePrice(symbol);

  if (price) {
    console.log(`💰 ${symbol} Binance: ${price}`);
    return price;
  }

  console.log(`⚠️ Binance failed, fallback CoinGecko: ${symbol}`);

  price = await getCoinGeckoPrice(symbol);

  if (price) {
    console.log(`💰 ${symbol} CoinGecko: ${price}`);
    return price;
  }

  console.log(`❌ No data for ${symbol}`);
  return null;
}

// ===== SCAN =====
async function scan() {
  console.log("🔍 SCAN STARTED");

  for (const symbol of ALLOWLIST) {
    const price = await getPrice(symbol);

    if (!price) continue;

    const msg = `🔥 SIGNAL\n${symbol}\nPrice: ${price}`;

    await sendTelegram(msg);
  }

  console.log("✅ SCAN DONE");
}

// ===== START =====
async function start() {
  await sendTelegram("✅ BOT ONLINE");

  await scan();

  setInterval(scan, 20000);
}

start();
