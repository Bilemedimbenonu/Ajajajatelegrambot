require(“dotenv”).config();
const axios = require(“axios”);
const ti    = require(“technicalindicators”);

// ─── CONFIG ──────────────────────────────────────────────────
const TG_BOT_TOKEN  = process.env.TG_BOT_TOKEN || “”;
const TG_CHAT_ID    = process.env.TG_CHAT_ID   || “”;
const BINANCE_BASE  = “https://fapi.binance.com”;

const SCAN_INTERVAL_MS = 60000;
const COOLDOWN_MS      = 3600000; // 1 saat cooldown per coin

// ─── FILTRE SWITCHES (açıp kapatabilirsin) ───────────────────
const FILTERS = {
TREND_1H:    true,   // 1h EMA + Supertrend
MACD_15M:    true,   // 15m MACD crossover
RSI:         true,   // RSI bant filtresi
VOLUME:      true,   // Hacim spike
CVD:         true,   // Cumulative Volume Delta
LEVEL_4H:    true,   // 4h high/low kirilimu
BTC_FILTER:  true,   // BTC trend filtresi
FUNDING:     true,   // Funding rate filtresi
};

// ─── PARAMETRELER ────────────────────────────────────────────
const PARAMS = {
MIN_SCORE:       4,    // Minimum confluence skoru (max 6)
VOL_MULT:        1.5,  // Hacim spike carpani
RSI_LONG_MIN:    40,   // Long RSI min
RSI_LONG_MAX:    65,   // Long RSI max
RSI_SHORT_MIN:   35,   // Short RSI min
RSI_SHORT_MAX:   60,   // Short RSI max
ATR_SL_MULT:     1.2,  // SL = ATR * bu carpan
TP1_MULT:        1.5,  // TP1 = ATR * bu carpan
TP2_MULT:        2.5,  // TP2 = ATR * bu carpan
TP3_MULT:        4.0,  // TP3 = ATR * bu carpan
MAX_DAILY:       4,    // Gunluk max sinyal
SESSION_START:   10,   // UTC saat baslangic
SESSION_END:     20,   // UTC saat bitis
};

// ─── WATCHLIST ───────────────────────────────────────────────
const WATCHLIST = [
“BTCUSDT”, “ETHUSDT”, “BNBUSDT”, “SOLUSDT”, “XRPUSDT”,
“DOGEUSDT”, “ADAUSDT”, “AVAXUSDT”, “LINKUSDT”, “TONUSDT”,
“DOTUSDT”, “MATICUSDT”, “LTCUSDT”, “NEARUSDT”, “ATOMUSDT”,
“APTUSDT”, “ARBUSDT”, “OPUSDT”, “INJUSDT”, “SUIUSDT”,
“SEIUSDT”, “FETUSDT”, “WLDUSDT”, “RUNEUSDT”, “FILUSDT”,
“AAVEUSDT”, “UNIUSDT”, “LDOUSDT”, “STXUSDT”, “ICPUSDT”,
“CRVUSDT”, “MKRUSDT”, “SNXUSDT”, “ALGOUSDT”, “EGLDUSDT”,
“SANDUSDT”, “MANAUSDT”, “AXSUSDT”, “GALAUSDT”, “APEUSDT”
];

// ─── DAILY STATE ─────────────────────────────────────────────
var dailyState = { date: “”, signalCount: 0, hasLoss: false };
const lastSignal = {};

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
if (dailyState.signalCount >= PARAMS.MAX_DAILY) { console.log(”[LIMIT] Max sinyal doldu”); return false; }
return true;
}

function isSessionOk() {
var hour = new Date().getUTCHours();
return hour >= PARAMS.SESSION_START && hour < PARAMS.SESSION_END;
}

// ─── BINANCE API ─────────────────────────────────────────────
async function binanceGet(path, params) {
try {
const res = await axios.get(BINANCE_BASE + path, {
params: params || {}, timeout: 12000,
headers: { “User-Agent”: “Mozilla/5.0” }
});
return res.data;
} catch(e) { return null; }
}

async function fetchCandles(symbol, interval, limit) {
const data = await binanceGet(”/fapi/v1/klines”, { symbol: symbol, interval: interval, limit: limit || 100 });
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
return data ? parseFloat(data.price) : null;
}

// ─── INDIKATÖRLER ────────────────────────────────────────────
function pad(arr, len) {
var diff = len - arr.length;
if (diff <= 0) return arr;
return new Array(diff).fill(null).concat(arr);
}

function calcEMA(closes, period) {
return pad(ti.EMA.calculate({ period: period, values: closes }), closes.length);
}

