require(“dotenv”).config();
const axios = require(“axios”);
const ti    = require(“technicalindicators”);

const TG_BOT_TOKEN     = process.env.TG_BOT_TOKEN || “”;
const TG_CHAT_ID       = process.env.TG_CHAT_ID   || “”;
const BINANCE_BASE     = “https://fapi.binance.com”;

const SCAN_INTERVAL_MS = 60000;
const COOLDOWN_MS      = 600000;
const CONCURRENT       = 10;

// Top 10 en yuksek hacimli coin
const WATCHLIST = [
“BTCUSDT”, “ETHUSDT”, “BNBUSDT”, “SOLUSDT”, “XRPUSDT”,
“DOGEUSDT”, “ADAUSDT”, “AVAXUSDT”, “LINKUSDT”, “TONUSDT”
];

const lastSignal = {};

async function binanceGet(path, params) {
try {
const res = await axios.get(BINANCE_BASE + path, {
params: params || {},
timeout: 12000,
headers: { “User-Agent”: “Mozilla/5.0” }
});
return res.data;
} catch(e) { return null; }
}

async function fetchCandles(symbol, interval, limit) {
const data = await binanceGet(”/fapi/v1/klines”, {
symbol: symbol, interval: interval, limit: limit || 100
});
if (!data || !data.length) return null;
return data.map(function(r) {
return {
ts: r[0], open: parseFloat(r[1]), high: parseFloat(r[2]),
low: parseFloat(r[3]), close: parseFloat(r[4]), vol: parseFloat(r[5])
};
});
}

async function fetchFunding(symbol) {
const data = await binanceGet(”/fapi/v1/premiumIndex”, { symbol: symbol });
if (!data) return null;
return parseFloat(data.lastFundingRate || 0);
}

async function fetchTicker(symbol) {
const data = await binanceGet(”/fapi/v1/ticker/price”, { symbol: symbol });
return data || null;
}

function pad(arr, len) {
var diff = len - arr.length;
if (diff <= 0) return arr;
var p = [];
for (var i = 0; i < diff; i++) p.push(null);
return p.concat(arr);
}

function calcEMA(closes, period) {
return pad(ti.EMA.calculate({ period: period, values: closes }), closes.length);
}

function calcRSI(closes, period) {
return pad(ti.RSI.calculate({ period: period, values: closes }), closes.length);
}

function calcATR(candles, period) {
return pad(ti.ATR.calculate({
high:  candles.map(function(c) { return c.high; }),
low:   candles.map(function(c) { return c.low; }),
close: candles.map(function(c) { return c.close; }),
period: period || 14
}), candles.length);
}

function calcVWAP(candles) {
var cumPV = 0, cumVol = 0;
return candles.map(function(c) {
var tp = (c.high + c.low + c.close) / 3;
cumPV += tp * c.vol;
cumVol += c.vol;
return cumVol > 0 ? cumPV / cumVol : c.close;
});
}

function calcCVD(candles) {
var cum = 0;
return candles.map(function(c) {
cum += c.close >= c.open ? c.vol : -c.vol;
return cum;
});
}

function avg(arr, last) {
var vals = arr.filter(function(v) { return v !== null; }).slice(-(last || 20));
if (!vals.length) return 0;
return vals.reduce(function(a, b) { return a + b; }, 0) / vals.length;
}

function calcSupertrend(candles, period, mult) {
period = period || 10; mult = mult || 3.0;
var atr = calcATR(candles, period), n = candles.length;
var upper = new Array(n).fill(null), lower = new Array(n).fill(null);
var dir = new Array(n).fill(1), st = new Array(n).fill(null);
for (var i = period; i < n; i++) {
var hl2 = (candles[i].high + candles[i].low) / 2, atrV = atr[i] || 0;
upper[i] = hl2 + mult * atrV; lower[i] = hl2 - mult * atrV;
if (i > period) {
if (!(upper[i] > upper[i-1] || candles[i-1].close > upper[i-1])) upper[i] = upper[i-1];
if (!(lower[i] < lower[i-1] || candles[i-1].close < lower[i-1])) lower[i] = lower[i-1];
}
if (i === period) { dir[i] = 1; st[i] = lower[i]; }
else if (st[i-1] === upper[i-1]) { dir[i] = candles[i].close > upper[i] ? 1 : -1; st[i] = dir[i] === 1 ? lower[i] : upper[i]; }
else { dir[i] = candles[i].close < lower[i] ? -1 : 1; st[i] = dir[i] === 1 ? lower[i] : upper[i]; }
}
return dir;
}

