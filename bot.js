require(“dotenv”).config();
const axios = require(“axios”);
const ti    = require(“technicalindicators”);

const TG_BOT_TOKEN     = process.env.TG_BOT_TOKEN || “”;
const TG_CHAT_ID       = process.env.TG_CHAT_ID   || “”;
const BINANCE_BASE     = “https://fapi.binance.com”;

const SCAN_INTERVAL_MS = 60000;
const COOLDOWN_MS      = 1800000;

const WATCHLIST = [
“BTCUSDT”, “ETHUSDT”, “BNBUSDT”, “SOLUSDT”, “XRPUSDT”,
“DOGEUSDT”, “ADAUSDT”, “AVAXUSDT”, “LINKUSDT”, “TONUSDT”,
“DOTUSDT”, “MATICUSDT”, “LTCUSDT”, “NEARUSDT”, “ATOMUSDT”,
“APTUSDT”, “ARBUSDT”, “OPUSDT”, “INJUSDT”, “SUIUSDT”,
“SEIUSDT”, “TIAUSDT”, “FETUSDT”, “WLDUSDT”, “RUNEUSDT”,
“FILUSDT”, “AAVEUSDT”, “UNIUSDT”, “MKRUSDT”, “SNXUSDT”,
“CRVUSDT”, “LDOUSDT”, “STXUSDT”, “ALGOUSDT”, “ICPUSDT”,
“FLOWUSDT”, “EGLDUSDT”, “SANDUSDT”, “MANAUSDT”, “AXSUSDT”
];

var dailyState = {
date: “”, signalCount: 0, hasLoss: false, maxSignals: 2
};

function getTodayUTC() {
var d = new Date();
return d.getUTCFullYear() + “-” + (d.getUTCMonth()+1) + “-” + d.getUTCDate();
}

function resetDailyIfNeeded() {
var today = getTodayUTC();
if (dailyState.date !== today) {
dailyState.date = today;
dailyState.signalCount = 0;
dailyState.hasLoss = false;
console.log(”[RESET] Yeni gun: “ + today);
}
}

function canSendSignal() {
resetDailyIfNeeded();
if (dailyState.hasLoss) { console.log(”[LIMIT] Bugun zarar var”); return false; }
if (dailyState.signalCount >= dailyState.maxSignals) { console.log(”[LIMIT] Max sinyal doldu”); return false; }
return true;
}

function isSessionOk() {
var hour = new Date().getUTCHours();
return hour >= 10 && hour < 16;
}

const lastSignal = {};

async function binanceGet(path, params) {
try {
const res = await axios.get(BINANCE_BASE + path, {
params: params || {}, timeout: 12000, headers: { “User-Agent”: “Mozilla/5.0” }
});
return res.data;
} catch(e) { return null; }
}

