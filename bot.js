require(“dotenv”).config();
const axios = require(“axios”);
const ti = require(“technicalindicators”);

// =====================================================
// SMC SCALPING BOT v2.0
// Strateji: Liquidity Sweep + FVG + CHoCH + OTE
// Timeframe: 1h bias, 15m giris
// Win Rate Hedef: %65-70 | R:R: 1:3
// =====================================================

const TG_TOKEN = process.env.TG_BOT_TOKEN || “”;
const TG_CHAT  = process.env.TG_CHAT_ID   || “”;
const BINANCE  = “https://fapi.binance.com”;

// — PARAMETRELER —
const SCAN_MS    = 60000;
const COOLDOWN   = 7200000; // 2 saat - kaliteli sinyal icin
const MAX_DAILY  = 3;       // Gunluk max 3 sinyal - az ama kaliteli
const SESSION_START = 10;   // 10:00 UTC = 13:00 TR
const SESSION_END   = 20;   // 20:00 UTC = 23:00 TR

// FVG minimum boyutu (ATR’nin kati)
const FVG_MIN_ATR = 0.3;

// Sweep mesafesi - en az bu kadar olmali
const SWEEP_MIN_ATR = 0.1;

// Displacement - sweep sonrasi bu kadar guc olmali
const DISP_MIN_ATR = 0.5;

// OTE zonu (Fibonacci %62-79)
const OTE_LOW  = 0.62;
const OTE_HIGH = 0.79;

// SL/TP
const SL_ATR_MULT = 1.0;
const TP1_MULT    = 1.5;
const TP2_MULT    = 3.0;
const TP3_MULT    = 5.0;

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

var dailyState = { date: “”, count: 0 };
var lastSignal = {};

function todayUTC() {
var d = new Date();
return d.getUTCFullYear() + “-” + (d.getUTCMonth()+1) + “-” + d.getUTCDate();
}

function resetDaily() {
var t = todayUTC();
if (dailyState.date !== t) {
dailyState.date = t;
dailyState.count = 0;
console.log(”[RESET] “ + t);
}
}

function canTrade() {
resetDaily();
return dailyState.count < MAX_DAILY;
}

function inSession() {
var h = new Date().getUTCHours();
return h >= SESSION_START && h < SESSION_END;
}

// — API —
async function bGet(path, params) {
try {
var r = await axios.get(BINANCE + path, {
params: params || {}, timeout: 12000,
headers: { “User-Agent”: “Mozilla/5.0” }
});
return r.data;
} catch(e) { return null; }
}

async function getCandles(sym, tf, limit) {
var d = await bGet(”/fapi/v1/klines”, { symbol: sym, interval: tf, limit: limit || 100 });
if (!d || !d.length) return null;
return d.map(function(r) {
return {
ts: r[0],
open:  parseFloat(r[1]),
high:  parseFloat(r[2]),
low:   parseFloat(r[3]),
close: parseFloat(r[4]),
vol:   parseFloat(r[5])
};
});
}

async function getFunding(sym) {
var d = await bGet(”/fapi/v1/premiumIndex”, { symbol: sym });
return d ? parseFloat(d.lastFundingRate || 0) : null;
}

// — INDIKATÖRLER —
function pad(arr, len) {
var diff = len - arr.length;
return diff <= 0 ? arr : new Array(diff).fill(null).concat(arr);
}

function ema(closes, p) {
return pad(ti.EMA.calculate({ period: p, values: closes }), closes.length);
}

function atr(candles, p) {
return pad(ti.ATR.calculate({
high:  candles.map(function(c) { return c.high; }),
low:   candles.map(function(c) { return c.low; }),
close: candles.map(function(c) { return c.close; }),
period: p || 14
}), candles.length);
}

function rsi(closes, p) {
return pad(ti.RSI.calculate({ period: p || 14, values: closes }), closes.length);
}

// — SMC FONKSIYONLARI —

