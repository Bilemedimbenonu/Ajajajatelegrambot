const axios = require("axios");
const TG_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT = process.env.TG_CHAT_ID || "";
const BINANCE = "https://fapi.binance.com";
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const SCAN_MS = 60000;

async function bGet(path, params) {
  try {
    const r = await axios.get(BINANCE + path, { params: params || {}, timeout: 12000, headers: { "User-Agent": "Mozilla/5.0" } });
    return r.data;
  } catch(e) { return null; }
}

async function getCandles(sym, tf, limit) {
  const d = await bGet("/fapi/v1/klines", { symbol: sym, interval: tf, limit: limit || 100 });
  if (!d) return null;
  return d.map(c => ({ open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]) }));
}

async function getFunding(sym) {
  const d = await bGet("/fapi/v1/premiumIndex", { symbol: sym });
  return d ? parseFloat(d.lastFundingRate || 0) : null;
}

function calcOBV(candles) {
  let obv = 0;
  const obvArr = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i-1].close) obv += candles[i].volume;
    else if (candles[i].close < candles[i-1].close) obv -= candles[i].volume;
    obvArr.push(obv);
  }
  return obvArr;
}

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  let ema = arr[0];
  const result = [ema];
  for (let i = 1; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcATR(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i-1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  return calcEMA(trs, period);
}

function fmtPrice(p) {
  if (p >= 1000) return p.toFixed(1);
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  return p.toFixed(5);
}

async function tgSend(text) {
  try {
    await axios.post("https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage", {
      chat_id: TG_CHAT, text: text, parse_mode: "HTML"
    });
  } catch(e) {}
}

var lastSignal = {};
var COOLDOWN = 0;

async function scanSymbol(sym) {
  try {
    const key = sym;
    if (Date.now() - (lastSignal[key] || 0) < COOLDOWN) return;

    const [c5m, c15m, funding] = await Promise.all([
      getCandles(sym, "5m", 100),
      getCandles(sym, "15m", 100),
      getFunding(sym)
    ]);

    if (!c5m || !c15m) return;
    if (c5m.length < 50 || c15m.length < 50) return;

    const n5 = c5m.length - 1;
    const n15 = c15m.length - 1;
    const price = c5m[n5].close;

    const atr5 = calcATR(c5m, 14);
    const atrVal = atr5[n5];

    const obv5 = calcOBV(c5m);
    const obv15 = calcOBV(c15m);

    const obvEma5 = calcEMA(obv5, 20);
    const obvEma15 = calcEMA(obv15, 20);

    const obv5Bull = obv5[n5] > obvEma5[n5] && obv5[n5] > obv5[n5-3];
    const obv5Bear = obv5[n5] < obvEma5[n5] && obv5[n5] < obv5[n5-3];

    const obv15Bull = obv15[n15] > obvEma15[n15] && obv15[n15] > obv15[n15-3];
    const obv15Bear = obv15[n15] < obvEma15[n15] && obv15[n15] < obv15[n15-3];

    const price5Low = Math.min(...c5m.slice(-10).map(c => c.low));
    const obvLow = Math.min(...obv5.slice(-10));
    const bullDiv = c5m[n5].low <= price5Low && obv5[n5] > obvLow * 1.02;

    const price5High = Math.max(...c5m.slice(-10).map(c => c.high));
    const obvHigh = Math.max(...obv5.slice(-10));
    const bearDiv = c5m[n5].high >= price5High && obv5[n5] < obvHigh * 0.98;

    const fundingExtremeLong = funding > 0.0005;
    const fundingExtremeShort = funding < -0.0005;

    const lastCandle = c5m[n5];
    const body = Math.abs(lastCandle.close - lastCandle.open);
    const totalRange = lastCandle.high - lastCandle.low;
    if (totalRange > 0 && body / totalRange < 0.4) return;

    let direction = null;
    if (obv5Bull && obv15Bull && (bullDiv || fundingExtremeShort)) {
      direction = "long";
    } else if (obv5Bear && obv15Bear && (bearDiv || fundingExtremeLong)) {
      direction = "short";
    }

    if (!direction) return;

    let sl, tp1, tp2, tp3;
    if (direction === "long") {
      sl = price - atrVal * 1.5;
      tp1 = price + atrVal * 1.5;
      tp2 = price + atrVal * 3.0;
      tp3 = price + atrVal * 5.0;
    } else {
      sl = price + atrVal * 1.5;
      tp1 = price - atrVal * 1.5;
      tp2 = price - atrVal * 3.0;
      tp3 = price - atrVal * 5.0;
    }

    const slDist = Math.abs(price - sl) / price;
    if (slDist > 0.05 || slDist < 0.002) return;
    const rr = Math.abs(tp2 - price) / Math.abs(price - sl);
    if (rr < 1.5) return;

    lastSignal[key] = Date.now();

    const lev = 10;
    const label = direction === "long" ? "[LONG]" : "[SHORT]";
    const slPct = (slDist * 100).toFixed(2);
    const tp1Pct = (Math.abs(tp1 - price) / price * 100).toFixed(2);
    const tp2Pct = (Math.abs(tp2 - price) / price * 100).toFixed(2);
    const tp3Pct = (Math.abs(tp3 - price) / price * 100).toFixed(2);
    const fund = funding !== null ? (funding * 100).toFixed(4) + "%" : "-";
    const rrStr = (Math.abs(tp2 - price) / Math.abs(price - sl)).toFixed(1);
    const divStr = direction === "long" ? (bullDiv ? "BULL-DIV" : "FUND-EXT") : (bearDiv ? "BEAR-DIV" : "FUND-EXT");

    const msg =
      "<b>" + label + " " + sym + "</b>\n" +
      "--------\n" +
      "<b>Giris:</b> " + fmtPrice(price) + "\n" +
      "<b>OBV Sinyal:</b> " + divStr + "\n\n" +
      "<b>TP1:</b> " + fmtPrice(tp1) + " (+" + tp1Pct + "% | " + lev + "x:+%" + (parseFloat(tp1Pct)*lev).toFixed(0) + ") %30\n" +
      "<b>TP2:</b> " + fmtPrice(tp2) + " (+" + tp2Pct + "% | " + lev + "x:+%" + (parseFloat(tp2Pct)*lev).toFixed(0) + ") %40\n" +
      "<b>TP3:</b> " + fmtPrice(tp3) + " (+" + tp3Pct + "% | " + lev + "x:+%" + (parseFloat(tp3Pct)*lev).toFixed(0) + ") %30\n" +
      "<b>SL:</b> " + fmtPrice(sl) + " (-" + slPct + "% | " + lev + "x:-%" + (parseFloat(slPct)*lev).toFixed(0) + ")\n" +
      "--------\n" +
      "R:R: 1:" + rrStr + " | Funding: " + fund + "\n" +
      "--------\n" +
      "<b>OBV Bot v1.0 | BTC+ETH</b>\n" +
      "Strateji: OBV Divergence + Funding\n" +
      "--------\n" +
      "<i>TP1 gelince SL girise cek!</i>\n" +
      "<i>TP3 hedefliyorsan pozisyonu koru!</i>\n" +
      new Date().toUTCString().slice(5, 25) + " UTC\n" +
      "<i>Ticaret tavsiyesi degildir.</i>";

    console.log("[SINYAL] " + sym + " " + direction.toUpperCase());
    await tgSend(msg);

    var tpHit = { tp1: false, tp2: false, sl: false };
    var trackInterval = setInterval(async function() {
      try {
        var d = await bGet("/fapi/v1/ticker/price", { symbol: sym });
        if (!d) return;
        var cur = parseFloat(d.price);

        if (direction === "long") {
          if (!tpHit.tp1 && cur >= tp1) {
            tpHit.tp1 = true;
            await tgSend("🟡 <b>TP1 HIT!</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\nSL girise cek! (" + fmtPrice(price) + ")\nTP2/TP3 icin pozisyonu koru.");
          }
          if (!tpHit.tp2 && cur >= tp2) {
            tpHit.tp2 = true;
            await tgSend("🟢 <b>TP2 HIT!</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\nTP3 hedefliyorsan pozisyonu koru!\nHedef: " + fmtPrice(tp3));
          }
          if (!tpHit.sl && cur <= sl) {
            tpHit.sl = true;
            await tgSend("🔴 <b>STOP!</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\nSL tetiklendi: " + fmtPrice(sl));
            clearInterval(trackInterval);
          }
        } else {
          if (!tpHit.tp1 && cur <= tp1) {
            tpHit.tp1 = true;
            await tgSend("🟡 <b>TP1 HIT!</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\nSL girise cek! (" + fmtPrice(price) + ")\nTP2/TP3 icin pozisyonu koru.");
          }
          if (!tpHit.tp2 && cur <= tp2) {
            tpHit.tp2 = true;
            await tgSend("🟢 <b>TP2 HIT!</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\nTP3 hedefliyorsan pozisyonu koru!\nHedef: " + fmtPrice(tp3));
          }
          if (!tpHit.sl && cur >= sl) {
            tpHit.sl = true;
            await tgSend("🔴 <b>STOP!</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\nSL tetiklendi: " + fmtPrice(sl));
            clearInterval(trackInterval);
          }
        }
        setTimeout(function() { clearInterval(trackInterval); }, 14400000);
      } catch(e) {}
    }, 30000);

  } catch(e) {
    console.error("[ERR] " + sym + ": " + e.message);
  }
}

async function main() {
  console.log("OBV Bot v1.0 basliyor...");
  console.log("Semboller: " + SYMBOLS.join(", "));
  console.log("Strateji: OBV Divergence + Funding Rate");

  await tgSend(
    "<b>OBV Bot v1.0</b>\n\n" +
    "Strateji: OBV Divergence + Funding Rate\n" +
    "Semboller: BTCUSDT + ETHUSDT\n" +
    "Tarama: Her dakika\n" +
    "TP/SL takibi: Otomatik\n\n" +
    "<i>Basladi!</i>"
  );

  while (true) {
    const t0 = Date.now();
    for (const sym of SYMBOLS) {
      await scanSymbol(sym);
    }
    await new Promise(r => setTimeout(r, Math.max(0, SCAN_MS - (Date.now() - t0))));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