async function fetchCandles(symbol, interval, limit) {
const data = await binanceGet(”/fapi/v1/klines”, { symbol: symbol, interval: interval, limit: limit || 100 });
if (!data || !data.length) return null;
return data.map(function(r) {
return { ts: r[0], open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]), vol: parseFloat(r[5]) };
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

function calcEMA(closes, period) { return pad(ti.EMA.calculate({ period: period, values: closes }), closes.length); }
function calcRSI(closes, period) { return pad(ti.RSI.calculate({ period: period, values: closes }), closes.length); }
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
cumPV += tp * c.vol; cumVol += c.vol;
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

function avg(arr, last) {
var vals = arr.filter(function(v) { return v !== null; }).slice(-(last || 20));
if (!vals.length) return 0;
return vals.reduce(function(a, b) { return a + b; }, 0) / vals.length;
}

// VWAP Bounce - %0.5 tolerans
function isVWAPBounce(candles, vwap, direction, n) {
if (n < 3) return false;
var price = candles[n].close;
var vwapN = vwap[n];
if (!vwapN) return false;
var dist = Math.abs(price - vwapN) / vwapN;
if (dist > 0.008) return false;
var prev = candles[n-1], curr = candles[n];
if (direction === “long”) {
var touchedVWAP = prev.low <= vwapN * 1.003;
var greenCandle = curr.close > curr.open;
var aboveVWAP   = curr.close > vwapN;
var body        = Math.abs(curr.close - curr.open);
var lowerWick   = Math.min(curr.open, curr.close) - curr.low;
var hasWick     = body > 0 && lowerWick >= body * 0.2;
return touchedVWAP && greenCandle && aboveVWAP && hasWick;
} else {
var touchedVWAP = prev.high >= vwapN * 0.997;
var redCandle   = curr.close < curr.open;
var belowVWAP   = curr.close < vwapN;
var body        = Math.abs(curr.close - curr.open);
var upperWick   = curr.high - Math.max(curr.open, curr.close);
var hasWick     = body > 0 && upperWick >= body * 0.2;
return touchedVWAP && redCandle && belowVWAP && hasWick;
}
}

// 1h trend - EMA + Supertrend zorunlu
function isStrongTrend1h(c1h, direction) {
var closes = c1h.map(function(c) { return c.close; });
var ema9   = calcEMA(closes, 9);
var ema21  = calcEMA(closes, 21);
var st     = calcSupertrend(c1h, 10, 3);
var n      = c1h.length - 1;
if (direction === “long”)  return ema9[n] > ema21[n] && st[n] === 1;
if (direction === “short”) return ema9[n] < ema21[n] && st[n] === -1;
return false;
}

// RSI bant - gevsetildi
function isRSIOk(candles, direction, n) {
var closes = candles.map(function(c) { return c.close; });
var rsi    = calcRSI(closes, 14);
var r      = rsi[n];
if (!r) return false;
if (direction === “long”)  return r >= 28 && r <= 58;
if (direction === “short”) return r >= 42 && r <= 72;
return false;
}

// CVD - bonus
function isCVDOk(candles, direction, n) {
var cvd   = calcCVD(candles);
var cvdUp = cvd[n] > cvd[n-3];
return direction === “long” ? cvdUp : !cvdUp;
}

// Hacim - x1.8
function isVolumeOk(candles, n) {
var vols   = candles.map(function(c) { return c.vol; });
var volAvg = avg(vols, 20);
return candles[n].vol > volAvg * 1.8;
}

// Momentum - son 2 mumdan biri yeterli
function isMomentumOk(candles, direction, n) {
if (n < 2) return false;
var curr = candles[n], prev = candles[n-1];
if (direction === “long”)  return curr.close > curr.open || prev.close > prev.open;
if (direction === “short”) return curr.close < curr.open || prev.close < prev.open;
return false;
}

function isFundingOk(funding, direction) {
if (funding === null) return true;
if (direction === “long”)  return funding < 0.001;
if (direction === “short”) return funding > 0.0001;
return true;
}

// SL/TP
function calcSL(price, vwap, atr, direction) {
if (direction === “long”) {
var slVWAP = vwap * 0.996;
var slATR  = price - atr * 1.0;
return Math.min(slVWAP, slATR);
} else {
var slVWAP = vwap * 1.004;
var slATR  = price + atr * 1.0;
return Math.max(slVWAP, slATR);
}
}

function calcTP(price, atr, direction) {
if (direction === “long”) {
return { tp1: price + atr * 2.0, tp2: price + atr * 3.5, tp3: price + atr * 5.5 };
} else {
return { tp1: price - atr * 2.0, tp2: price - atr * 3.5, tp3: price - atr * 5.5 };
}
}

async function sendTelegram(text) {
if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
try {
await axios.post(“https://api.telegram.org/bot” + TG_BOT_TOKEN + “/sendMessage”,
{ chat_id: TG_CHAT_ID, text: text, parse_mode: “HTML”, disable_web_page_preview: true },
{ timeout: 8000 });
} catch(e) { console.error(”[TG ERR]”, e.message); }
}

function fmtPrice(p) {
if (p < 0.001) return p.toFixed(7);
if (p < 0.01)  return p.toFixed(6);
if (p < 1)     return p.toFixed(5);
if (p < 100)   return p.toFixed(4);
if (p < 10000) return p.toFixed(2);
return p.toFixed(1);
}

function buildMessage(symbol, direction, price, sl, tps, funding, score, hits, signalNo) {
var emoji = direction === “long” ? “🟢” : “🔴”;
var dirTr = direction === “long” ? “LONG  ▲” : “SHORT ▼”;
var lev   = 20;
var slPct  = (Math.abs(price - sl)    / price * 100).toFixed(2);
var tp1Pct = (Math.abs(tps.tp1-price) / price * 100).toFixed(2);
var tp2Pct = (Math.abs(tps.tp2-price) / price * 100).toFixed(2);
var tp3Pct = (Math.abs(tps.tp3-price) / price * 100).toFixed(2);
var rr     = (parseFloat(tp2Pct) / parseFloat(slPct)).toFixed(1);
var sl20   = (parseFloat(slPct)  * lev).toFixed(0);
var tp120  = (parseFloat(tp1Pct) * lev).toFixed(0);
var tp220  = (parseFloat(tp2Pct) * lev).toFixed(0);
var tp320  = (parseFloat(tp3Pct) * lev).toFixed(0);
var fundStr = funding !== null ? (funding * 100).toFixed(4) + “%” : “-”;
var now     = new Date().toUTCString().slice(5, 25) + “ UTC”;
var bar     = “█”.repeat(score) + “░”.repeat(6 - score);
var tier    = score >= 6 ? “🔥 MUKEMMEL” : score === 5 ? “⭐ GUCLU” : “✅ IYI”;

return emoji + “ <b>” + dirTr + “ — “ + symbol + “</b>  [” + signalNo + “/2]\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💰 <b>Giris:</b> “ + fmtPrice(price) + “\n\n” +
“🎯 <b>TP1:</b> “ + fmtPrice(tps.tp1) + “  (+” + tp1Pct + “% | 20x:+%” + tp120 + “) <i>%40</i>\n” +
“🎯 <b>TP2:</b> “ + fmtPrice(tps.tp2) + “  (+” + tp2Pct + “% | 20x:+%” + tp220 + “) <i>%40</i>\n” +
“🎯 <b>TP3:</b> “ + fmtPrice(tps.tp3) + “  (+” + tp3Pct + “% | 20x:+%” + tp320 + “) <i>%20</i>\n” +
“🛑 <b>SL:</b>  “ + fmtPrice(sl) + “  (-” + slPct + “% | 20x:-%” + sl20 + “)\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“📊 Skor: “ + bar + “ <b>” + score + “/6</b>  “ + tier + “\n” +
“✅ <code>” + hits.join(” “) + “</code>\n” +
“⚖️ R:R: 1:” + rr + “ | 💸 Funding: “ + fundStr + “\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“📌 VWAP Bounce | London 13:00-19:00 TR\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💡 <i>Mum KAPANISINI bekle!\n” +
“TP1’de %40 kapat, SL’i girise cek!\n” +
“$100 kazaninca O GUN DUR!\n” +
“Stop olursa BUGUN BITTI!</i>\n” +
“🕒 “ + now + “\n” +
“<i>⚠ Ticaret tavsiyesi degildir.</i>”;
}

async function scanCoin(symbol) {
try {
if (!isSessionOk() || !canSendSignal()) return;

```
var ticker = await fetchTicker(symbol);
if (!ticker) return;
var price = parseFloat(ticker.price || 0);
if (price <= 0) return;

var results = await Promise.all([
  fetchCandles(symbol, "1h",  100),
  fetchCandles(symbol, "15m", 100),
  fetchFunding(symbol)
]);

var c1h = results[0], c15m = results[1], funding = results[2];
if (!c1h || !c15m || c1h.length < 30 || c15m.length < 30) return;

var vwap15 = calcVWAP(c15m);
var atr15  = calcATR(c15m, 14);
var n15    = c15m.length - 1;
var atrVal = atr15[n15] || price * 0.005;

for (var d = 0; d < 2; d++) {
  var direction = d === 0 ? "long" : "short";
  var key = symbol + "_" + direction;
  if (Date.now() - (lastSignal[key] || 0) < COOLDOWN_MS) continue;
  if (!canSendSignal()) break;

  if (!isVWAPBounce(c15m, vwap15, direction, n15)) continue;
  if (!isStrongTrend1h(c1h, direction)) continue;
  if (!isRSIOk(c15m, direction, n15)) continue;

  var score = 3;
  var hits  = ["VWAP", "TREND", "RSI"];

  if (isVolumeOk(c15m, n15))              { score++; hits.push("VOL"); }
  if (isCVDOk(c15m, direction, n15))      { score++; hits.push("CVD"); }
  if (isMomentumOk(c15m, direction, n15)) { score++; hits.push("MOM"); }
  if (isFundingOk(funding, direction))     { hits.push("FUND"); }

  if (score < 4) continue;

  var sl  = calcSL(price, vwap15[n15], atrVal, direction);
  var tps = calcTP(price, atrVal, direction);

  if (direction === "long"  && sl >= price) continue;
  if (direction === "short" && sl <= price) continue;

  var slDist = Math.abs(price - sl) / price;
  if (slDist > 0.05 || slDist < 0.002) continue;

  var rr = Math.abs(tps.tp1 - price) / Math.abs(price - sl);
  if (rr < 1.5) continue;

  dailyState.signalCount++;
  lastSignal[key] = Date.now();

  console.log("🚀 SINYAL #" + dailyState.signalCount + " " + symbol + " " + direction.toUpperCase() + " " + score + "/6");
  await sendTelegram(buildMessage(symbol, direction, price, sl, tps, funding, score, hits, dailyState.signalCount));

  if (dailyState.signalCount >= dailyState.maxSignals) {
    await sendTelegram("🔒 <b>Gunluk 2 sinyal doldu!</b>\nYarin tekrar aktif.\n\n<i>Disiplin = Kar</i>");
    return;
  }
}
```

} catch(e) { console.error(”[ERR] “ + symbol + “: “ + e.message); }
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
console.log(”=”.repeat(55));
console.log(”  VWAP Bounce Scanner v6.1”);
console.log(”  Session: 10:00-16:00 UTC (13:00-19:00 TR)”);
console.log(”  Gunluk max 2 sinyal”);
console.log(”  Min skor: 4/6”);
console.log(”=”.repeat(55));

await sendTelegram(
“🤖 <b>VWAP Bounce Scanner v6.1</b>\n\n” +
“Session: 13:00-19:00 TR\n” +
“Gunluk max 2 sinyal\n” +
“Min skor: 4/6\n” +
“Filtreler gevsetildi\n\n” +
“<i>Az ama kaliteli sinyal!</i>”
);

var cycle = 0;
while (true) {
cycle++;
resetDailyIfNeeded();

```
if (!isSessionOk()) {
  var hour = new Date().getUTCHours();
  if (cycle % 30 === 0) console.log("Session disi (" + hour + " UTC) | Bekleniyor...");
  await sleep(SCAN_INTERVAL_MS);
  continue;
}

if (!canSendSignal()) {
  await sleep(SCAN_INTERVAL_MS);
  continue;
}

console.log("Tur #" + cycle + " | " + new Date().toUTCString() + " | Sinyal: " + dailyState.signalCount + "/2");
var t0 = Date.now();
await Promise.all(WATCHLIST.map(function(s) { return scanCoin(s); }));
await sleep(Math.max(0, SCAN_INTERVAL_MS - (Date.now() - t0)));
```

}
}

main().catch(function(e) { console.error(”[FATAL]”, e); process.exit(1); });
