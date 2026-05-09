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
const VOL_SPIKE_MULT    = 1.5;

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
const data = await binanceGet(”/fapi/v1/klines”, { symbol: symbol, interval: interval, limit: limit || 200 });
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

// ─── PULLBACK SISTEMI ─────────────────────────────────────────
//
// Mantik:
// 1. 4h/1h’ta GUCLU trend var mi? (EMA + Supertrend)
// 2. 15m’de GERI CEKILME oldu mu? (RSI dusuk, fiyat EMA’ya yaklasti)
// 3. Geri cekilme BITTI mi? (Bullish reversal mumlar)
// 4. Hacim geri donus mumunda artiyor mu?
//
// Bu sistem trend BASINDA degil, geri cekilme SONRASINDA girer.
// Cok daha gec deger degil, cok daha GUVENLI giriyor.

// 4h guclu trend kontrolu
function isStrongTrend4h(c4h, direction) {
var closes = c4h.map(function(c) { return c.close; });
var ema21 = calcEMA(closes, 21);
var ema50 = calcEMA(closes, 50);
var st    = calcSupertrend(c4h, 10, 3);
var n     = c4h.length - 1;

if (direction === “long”) {
// 4h’ta EMA21 > EMA50 ve Supertrend yukari
return ema21[n] > ema50[n] && st[n] === 1;
} else {
return ema21[n] < ema50[n] && st[n] === -1;
}
}

// 1h trend teyidi
function isTrend1h(c1h, direction) {
var closes = c1h.map(function(c) { return c.close; });
var ema9  = calcEMA(closes, 9);
var ema21 = calcEMA(closes, 21);
var n     = c1h.length - 1;

if (direction === “long”)  return ema9[n] > ema21[n];
if (direction === “short”) return ema9[n] < ema21[n];
return false;
}

// 15m’de geri cekilme var mi?
// Long icin: RSI dusmus (30-50 arasi), fiyat EMA21’e yaklasmiş
function isPullback(c15m, direction) {
var closes = c15m.map(function(c) { return c.close; });
var ema21  = calcEMA(closes, 21);
var rsi    = calcRSI(closes, 14);
var n      = c15m.length - 1;

var price  = closes[n];
var e21    = ema21[n];
var r      = rsi[n];

if (!r || !e21) return false;

if (direction === “long”) {
// Fiyat EMA21’e yaklasti (ema21’in %1 icinde) ve RSI 35-55 arasi (geri cekilme bolge)
var nearEMA = Math.abs(price - e21) / e21 < 0.015;
var rsiPB   = r >= 30 && r <= 55;
return nearEMA || rsiPB;
} else {
var nearEMA = Math.abs(price - e21) / e21 < 0.015;
var rsiPB   = r >= 45 && r <= 70;
return nearEMA || rsiPB;
}
}

// Geri cekilme bitti mi? (Reversal sinyali)
// Bullish pin bar, engulfing veya RSI yeniden yukari donuyor
function isPullbackEnd(c15m, direction) {
var n      = c15m.length - 1;
var closes = c15m.map(function(c) { return c.close; });
var rsi    = calcRSI(closes, 14);
var cvd    = calcCVD(c15m);

var curr = c15m[n];
var prev = c15m[n-1];
var r    = rsi[n];
var rp   = rsi[n-1];

if (!r || !rp) return false;

if (direction === “long”) {
// Bullish engulfing
var engulf = prev.close < prev.open &&
curr.close > curr.open &&
curr.close > prev.open &&
curr.open < prev.close;

```
// Bullish pin bar (hammer)
var body   = Math.abs(curr.close - curr.open);
var lowerW = Math.min(curr.open, curr.close) - curr.low;
var upperW = curr.high - Math.max(curr.open, curr.close);
var pinBar = body > 0 && lowerW >= body * 1.5 && upperW <= body * 0.5;

// RSI yukari donuyor
var rsiTurn = r > rp && r >= 40;

// CVD artiyor
var cvdUp = cvd[n] > cvd[n-3];

return (engulf || pinBar) && (rsiTurn || cvdUp);
```

} else {
// Bearish engulfing
var engulf = prev.close > prev.open &&
curr.close < curr.open &&
curr.close < prev.open &&
curr.open > prev.close;

```
// Shooting star
var body   = Math.abs(curr.close - curr.open);
var upperW = curr.high - Math.max(curr.open, curr.close);
var lowerW = Math.min(curr.open, curr.close) - curr.low;
var pinBar = body > 0 && upperW >= body * 1.5 && lowerW <= body * 0.5;

// RSI asagi donuyor
var rsiTurn = r < rp && r <= 60;

// CVD azaliyor
var cvdDown = cvd[n] < cvd[n-3];

return (engulf || pinBar) && (rsiTurn || cvdDown);
```

}
}

