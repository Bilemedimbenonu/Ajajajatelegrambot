require(“dotenv”).config();
const axios = require(“axios”);
const ti    = require(“technicalindicators”);

const TG_BOT_TOKEN      = process.env.TG_BOT_TOKEN || “”;
const TG_CHAT_ID        = process.env.TG_CHAT_ID   || “”;
const BINANCE_BASE      = “https://fapi.binance.com”;

const SCAN_INTERVAL_MS  = 120000;
const MIN_SCORE         = 8;
const VOL_SPIKE_MULT    = 2.0;
const MIN_24H_VOL       = 50000000;
const MAX_COINS         = 80;
const FUNDING_LONG_MAX  = 0.0008;
const FUNDING_SHORT_MIN = 0.0002;
const COOLDOWN_MS       = 900000;
const CONCURRENT        = 8;
const OB_MIN            = 0.62;
const BTC_FILTER        = true;
const ATR_MIN_RATIO     = 0.8;

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
if (!data || !data.symbols) { console.error(”[ERR] Binance enstruman listesi alinamadi”); return []; }
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

async function fetchOrderbook(symbol) {
const data = await binanceGet(”/fapi/v1/depth”, { symbol: symbol, limit: 20 });
return data || null;
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
function calcStochRSI(closes) { return pad(ti.StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 }), closes.length); }
function calcATR(candles, period) {
return pad(ti.ATR.calculate({
high: candles.map(function(c) { return c.high; }),
low: candles.map(function(c) { return c.low; }),
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
ema9: calcEMA(closes, 9), ema21: calcEMA(closes, 21), ema50: calcEMA(closes, 50),
rsi7: calcRSI(closes, 7), rsi14: calcRSI(closes, 14),
stochRsi: calcStochRSI(closes), atr: calcATR(candles, 14),
macd: calcMACD(closes), bbWidth: calcBBWidth(closes),
vwap: calcVWAP(candles), cvd: calcCVD(candles),
supertrend: calcSupertrend(candles, 10, 3),
vols: candles.map(function(c) { return c.vol; })
};
}

// ─── GRAFIK ANALIZ ───────────────────────────────────────────

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

// Destek/Direnc zonlari — birden fazla kez test edilen seviyeler
function findSRLevels(candles, direction, price) {
var swings = findSwings(candles, 3);
var tolerance = price * 0.005; // %0.5 tolerans

// Tum swing seviyelerini topla
var levels = [];
swings.highs.forEach(function(h) { levels.push({ price: h.price, type: “resistance” }); });
swings.lows.forEach(function(l)  { levels.push({ price: l.price, type: “support” }); });

// Birbirine yakin seviyeleri birlestir (zone olustur)
var zones = [];
levels.forEach(function(lv) {
var found = false;
for (var i = 0; i < zones.length; i++) {
if (Math.abs(zones[i].price - lv.price) <= tolerance) {
zones[i].price = (zones[i].price * zones[i].count + lv.price) / (zones[i].count + 1);
zones[i].count++;
found = true;
break;
}
}
if (!found) zones.push({ price: lv.price, count: 1 });
});

// Guc siralamasina gore sirala
zones.sort(function(a, b) { return b.count - a.count; });

// Long icin fiyatin ustundeki direncler, short icin fiyatin altindaki destekler
if (direction === “long”) {
return zones
.filter(function(z) { return z.price > price * 1.003; })
.sort(function(a, b) { return a.price - b.price; }) // en yakinden en uzaga
.slice(0, 4);
} else {
return zones
.filter(function(z) { return z.price < price * 0.997; })
.sort(function(a, b) { return b.price - a.price; }) // en yakinden en uzaga
.slice(0, 4);
}
}

// SL icin son swing seviyesi
function findSwingSL(candles, direction, price) {
var swings = findSwings(candles, 4);
if (direction === “long”) {
// Fiyatin altindaki en yakin swing low
var lows = swings.lows
.filter(function(l) { return l.price < price; })
.sort(function(a, b) { return b.price - a.price; }); // en yakinden
if (lows.length > 0) return lows[0].price * 0.999; // biraz altina koy
return price * 0.98; // bulamazsa %2 alt
} else {
// Fiyatin ustundeki en yakin swing high
var highs = swings.highs
.filter(function(h) { return h.price > price; })
.sort(function(a, b) { return a.price - b.price; }); // en yakinden
if (highs.length > 0) return highs[0].price * 1.001; // biraz ustune koy
return price * 1.02; // bulamazsa %2 ust
}
}

// ─── FILTRELER ───────────────────────────────────────────────

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

// ─── SKOR MOTORU ─────────────────────────────────────────────

function scoreSignal(c1h, c15m, funding, direction, ob) {
var score = 0, hits = [], atr = 0;
try {
var i1h = computeAll(c1h);
var i15 = computeAll(c15m);
var n1h = c1h.length  - 1;
var n15 = c15m.length - 1;
var n15p = n15 - 1;
atr = i15.atr[n15] || 0;
var volAvg = avg(i15.vols, 20);
var cvd = i15.cvd, cvdUp = cvd[n15] > cvd[n15 - 5];
var srK  = i15.stochRsi[n15]  ? i15.stochRsi[n15].k  : null;
var srD  = i15.stochRsi[n15]  ? i15.stochRsi[n15].d  : null;
var srKp = i15.stochRsi[n15p] ? i15.stochRsi[n15p].k : null;
var srDp = i15.stochRsi[n15p] ? i15.stochRsi[n15p].d : null;
var macd15  = i15.macd[n15];
var vol15   = c15m[n15].vol;
var rsi7    = i15.rsi7[n15];
var close15 = c15m[n15].close;
var vwap1h  = i1h.vwap[n1h];

```
if (direction === "long") {
  if (i1h.ema9[n1h] > i1h.ema21[n1h] && i1h.ema21[n1h] > i1h.ema50[n1h]) { score++; hits.push("EMA1h"); }
  if (i1h.supertrend[n1h] === 1) { score++; hits.push("ST1h"); }
  if (close15 > vwap1h) { score++; hits.push("VWAP"); }
  if (i15.ema9[n15] > i15.ema21[n15] && i15.ema21[n15] > i15.ema50[n15]) { score++; hits.push("EMA15"); }
  if (srK != null && srD != null && srK > srD && srKp <= srDp && srK > 20) { score++; hits.push("StRSI"); }
  if (rsi7 != null && rsi7 > 30 && rsi7 < 65) { score++; hits.push("RSI"); }
  if (macd15 && macd15.histogram != null && macd15.histogram > 0) { score++; hits.push("MACD"); }
  if (cvdUp) { score++; hits.push("CVD"); }
  if (vol15 > volAvg * VOL_SPIKE_MULT) { score++; hits.push("VOL"); }
  if (obImbalance(ob, "long")) { score++; hits.push("OB"); }
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

// ─── TELEGRAM ────────────────────────────────────────────────

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

function pct(a, b) { return ((a - b) / b * 100).toFixed(2); }

function buildMessage(symbol, direction, price, score, hits, funding, sl, tps) {
var emoji = direction === “long” ? “🟢” : “🔴”;
var dirTr = direction === “long” ? “LONG  ▲” : “SHORT ▼”;
var lev   = 20;

var slPct  = Math.abs(parseFloat(pct(sl, price)));
var fundStr = funding !== null ? (funding * 100).toFixed(4) + “%” : “-”;
var now     = new Date().toUTCString().slice(5, 25) + “ UTC”;
var bar     = “█”.repeat(score) + “░”.repeat(11 - score);
var tier    = score >= 10 ? “🔥 MUKEMMEL” : score === 9 ? “⭐ GUCLU” : “✅ IYI”;

// TP satirlari
var tpLines = “”;
var tpEmojis = [“🎯”, “🎯”, “🎯”];
var tpLabels = [“TP1”, “TP2”, “TP3”];
var tpWeights = [”(%40 kapat)”, “(%40 kapat)”, “(%20 beklet)”];

for (var i = 0; i < tps.length && i < 3; i++) {
var tp = tps[i];
var tpPct = parseFloat(pct(tp, price));
var levPct = (tpPct * lev).toFixed(0);
var sign = tpPct >= 0 ? “+” : “”;
tpLines += tpEmojis[i] + “ <b>” + tpLabels[i] + “:</b>   “ + fmtPrice(tp) +
“  (” + sign + tpPct.toFixed(2) + “% | 20x: “ + sign + “%” + levPct + “)  “ +
“<i>” + tpWeights[i] + “</i>\n”;
}

var rr = tps.length > 1 ? (Math.abs(parseFloat(pct(tps[1], price))) / slPct).toFixed(1) : “-”;

return emoji + “ <b>” + dirTr + “ — “ + symbol + “</b>\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💰 <b>Giris:</b>  “ + fmtPrice(price) + “\n\n” +
tpLines +
“🛑 <b>SL:</b>     “ + fmtPrice(sl) + “  (-” + slPct.toFixed(2) + “% | 20x: -%” + (slPct * lev).toFixed(0) + “)\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“📊 Skor: “ + bar + “ <b>” + score + “/11</b>  “ + tier + “\n” +
“✅ <code>” + hits.join(” “) + “</code>\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“⚖️ R:R: 1:” + rr + “  |  💸 Funding: “ + fundStr + “\n” +
“📐 TF: 1h trend + 15m giris\n” +
“📌 SL: Son swing “ + (direction === “long” ? “low” : “high”) + “\n” +
“📌 TP: Destek/Direnc zonlari\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“🕒 “ + now + “\n” +
“<i>⚠ Ticaret tavsiyesi degildir.</i>”;
}

// ─── TEK COIN TARAMA ─────────────────────────────────────────

async function scanCoin(symbol) {
try {
var ticker = await fetchTicker(symbol);
if (!ticker) return;
var price = parseFloat(ticker.price || 0);
if (price <= 0) return;

```
var results = await Promise.all([
  fetchCandles(symbol, "1h",  200),
  fetchCandles(symbol, "15m", 200),
  fetchFunding(symbol),
  fetchOrderbook(symbol)
]);

var c1h = results[0], c15m = results[1], funding = results[2], ob = results[3];
if (!c1h || !c15m) return;
if (c1h.length < 60 || c15m.length < 60) return;

var atr1 = calcATR(c15m, 14);
var atrVal = atr1[atr1.length - 1], atrMA = avg(atr1, 20);
if (!atrVal || atrVal < atrMA * ATR_MIN_RATIO) return;

var i15m = computeAll(c15m);
var n15  = c15m.length - 1;

var regime = marketRegime(i15m, n15);
if (regime === "volatile") return;

for (var d = 0; d < 2; d++) {
  var direction = d === 0 ? "long" : "short";
  var key = symbol + "_" + direction;
  if (Date.now() - (lastSignal[key] || 0) < COOLDOWN_MS) continue;

  if (detectDivergence(c15m, i15m.rsi14, direction, n15)) continue;

  if (BTC_FILTER && symbol !== "BTCUSDT") {
    if (direction === "long"  && btcTrend === "down") continue;
    if (direction === "short" && btcTrend === "up")   continue;
  }

  if (regime === "range") continue;

  var result = scoreSignal(c1h, c15m, funding, direction, ob);
  if (result.score < MIN_SCORE) continue;

  // Swing bazli SL
  var sl = findSwingSL(c15m, direction, price);

  // SL mantikli mi kontrol
  if (direction === "long"  && sl >= price) continue;
  if (direction === "short" && sl <= price) continue;

  var slDist = Math.abs(price - sl) / price;
  if (slDist > 0.06) continue;  // %6'dan uzak SL -> atla
  if (slDist < 0.002) continue; // %0.2'den yakin -> cok dar

  // Destek/Direnc bazli TP'ler
  var srZones = findSRLevels(c15m, direction, price);

  // 1h'tan da SR zonlari ekle (daha guclu seviyeler)
  var srZones1h = findSRLevels(c1h, direction, price);

  // Birlesik zon listesi
  var allZones = srZones.concat(srZones1h);
  var tol = price * 0.005;
  var merged = [];
  allZones.forEach(function(z) {
    var found = false;
    for (var i = 0; i < merged.length; i++) {
      if (Math.abs(merged[i].price - z.price) <= tol) {
        merged[i].count += z.count;
        found = true; break;
      }
    }
    if (!found) merged.push({ price: z.price, count: z.count });
  });

  // Sirala ve en guclu 3 TP al
  if (direction === "long") {
    merged = merged.filter(function(z) { return z.price > price * 1.003; })
                   .sort(function(a, b) { return a.price - b.price; });
  } else {
    merged = merged.filter(function(z) { return z.price < price * 0.997; })
                   .sort(function(a, b) { return b.price - a.price; });
  }

  // En az 1 TP gerekli
  if (merged.length === 0) continue;

  var tps = merged.slice(0, 3).map(function(z) { return z.price; });

  // R:R kontrolu minimum 1:1.5
  var rrRatio = Math.abs(tps[0] - price) / Math.abs(price - sl);
  if (rrRatio < 1.5) continue;

  console.log("🚀 SINYAL → " + symbol + " " + direction.toUpperCase() + " " + result.score + "/11 " + result.hits.join(" "));
  var msg = buildMessage(symbol, direction, price, result.score, result.hits, funding, sl, tps);
  await sendTelegram(msg);
  lastSignal[key] = Date.now();
}
```

} catch(e) { console.error(”[ERR] “ + symbol + “: “ + e.message); }
}

// ─── ANA DONGU ───────────────────────────────────────────────

async function runBatch(list) {
for (var i = 0; i < list.length; i += CONCURRENT) {
await Promise.all(list.slice(i, i + CONCURRENT).map(function(s) { return scanCoin(s); }));
}
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
console.log(”=”.repeat(55));
console.log(”  Binance Futures Intraday Scanner v2”);
console.log(”  TF: 1h trend + 15m giris”);
console.log(”  SL: Son swing high/low (grafik bazli)”);
console.log(”  TP: Destek/Direnc zonlari (grafik bazli)”);
console.log(”  Min skor: “ + MIN_SCORE + “/11 | R:R min 1:1.5”);
console.log(”=”.repeat(55));

await sendTelegram(
“🤖 <b>Binance Intraday Scanner v2 aktif</b>\n” +
“TF: 1h + 15m\n” +
“SL: Swing high/low\n” +
“TP: Destek/Direnc zonlari\n” +
“Min skor: “ + MIN_SCORE + “/11 | R:R min 1:1.5”
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
