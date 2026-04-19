// =======================
// 🔥 FULL DEBUG SCANNER BOT
// =======================

import fetch from "node-fetch";

// ===== ENV =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALLOWLIST_RAW = process.env.ALLOWLIST || "BTCUSDT,ETHUSDT,SOLUSDT";

// ===== PARSE ALLOWLIST =====
const ALLOWLIST = ALLOWLIST_RAW.split(",")
  .map(x => x.trim())
  .filter(Boolean);

// ===== START LOG =====
console.log("🚀 BOT STARTED");
console.log("ALLOWLIST RAW:", ALLOWLIST_RAW);
console.log("ALLOWLIST PARSED:", ALLOWLIST);
console.log("ALLOWLIST COUNT:", ALLOWLIST.length);
console.log("TELEGRAM TOKEN:", TELEGRAM_BOT_TOKEN ? "OK" : "MISSING");
console.log("TELEGRAM CHAT ID:", TELEGRAM_CHAT_ID || "MISSING");

// ===== TELEGRAM TEST =====
async function testTelegram() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: "✅ TEST MESSAGE - BOT ONLINE"
      })
    });

    const data = await res.json();
    console.log("📨 TELEGRAM TEST RESPONSE:", data);
  } catch (err) {
    console.error("❌ TELEGRAM ERROR:", err);
  }
}

// ===== BINANCE FETCH =====
async function getPrice(symbol) {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );
    const data = await res.json();
    return Number(data.price);
  } catch (err) {
    console.error(`❌ BINANCE ERROR (${symbol}):`, err);
    return null;
  }
}

// ===== SCAN LOOP =====
async function scan() {
  console.log("🔍 SCAN STARTED");

  for (const symbol of ALLOWLIST) {
    try {
      console.log(`➡️ Checking ${symbol}...`);

      const price = await getPrice(symbol);

      if (!price) {
        console.log(`⚠️ No price for ${symbol}`);
        continue;
      }

      console.log(`💰 ${symbol} PRICE: ${price}`);

      // ===== BASIT SİNYAL (TEST AMAÇLI) =====
      // Her coin için FAKE sinyal üretelim ki pipeline test edilsin

      const message = `🔥 TEST SIGNAL\n${symbol}\nPrice: ${price}`;

      await sendTelegram(message);

    } catch (err) {
      console.error(`❌ SCAN ERROR (${symbol}):`, err);
    }
  }

  console.log("✅ SCAN COMPLETED");
}

// ===== TELEGRAM SEND =====
async function sendTelegram(text) {
  try {
    console.log("📤 SENDING TELEGRAM:", text);

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text
      })
    });

    const data = await res.json();

    console.log("📨 TELEGRAM RESPONSE:", data);

  } catch (err) {
    console.error("❌ TELEGRAM SEND ERROR:", err);
  }
}

// ===== RUN =====
async function start() {
  await testTelegram();

  // İlk scan hemen
  await scan();

  // Sonra sürekli çalışsın
  setInterval(scan, 20000);
}

start();