// Hacim dogrulama: geri donus mumunda hacim artmali
function isVolumeConfirm(c15m) {
var n      = c15m.length - 1;
var volAvg = avg(c15m.map(function(c) { return c.vol; }), 20);
return c15m[n].vol > volAvg * VOL_SPIKE_MULT;
}

// VWAP pozisyonu
function isAboveVWAP(c1h, direction) {
var vwap  = calcVWAP(c1h);
var n     = c1h.length - 1;
var price = c1h[n].close;
if (direction === “long”)  return price > vwap[n];
if (direction === “short”) return price < vwap[n];
return false;
}

// Funding rate kontrolu
function isFundingOk(funding, direction) {
if (funding === null) return true;
if (direction === “long”)  return funding < FUNDING_LONG_MAX;
if (direction === “short”) return funding > FUNDING_SHORT_MIN;
return true;
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
var swings    = findSwings(candles, 3);
var tolerance = price * 0.005;
var levels    = [];
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

function findSwingSL(c15m, direction, price) {
var swings = findSwings(c15m, 4);
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

// ─── ANA SINYAL MOTORU ───────────────────────────────────────

function scoreSignal(c4h, c1h, c15m, funding, direction) {
var score = 0, hits = [];

// 1. 4h guclu trend (ZORUNLU - biri saglanmali)
var strong4h = isStrongTrend4h(c4h, direction);
if (strong4h) { score++; hits.push(“4hTREND”); }

// 2. 1h trend teyidi
var trend1h = isTrend1h(c1h, direction);
if (trend1h) { score++; hits.push(“1hTREND”); }

// 3. 15m’de geri cekilme var (pullback bolgesi)
var pullback = isPullback(c15m, direction);
if (pullback) { score++; hits.push(“PULLBACK”); }

// 4. Geri cekilme bitti (reversal sinyali) - EN ONEMLI
var pbEnd = isPullbackEnd(c15m, direction);
if (pbEnd) { score++; hits.push(“REVERSAL”); }

// 5. Hacim dogrulama
var volOk = isVolumeConfirm(c15m);
if (volOk) { score++; hits.push(“VOL”); }

// 6. VWAP pozisyonu
var vwapOk = isAboveVWAP(c1h, direction);
if (vwapOk) { score++; hits.push(“VWAP”); }

// 7. Funding rate
var fundOk = isFundingOk(funding, direction);
if (fundOk) { score++; hits.push(“FUND”); }

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
var bar     = “█”.repeat(score) + “░”.repeat(7 - score);
var tier    = score === 7 ? “🔥 MUKEMMEL” : score === 6 ? “⭐ GUCLU” : “✅ IYI”;

var tpLines = “”;
var tpLabels  = [“TP1”, “TP2”, “TP3”];
var tpWeights = [”(%40)”, “(%40)”, “(%20)”];
for (var i = 0; i < tps.length && i < 3; i++) {
var tpPct = (Math.abs(tps[i] - price) / price * 100).toFixed(2);
var sign  = tps[i] > price ? “+” : “-”;
var lev20 = (parseFloat(tpPct) * 20).toFixed(0);
tpLines += “🎯 <b>” + tpLabels[i] + “:</b> “ + fmtPrice(tps[i]) +
“  (” + sign + tpPct + “% | 20x:” + sign + “%” + lev20 + “) “ + tpWeights[i] + “\n”;
}

var rr = tps.length > 0
? (parseFloat((Math.abs(tps[0] - price) / price * 100).toFixed(2)) / parseFloat(slPct)).toFixed(1)
: “-”;

return emoji + “ <b>” + dirTr + “ — “ + symbol + “</b>\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💰 <b>Giris:</b> “ + fmtPrice(price) + “\n\n” +
tpLines +
“🛑 <b>SL:</b> “ + fmtPrice(sl) + “  (-” + slPct + “% | 20x:-%” + (parseFloat(slPct)*20).toFixed(0) + “)\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“📊 Skor: “ + bar + “ <b>” + score + “/7</b>  “ + tier + “\n” +
“✅ <code>” + hits.join(” “) + “</code>\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“⚖️ R:R: 1:” + rr + “ | 💸 Funding: “ + fundStr + “\n” +
“📐 Strateji: Pullback Entry\n” +
“📌 4h trend + 1h teyit + 15m geri cekilme sonu\n” +
“━━━━━━━━━━━━━━━━━━━━━━\n” +
“💡 <i>Mum KAPANISINI bekle, sonra gir!\n” +
“TP1’de %40 kapat, SL’i girise cek.</i>\n” +
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
// 4h + 1h + 15m paralel cek
var results = await Promise.all([
  fetchCandles(symbol, "4h",  100),
  fetchCandles(symbol, "1h",  150),
  fetchCandles(symbol, "15m", 200),
  fetchFunding(symbol)
]);

var c4h = results[0], c1h = results[1], c15m = results[2], funding = results[3];
if (!c4h || !c1h || !c15m) return;
if (c4h.length < 30 || c1h.length < 50 || c15m.length < 50) return;

for (var d = 0; d < 2; d++) {
  var direction = d === 0 ? "long" : "short";
  var key = symbol + "_" + direction;
  if (Date.now() - (lastSignal[key] || 0) < COOLDOWN_MS) continue;

  // BTC filtresi
  if (BTC_FILTER && symbol !== "BTCUSDT") {
    if (direction === "long"  && btcTrend === "down") continue;
    if (direction === "short" && btcTrend === "up")   continue;
  }

  // 4h trend ZORUNLU - yoksa devam etme
  if (!isStrongTrend4h(c4h, direction)) continue;

  var result = scoreSignal(c4h, c1h, c15m, funding, direction);
  if (result.score < MIN_SCORE) continue;

  // Pullback ve reversal ikisi de olmali
  if (!isPullback(c15m, direction) || !isPullbackEnd(c15m, direction)) continue;

  // SL hesapla
  var sl = findSwingSL(c15m, direction, price);
  if (direction === "long"  && sl >= price) continue;
  if (direction === "short" && sl <= price) continue;

  var slDist = Math.abs(price - sl) / price;
  if (slDist > 0.06) continue;
  if (slDist < 0.003) continue;

  // TP: SR zonlari
  var sr15  = findSRLevels(c15m, direction, price);
  var sr1h  = findSRLevels(c1h,  direction, price);
  var all   = sr15.concat(sr1h);
  var tol   = price * 0.005;
  var merged = [];
  all.forEach(function(z) {
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

  console.log("🚀 PULLBACK " + symbol + " " + direction.toUpperCase() + " " + result.score + "/7 " + result.hits.join(" "));
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
console.log(”  Binance Pullback Scanner v4”);
console.log(”  Strateji: Trend icinde geri cekilme sonu”);
console.log(”  TF: 4h trend + 1h teyit + 15m giris”);
console.log(”  Giris: Reversal mum + Hacim + RSI donus”);
console.log(”  SL: Son swing | TP: SR Zonlari”);
console.log(”  Min skor: “ + MIN_SCORE + “/7”);
console.log(”=”.repeat(55));

await sendTelegram(
“🤖 <b>Pullback Scanner v4 aktif</b>\n” +
“Strateji: Trend icinde geri cekilme sonu\n” +
“TF: 4h + 1h + 15m\n” +
“Giris: Reversal mum + Hacim + RSI donus\n” +
“Min: “ + MIN_SCORE + “/7 | R:R 1:1.5”
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
