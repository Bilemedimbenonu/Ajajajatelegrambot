require(“dotenv”).config();
const axios = require(“axios”);
const ti    = require(“technicalindicators”);

const TG_BOT_TOKEN      = process.env.TG_BOT_TOKEN || “”;
const TG_CHAT_ID        = process.env.TG_CHAT_ID   || “”;
const BINANCE_BASE      = “https://fapi.binance.com”;

const SCAN_INTERVAL_MS  = 120000;
const MIN_SCORE         = 6;
const MIN_24H_VOL       = 50000000;
const MAX_COINS         = 80;
const FUNDING_LONG_MAX  = 0.0008;
const FUNDING_SHORT_MIN = 0.0002;
const COOLDOWN_MS       = 900000;
const CONCURRENT        = 8;
const BTC_FILTER        = true;
const ATR_MIN_RATIO     = 0.8;
const VOL_SPIKE_MULT    = 1.8;

const lastSignal = {};
let   btcTrend   = “neutral”;
let   watchlist  = [];

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
if (!data || !data.symbols) { console.error(”[ERR] Liste alinamadi”); return []; }
var usdt = data.symbols.filter(function(s) {
return s.quoteAsset === “USDT” && s.status === “TRADING” && s.contractType === “PERPETUAL”;
}).map(function(s) { return s.symbol; });
const tickers = await binanceGet(”/fapi/v1/ticker/24hr”);
if (!tickers) return usdt.slice(0, MAX_COINS);
var volMap = {};
tickers.forEach(function(t) { volMap[t.symbol] = parseFloat(t.quoteVolume || 0); });
var filtered = usdt
.filter(function(s) { return volMap[s] >= MIN_24H_VOL; })
.sort(function(a, b) { return (volMap[b] || 0) - (volMap[a] || 0); })
.slice(0, MAX_COINS);
console.log(”[INFO] “ + usdt.length + “ coin -> filtre: “ + filtered.length + “ taranacak”);
return filtered;
}

async function fetchCandles(symbol, interval, limit) {
const data = await binanceGet(”/fapi/v1/klines”, { symbol: symbol, interval: interval, limit: limit || 150 });
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
var prefix = [];
for (var i = 0; i < diff; i++) prefix.push(null);
return prefix.concat(arr);
}

function calcEMA(closes, period) { return pad(ti.EMA.calculate({ period: period, values: closes }), closes.length); }
function calcRSI(closes, period) { return pad(ti.RSI.calculate({ period: period, values: closes }), closes.length); }
function calcATR(candles, period) {
return pad(ti.ATR.calculate({
high: candles.map(function(c) { return c.high; }),
low: candles.map(function(c) { return c.low; }),
close: candles.map(function(c) { return c.close; }),
period: period || 14
}), candles.length);
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

// ─── PRICE ACTION ────────────────────────────────────────────

// Bullish Engulfing: onceki kirmizi mum, simdi yesil ve daha buyuk
function isBullishEngulfing(candles, n) {
if (n < 1) return false;
var prev = candles[n-1], curr = candles[n];
return prev.close < prev.open &&
curr.close > curr.open &&
curr.open < prev.close &&
curr.close > prev.open;
}

// Bearish Engulfing: onceki yesil mum, simdi kirmizi ve daha buyuk
function isBearishEngulfing(candles, n) {
if (n < 1) return false;
var prev = candles[n-1], curr = candles[n];
return prev.close > prev.open &&
curr.close < curr.open &&
curr.open > prev.close &&
curr.close < prev.open;
}

// Bullish Pin Bar: alt fitil uzun, ust fitil kisa (hammer)
function isBullishPinBar(candles, n) {
var c = candles[n];
var body   = Math.abs(c.close - c.open);
var lowerW = Math.min(c.open, c.close) - c.low;
var upperW = c.high - Math.max(c.open, c.close);
if (body === 0) return false;
return lowerW >= body * 2 && upperW <= body * 0.5;
}

// Bearish Pin Bar: ust fitil uzun, alt fitil kisa (shooting star)
function isBearishPinBar(candles, n) {
var c = candles[n];
var body   = Math.abs(c.close - c.open);
var upperW = c.high - Math.max(c.open, c.close);
var lowerW = Math.min(c.open, c.close) - c.low;
if (body === 0) return false;
return upperW >= body * 2 && lowerW <= body * 0.5;
}

// Higher High / Higher Low yapisi (yukselis trendi)
function isHigherHighHL(candles, n, lookback) {
lookback = lookback || 10;
if (n < lookback * 2) return false;
var recent = candles.slice(n - lookback, n + 1);
var prev   = candles.slice(n - lookback * 2, n - lookback + 1);
var recentHigh = Math.max.apply(null, recent.map(function(c) { return c.high; }));
var recentLow  = Math.min.apply(null, recent.map(function(c) { return c.low; }));
var prevHigh   = Math.max.apply(null, prev.map(function(c) { return c.high; }));
var prevLow    = Math.min.apply(null, prev.map(function(c) { return c.low; }));
return recentHigh > prevHigh && recentLow > prevLow;
}

// Lower Low / Lower High yapisi (dusus trendi)
function isLowerLowLH(candles, n, lookback) {
lookback = lookback || 10;
if (n < lookback * 2) return false;
var recent = candles.slice(n - lookback, n + 1);
var prev   = candles.slice(n - lookback * 2, n - lookback + 1);
var recentHigh = Math.max.apply(null, recent.map(function(c) { return c.high; }));
var recentLow  = Math.min.apply(null, recent.map(function(c) { return c.low; }));
var prevHigh   = Math.max.apply(null, prev.map(function(c) { return c.high; }));
var prevLow    = Math.min.apply(null, prev.map(function(c) { return c.low; }));
return recentLow < prevLow && recentHigh < prevHigh;
}

// VWAP kirilmasi: fiyat VWAP’i yukari/asagi kirdi mi
function isVWAPBreak(candles, vwap, n, direction) {
if (n < 2) return false;
var prev = candles[n-1], curr = candles[n];
if (direction === “long”) {
return prev.close < vwap[n-1] && curr.close > vwap[n];
} else {
return prev.close > vwap[n-1] && curr.close < vwap[n];
}
}

// ─── SR ZONLARI ──────────────────────────────────────────────

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
if (isHigh) highs.push({ price: candles[i].high, idx: i });
if (isLow)  lows.push({  price: candles[i].low,  idx: i });
}
return { highs: highs, lows: lows };
}