// 1h Trend Bias: HH/HL = bullish, LH/LL = bearish
function getTrendBias(c1h) {
var n = c1h.length - 1;
if (n < 5) return “neutral”;

// Son 20 mumun swing high/low’larini bul
var highs = [];
var lows  = [];

for (var i = 2; i < Math.min(n, 22); i++) {
if (c1h[n-i].high > c1h[n-i-1].high && c1h[n-i].high > c1h[n-i+1].high) {
highs.push(c1h[n-i].high);
}
if (c1h[n-i].low < c1h[n-i-1].low && c1h[n-i].low < c1h[n-i+1].low) {
lows.push(c1h[n-i].low);
}
}

if (highs.length < 2 || lows.length < 2) return “neutral”;

var hhBull = highs[0] > highs[1]; // Son HH oncekinden yuksek
var hlBull = lows[0] > lows[1];   // Son HL oncekinden yuksek
var lhBear = highs[0] < highs[1]; // Son LH oncekinden dusuk
var llBear = lows[0] < lows[1];   // Son LL oncekinden dusuk

// EMA konfirmasyonu
var closes = c1h.map(function(c) { return c.close; });
var ema50  = ema(closes, 50);
var price  = c1h[n].close;
var aboveEMA = price > ema50[n];

if (hhBull && hlBull && aboveEMA) return “bullish”;
if (lhBear && llBear && !aboveEMA) return “bearish”;
return “neutral”;
}

// Equal Highs/Lows tespiti (likidite havuzu)
function findLiquidityLevels(candles, atrVal) {
var levels = { highs: [], lows: [] };
var n = candles.length;
var tolerance = atrVal * 0.3;

for (var i = 2; i < n - 1; i++) {
// Swing high
if (candles[i].high >= candles[i-1].high && candles[i].high >= candles[i+1].high) {
// Equal high var mi?
var isEqual = false;
for (var j = i + 2; j < Math.min(i + 15, n - 1); j++) {
if (candles[j].high >= candles[j-1].high && candles[j].high >= candles[j+1].high) {
if (Math.abs(candles[j].high - candles[i].high) <= tolerance) {
isEqual = true;
break;
}
}
}
levels.highs.push({ level: candles[i].high, equal: isEqual, idx: i });
}

```
// Swing low
if (candles[i].low <= candles[i-1].low && candles[i].low <= candles[i+1].low) {
  var isEqualL = false;
  for (var k = i + 2; k < Math.min(i + 15, n - 1); k++) {
    if (candles[k].low <= candles[k-1].low && candles[k].low <= candles[k+1].low) {
      if (Math.abs(candles[k].low - candles[i].low) <= tolerance) {
        isEqualL = true;
        break;
      }
    }
  }
  levels.lows.push({ level: candles[i].low, equal: isEqualL, idx: i });
}
```

}

return levels;
}

// Liquidity Sweep tespiti
function detectSweep(candles, levels, atrVal, direction) {
var n = candles.length - 1;
var curr = candles[n];
var prev = candles[n-1];
var minSweep = atrVal * SWEEP_MIN_ATR;

if (direction === “long”) {
// Bearish sweep: fiyat once asagi gidip sweep yapti, sonra yukari donus
var recentLows = levels.lows.filter(function(l) {
return l.idx >= n - 20 && l.idx < n - 1;
});

```
for (var i = 0; i < recentLows.length; i++) {
  var lvl = recentLows[i].level;
  // Onceki mum level'i gecti (sweep)
  if (prev.low < lvl - minSweep) {
    // Mevcut mum kapanisi level'in ustunde (reclaim)
    if (curr.close > lvl) {
      return {
        swept: true,
        level: lvl,
        sweepCandle: prev,
        sweepIdx: n-1,
        equal: recentLows[i].equal
      };
    }
  }
}
```

} else {
// Bullish sweep: fiyat once yukari gidip sweep yapti, sonra asagi donus
var recentHighs = levels.highs.filter(function(l) {
return l.idx >= n - 20 && l.idx < n - 1;
});

```
for (var j = 0; j < recentHighs.length; j++) {
  var hvl = recentHighs[j].level;
  if (prev.high > hvl + minSweep) {
    if (curr.close < hvl) {
      return {
        swept: true,
        level: hvl,
        sweepCandle: prev,
        sweepIdx: n-1,
        equal: recentHighs[j].equal
      };
    }
  }
}
```

}

return { swept: false };
}