// ─── VWAP BOUNCE SISTEMI ─────────────────────────────────────
//
// Strateji:
// 1. 1h trend yukari/asagi (EMA + Supertrend)
// 2. Fiyat VWAP’a yaklasti (bounce bolgesi)
// 3. RSI geri cekilme bolgesinde (35-55 long, 45-65 short)
// 4. VWAP’tan sekis basliyor (reversal mum)
// 5. CVD destekliyor
// 6. Hacim artisi var
//
// SL: VWAP’in %0.3 altı/ustu (net, tartismasiz)
// TP1: ATR x1.5 | TP2: ATR x3.0 | TP3: ATR x5.0

function isVWAPBounce(candles, vwap, direction, n) {
if (n < 3) return false;
var price  = candles[n].close;
var vwapN  = vwap[n];
var vwapP  = vwap[n-1];
if (!vwapN || !vwapP) return false;

// Fiyat VWAP’a ne kadar yakin? (max %0.5)
var dist = Math.abs(price - vwapN) / vwapN;
if (dist > 0.005) return false;

// Onceki bar VWAP’in altinda/ustunde miydi?
var prev = candles[n-1];
var curr = candles[n];

if (direction === “long”) {
// Fiyat VWAP altina inmis, simdi geri yukari doniyor
var touchedBelow = prev.low < vwapP;
var bouncingUp   = curr.close > curr.open; // yesil mum
var aboveVWAP    = curr.close >= vwapN;
return touchedBelow && bouncingUp && aboveVWAP;
} else {
// Fiyat VWAP ustune cikip geri asagi doniyor
var touchedAbove = prev.high > vwapP;
var bouncingDown = curr.close < curr.open; // kirmizi mum
var belowVWAP    = curr.close <= vwapN;
return touchedAbove && bouncingDown && belowVWAP;
}
}

function isTrend1h(c1h, direction) {
var closes = c1h.map(function(c) { return c.close; });
var ema9   = calcEMA(closes, 9);
var ema21  = calcEMA(closes, 21);
var st     = calcSupertrend(c1h, 10, 3);
var n      = c1h.length - 1;
if (direction === “long”)  return ema9[n] > ema21[n] && st[n] === 1;
if (direction === “short”) return ema9[n] < ema21[n] && st[n] === -1;
return false;
}

function isRSIOk(candles, direction, n) {
var closes = candles.map(function(c) { return c.close; });
var rsi    = calcRSI(closes, 14);
var r      = rsi[n];
if (!r) return false;
if (direction === “long”)  return r >= 30 && r <= 58;
if (direction === “short”) return r >= 42 && r <= 70;
return false;
}

function isCVDOk(candles, direction, n) {
var cvd   = calcCVD(candles);
var cvdUp = cvd[n] > cvd[n-3];
return direction === “long” ? cvdUp : !cvdUp;
}

function isVolumeOk(candles, n) {
var vols   = candles.map(function(c) { return c.vol; });
var volAvg = avg(vols, 20);
return candles[n].vol > volAvg * 1.3;
}

function isFundingOk(funding, direction) {
if (funding === null) return true;
if (direction === “long”)  return funding < 0.001;
if (direction === “short”) return funding > 0.0001;
return true;
}

// ─── SR SEVIYELERI ───────────────────────────────────────────

function findSwings(candles, lookback) {
lookback = lookback || 5;
var n = candles.length;
var highs = [], lows = [];
for (var i = lookback; i < n - lookback; i++) {
var isHigh = true, isLow = true;
for (var j = i - lookback; j <= i + lookback; j++) {
if (j === i) continue;
if (candles[j].high >= candles[i].high) isHigh = false;
if (candles[j].low  <= candles[i].low)  isLow  = false;
}
if (isHigh) highs.push(candles[i].high);
if (isLow)  lows.push(candles[i].low);
}
return { highs: highs, lows: lows };
}

function calcTP(price, atr, direction) {
if (direction === “long”) {
return {
tp1: price + atr * 1.5,
tp2: price + atr * 3.0,
tp3: price + atr * 5.0
};
} else {
return {
tp1: price - atr * 1.5,
tp2: price - atr * 3.0,
tp3: price - atr * 5.0
};
}
}