function calcRSI(closes, period) {
return pad(ti.RSI.calculate({ period: period || 14, values: closes }), closes.length);
}

function calcATR(candles, period) {
return pad(ti.ATR.calculate({
high:  candles.map(function(c) { return c.high; }),
low:   candles.map(function(c) { return c.low; }),
close: candles.map(function(c) { return c.close; }),
period: period || 14
}), candles.length);
}

function calcMACD(closes) {
var result = ti.MACD.calculate({
values: closes, fastPeriod: 12, slowPeriod: 26,
signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false
});
return pad(result, closes.length);
}

function calcSupertrend(candles, period, mult) {
period = period || 10; mult = mult || 3.0;
var atr = calcATR(candles, period);
var n = candles.length;
var upper = new Array(n).fill(null);
var lower = new Array(n).fill(null);
var dir = new Array(n).fill(1);
var st  = new Array(n).fill(null);

for (var i = period; i < n; i++) {
var hl2  = (candles[i].high + candles[i].low) / 2;
var atrV = atr[i] || 0;
upper[i] = hl2 + mult * atrV;
lower[i] = hl2 - mult * atrV;
if (i > period) {
if (!(upper[i] > upper[i-1] || candles[i-1].close > upper[i-1])) upper[i] = upper[i-1];
if (!(lower[i] < lower[i-1] || candles[i-1].close < lower[i-1])) lower[i] = lower[i-1];
}
if (i === period) { dir[i] = 1; st[i] = lower[i]; }
else if (st[i-1] === upper[i-1]) {
dir[i] = candles[i].close > upper[i] ? 1 : -1;
st[i]  = dir[i] === 1 ? lower[i] : upper[i];
} else {
dir[i] = candles[i].close < lower[i] ? -1 : 1;
st[i]  = dir[i] === 1 ? lower[i] : upper[i];
}
}
return dir;
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

// ─── FILTRELER ───────────────────────────────────────────────

function checkTrend1h(c1h, direction) {
var closes = c1h.map(function(c) { return c.close; });
var ema9  = calcEMA(closes, 9);
var ema21 = calcEMA(closes, 21);
var st    = calcSupertrend(c1h, 10, 3);
var n     = c1h.length - 1;
if (direction === “long”)  return ema9[n] > ema21[n] && st[n] === 1;
if (direction === “short”) return ema9[n] < ema21[n] && st[n] === -1;
return false;
}

function checkMACD15m(c15m, direction) {
var closes = c15m.map(function(c) { return c.close; });
var macd   = calcMACD(closes);
var n      = c15m.length - 1;
var curr   = macd[n];
var prev   = macd[n-1];
if (!curr || !prev) return false;
if (direction === “long”)  return curr.MACD > curr.signal && prev.MACD <= prev.signal;
if (direction === “short”) return curr.MACD < curr.signal && prev.MACD >= prev.signal;
return false;
}

function checkRSI(c15m, direction) {
var closes = c15m.map(function(c) { return c.close; });
var rsi    = calcRSI(closes, 14);
var r      = rsi[c15m.length - 1];
if (!r) return false;
if (direction === “long”)  return r >= PARAMS.RSI_LONG_MIN  && r <= PARAMS.RSI_LONG_MAX;
if (direction === “short”) return r >= PARAMS.RSI_SHORT_MIN && r <= PARAMS.RSI_SHORT_MAX;
return false;
}

function checkVolume(c15m) {
var n      = c15m.length - 1;
var vols   = c15m.map(function(c) { return c.vol; });
var volAvg = avg(vols, 20);
return c15m[n].vol > volAvg * PARAMS.VOL_MULT;
}

function checkCVD(c15m, direction) {
var cvd   = calcCVD(c15m);
var n     = c15m.length - 1;
var cvdUp = cvd[n] > cvd[n-3];
return direction === “long” ? cvdUp : !cvdUp;
}

function checkLevel4h(c4h, price, direction) {
var n    = c4h.length - 1;
var highs = c4h.slice(n-20, n).map(function(c) { return c.high; });
var lows  = c4h.slice(n-20, n).map(function(c) { return c.low; });
var high  = Math.max.apply(null, highs);
var low   = Math.min.apply(null, lows);
if (direction === “long”)  return price > high * 0.998;
if (direction === “short”) return price < low  * 1.002;
return false;
}

function checkBTC(btcCandles, direction) {
if (!btcCandles) return true;
var closes = btcCandles.map(function(c) { return c.close; });
var ema9   = calcEMA(closes, 9);
var ema21  = calcEMA(closes, 21);
var n      = btcCandles.length - 1;
if (direction === “long”)  return ema9[n] >= ema21[n] * 0.998;
if (direction === “short”) return ema9[n] <= ema21[n] * 1.002;
return true;
}

function checkFunding(funding, direction) {
if (funding === null) return true;
if (direction === “long”)  return funding < 0.001;
if (direction === “short”) return funding > -0.001;
return true;
}

// ─── SL / TP ─────────────────────────────────────────────────
function calcSLTP(price, atr, direction) {
var slDist  = atr * PARAMS.ATR_SL_MULT;
var tp1Dist = atr * PARAMS.TP1_MULT;
var tp2Dist = atr * PARAMS.TP2_MULT;
var tp3Dist = atr * PARAMS.TP3_MULT;
if (direction === “long”) {
return { sl: price - slDist, tp1: price + tp1Dist, tp2: price + tp2Dist, tp3: price + tp3Dist };
} else {
return { sl: price + slDist, tp1: price - tp1Dist, tp2: price - tp2Dist, tp3: price - tp3Dist };
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

function buildMessage(symbol, direction, price, levels, funding, score, hits, signalNo) {
var emoji = direction === “long” ? “🟢” : “🔴”;
var dirTr = direction === “long” ? “LONG  ▲” : “SHORT ▼”;
var lev   = 20;
var slPct  = (Math.abs(price - levels.sl)  / price * 100).toFixed(2);
var tp1Pct = (Math.abs(levels.tp1 - price) / price * 100).toFixed(2);
var tp2Pct = (Math.abs(levels.tp2 - price) / price * 100).toFixed(2);
var tp3Pct = (Math.abs(levels.tp3 - price) / price * 100).toFixed(2);
var rr     = (parseFloat(tp2Pct) / parseFloat(slPct)).toFixed(1);
var sl20   = (parseFloat(slPct)  * lev).toFixed(0);
var tp120  = (parseFloat(tp1Pct) * lev).toFixed(0);
var tp220  = (parseFloat(tp2Pct) * lev).toFixed(0);
var tp320  = (parseFloat(tp3Pct) * lev).toFixed(0);
var fundStr = funding !== null ? (funding * 100).toFixed(4) + “%” : “-”;
var now     = new Date().toUTCString().slice(5, 25) + “ UTC”;
var bar     = “█”.repeat(score) + “░”.repeat(6 - score);
var tier    = score >= 6 ? “🔥 MUKEMMEL” : score === 5 ? “⭐ GUCLU” : “✅ IYI”;

return (
emoji + “ <b>” + dirTr + “ — “ + symbol + “</b>  [” + signalNo + “/” + PARAMS.MAX_DAILY + “]\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💰 <b>Giris:</b> “ + fmtPrice(price) + “\n\n” +
“🎯 <b>TP1:</b> “ + fmtPrice(levels.tp1) + “  (+” + tp1Pct + “% | 20x:+%” + tp120 + “) <i>%40</i>\n” +
“🎯 <b>TP2:</b> “ + fmtPrice(levels.tp2) + “  (+” + tp2Pct + “% | 20x:+%” + tp220 + “) <i>%40</i>\n” +
“🎯 <b>TP3:</b> “ + fmtPrice(levels.tp3) + “  (+” + tp3Pct + “% | 20x:+%” + tp320 + “) <i>%20</i>\n” +
“🛑 <b>SL:</b>  “ + fmtPrice(levels.sl) + “  (-” + slPct + “% | 20x:-%” + sl20 + “)\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“📊 Skor: “ + bar + “ <b>” + score + “/6</b>  “ + tier + “\n” +
“✅ <code>” + hits.join(” | “) + “</code>\n” +
“⚖️ R:R: 1:” + rr + “ | 💸 Funding: “ + fundStr + “\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“📌 Multi-Confluence | London+NY Session\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💡 <i>Mum KAPANISINI bekle!\n” +
“TP1’de %40 kapat, SL’i girise cek!\n” +
“2 stop = O GUN BIT!</i>\n” +
“🕒 “ + now + “\n” +
“<i>⚠ Ticaret tavsiyesi degildir.</i>”
);
}

// ─── TARAMA ──────────────────────────────────────────────────
async function scanCoin(symbol, btcCandles) {
try {
var price = await fetchTicker(symbol);
if (!price || price <= 0) return;

```
var results = await Promise.all([
  fetchCandles(symbol, "1h",  100),
  fetchCandles(symbol, "15m", 100),
  fetchCandles(symbol, "4h",  50),
  fetchFunding(symbol)
]);

var c1h = results[0], c15m = results[1], c4h = results[2], funding = results[3];
if (!c1h || !c15m || !c4h) return;
if (c1h.length < 30 || c15m.length < 30 || c4h.length < 25) return;

var atr15  = calcATR(c15m, 14);
var atrVal = atr15[c15m.length - 1] || price * 0.005;

for (var d = 0; d < 2; d++) {
  var direction = d === 0 ? "long" : "short";
  var key = symbol + "_" + direction;

  if (Date.now() - (lastSignal[key] || 0) < COOLDOWN_MS) continue;
  if (!canSendSignal()) break;

  if (FILTERS.BTC_FILTER && symbol !== "BTCUSDT") {
    if (!checkBTC(btcCandles, direction)) continue;
  }
  if (FILTERS.FUNDING && !checkFunding(funding, direction)) continue;

  var score = 0;
  var hits  = [];

  if (FILTERS.TREND_1H && checkTrend1h(c1h, direction))        { score++; hits.push("TREND"); }
  if (FILTERS.MACD_15M && checkMACD15m(c15m, direction))       { score++; hits.push("MACD"); }
  if (FILTERS.RSI      && checkRSI(c15m, direction))           { score++; hits.push("RSI"); }
  if (FILTERS.VOLUME   && checkVolume(c15m))                   { score++; hits.push("VOL"); }
  if (FILTERS.CVD      && checkCVD(c15m, direction))           { score++; hits.push("CVD"); }
  if (FILTERS.LEVEL_4H && checkLevel4h(c4h, price, direction)) { score++; hits.push("4H-LVL"); }

  if (score < PARAMS.MIN_SCORE) continue;

  var levels = calcSLTP(price, atrVal, direction);

  if (direction === "long"  && levels.sl >= price) continue;
  if (direction === "short" && levels.sl <= price) continue;

  var slDist = Math.abs(price - levels.sl) / price;
  if (slDist > 0.05 || slDist < 0.002) continue;

  var rr = Math.abs(levels.tp1 - price) / Math.abs(price - levels.sl);
  if (rr < 1.3) continue;

  dailyState.signalCount++;
  lastSignal[key] = Date.now();

  console.log("🚀 SINYAL #" + dailyState.signalCount + " " + symbol + " " + direction.toUpperCase() + " " + score + "/6");
  await sendTelegram(buildMessage(symbol, direction, price, levels, funding, score, hits, dailyState.signalCount));

  if (dailyState.signalCount >= PARAMS.MAX_DAILY) {
    await sendTelegram("🔒 <b>Gunluk " + PARAMS.MAX_DAILY + " sinyal doldu!</b>\nYarin tekrar aktif.\n\n<i>Disiplin = Kar</i>");
    return;
  }
  break;
}
```

} catch(e) { console.error(”[ERR] “ + symbol + “: “ + e.message); }
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ─── MAIN ────────────────────────────────────────────────────
async function main() {
console.log(”=”.repeat(55));
console.log(”  Multi-Confluence Scalping Bot v1.0”);
console.log(”  Session: “ + PARAMS.SESSION_START + “:00-” + PARAMS.SESSION_END + “:00 UTC (13:00-23:00 TR)”);
console.log(”  Gunluk max “ + PARAMS.MAX_DAILY + “ sinyal | Min skor: “ + PARAMS.MIN_SCORE + “/6”);
console.log(”  “ + WATCHLIST.length + “ coin taraniyor”);
console.log(”=”.repeat(55));

await sendTelegram(
“🤖 <b>Multi-Confluence Scalping Bot v1.0</b>\n\n” +
“Session: 13:00-23:00 TR\n” +
WATCHLIST.length + “ coin taraniyor\n” +
“Min skor: “ + PARAMS.MIN_SCORE + “/6\n” +
“Gunluk max: “ + PARAMS.MAX_DAILY + “ sinyal\n\n” +
“Filtreler: TREND | MACD | RSI | VOL | CVD | 4H-LVL\n\n” +
“<i>Kaliteli sinyal, disiplinli trading!</i>”
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

console.log("Tur #" + cycle + " | " + new Date().toUTCString() + " | Sinyal: " + dailyState.signalCount + "/" + PARAMS.MAX_DAILY);

var btcCandles = await fetchCandles("BTCUSDT", "1h", 100);
var t0 = Date.now();
await Promise.all(WATCHLIST.map(function(s) { return scanCoin(s, btcCandles); }));
await sleep(Math.max(0, SCAN_INTERVAL_MS - (Date.now() - t0)));
```

}
}

main().catch(function(e) { console.error(”[FATAL]”, e); process.exit(1); });