// Displacement kalitesi - sweep sonrasi guclu hareket var mi?
function checkDisplacement(candles, sweepIdx, direction, atrVal) {
var n = candles.length - 1;
var minDisp = atrVal * DISP_MIN_ATR;

// Sweep mumundan sonraki mum(lar)da guclu hareket
var dispCandle = candles[n];
var body = Math.abs(dispCandle.close - dispCandle.open);

if (direction === “long”) {
return dispCandle.close > dispCandle.open && body >= minDisp;
} else {
return dispCandle.close < dispCandle.open && body >= minDisp;
}
}

// FVG (Fair Value Gap) tespiti
function findFVG(candles, direction, atrVal) {
var n = candles.length - 1;
var minFVG = atrVal * FVG_MIN_ATR;
var fvgs = [];

// Son 10 mumda FVG ara
for (var i = n - 8; i <= n - 2; i++) {
if (i < 1) continue;
var c1 = candles[i-1];
var c2 = candles[i];
var c3 = candles[i+1];
if (!c1 || !c2 || !c3) continue;

```
if (direction === "long") {
  // Bullish FVG: c1.high < c3.low
  var fvgTop    = c3.low;
  var fvgBottom = c1.high;
  if (fvgTop > fvgBottom && (fvgTop - fvgBottom) >= minFVG) {
    fvgs.push({ top: fvgTop, bottom: fvgBottom, mid: (fvgTop + fvgBottom) / 2, idx: i });
  }
} else {
  // Bearish FVG: c1.low > c3.high
  var fvgTop2    = c1.low;
  var fvgBottom2 = c3.high;
  if (fvgTop2 > fvgBottom2 && (fvgTop2 - fvgBottom2) >= minFVG) {
    fvgs.push({ top: fvgTop2, bottom: fvgBottom2, mid: (fvgTop2 + fvgBottom2) / 2, idx: i });
  }
}
```

}

return fvgs;
}

// Fiyat FVG icinde mi? (geri donus)
function priceInFVG(price, fvgs, direction) {
for (var i = 0; i < fvgs.length; i++) {
var f = fvgs[i];
if (direction === “long”) {
// Fiyat FVG icinde veya yakininda
if (price >= f.bottom * 0.999 && price <= f.top * 1.001) {
return f;
}
} else {
if (price >= f.bottom * 0.999 && price <= f.top * 1.001) {
return f;
}
}
}
return null;
}

// CHoCH (Change of Character) - kisa vadeli trend degisimi
function detectCHoCH(candles, direction) {
var n = candles.length - 1;
if (n < 5) return false;

if (direction === “long”) {
// Son 3 mumun son mumun onceki bir yuksegini kirmasi
var prevHigh = Math.max(candles[n-2].high, candles[n-3].high);
return candles[n].close > prevHigh;
} else {
var prevLow = Math.min(candles[n-2].low, candles[n-3].low);
return candles[n].close < prevLow;
}
}

// OTE (Optimal Trade Entry) - Fibonacci %62-79 zonu
function inOTE(price, sweepLevel, bias, direction) {
var swingHigh, swingLow;

if (direction === “long”) {
swingLow  = sweepLevel;
swingHigh = bias.recentHigh || sweepLevel * 1.02;
} else {
swingHigh = sweepLevel;
swingLow  = bias.recentLow || sweepLevel * 0.98;
}

var range = swingHigh - swingLow;
if (range <= 0) return false;

var ote62 = swingHigh - range * OTE_LOW;
var ote79 = swingHigh - range * OTE_HIGH;

if (direction === “long”) {
return price >= ote79 && price <= ote62;
} else {
var ote62b = swingLow + range * OTE_LOW;
var ote79b = swingLow + range * OTE_HIGH;
return price >= ote62b && price <= ote79b;
}
}

// Order Block tespiti - sweep oncesinin son karsi mumu
function findOrderBlock(candles, sweepIdx, direction) {
// Sweep oncesinde karsi yonde en son guclu mum
var start = Math.max(sweepIdx - 10, 0);
var end   = sweepIdx;

for (var i = end - 1; i >= start; i–) {
var c = candles[i];
var body = Math.abs(c.close - c.open);
var totalRange = c.high - c.low;
if (totalRange <= 0) continue;

```
if (direction === "long") {
  // Bearish OB: kirmizi mum (kurumlar buradan short acmisti, simdi destek)
  if (c.close < c.open && body / totalRange > 0.5) {
    return { top: c.open, bottom: c.close, idx: i };
  }
} else {
  // Bullish OB: yesil mum (kurumlar buradan long acmisti, simdi direnc)
  if (c.close > c.open && body / totalRange > 0.5) {
    return { top: c.close, bottom: c.open, idx: i };
  }
}
```

}
return null;
}