function calcSL(price, vwap, atr, direction) {
if (direction === “long”) {
// VWAP altina SL, ama en az ATR x0.5 uzakta
var slVWAP = vwap * 0.997;
var slATR  = price - atr * 0.8;
return Math.min(slVWAP, slATR);
} else {
var slVWAP = vwap * 1.003;
var slATR  = price + atr * 0.8;
return Math.max(slVWAP, slATR);
}
}

// ─── TELEGRAM ────────────────────────────────────────────────

async function sendTelegram(text) {
if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
try {
await axios.post(
“https://api.telegram.org/bot” + TG_BOT_TOKEN + “/sendMessage”,
{ chat_id: TG_CHAT_ID, text: text, parse_mode: “HTML”, disable_web_page_preview: true },
{ timeout: 8000 }
);
} catch(e) { console.error(”[TG ERR]”, e.message); }
}

function fmtPrice(p) {
if (p < 0.001)  return p.toFixed(7);
if (p < 0.01)   return p.toFixed(6);
if (p < 1)      return p.toFixed(5);
if (p < 100)    return p.toFixed(4);
if (p < 10000)  return p.toFixed(2);
return p.toFixed(1);
}

function buildMessage(symbol, direction, price, sl, tps, funding, score, hits) {
var emoji = direction === “long” ? “🟢” : “🔴”;
var dirTr = direction === “long” ? “LONG  ▲” : “SHORT ▼”;
var lev   = 20;

var slPct   = (Math.abs(price - sl) / price * 100).toFixed(2);
var tp1Pct  = (Math.abs(tps.tp1 - price) / price * 100).toFixed(2);
var tp2Pct  = (Math.abs(tps.tp2 - price) / price * 100).toFixed(2);
var tp3Pct  = (Math.abs(tps.tp3 - price) / price * 100).toFixed(2);
var rr      = (parseFloat(tp2Pct) / parseFloat(slPct)).toFixed(1);

var fundStr = funding !== null ? (funding * 100).toFixed(4) + “%” : “-”;
var now     = new Date().toUTCString().slice(5, 25) + “ UTC”;
var bar     = “█”.repeat(score) + “░”.repeat(5 - score);
var tier    = score === 5 ? “🔥 MUKEMMEL” : score === 4 ? “⭐ GUCLU” : “✅ IYI”;

// 20x kar/zarar
var sl20  = (parseFloat(slPct)  * lev).toFixed(0);
var tp120 = (parseFloat(tp1Pct) * lev).toFixed(0);
var tp220 = (parseFloat(tp2Pct) * lev).toFixed(0);
var tp320 = (parseFloat(tp3Pct) * lev).toFixed(0);

return emoji + “ <b>” + dirTr + “ — “ + symbol + “</b>\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💰 <b>Giris:</b> “ + fmtPrice(price) + “\n\n” +
“🎯 <b>TP1:</b> “ + fmtPrice(tps.tp1) + “  (+” + tp1Pct + “% | 20x:+%” + tp120 + “) <i>%40 kapat</i>\n” +
“🎯 <b>TP2:</b> “ + fmtPrice(tps.tp2) + “  (+” + tp2Pct + “% | 20x:+%” + tp220 + “) <i>%40 kapat</i>\n” +
“🎯 <b>TP3:</b> “ + fmtPrice(tps.tp3) + “  (+” + tp3Pct + “% | 20x:+%” + tp320 + “) <i>%20 beklet</i>\n” +
“🛑 <b>SL:</b>  “ + fmtPrice(sl) + “  (-” + slPct + “% | 20x:-%” + sl20 + “)\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“📊 Skor: “ + bar + “ <b>” + score + “/5</b>  “ + tier + “\n” +
“✅ <code>” + hits.join(” “) + “</code>\n” +
“⚖️ R:R: 1:” + rr + “ | 💸 Funding: “ + fundStr + “\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“📌 Strateji: VWAP Bounce\n” +
“📌 SL: VWAP altı/üstü\n” +
“📌 TP: ATR bazlı\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💡 <i>Mum KAPANISINI bekle sonra gir!\n” +
“TP1’de %40 kapat, SL’i girise cek.\n” +
“$100 kazaninca O GUN DUR!</i>\n” +
“🕒 “ + now + “\n” +
“<i>⚠ Ticaret tavsiyesi degildir.</i>”;
}