function findSRLevels(candles, direction, price) {
var swings = findSwings(candles, 3);
var tolerance = price * 0.005;
var levels = [];
swings.highs.forEach(function(h) { levels.push({ price: h.price }); });
swings.lows.forEach(function(l)  { levels.push({ price: l.price }); });

var zones = [];
levels.forEach(function(lv) {
var found = false;
for (var i = 0; i < zones.length; i++) {
if (Math.abs(zones[i].price - lv.price) <= tolerance) {
zones[i].price = (zones[i].price * zones[i].count + lv.price) / (zones[i].count + 1);
zones[i].count++;
found = true; break;
}
}
if (!found) zones.push({ price: lv.price, count: 1 });
});

if (direction === “long”) {
return zones.filter(function(z) { return z.price > price * 1.003; })
.sort(function(a, b) { return a.price - b.price; }).slice(0, 3);
} else {
return zones.filter(function(z) { return z.price < price * 0.997; })
.sort(function(a, b) { return b.price - a.price; }).slice(0, 3);
}
}

function findSwingSL(candles, direction, price) {
var swings = findSwings(candles, 4);
if (direction === “long”) {
var lows = swings.lows.filter(function(l) { return l.price < price; })
.sort(function(a, b) { return b.price - a.price; });
if (lows.length > 0) return lows[0].price * 0.994;
return price * 0.97;
} else {
var highs = swings.highs.filter(function(h) { return h.price > price; })
.sort(function(a, b) { return a.price - b.price; });
if (highs.length > 0) return highs[0].price * 1.006;
return price * 1.03;
}
}

// ─── SKOR MOTORU (8 guclu kosul) ─────────────────────────────