// Funding rate filtresi
function fundingOk(funding, direction) {
if (funding === null) return true;
// Extreme funding = karsi yonde al
if (direction === “long”)  return funding < 0.0015;  // Cok pozitif funding = dikkat
if (direction === “short”) return funding > -0.0015; // Cok negatif funding = dikkat
return true;
}

// — TELEGRAM —
async function tgSend(text) {
if (!TG_TOKEN || !TG_CHAT) return;
try {
await axios.post(“https://api.telegram.org/bot” + TG_TOKEN + “/sendMessage”, {
chat_id: TG_CHAT, text: text, parse_mode: “HTML”, disable_web_page_preview: true
}, { timeout: 8000 });
} catch(e) { console.error(”[TG]”, e.message); }
}

function fmt(p) {
if (p < 0.001) return p.toFixed(7);
if (p < 0.01)  return p.toFixed(6);
if (p < 1)     return p.toFixed(5);
if (p < 100)   return p.toFixed(4);
if (p < 10000) return p.toFixed(2);
return p.toFixed(1);
}

function buildMsg(sym, dir, price, sl, tp1, tp2, tp3, score, hits, funding, no) {
var lev   = 20;
var slPct  = (Math.abs(price - sl)   / price * 100).toFixed(2);
var tp1Pct = (Math.abs(tp1 - price)  / price * 100).toFixed(2);
var tp2Pct = (Math.abs(tp2 - price)  / price * 100).toFixed(2);
var tp3Pct = (Math.abs(tp3 - price)  / price * 100).toFixed(2);
var rr     = (parseFloat(tp2Pct) / parseFloat(slPct)).toFixed(1);
var sl20   = (parseFloat(slPct)  * lev).toFixed(0);
var tp120  = (parseFloat(tp1Pct) * lev).toFixed(0);
var tp220  = (parseFloat(tp2Pct) * lev).toFixed(0);
var tp320  = (parseFloat(tp3Pct) * lev).toFixed(0);
var fund   = funding !== null ? (funding * 100).toFixed(4) + “%” : “-”;
var now    = new Date().toUTCString().slice(5, 25) + “ UTC”;
var label  = dir === “long” ? “[LONG]” : “[SHORT]”;
var qual   = score >= 5 ? “MUKEMMEL” : score === 4 ? “GUCLU” : “IYI”;
var bar    = “X”.repeat(score) + “.”.repeat(5 - score);

return “<b>” + label + “ “ + sym + “</b> [” + no + “/” + MAX_DAILY + “]\n” +
“————————\n” +
“<b>Giris:</b> “ + fmt(price) + “\n\n” +
“<b>TP1:</b> “ + fmt(tp1) + “ (+” + tp1Pct + “% | 20x:+%” + tp120 + “) %30\n” +
“<b>TP2:</b> “ + fmt(tp2) + “ (+” + tp2Pct + “% | 20x:+%” + tp220 + “) %40\n” +
“<b>TP3:</b> “ + fmt(tp3) + “ (+” + tp3Pct + “% | 20x:+%” + tp320 + “) %30\n” +
“<b>SL:</b>  “ + fmt(sl)  + “ (-”  + slPct  + “% | 20x:-%” + sl20  + “)\n” +
“————————\n” +
“Skor: “ + bar + “ <b>” + score + “/5</b> “ + qual + “\n” +
“<code>” + hits.join(” | “) + “</code>\n” +
“R:R: 1:” + rr + “ | Funding: “ + fund + “\n” +
“————————\n” +
“SMC Bot v2.0 | London+NY\n” +
“Strateji: Sweep+FVG+CHoCH\n” +
“————————\n” +
“<i>Mum kapanisini bekle!\n” +
“TP1 de %30 kapat, SL girise cek!\n” +
“TP2 de %40 kapat, kalanini surdur!\n” +
“2 stop = O GUN BIT!</i>\n” +
now + “\n” +
“<i>Ticaret tavsiyesi degildir.</i>”;
}

