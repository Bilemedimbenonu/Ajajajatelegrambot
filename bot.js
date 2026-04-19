// =======================
// 🚀 WORKING TELEGRAM SCANNER BOT
// =======================

// ❌ node-fetch YOK (EN ÖNEMLİ FİX)

// ===== ENV =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALLOWLIST_RAW = process.env.ALLOWLIST || "BTCUSDT,ETHUSDT,SOLUSDT";

// ===== PARSE =====
const ALLOWLIST = ALLOWLIST_RAW.split(",")
  .map(x => x.trim())
  .filter(Boolean);

// ===== START LOG =====
console.log("🚀 BOT STARTED");
console.log("ALLOWLIST:", ALLOWLIST);
console.log("TOKEN:", TELEGRAM_BOT_TOKEN ? "OK" : "MISSING");
console.log("CHAT ID:", TELEGRAM_CHAT_ID || "MISSING");

// ===== TELEGRAM SEND =====
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

// ===== TELEGRAM TEST =====
async function testTelegram() {
  await sendTelegram("✅ TEST MESSAGE - BOT ONLINE");
}

// ===== BINANCE PRICE =====
async function getPrice(symbol) {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );
    const data = await res.json();
    return Number(data.price);
  } catch (err) {
    console.error(`❌ Binance error (${symbol}):`, err);
    return null;
  }
}

// ===== SCAN =====
async function scan() {
  console.log("🔍 SCAN STARTED");

  for (const symbol of ALLOWLIST) {
    try {
      console.log(`➡️ Checking ${symbol}`);

      const price = await getPrice(symbol);

      if (!price) {
        console.log(`⚠️ No data for ${symbol}`);
        continue;
      }

      console.log(`💰 ${symbol}: ${price}`);

      // ===== TEST SIGNAL =====
      const message = `🔥 SIGNAL\n${symbol}\nPrice: ${price}`;

      await sendTelegram(message);

    } catch (err) {
      console.error(`❌ Scan error (${symbol}):`, err);
    }
  }

  console.log("✅ SCAN DONE");
}

// ===== START =====
async function start() {
  await testTelegram();   // Telegram çalışıyor mu test

  await scan();           // ilk scan

  setInterval(scan, 20000); // 20 saniyede bir tekrar
}

start();