// ─── TARAMA ──────────────────────────────────────────────────

async function scanCoin(symbol) {
try {
var ticker = await fetchTicker(symbol);
if (!ticker) return;
var price = parseFloat(ticker.price || 0);
if (price <= 0) return;

```
var results = await Promise.all([
  fetchCandles(symbol, "1h",  100),
  fetchCandles(symbol, "15m", 100),
  fetchFunding(symbol)
]);

var c1h     = results[0];
var c15m    = results[1];
var funding = results[2];

if (!c1h || !c15m || c1h.length < 30 || c15m.length < 30) return;

var vwap15 = calcVWAP(c15m);
var atr15  = calcATR(c15m, 14);
var n15    = c15m.length - 1;
var atrVal = atr15[n15] || price * 0.005;

for (var d = 0; d < 2; d++) {
  var direction = d === 0 ? "long" : "short";
  var key = symbol + "_" + direction;
  if (Date.now() - (lastSignal[key] || 0) < COOLDOWN_MS) continue;

  // 1. VWAP Bounce ana kosul
  if (!isVWAPBounce(c15m, vwap15, direction, n15)) continue;

  // 2. 1h trend teyidi
  if (!isTrend1h(c1h, direction)) continue;

  var score = 2; // VWAP bounce + trend = 2 puan
  var hits  = ["VWAP-BOUNCE", "TREND"];

  // 3. RSI
  if (isRSIOk(c15m, direction, n15)) { score++; hits.push("RSI"); }

  // 4. CVD
  if (isCVDOk(c15m, direction, n15)) { score++; hits.push("CVD"); }

  // 5. Hacim
  if (isVolumeOk(c15m, n15)) { score++; hits.push("VOL"); }

  // Funding bonus
  var fundOk = isFundingOk(funding, direction);
  if (fundOk) hits.push("FUND");

  // Min 3/5 skor gerekli (VWAP+TREND zorunlu + en az 1 teyit)
  if (score < 3) continue;

  // SL ve TP hesapla
  var sl  = calcSL(price, vwap15[n15], atrVal, direction);
  var tps = calcTP(price, atrVal, direction);

  // SL mantikli mi?
  if (direction === "long"  && sl >= price) continue;
  if (direction === "short" && sl <= price) continue;

  var slDist = Math.abs(price - sl) / price;
  if (slDist > 0.05) continue;
  if (slDist < 0.001) continue;

  // R:R min 1:1.5
  var rr = Math.abs(tps.tp1 - price) / Math.abs(price - sl);
  if (rr < 1.5) continue;

  console.log("🚀 VWAP BOUNCE " + symbol + " " + direction.toUpperCase() + " " + score + "/5 " + hits.join(" "));
  await sendTelegram(buildMessage(symbol, direction, price, sl, tps, funding, score, hits));
  lastSignal[key] = Date.now();
}
```

} catch(e) { console.error(”[ERR] “ + symbol + “: “ + e.message); }
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
console.log(”=”.repeat(55));
console.log(”  VWAP Bounce Scanner v5”);
console.log(”  Strateji: VWAP Bounce - Kurumsal Seviye”);
console.log(”  Coinler: Top 10 Hacimli”);
console.log(”  TF: 1h trend + 15m giris”);
console.log(”  SL: VWAP altı/ustu | TP: ATR bazli”);
console.log(”=”.repeat(55));

await sendTelegram(
“🤖 <b>VWAP Bounce Scanner v5 aktif</b>\n” +
“Strateji: VWAP Bounce\n” +
“Coinler: BTC ETH BNB SOL XRP DOGE ADA AVAX LINK TON\n” +
“TF: 1h trend + 15m bounce\n” +
“Gunluk $100 kazaninca DUR!”
);

var cycle = 0;
while (true) {
cycle++;
var t0 = Date.now();
console.log(”\n— Tur #” + cycle + “ | “ + new Date().toUTCString() + “ —”);

```
await Promise.all(WATCHLIST.map(function(s) { return scanCoin(s); }));

var elapsed = Date.now() - t0;
console.log("--- Tur #" + cycle + " bitti (" + (elapsed/1000).toFixed(1) + "s) ---");

var wait = Math.max(0, SCAN_INTERVAL_MS - elapsed);
if (wait) await sleep(wait);
```

}
}

main().catch(function(e) { console.error(”[FATAL]”, e); process.exit(1); });
