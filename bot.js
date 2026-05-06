require(“dotenv”).config();
const axios = require(“axios”);
const ti    = require(“technicalindicators”);

const TG_BOT_TOKEN      = process.env.TG_BOT_TOKEN || “”;
const TG_CHAT_ID        = process.env.TG_CHAT_ID   || “”;
const BINANCE_BASE      = “https://fapi.binance.com”;

const SCAN_INTERVAL_MS  = 120000;   // 2 dakika
const MIN_SCORE         = 8;        // 11 üzerinden
const VOL_SPIKE_MULT    = 2.0;
const MIN_24H_VOL       = 50000000; // $50M minimum
const MAX_COINS         = 80;
const FUNDING_LONG_MAX  = 0.0008;
const FUNDING_SHORT_MIN = 0.0002;
const COOLDOWN_MS       = 900000;   // 15 dk — az ama kaliteli
const CONCURRENT        = 8;
const OB_MIN            = 0.62;
const BTC_FILTER        = true;
const ATR_MIN_RATIO     = 0.8;

const lastSignal = {};
let   btcTrend   = “neutral”;
let   watchlist  = [];

// ─── BINANCE REST ─────────────────────────────────────────────

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

async function fetchAllInstruments() {
const data = await binanceGet(”/fapi/v1/exchangeInfo”);
if (!data || !data.symbols) { console.error(”[ERR] Binance enstruman listesi alinamadi”); return []; }

var usdt = data.symbols.filter(function(s) {
return s.quoteAsset === “USDT” && s.status === “TRADING” && s.contractType === “PERPETUAL”;
}).map(function(s) { return s.symbol; });

// 24s hacim filtresi
const tickers = await binanceGet(”/fapi/v1/ticker/24hr”);
if (!tickers) return usdt.slice(0, MAX_COINS);

var volMap = {};
tickers.forEach(function(t) {
volMap[t.symbol] = parseFloat(t.quoteVolume || 0);
});

var filtered = usdt
.filter(function(s) { return volMap[s] >= MIN_24H_VOL; })
.sort(function(a, b) { return (volMap[b] || 0) - (volMap[a] || 0); })
.slice(0, MAX_COINS);

console.log(”[INFO] “ + usdt.length + “ coin -> filtre: “ + filtered.length + “ taranacak”);
return filtered;
}

async function fetchCandles(symbol, interval, limit) {
const data = await binanceGet(”/fapi/v1/klines”, {
symbol: symbol, interval: interval, limit: limit || 150
});
if (!data || !data.length) return null;
return data.map(function(r) {
return {
ts:    r[0],
open:  parseFloat(r[1]),
high:  parseFloat(r[2]),
low:   parseFloat(r[3]),
close: parseFloat(r[4]),
vol:   parseFloat(r[5])
};
});
}

async function fetchFunding(symbol) {
const data = await binanceGet(”/fapi/v1/premiumIndex”, { symbol: symbol });
if (!data) return null;
return parseFloat(data.lastFundingRate || 0);
}

async function fetchOrderbook(symbol) {
const data = await binanceGet(”/fapi/v1/depth”, { symbol: symbol, limit: 20 });
if (!data) return null;
return data;
}

async function fetchTicker(symbol) {
const data = await binanceGet(”/fapi/v1/ticker/price”, { symbol: symbol });
if (!data) return null;
return data;
}

// ─── INDIKATÖRLER ─────────────────────────────────────────────

function pad(arr, len) {
var diff = len - arr.length;
if (diff <= 0) return arr;
var prefix = [];
for (var i = 0; i < diff; i++) prefix.push(null);
return prefix.concat(arr);
}