// — ANA TARAMA —
async function scanCoin(sym, btc1h) {
try {
var price15data = await Promise.all([
getCandles(sym, “1h”, 100),
getCandles(sym, “15m”, 100),
getFunding(sym)
]);

```
var c1h     = price15data[0];
var c15m    = price15data[1];
var funding = price15data[2];

if (!c1h || !c15m) return;
if (c1h.length < 50 || c15m.length < 50) return;

var n15  = c15m.length - 1;
var price = c15m[n15].close;

// ATR hesapla
var atr15  = atr(c15m, 14);
var atrVal = atr15[n15] || price * 0.005;

// 1. TREND BIAS (1h)
var bias = getTrendBias(c1h);
if (bias === "neutral") return;

// BTC konfirmasyonu
if (sym !== "BTCUSDT" && btc1h) {
  var btcBias = getTrendBias(btc1h);
  if (btcBias !== "neutral" && btcBias !== bias) return;
}

var directions = bias === "bullish" ? ["long"] : ["short"];

for (var di = 0; di < directions.length; di++) {
  var direction = directions[di];
  var key = sym + "_" + direction;

  if (Date.now() - (lastSignal[key] || 0) < COOLDOWN) continue;
  if (!canTrade()) break;

  // Funding filtresi
  if (!fundingOk(funding, direction)) continue;

  // 2. LIKIDITE SEVIYELERI
  var levels = findLiquidityLevels(c15m, atrVal);

  // 3. SWEEP TESPITI
  var sweep = detectSweep(c15m, levels, atrVal, direction);
  if (!sweep.swept) continue;

  // Equal high/low sweep daha guvenilir
  var isEqualSweep = sweep.equal;

  // 4. DISPLACEMENT
  var hasDisp = checkDisplacement(c15m, sweep.sweepIdx, direction, atrVal);
  if (!hasDisp) continue;

  // 5. FVG TESPITI
  var fvgs = findFVG(c15m, direction, atrVal);
  if (fvgs.length === 0) continue;

  // 6. FIYAT FVG ICINDE MI?
  var activeFVG = priceInFVG(price, fvgs, direction);
  if (!activeFVG) continue;

  // 7. CHoCH KONFIRMASYONU
  var hasCHoCH = detectCHoCH(c15m, direction);

  // 8. ORDER BLOCK
  var ob = findOrderBlock(c15m, sweep.sweepIdx, direction);

  // 9. OTE ZONU
  var closes1h  = c1h.map(function(c) { return c.close; });
  var recentHigh = Math.max.apply(null, c1h.slice(-20).map(function(c) { return c.high; }));
  var recentLow  = Math.min.apply(null, c1h.slice(-20).map(function(c) { return c.low;  }));
  var biasInfo = { recentHigh: recentHigh, recentLow: recentLow };
  var inOTEZone = inOTE(price, sweep.level, biasInfo, direction);

  // RSI konfirmasyonu
  var closes15 = c15m.map(function(c) { return c.close; });
  var rsi15 = rsi(closes15, 14);
  var rsiVal = rsi15[n15];
  var rsiOk = false;
  if (direction === "long")  rsiOk = rsiVal >= 35 && rsiVal <= 65;
  if (direction === "short") rsiOk = rsiVal >= 35 && rsiVal <= 65;

  // SKOR SISTEMI (max 5)
  var score = 0;
  var hits  = [];

  // Zorunlu: Sweep + Displacement + FVG = 3 puan
  score += 3;
  hits.push("SWEEP");
  hits.push("DISP");
  hits.push("FVG");

  // Bonus: CHoCH
  if (hasCHoCH) { score++; hits.push("CHoCH"); }

  // Bonus: Equal sweep veya OTE veya OB
  if (isEqualSweep)  { hits.push("EQ-LVL"); }
  if (inOTEZone)     { score++; hits.push("OTE"); }
  if (ob)            { hits.push("OB"); }
  if (rsiOk)         { hits.push("RSI"); }

  // Min skor: 4 (zorunlu 3 + en az 1 bonus)
  if (score < 4) continue;

  // SL/TP hesapla
  var sl, tp1, tp2, tp3;
  if (direction === "long") {
    sl  = sweep.level - atrVal * SL_ATR_MULT;
    tp1 = price + atrVal * TP1_MULT;
    tp2 = price + atrVal * TP2_MULT;
    tp3 = price + atrVal * TP3_MULT;
  } else {
    sl  = sweep.level + atrVal * SL_ATR_MULT;
    tp1 = price - atrVal * TP1_MULT;
    tp2 = price - atrVal * TP2_MULT;
    tp3 = price - atrVal * TP3_MULT;
  }

  // Gecerlilik kontrolleri
  if (direction === "long"  && sl >= price) continue;
  if (direction === "short" && sl <= price) continue;

  var slDist = Math.abs(price - sl) / price;
  if (slDist > 0.06 || slDist < 0.002) continue;

  var rr = Math.abs(tp2 - price) / Math.abs(price - sl);
  if (rr < 2.0) continue; // Min 1:2 R:R

  // SINYAL GONDER
  dailyState.count++;
  lastSignal[key] = Date.now();

  console.log("[SMC SINYAL] #" + dailyState.count + " " + sym + " " + direction.toUpperCase() + " " + score + "/5 | " + hits.join(","));
  await tgSend(buildMsg(sym, direction, price, sl, tp1, tp2, tp3, score, hits, funding, dailyState.count));

  if (dailyState.count >= MAX_DAILY) {
    await tgSend("<b>Gunluk " + MAX_DAILY + " sinyal doldu!</b>\nYarin tekrar aktif.\n\n<i>Disiplin = Kar</i>");
    return;
  }
  break;
}
```

} catch(e) {
console.error(”[ERR] “ + sym + “: “ + e.message);
}
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// — MAIN —
async function main() {
console.log(”===================================================”);
console.log(”  SMC Scalping Bot v2.0”);
console.log(”  Strateji: Liquidity Sweep + FVG + CHoCH + OTE”);
console.log(”  Session: “ + SESSION_START + “:00-” + SESSION_END + “:00 UTC”);
console.log(”  Max: “ + MAX_DAILY + “ sinyal/gun | Min R:R: 1:2”);
console.log(”  “ + WATCHLIST.length + “ coin”);
console.log(”===================================================”);

await tgSend(
“<b>SMC Scalping Bot v2.0</b>\n\n” +
“Strateji: Liquidity Sweep + FVG + CHoCH\n” +
“Session: 13:00-23:00 TR\n” +
WATCHLIST.length + “ coin\n” +
“Max: “ + MAX_DAILY + “ sinyal/gun\n” +
“Min R:R: 1:2\n\n” +
“Filtreler:\n” +
“- 1h Trend Bias (HH/HL)\n” +
“- Liquidity Sweep (Equal High/Low)\n” +
“- Displacement (guclu ters mum)\n” +
“- Fair Value Gap (FVG)\n” +
“- CHoCH (yön degisimi)\n” +
“- OTE (Fib %62-79)\n” +
“- BTC konfirmasyonu\n” +
“- Funding rate filtresi\n\n” +
“<i>Az ama keskin sinyal!</i>”
);

var cycle = 0;
while (true) {
cycle++;
resetDaily();

```
if (!inSession()) {
  if (cycle % 30 === 0) {
    var h = new Date().getUTCHours();
    console.log("Session disi (" + h + " UTC) | Bekleniyor...");
  }
  await sleep(SCAN_MS);
  continue;
}

if (!canTrade()) {
  await sleep(SCAN_MS);
  continue;
}

console.log("Tur #" + cycle + " | " + new Date().toUTCString() + " | Sinyal: " + dailyState.count + "/" + MAX_DAILY);

var btc1h = await getCandles("BTCUSDT", "1h", 100);
var t0 = Date.now();
await Promise.all(WATCHLIST.map(function(s) { return scanCoin(s, btc1h); }));
await sleep(Math.max(0, SCAN_MS - (Date.now() - t0)));
```

}
}

main().catch(function(e) { console.error(”[FATAL]”, e); process.exit(1); });