function scoreSignal(c1h, c15m, funding, direction) {
var score = 0, hits = [];

try {
var closes1h  = c1h.map(function(c) { return c.close; });
var closes15m = c15m.map(function(c) { return c.close; });

```
var ema9_1h  = calcEMA(closes1h, 9);
var ema21_1h = calcEMA(closes1h, 21);
var st1h     = calcSupertrend(c1h, 10, 3);
var vwap1h   = calcVWAP(c1h);
var vwap15m  = calcVWAP(c15m);
var ema9_15  = calcEMA(closes15m, 9);
var ema21_15 = calcEMA(closes15m, 21);
var rsi7     = calcRSI(closes15m, 7);
var cvd      = calcCVD(c15m);
var atr15    = calcATR(c15m, 14);
var bbw      = calcBBWidth(closes15m);

var n1h  = c1h.length  - 1;
var n15  = c15m.length - 1;

var volAvg = avg(c15m.map(function(c) { return c.vol; }), 20);
var atrAvg = avg(atr15, 20);
var atrVal = atr15[n15] || 0;
var cvdUp  = cvd[n15] > cvd[n15 - 5];
var vol15  = c15m[n15].vol;

if (direction === "long") {

  // 1. 1h EMA trend yukari
  if (ema9_1h[n1h] > ema21_1h[n1h]) { score++; hits.push("EMA1h"); }

  // 2. 1h Supertrend yukari
  if (st1h[n1h] === 1) { score++; hits.push("ST"); }

  // 3. VWAP kirilmasi (15m) VEYA fiyat VWAP ustunde
  var vwapBreak = isVWAPBreak(c15m, vwap15m, n15, "long");
  var aboveVWAP = c15m[n15].close > vwap1h[n1h];
  if (vwapBreak || aboveVWAP) { score++; hits.push("VWAP"); }

  // 4. Price action: Engulfing VEYA Pin Bar VEYA HH/HL
  var pa = isBullishEngulfing(c15m, n15) || isBullishPinBar(c15m, n15) || isHigherHighHL(c15m, n15, 8);
  if (pa) { score++; hits.push("PA"); }

  // 5. 15m EMA yukari
  if (ema9_15[n15] > ema21_15[n15]) { score++; hits.push("EMA15"); }

  // 6. CVD pozitif
  if (cvdUp) { score++; hits.push("CVD"); }

  // 7. Hacim spike
  if (vol15 > volAvg * VOL_SPIKE_MULT) { score++; hits.push("VOL"); }

  // 8. Funding uygun
  if (funding !== null && funding < FUNDING_LONG_MAX) { score++; hits.push("FUND"); }

} else {

  if (ema9_1h[n1h] < ema21_1h[n1h]) { score++; hits.push("EMA1h"); }
  if (st1h[n1h] === -1) { score++; hits.push("ST"); }

  var vwapBreakS = isVWAPBreak(c15m, vwap15m, n15, "short");
  var belowVWAP  = c15m[n15].close < vwap1h[n1h];
  if (vwapBreakS || belowVWAP) { score++; hits.push("VWAP"); }

  var paS = isBearishEngulfing(c15m, n15) || isBearishPinBar(c15m, n15) || isLowerLowLH(c15m, n15, 8);
  if (paS) { score++; hits.push("PA"); }

  if (ema9_15[n15] < ema21_15[n15]) { score++; hits.push("EMA15"); }
  if (!cvdUp) { score++; hits.push("CVD"); }
  if (vol15 > volAvg * VOL_SPIKE_MULT) { score++; hits.push("VOL"); }
  if (funding !== null && funding > FUNDING_SHORT_MIN) { score++; hits.push("FUND"); }
}
```

} catch(e) { console.debug(”[SCORE ERR]”, e.message); }
return { score: score, hits: hits };
}

// ─── TELEGRAM ────────────────────────────────────────────────

async function sendTelegram(text) {
if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
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

function buildMessage(symbol, direction, price, score, hits, funding, sl, tps) {
var emoji = direction === “long” ? “🟢” : “🔴”;
var dirTr = direction === “long” ? “LONG  ▲” : “SHORT ▼”;

var slPct   = (Math.abs(price - sl) / price * 100).toFixed(2);
var fundStr = funding !== null ? (funding * 100).toFixed(4) + “%” : “-”;
var now     = new Date().toUTCString().slice(5, 25) + “ UTC”;
var bar     = “█”.repeat(score) + “░”.repeat(8 - score);
var tier    = score === 8 ? “🔥 MUKEMMEL” : score === 7 ? “⭐ GUCLU” : “✅ IYI”;

var tpLines = “”;
var tpLabels = [“TP1”, “TP2”, “TP3”];
var tpWeights = [”(%40)”, “(%40)”, “(%20)”];
for (var i = 0; i < tps.length && i < 3; i++) {
var tpPct = (Math.abs(tps[i] - price) / price * 100).toFixed(2);
var sign  = tps[i] > price ? “+” : “-”;
var lev20 = (parseFloat(tpPct) * 20).toFixed(0);
tpLines += “🎯 <b>” + tpLabels[i] + “:</b> “ + fmtPrice(tps[i]) +
“  (” + sign + tpPct + “% | 20x:” + sign + “%” + lev20 + “) “ + tpWeights[i] + “\n”;
}

var rr = tps.length > 0 ? (parseFloat((Math.abs(tps[0] - price) / price * 100).toFixed(2)) / parseFloat(slPct)).toFixed(1) : “-”;

return emoji + “ <b>” + dirTr + “ — “ + symbol + “</b>\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💰 <b>Giris:</b> “ + fmtPrice(price) + “\n\n” +
tpLines +
“🛑 <b>SL:</b> “ + fmtPrice(sl) + “  (-” + slPct + “% | 20x:-%” + (parseFloat(slPct)*20).toFixed(0) + “)\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“📊 Skor: “ + bar + “ <b>” + score + “/8</b>  “ + tier + “\n” +
“✅ <code>” + hits.join(” “) + “</code>\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“⚖️ R:R: 1:” + rr + “ | 💸 Funding: “ + fundStr + “\n” +
“📐 TF: 1h trend + 15m giris\n” +
“📌 Price Action: Engulfing/PinBar/HH-HL\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💡 <i>Mum kapanisini bekle, sonra gir!</i>\n” +
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
  fetchCandles(symbol, "1h",  150),
  fetchCandles(symbol, "15m", 150),
  fetchFunding(symbol)
]);