function calcEMA(closes, period) { return pad(ti.EMA.calculate({ period: period, values: closes }), closes.length); }
function calcRSI(closes, period) { return pad(ti.RSI.calculate({ period: period, values: closes }), closes.length); }
function calcStochRSI(closes) { return pad(ti.StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 }), closes.length); }
function calcATR(candles, period) {
return pad(ti.ATR.calculate({
high:  candles.map(function(c) { return c.high; }),
low:   candles.map(function(c) { return c.low; }),
close: candles.map(function(c) { return c.close; }),
period: period || 14
}), candles.length);
}
function calcMACD(closes) {
return pad(ti.MACD.calculate({ values: closes, fastPeriod: 5, slowPeriod: 13, signalPeriod: 1, SimpleMAOscillator: false, SimpleMASignal: false }), closes.length);
}
function calcBBWidth(closes) {
var bb = ti.BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
return pad(bb.map(function(b) { return (b.upper - b.lower) / b.middle; }), closes.length);
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

function computeAll(candles) {
var closes = candles.map(function(c) { return c.close; });
return {
ema9:       calcEMA(closes, 9),
ema21:      calcEMA(closes, 21),
ema50:      calcEMA(closes, 50),
rsi7:       calcRSI(closes, 7),
rsi14:      calcRSI(closes, 14),
stochRsi:   calcStochRSI(closes),
atr:        calcATR(candles, 14),
macd:       calcMACD(closes),
bbWidth:    calcBBWidth(closes),
vwap:       calcVWAP(candles),
cvd:        calcCVD(candles),
supertrend: calcSupertrend(candles, 10, 3),
vols:       candles.map(function(c) { return c.vol; })
};
}

// ─── GRAFİK ANALİZİ ───────────────────────────────────────────

// Swing high/low tespiti
function findSwings(candles, lookback) {
lookback = lookback || 5;
var n = candles.length;
var swingHighs = [], swingLows = [];
for (var i = lookback; i < n - lookback; i++) {
var isHigh = true, isLow = true;
for (var j = i - lookback; j <= i + lookback; j++) {
if (j === i) continue;
if (candles[j].high >= candles[i].high) isHigh = false;
if (candles[j].low  <= candles[i].low)  isLow  = false;
}
if (isHigh) swingHighs.push({ price: candles[i].high, idx: i });
if (isLow)  swingLows.push({  price: candles[i].low,  idx: i });
}
return { highs: swingHighs, lows: swingLows };
}

// Destek/Direnç zonları
function findSRZones(candles, tolerance) {
tolerance = tolerance || 0.005;
var swings = findSwings(candles, 5);
var levels = [];
swings.highs.forEach(function(h) { levels.push(h.price); });
swings.lows.forEach(function(l)  { levels.push(l.price); });

var zones = [];
levels.forEach(function(price) {
var found = false;
zones.forEach(function(z) {
if (Math.abs(z.price - price) / price < tolerance) {
z.price = (z.price + price) / 2;
z.strength++;
found = true;
}
});
if (!found) zones.push({ price: price, strength: 1 });
});

return zones.filter(function(z) { return z.strength >= 2; })
.sort(function(a, b) { return b.strength - a.strength; });
}

// Fibonacci seviyeleri
function calcFibLevels(swingLow, swingHigh, direction) {
var diff = swingHigh - swingLow;
if (direction === “long”) {
return {
tp1: swingHigh + diff * 0.382,
tp2: swingHigh + diff * 0.618,
tp3: swingHigh + diff * 1.000,
sl:  swingLow  - diff * 0.236
};
} else {
return {
tp1: swingLow  - diff * 0.382,
tp2: swingLow  - diff * 0.618,
tp3: swingLow  - diff * 1.000,
sl:  swingHigh + diff * 0.236
};
}
}

// Son swing high/low bul
function getLastSwing(candles, direction) {
var swings = findSwings(candles, 5);
if (direction === “long”) {
var lows = swings.lows;
return lows.length > 0 ? lows[lows.length - 1].price : null;
} else {
var highs = swings.highs;
return highs.length > 0 ? highs[highs.length - 1].price : null;
}
}

// ─── FİLTRELER ────────────────────────────────────────────────

function marketRegime(ind, n) {
var atrVal = ind.atr[n], atrMA = avg(ind.atr, 20);
var bbW = ind.bbWidth[n], bbWMA = avg(ind.bbWidth, 20);
if (!atrVal || !bbW) return “unknown”;
if (atrVal > atrMA * 2.5) return “volatile”;
if (bbW < bbWMA * 0.65)   return “range”;
return “trend”;
}

function detectDivergence(candles, rsi14, direction, n) {
try {
if (n < 6) return false;
var c0 = candles[n].close, c4 = candles[n-4].close;
var r0 = rsi14[n], r4 = rsi14[n-4];
if (r0 == null || r4 == null) return false;
if (direction === “long”)  return c0 > c4 && r0 < r4;
if (direction === “short”) return c0 < c4 && r0 > r4;
} catch(e) { return false; }
return false;
}

function obImbalance(ob, direction) {
if (!ob) return true;
try {
var bidVol = ob.bids.slice(0,10).reduce(function(s,b) { return s + parseFloat(b[1]); }, 0);
var askVol = ob.asks.slice(0,10).reduce(function(s,a) { return s + parseFloat(a[1]); }, 0);
var total = bidVol + askVol;
if (!total) return true;
var ratio = bidVol / total;
return direction === “long” ? ratio >= OB_MIN : ratio <= (1 - OB_MIN);
} catch(e) { return true; }
}

function getBtcTrend(candles) {
var ind = computeAll(candles), n = candles.length - 1;
if (ind.ema9[n] > ind.ema21[n] && ind.ema21[n] > ind.ema50[n]) return “up”;
if (ind.ema9[n] < ind.ema21[n] && ind.ema21[n] < ind.ema50[n]) return “down”;
return “neutral”;
}

// ─── SKOR MOTORU (11 koşul) ───────────────────────────────────

function scoreSignal(c1h, c15m, funding, direction, ob) {
var score = 0, hits = [], atr = 0;
try {
var i1h  = computeAll(c1h);
var i15  = computeAll(c15m);
var n1h  = c1h.length  - 1;
var n15  = c15m.length - 1;
var n15p = n15 - 1;

```
atr = i15.atr[n15] || 0;
var volAvg = avg(i15.vols, 20);
var atrAvg = avg(i15.atr,  20);
var cvd    = i15.cvd;
var cvdUp  = cvd[n15] > cvd[n15 - 5];

var srK  = i15.stochRsi[n15]  ? i15.stochRsi[n15].k  : null;
var srD  = i15.stochRsi[n15]  ? i15.stochRsi[n15].d  : null;
var srKp = i15.stochRsi[n15p] ? i15.stochRsi[n15p].k : null;
var srDp = i15.stochRsi[n15p] ? i15.stochRsi[n15p].d : null;
var macd15 = i15.macd[n15];
var vol15  = c15m[n15].vol;
var rsi7   = i15.rsi7[n15];
var close15 = c15m[n15].close;
var vwap1h  = i1h.vwap[n1h];

if (direction === "long") {
  // 1. 1h EMA dizilimi (trend yönü)
  if (i1h.ema9[n1h] > i1h.ema21[n1h] && i1h.ema21[n1h] > i1h.ema50[n1h]) { score++; hits.push("EMA1h"); }
  // 2. 1h Supertrend yukarı
  if (i1h.supertrend[n1h] === 1) { score++; hits.push("ST1h"); }
  // 3. Fiyat 1h VWAP üzeri
  if (close15 > vwap1h) { score++; hits.push("VWAP"); }
  // 4. 15m EMA dizilimi
  if (i15.ema9[n15] > i15.ema21[n15] && i15.ema21[n15] > i15.ema50[n15]) { score++; hits.push("EMA15"); }
  // 5. Stoch RSI crossover yukarı (15m)
  if (srK != null && srD != null && srK > srD && srKp <= srDp && srK > 20) { score++; hits.push("StRSI"); }
  // 6. RSI(7) momentum
  if (rsi7 != null && rsi7 > 30 && rsi7 < 65) { score++; hits.push("RSI"); }
  // 7. MACD histogram pozitif (15m)
  if (macd15 && macd15.histogram != null && macd15.histogram > 0) { score++; hits.push("MACD"); }
  // 8. CVD pozitif (alış baskısı)
  if (cvdUp) { score++; hits.push("CVD"); }
  // 9. Hacim spike
  if (vol15 > volAvg * VOL_SPIKE_MULT) { score++; hits.push("VOL"); }
  // 10. Order book alıcı baskısı
  if (obImbalance(ob, "long")) { score++; hits.push("OB"); }
  // 11. Funding uygun
  if (funding !== null && funding < FUNDING_LONG_MAX) { score++; hits.push("FUND"); }

} else {
  if (i1h.ema9[n1h] < i1h.ema21[n1h] && i1h.ema21[n1h] < i1h.ema50[n1h]) { score++; hits.push("EMA1h"); }
  if (i1h.supertrend[n1h] === -1) { score++; hits.push("ST1h"); }
  if (close15 < vwap1h) { score++; hits.push("VWAP"); }
  if (i15.ema9[n15] < i15.ema21[n15] && i15.ema21[n15] < i15.ema50[n15]) { score++; hits.push("EMA15"); }
  if (srK != null && srD != null && srK < srD && srKp >= srDp && srK < 80) { score++; hits.push("StRSI"); }
  if (rsi7 != null && rsi7 > 35 && rsi7 < 70) { score++; hits.push("RSI"); }
  if (macd15 && macd15.histogram != null && macd15.histogram < 0) { score++; hits.push("MACD"); }
  if (!cvdUp) { score++; hits.push("CVD"); }
  if (vol15 > volAvg * VOL_SPIKE_MULT) { score++; hits.push("VOL"); }
  if (obImbalance(ob, "short")) { score++; hits.push("OB"); }
  if (funding !== null && funding > FUNDING_SHORT_MIN) { score++; hits.push("FUND"); }
}
```

} catch(e) { console.debug(”[SCORE ERR]”, e.message); }
return { score: score, hits: hits, atr: atr };
}

// ─── TELEGRAM ─────────────────────────────────────────────────

async function sendTelegram(text) {
if (!TG_BOT_TOKEN || !TG_CHAT_ID) { console.warn(”[WARN] Token eksik”); return; }
try {
await axios.post(“https://api.telegram.org/bot” + TG_BOT_TOKEN + “/sendMessage”, {
chat_id: TG_CHAT_ID, text: text, parse_mode: “HTML”, disable_web_page_preview: true
}, { timeout: 8000 });
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

function buildMessage(symbol, direction, price, score, hits, funding, fib, swingSL) {
var emoji = direction === “long” ? “🟢” : “🔴”;
var dirTr = direction === “long” ? “LONG  ▲” : “SHORT ▼”;

var sl  = swingSL;
var tp1 = fib.tp1;
var tp2 = fib.tp2;
var tp3 = fib.tp3;

var slPct  = (Math.abs(price - sl)  / price * 100).toFixed(2);
var tp1Pct = (Math.abs(tp1 - price) / price * 100).toFixed(2);
var tp2Pct = (Math.abs(tp2 - price) / price * 100).toFixed(2);
var tp3Pct = (Math.abs(tp3 - price) / price * 100).toFixed(2);
var rr     = (parseFloat(tp2Pct) / parseFloat(slPct)).toFixed(1);

var lev     = 20;
var p1pct   = (parseFloat(tp1Pct) * lev).toFixed(0);
var p2pct   = (parseFloat(tp2Pct) * lev).toFixed(0);
var p3pct   = (parseFloat(tp3Pct) * lev).toFixed(0);
var losspct = (parseFloat(slPct)  * lev).toFixed(0);

var fundStr = funding !== null ? (funding * 100).toFixed(4) + “%” : “-”;
var now     = new Date().toUTCString().slice(5, 25) + “ UTC”;
var bar     = “█”.repeat(score) + “░”.repeat(11 - score);
var tier    = score >= 10 ? “🔥 MUKEMMEL” : score === 9 ? “⭐ GUCLU” : “✅ IYI”;

return emoji + “ <b>” + dirTr + “ — “ + symbol + “</b>\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💰 <b>Giris:</b>  “ + fmtPrice(price) + “\n\n” +
“🎯 <b>TP1:</b>    “ + fmtPrice(tp1) + “  (+” + tp1Pct + “% / 20x: +%” + p1pct + “)\n” +
“🎯 <b>TP2:</b>    “ + fmtPrice(tp2) + “  (+” + tp2Pct + “% / 20x: +%” + p2pct + “)\n” +
“🎯 <b>TP3:</b>    “ + fmtPrice(tp3) + “  (+” + tp3Pct + “% / 20x: +%” + p3pct + “)\n” +
“🛑 <b>SL:</b>     “ + fmtPrice(sl)  + “  (-”  + slPct  + “% / 20x: -%” + losspct + “)\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“📊 Skor: “ + bar + “ <b>” + score + “/11</b>  “ + tier + “\n” +
“✅ <code>” + hits.join(” “) + “</code>\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“⚖️ R:R: 1:” + rr + “  |  💸 Funding: “ + fundStr + “\n” +
“⏱ TF: 1h trend + 15m giris\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💡 <i>TP1’de %40 kapat → SL’i girise cek\n” +
“TP2’de %40 kapat → TP3 icin %20 beklet</i>\n” +
“🕒 “ + now + “\n” +
“<i>⚠ Ticaret tavsiyesi degildir.</i>”;
}

// ─── TEK COİN TARAMA ──────────────────────────────────────────

async function scanCoin(symbol) {
try {
var ticker = await fetchTicker(symbol);
if (!ticker) return;
var price = parseFloat(ticker.price || 0);
if (price <= 0) return;

```
// 1h + 15m + funding + OB paralel
var results = await Promise.all([
  fetchCandles(symbol, "1h",  150),
  fetchCandles(symbol, "15m", 150),
  fetchFunding(symbol),
  fetchOrderbook(symbol)
]);

var c1h     = results[0];
var c15m    = results[1];
var funding = results[2];
var ob      = results[3];

if (!c1h || !c15m) return;
if (c1h.length < 60 || c15m.length < 60) return;

// ATR filtresi
var atr1 = calcATR(c15m, 14);
var atrVal = atr1[atr1.length - 1], atrMA = avg(atr1, 20);
if (!atrVal || atrVal < atrMA * ATR_MIN_RATIO) return;

var i15m = computeAll(c15m);
var n15  = c15m.length - 1;

// Piyasa rejimi
var regime = marketRegime(i15m, n15);
if (regime === "volatile") return;

// BTC filtresi
if (BTC_FILTER && symbol !== "BTCUSDT") {
  if (btcTrend === "down" && true) {} // long için kontrol scoreSignal içinde
}

for (var d = 0; d < 2; d++) {
  var direction = d === 0 ? "long" : "short";
  var key = symbol + "_" + direction;
  if (Date.now() - (lastSignal[key] || 0) < COOLDOWN_MS) continue;

  // Diverjans filtresi
  if (detectDivergence(c15m, i15m.rsi14, direction, n15)) continue;

  // BTC korelasyon
  if (BTC_FILTER && symbol !== "BTCUSDT") {
    if (direction === "long"  && btcTrend === "down") continue;
    if (direction === "short" && btcTrend === "up")   continue;
  }

  // Range piyasada sadece reversal değil trend sinyali
  if (regime === "range") continue;

  // Skor
  var result = scoreSignal(c1h, c15m, funding, direction, ob);
  if (result.score < MIN_SCORE) continue;

  // Swing bazlı SL
  var swingSL = getLastSwing(c15m, direction);
  if (!swingSL) continue;

  // SL çok uzaksa atla (pozisyon boyutu yönetimi)
  var slDist = Math.abs(price - swingSL) / price;
  if (slDist > 0.05) continue; // %5'ten uzak SL → atla
  if (slDist < 0.003) continue; // %0.3'ten yakın SL → çok dar

  // Fibonacci TP seviyeleri
  var swings   = findSwings(c15m, 5);
  var recentHighs = swings.highs.slice(-3);
  var recentLows  = swings.lows.slice(-3);

  var swingHigh = recentHighs.length > 0 ? Math.max.apply(null, recentHighs.map(function(h) { return h.price; })) : price * 1.02;
  var swingLow  = recentLows.length  > 0 ? Math.min.apply(null, recentLows.map(function(l)  { return l.price; })) : price * 0.98;

  var fib = calcFibLevels(swingLow, swingHigh, direction);

  // TP'ler mantıklı mı kontrol et
  if (direction === "long") {
    if (fib.tp1 <= price || fib.tp2 <= fib.tp1) continue;
  } else {
    if (fib.tp1 >= price || fib.tp2 >= fib.tp1) continue;
  }

  // R:R kontrolü — minimum 1:2
  var rrRatio = Math.abs(fib.tp2 - price) / Math.abs(price - swingSL);
  if (rrRatio < 2.0) continue;

  console.log("🚀 SINYAL → " + symbol + " " + direction.toUpperCase() + " " + result.score + "/11 " + result.hits.join(" "));
  var msg = buildMessage(symbol, direction, price, result.score, result.hits, funding, fib, swingSL);
  await sendTelegram(msg);
  lastSignal[key] = Date.now();
}
```

} catch(e) { console.error(”[ERR] “ + symbol + “: “ + e.message); }
}

// ─── ANA DÖNGÜ ────────────────────────────────────────────────

async function runBatch(list) {
for (var i = 0; i < list.length; i += CONCURRENT) {
await Promise.all(list.slice(i, i + CONCURRENT).map(function(s) { return scanCoin(s); }));
}
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
console.log(”=”.repeat(55));
console.log(”  Binance Futures Intraday Scanner”);
console.log(”  TF: 1h trend + 15m giris”);
console.log(”  Swing SL + Fibonacci TP + CVD”);
console.log(”  Min skor: “ + MIN_SCORE + “/11 | R:R min 1:2”);
console.log(”=”.repeat(55));

await sendTelegram(
“🤖 <b>Binance Intraday Scanner aktif</b>\n” +
“TF: 1h + 15m | Skor: “ + MIN_SCORE + “/11\n” +
“Swing SL + Fibonacci TP + CVD\n” +
“Min R:R: 1:2 | Cooldown: “ + (COOLDOWN_MS/60000) + “dk”
);

var cycle = 0;

while (true) {
cycle++;
var t0 = Date.now();
console.log(”\n— Tur #” + cycle + “ | “ + new Date().toUTCString() + “ —”);

```
if (cycle === 1 || cycle % 10 === 0) {
  watchlist = await fetchAllInstruments();
  if (!watchlist.length) { await sleep(30000); continue; }
}

// BTC trend güncelle
try {
  var btcC = await fetchCandles("BTCUSDT", "1h", 60);
  if (btcC) { btcTrend = getBtcTrend(btcC); console.log("BTC: " + btcTrend.toUpperCase()); }
} catch(e) {}

await runBatch(watchlist);

var elapsed = Date.now() - t0;
console.log("--- Tur #" + cycle + " bitti (" + (elapsed/1000).toFixed(1) + "s) | " + watchlist.length + " coin ---");

var wait = Math.max(0, SCAN_INTERVAL_MS - elapsed);
if (wait) await sleep(wait);
```

}
}

main().catch(function(e) { console.error(”[FATAL]”, e); process.exit(1); });