var c1h = results[0], c15m = results[1], funding = results[2];
if (!c1h || !c15m || c1h.length < 50 || c15m.length < 50) return;

// ATR filtresi - duz piyasada sinyal verme
var atr15 = calcATR(c15m, 14);
var atrVal = atr15[atr15.length - 1];
var atrMA  = avg(atr15, 20);
if (!atrVal || atrVal < atrMA * ATR_MIN_RATIO) return;

// BB genislik filtresi - range piyasada sinyal verme
var closes15m = c15m.map(function(c) { return c.close; });
var bbw = calcBBWidth(closes15m);
var bbwMA = avg(bbw, 20);
if (bbw[bbw.length-1] < bbwMA * 0.65) return;

for (var d = 0; d < 2; d++) {
  var direction = d === 0 ? "long" : "short";
  var key = symbol + "_" + direction;
  if (Date.now() - (lastSignal[key] || 0) < COOLDOWN_MS) continue;

  // BTC filtresi
  if (BTC_FILTER && symbol !== "BTCUSDT") {
    if (direction === "long"  && btcTrend === "down") continue;
    if (direction === "short" && btcTrend === "up")   continue;
  }

  var result = scoreSignal(c1h, c15m, funding, direction);
  if (result.score < MIN_SCORE) continue;

  // SL hesapla
  var sl = findSwingSL(c15m, direction, price);
  if (direction === "long"  && sl >= price) continue;
  if (direction === "short" && sl <= price) continue;

  var slDist = Math.abs(price - sl) / price;
  if (slDist > 0.07) continue;
  if (slDist < 0.003) continue;

  // TP: destek/direnc zonlari
  var srZones  = findSRLevels(c15m, direction, price);
  var srZones1h= findSRLevels(c1h,  direction, price);
  var allZones = srZones.concat(srZones1h);
  var tol = price * 0.005;
  var merged = [];
  allZones.forEach(function(z) {
    var found = false;
    for (var i = 0; i < merged.length; i++) {
      if (Math.abs(merged[i].price - z.price) <= tol) {
        merged[i].count = (merged[i].count || 1) + 1;
        found = true; break;
      }
    }
    if (!found) merged.push({ price: z.price, count: 1 });
  });

  if (direction === "long") {
    merged = merged.filter(function(z) { return z.price > price * 1.003; })
                   .sort(function(a, b) { return a.price - b.price; });
  } else {
    merged = merged.filter(function(z) { return z.price < price * 0.997; })
                   .sort(function(a, b) { return b.price - a.price; });
  }

  if (merged.length === 0) continue;
  var tps = merged.slice(0, 3).map(function(z) { return z.price; });

  // R:R min 1:1.5
  var rrRatio = Math.abs(tps[0] - price) / Math.abs(price - sl);
  if (rrRatio < 1.5) continue;

  console.log("🚀 " + symbol + " " + direction.toUpperCase() + " " + result.score + "/8 " + result.hits.join(" "));
  await sendTelegram(buildMessage(symbol, direction, price, result.score, result.hits, funding, sl, tps));
  lastSignal[key] = Date.now();
}
```

} catch(e) { console.error(”[ERR] “ + symbol + “: “ + e.message); }
}

async function runBatch(list) {
for (var i = 0; i < list.length; i += CONCURRENT) {
await Promise.all(list.slice(i, i + CONCURRENT).map(function(s) { return scanCoin(s); }));
}
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function getBtcTrend(candles) {
var closes = candles.map(function(c) { return c.close; });
var ema9  = calcEMA(closes, 9);
var ema21 = calcEMA(closes, 21);
var n = candles.length - 1;
if (ema9[n] > ema21[n]) return “up”;
if (ema9[n] < ema21[n]) return “down”;
return “neutral”;
}

async function main() {
console.log(”=”.repeat(55));
console.log(”  Binance Scalping Scanner v3 - Price Action Edition”);
console.log(”  TF: 1h trend + 15m giris”);
console.log(”  Price Action: Engulfing | Pin Bar | HH-HL”);
console.log(”  SL: Swing high/low | TP: SR Zonlari”);
console.log(”  Min skor: “ + MIN_SCORE + “/8 | R:R min 1:1.5”);
console.log(”=”.repeat(55));

await sendTelegram(
“🤖 <b>Scanner v3 - Price Action Edition</b>\n” +
“Engulfing | Pin Bar | HH-HL | CVD\n” +
“SL: Swing | TP: SR Zonlari\n” +
“Min: “ + MIN_SCORE + “/8 | R:R 1:1.5”
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
