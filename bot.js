// ============================================================
// OKX Futures Scalping Scanner v3 — Maximum Winrate Edition
// Railway + GitHub | Node.js 18+
// npm install axios technicalindicators dotenv
//
// Sinyal motoru (10 koşul):
//   1.  EMA 9/21/50 dizilimi     — 5m + 15m çift teyit
//   2.  VWAP pozisyonu           — 5m
//   3.  Supertrend yönü          — 5m
//   4.  Stoch RSI crossover      — 1m
//   5.  RSI(7) bant              — 1m
//   6.  MACD histogram yönü      — 3m
//   7.  CVD delta trendi         — 1m
//   8.  Hacim spike x2           — 1m
//   9.  Order book imbalance     — anlık
//  10.  Funding rate filtresi    — squeeze önleme
//
// Hard filtreler (skor dışı — biri başarısız → sinyal iptal):
//   - Piyasa rejimi: range / volatile → sinyal yok
//   - RSI diverjans filtresi
//   - BTC korelasyon filtresi
//   - Session filtresi (08-22 UTC)
//   - ATR minimum eşiği
//   - 15m trend teyidi (üst TF bias)
//
// MIN_SCORE = 8/10 → az ama kaliteli sinyal
// ============================================================

require(“dotenv”).config();
const axios = require(“axios”);
const ti    = require(“technicalindicators”);

// ─── CONFIG ──────────────────────────────────────────────────

const TG_BOT_TOKEN      = process.env.TG_BOT_TOKEN || “”;
const TG_CHAT_ID        = process.env.TG_CHAT_ID   || “”;
const OKX_BASE          = “https://www.okx.com”;

const SCAN_INTERVAL_MS  = 120_000;      // 2 dakika
const MIN_SCORE         = 8;            // 10 üzerinden — yüksek kalite
const VOL_SPIKE_MULT    = 2.0;          // daha sıkı hacim filtresi
const MIN_24H_VOL       = 20_000_000;   // min $20M — likit coinler
const MAX_COINS         = 100;          // top 100
const FUNDING_LONG_MAX  = 0.0006;       // long max funding
const FUNDING_SHORT_MIN = 0.0002;       // short min funding
const COOLDOWN_MS       = 600_000;      // 10 dk — az ama kaliteli sinyal
const CONCURRENT        = 10;

const ATR_SL_MULT       = 1.0;
const ATR_TP1_MULT      = 1.5;
const ATR_TP2_MULT      = 3.5;

const SESSION_FILTER    = true;
const PRIME_HOURS_UTC   = new Set([8,9,10,11,12,13,14,15,16,17,18,19,20,21]);
const OB_IMBALANCE_MIN  = 0.62;
const BTC_FILTER        = true;
const ATR_MIN_RATIO     = 0.85; // ATR ortalamanın en az %85’i olmalı

// ─── STATE ───────────────────────────────────────────────────

const lastSignal = {};
let   btcTrend   = “neutral”;
let   watchlist  = [];

// ─── OKX REST ────────────────────────────────────────────────

async function okxGet(path, params = {}) {
try {
const res = await axios.get(OKX_BASE + path, {
params,
timeout: 12000,
headers: { “User-Agent”: “Mozilla/5.0” },
});
if (res.data?.code === “0”) return res.data;
return null;
} catch { return null; }
}

async function fetchAllInstruments() {
const inst = await okxGet(”/api/v5/public/instruments”, { instType: “SWAP” });
if (!inst) { console.error(”[ERR] Enstruman listesi alinamadi”); return []; }

const active = new Set(
inst.data
.filter(d => d.settleCcy === “USDT” && d.state === “live”)
.map(d => d.instId)
);

const tickers = await okxGet(”/api/v5/market/tickers”, { instType: “SWAP” });
if (!tickers) return […active].slice(0, MAX_COINS);

const volMap = {};
for (const t of tickers.data) {
if (active.has(t.instId)) volMap[t.instId] = parseFloat(t.volCcy24h || 0);
}

const filtered = Object.entries(volMap)
.filter(([, v]) => v >= MIN_24H_VOL)
.sort(([, a], [, b]) => b - a)
.slice(0, MAX_COINS)
.map(([id]) => id);

console.log(`[INFO] ${active.size} coin -> filtre: ${filtered.length} taranacak`);
return filtered;
}

async function fetchCandles(instId, bar, limit = 150) {
const data = await okxGet(”/api/v5/market/candles”, { instId, bar, limit });
if (!data?.data?.length) return null;
return data.data.reverse().map(r => ({
ts:    parseInt(r[0]),
open:  parseFloat(r[1]),
high:  parseFloat(r[2]),
low:   parseFloat(r[3]),
close: parseFloat(r[4]),
vol:   parseFloat(r[5]),
}));
}

async function fetchFunding(instId) {
const data = await okxGet(”/api/v5/public/funding-rate”, { instId });
if (!data?.data?.[0]) return null;
return parseFloat(data.data[0].fundingRate);
}

async function fetchOrderbook(instId) {
const data = await okxGet(”/api/v5/market/books”, { instId, sz: “20” });
if (!data?.data?.[0]) return null;
return data.data[0];
}

async function fetchTicker(instId) {
const data = await okxGet(”/api/v5/market/ticker”, { instId });
if (!data?.data?.[0]) return null;
return data.data[0];
}

// ─── INDIKATÖRLER ────────────────────────────────────────────

function pad(arr, len) {
const diff = len - arr.length;
return diff > 0 ? […Array(diff).fill(null), …arr] : arr;
}

function calcEMA(closes, period) {
return pad(ti.EMA.calculate({ period, values: closes }), closes.length);
}

function calcRSI(closes, period) {
return pad(ti.RSI.calculate({ period, values: closes }), closes.length);
}

function calcStochRSI(closes) {
return pad(
ti.StochasticRSI.calculate({
values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3,
}),
closes.length
);
}

function calcATR(candles, period = 14) {
return pad(
ti.ATR.calculate({
high:  candles.map(c => c.high),
low:   candles.map(c => c.low),
close: candles.map(c => c.close),
period,
}),
candles.length
);
}

function calcMACD(closes) {
return pad(
ti.MACD.calculate({
values: closes,
fastPeriod: 5, slowPeriod: 13, signalPeriod: 1,
SimpleMAOscillator: false, SimpleMASignal: false,
}),
closes.length
);
}

function calcBBWidth(closes, period = 20) {
const bb = ti.BollingerBands.calculate({ period, values: closes, stdDev: 2 });
return pad(bb.map(b => (b.upper - b.lower) / b.middle), closes.length);
}

// VWAP — kümülatif (typical price × vol) / kümülatif vol
function calcVWAP(candles) {
let cumPV = 0, cumVol = 0;
return candles.map(c => {
const tp = (c.high + c.low + c.close) / 3;
cumPV  += tp * c.vol;
cumVol += c.vol;
return cumVol > 0 ? cumPV / cumVol : c.close;
});
}

// CVD — Cumulative Volume Delta
// close >= open → alış (+vol), close < open → satış (-vol)
function calcCVD(candles) {
let cum = 0;
return candles.map(c => {
cum += c.close >= c.open ? c.vol : -c.vol;
return cum;
});
}

// Supertrend — ATR bazlı trend çizgisi
function calcSupertrend(candles, period = 10, mult = 3.0) {
const atr    = calcATR(candles, period);
const n      = candles.length;
const upper  = new Array(n).fill(null);
const lower  = new Array(n).fill(null);
const st     = new Array(n).fill(null);  // supertrend değeri
const dir    = new Array(n).fill(1);     // 1=up(long), -1=down(short)

for (let i = period; i < n; i++) {
const hl2  = (candles[i].high + candles[i].low) / 2;
const atrV = atr[i] || 0;
upper[i]   = hl2 + mult * atrV;
lower[i]   = hl2 - mult * atrV;

```
// Band sıkıştırma
if (i > period) {
  upper[i] = upper[i] < upper[i-1] || candles[i-1].close > upper[i-1]
    ? upper[i] : upper[i-1];
  lower[i] = lower[i] > lower[i-1] || candles[i-1].close < lower[i-1]
    ? lower[i] : lower[i-1];
}

// Yön tespiti
if (i === period) {
  dir[i] = 1;
  st[i]  = lower[i];
} else if (st[i-1] === upper[i-1]) {
  dir[i] = candles[i].close > upper[i] ? 1 : -1;
  st[i]  = dir[i] === 1 ? lower[i] : upper[i];
} else {
  dir[i] = candles[i].close < lower[i] ? -1 : 1;
  st[i]  = dir[i] === 1 ? lower[i] : upper[i];
}
```

}
return dir; // 1 = yukarı trend, -1 = aşağı trend
}

// Ortalama hesabı (null filtreli)
function avg(arr, last = 20) {
const vals = arr.filter(v => v !== null).slice(-last);
if (!vals.length) return 0;
return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ─── TÜM İNDİKATÖRLERİ HESAPLA ──────────────────────────────

function computeAll(candles) {
const closes = candles.map(c => c.close);
return {
ema9:      calcEMA(closes, 9),
ema21:     calcEMA(closes, 21),
ema50:     calcEMA(closes, 50),
rsi7:      calcRSI(closes, 7),
rsi14:     calcRSI(closes, 14),
stochRsi:  calcStochRSI(closes),
atr:       calcATR(candles, 14),
macd:      calcMACD(closes),
bbWidth:   calcBBWidth(closes, 20),
vwap:      calcVWAP(candles),
cvd:       calcCVD(candles),
supertrend:calcSupertrend(candles, 10, 3),
vols:      candles.map(c => c.vol),
};
}

// ─── HARD FİLTRELER ──────────────────────────────────────────

// Piyasa rejimi: range veya volatile → giriş yok
function marketRegime(ind, n) {
const atrVal  = ind.atr[n];
const atrMA   = avg(ind.atr, 20);
const bbW     = ind.bbWidth[n];
const bbWMA   = avg(ind.bbWidth, 20);
if (!atrVal || !bbW) return “unknown”;
if (atrVal > atrMA * 2.5) return “volatile”;
if (bbW < bbWMA * 0.70)   return “range”;
return “trend”;
}

// RSI diverjans — True = diverjans var → giriş iptal
function detectDivergence(candles, rsi14, direction, n) {
try {
if (n < 6) return false;
const c0 = candles[n].close,   c4 = candles[n-4].close;
const r0 = rsi14[n],           r4 = rsi14[n-4];
if (r0 == null || r4 == null) return false;
if (direction === “long”)  return c0 > c4 && r0 < r4; // bearish div
if (direction === “short”) return c0 < c4 && r0 > r4; // bullish div
} catch { return false; }
return false;
}

// Order book imbalance
function obImbalance(ob, direction) {
if (!ob) return true; // veri yoksa geç
try {
const bidVol = ob.bids.slice(0,10).reduce((s, b) => s + parseFloat(b[1]), 0);
const askVol = ob.asks.slice(0,10).reduce((s, a) => s + parseFloat(a[1]), 0);
const total  = bidVol + askVol;
if (!total) return true;
const ratio = bidVol / total;
return direction === “long”
? ratio >= OB_IMBALANCE_MIN
: ratio <= (1 - OB_IMBALANCE_MIN);
} catch { return true; }
}

// Session filtresi
function sessionOk() {
if (!SESSION_FILTER) return true;
return PRIME_HOURS_UTC.has(new Date().getUTCHours());
}

// BTC trend tespiti
function getBtcTrend(candles) {
const ind = computeAll(candles);
const n   = candles.length - 1;
if (ind.ema9[n] > ind.ema21[n] && ind.ema21[n] > ind.ema50[n]) return “up”;
if (ind.ema9[n] < ind.ema21[n] && ind.ema21[n] < ind.ema50[n]) return “down”;
return “neutral”;
}

// 15m üst TF teyidi
function htfBias(candles15m, direction) {
const ind = computeAll(candles15m);
const n   = candles15m.length - 1;
if (direction === “long”)
return ind.ema9[n] > ind.ema21[n] && ind.supertrend[n] === 1;
if (direction === “short”)
return ind.ema9[n] < ind.ema21[n] && ind.supertrend[n] === -1;
return false;
}

// ─── SKOR MOTORU (10 koşul) ──────────────────────────────────

function scoreSignal(c15m, c5m, c1m, funding, direction, ob) {
let score = 0;
const hits = [];
let atr = 0;

try {
const i5  = computeAll(c5m);
const i1  = computeAll(c1m);
const n5  = c5m.length - 1;
const n1  = c1m.length - 1;
const n1p = n1 - 1;

```
atr = i1.atr[n1] || 0;
const volAvg = avg(i1.vols, 20);
const atrAvg = avg(i1.atr, 20);

const srK  = i1.stochRsi[n1]?.k;
const srD  = i1.stochRsi[n1]?.d;
const srKp = i1.stochRsi[n1p]?.k;
const srDp = i1.stochRsi[n1p]?.d;

const macd1  = i1.macd[n1];
const close5 = c5m[n5].close;
const close1 = c1m[n1].close;
const vol1   = c1m[n1].vol;

// CVD: son 5 barda trend
const cvd = i1.cvd;
const cvdUp = cvd[n1] > cvd[n1 - 5];

if (direction === "long") {

  // 1. EMA dizilimi (5m)
  if (i5.ema9[n5] > i5.ema21[n5] && i5.ema21[n5] > i5.ema50[n5]) {
    score++; hits.push("EMA✓");
  }

  // 2. VWAP üzeri (5m)
  if (close5 > i5.vwap[n5]) {
    score++; hits.push("VWAP✓");
  }

  // 3. Supertrend yukarı (5m)
  if (i5.supertrend[n5] === 1) {
    score++; hits.push("ST✓");
  }

  // 4. Stoch RSI crossover yukarı (1m)
  if (srK != null && srD != null &&
      srK > srD && srKp <= srDp && srK > 20) {
    score++; hits.push("StRSI✓");
  }

  // 5. RSI(7) momentum bandı (1m)
  const rsi7 = i1.rsi7[n1];
  if (rsi7 != null && rsi7 > 25 && rsi7 < 60) {
    score++; hits.push("RSI✓");
  }

  // 6. MACD histogram pozitif (1m)
  if (macd1?.histogram != null && macd1.histogram > 0) {
    score++; hits.push("MACD✓");
  }

  // 7. CVD pozitif trend (1m)
  if (cvdUp) {
    score++; hits.push("CVD✓");
  }

  // 8. Hacim spike (1m)
  if (vol1 > volAvg * VOL_SPIKE_MULT) {
    score++; hits.push("VOL✓");
  }

  // 9. Order book alıcı baskısı
  if (obImbalance(ob, "long")) {
    score++; hits.push("OB✓");
  }

  // 10. Funding uygun
  if (funding !== null && funding < FUNDING_LONG_MAX) {
    score++; hits.push("FUND✓");
  }

} else { // SHORT

  // 1. EMA dizilimi aşağı (5m)
  if (i5.ema9[n5] < i5.ema21[n5] && i5.ema21[n5] < i5.ema50[n5]) {
    score++; hits.push("EMA✓");
  }

  // 2. VWAP altı (5m)
  if (close5 < i5.vwap[n5]) {
    score++; hits.push("VWAP✓");
  }

  // 3. Supertrend aşağı (5m)
  if (i5.supertrend[n5] === -1) {
    score++; hits.push("ST✓");
  }

  // 4. Stoch RSI crossover aşağı (1m)
  if (srK != null && srD != null &&
      srK < srD && srKp >= srDp && srK < 80) {
    score++; hits.push("StRSI✓");
  }

  // 5. RSI(7) overbought bölgesi (1m)
  const rsi7 = i1.rsi7[n1];
  if (rsi7 != null && rsi7 > 40 && rsi7 < 75) {
    score++; hits.push("RSI✓");
  }

  // 6. MACD histogram negatif (1m)
  if (macd1?.histogram != null && macd1.histogram < 0) {
    score++; hits.push("MACD✓");
  }

  // 7. CVD negatif trend (1m)
  if (!cvdUp) {
    score++; hits.push("CVD✓");
  }

  // 8. Hacim spike (1m)
  if (vol1 > volAvg * VOL_SPIKE_MULT) {
    score++; hits.push("VOL✓");
  }

  // 9. Order book satıcı baskısı
  if (obImbalance(ob, "short")) {
    score++; hits.push("OB✓");
  }

  // 10. Funding squeeze uygun
  if (funding !== null && funding > FUNDING_SHORT_MIN) {
    score++; hits.push("FUND✓");
  }
}
```

} catch (e) {
console.debug(”[SCORE ERR]”, e.message);
}

return { score, hits, atr };
}

// ─── TELEGRAM ────────────────────────────────────────────────

async function sendTelegram(text) {
if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
console.warn(”[WARN] TG_BOT_TOKEN veya TG_CHAT_ID eksik!”);
return;
}
try {
await axios.post(
`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
{ chat_id: TG_CHAT_ID, text, parse_mode: “HTML”, disable_web_page_preview: true },
{ timeout: 8000 }
);
} catch (e) { console.error(”[TG ERR]”, e.message); }
}

function fmtPrice(p) {
if (p < 0.001)  return p.toFixed(7);
if (p < 0.01)   return p.toFixed(6);
if (p < 1)      return p.toFixed(5);
if (p < 100)    return p.toFixed(4);
if (p < 10000)  return p.toFixed(2);
return p.toFixed(1);
}

function buildMessage(instId, direction, price, score, hits, funding, atr) {
const symbol = instId.replace(”-USDT-SWAP”, “/USDT”);
const emoji  = direction === “long” ? “🟢” : “🔴”;
const dirTr  = direction === “long” ? “LONG  ▲” : “SHORT ▼”;

const sl  = direction === “long” ? price - atr * ATR_SL_MULT  : price + atr * ATR_SL_MULT;
const tp1 = direction === “long” ? price + atr * ATR_TP1_MULT : price - atr * ATR_TP1_MULT;
const tp2 = direction === “long” ? price + atr * ATR_TP2_MULT : price - atr * ATR_TP2_MULT;

const slPct  = (Math.abs(price - sl)  / price * 100).toFixed(2);
const tp1Pct = (Math.abs(tp1 - price) / price * 100).toFixed(2);
const tp2Pct = (Math.abs(tp2 - price) / price * 100).toFixed(2);
const rr     = (parseFloat(tp2Pct) / parseFloat(slPct)).toFixed(1);

const lev     = 20;
const profPct = (parseFloat(tp2Pct) * lev).toFixed(0);
const lossPct = (parseFloat(slPct)  * lev).toFixed(0);

const fundStr  = funding !== null ? `${(funding * 100).toFixed(4)}%` : “—”;
const now      = new Date().toUTCString().slice(5, 25) + “ UTC”;
const bar      = “█”.repeat(score) + “░”.repeat(10 - score);
const tier     = score === 10 ? “🔥 MÜKEMMEL” : score === 9 ? “⭐ GÜÇLÜ” : “✅ YETERLI”;

return (
`${emoji} <b>${dirTr} — ${symbol}</b>\n` +
`━━━━━━━━━━━━━━━━━━━━━━\n` +
`💰 Giriş:  <b>${fmtPrice(price)}</b>\n` +
`🎯 TP1:    <b>${fmtPrice(tp1)}</b>  (+${tp1Pct}%)\n` +
`🎯 TP2:    <b>${fmtPrice(tp2)}</b>  (+${tp2Pct}%)\n` +
`🛑 SL:     <b>${fmtPrice(sl)}</b>  (-${slPct}%)\n` +
`━━━━━━━━━━━━━━━━━━━━━━\n` +
`📊 Skor: ${bar} <b>${score}/10</b>  ${tier}\n` +
`✅ <code>${hits.join(" ")}</code>\n` +
`━━━━━━━━━━━━━━━━━━━━━━\n` +
`⚡ 20x → Kar: <b>+%${profPct}</b> | Zarar: <b>-%${lossPct}</b>\n` +
`⚖️ R:R: 1:${rr}  |  💸 Funding: ${fundStr}\n` +
`━━━━━━━━━━━━━━━━━━━━━━\n` +
`💡 <i>TP1'de %50 kapat → SL'i giriş fiyatına çek → TP2 bekle</i>\n` +
`🕒 ${now}\n` +
`<i>⚠ Ticaret tavsiyesi değildir.</i>`
);
}

// ─── TEK COİN TARAMA ─────────────────────────────────────────

async function scanCoin(instId) {
try {
if (!sessionOk()) return;

```
const ticker = await fetchTicker(instId);
if (!ticker) return;
const price = parseFloat(ticker.last || 0);
if (price <= 0) return;

// 1m + 5m + 15m + funding + OB paralel
const [c1m, c5m, c15m, funding, ob] = await Promise.all([
  fetchCandles(instId, "1m",  120),
  fetchCandles(instId, "5m",  150),
  fetchCandles(instId, "15m", 100),
  fetchFunding(instId),
  fetchOrderbook(instId),
]);

if (!c1m || !c5m || !c15m) return;
if (c1m.length < 60 || c5m.length < 60 || c15m.length < 30) return;

// ATR minimum eşiği — düz piyasa filtresi
const atr1   = calcATR(c1m, 14);
const atrVal = atr1[atr1.length - 1];
const atrMA  = avg(atr1, 20);
if (!atrVal || atrVal < atrMA * ATR_MIN_RATIO) {
  console.debug(`${instId} ATR düşük → atlandı`);
  return;
}

const i1m = computeAll(c1m);
const n1  = c1m.length - 1;

for (const direction of ["long", "short"]) {
  const key = `${instId}_${direction}`;
  if (Date.now() - (lastSignal[key] || 0) < COOLDOWN_MS) continue;

  // ── Hard filtreler ────────────────────────────────────────

  // 1. Piyasa rejimi
  const regime = marketRegime(i1m, n1);
  if (regime === "range" || regime === "volatile") {
    console.debug(`${instId} ${direction} → ${regime} piyasa`);
    continue;
  }

  // 2. RSI diverjans
  if (detectDivergence(c1m, i1m.rsi14, direction, n1)) {
    console.debug(`${instId} ${direction} → diverjans`);
    continue;
  }

  // 3. BTC korelasyon filtresi
  if (BTC_FILTER && !instId.includes("BTC-USDT-SWAP")) {
    if (direction === "long"  && btcTrend === "down") continue;
    if (direction === "short" && btcTrend === "up")   continue;
  }

  // 4. 15m üst TF teyidi
  if (!htfBias(c15m, direction)) {
    console.debug(`${instId} ${direction} → 15m bias yok`);
    continue;
  }

  // ── Skor ─────────────────────────────────────────────────

  const { score, hits, atr } = scoreSignal(c15m, c5m, c1m, funding, direction, ob);

  if (score >= MIN_SCORE) {
    console.log(`🚀 SİNYAL → ${instId} ${direction.toUpperCase()} ${score}/10`, hits.join(" "));
    const msg = buildMessage(instId, direction, price, score, hits, funding, atr);
    await sendTelegram(msg);
    lastSignal[key] = Date.now();
  } else {
    console.debug(`${instId} ${direction} ${score}/10 — yetersiz`);
  }
}
```

} catch (e) {
console.error(`[ERR] ${instId}:`, e.message);
}
}

// ─── ANA DÖNGÜ ───────────────────────────────────────────────

async function runBatch(list) {
for (let i = 0; i < list.length; i += CONCURRENT) {
await Promise.all(list.slice(i, i + CONCURRENT).map(id => scanCoin(id)));
}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
console.log(”=”.repeat(58));
console.log(”  OKX Scalping Scanner v3 — Maximum Winrate Edition”);
console.log(`  Min skor: ${MIN_SCORE}/10 | Cooldown: ${COOLDOWN_MS/60000}dk`);
console.log(`  Tarama: ${SCAN_INTERVAL_MS/1000}s | Max coin: ${MAX_COINS}`);
console.log(`  TF: 1m + 5m + 15m (triple TF)`);
console.log(`  Filtreler: Regime + Diverjans + BTC + HTF Bias + ATR`);
console.log(”=”.repeat(58));

await sendTelegram(
`🤖 <b>OKX Scanner v3 aktif</b>\n` +
`Skor: ${MIN_SCORE}/10 | Cooldown: ${COOLDOWN_MS/60000}dk\n` +
`TF: 1m + 5m + 15m | Max coin: ${MAX_COINS}\n` +
`Filtreler: Regime ✓ Diverjans ✓ BTC ✓ HTF ✓ ATR ✓`
);

let cycle = 0;

while (true) {
cycle++;
const t0 = Date.now();
console.log(`\n─── Tur #${cycle} | ${new Date().toUTCString()} ───`);

```
// Her 5 turda coin listesini yenile (~10 dakika)
if (cycle === 1 || cycle % 5 === 0) {
  watchlist = await fetchAllInstruments();
  if (!watchlist.length) {
    console.error("[ERR] Coin listesi bos, 30s bekle...");
    await sleep(30_000);
    continue;
  }
}

// BTC trend güncelle
try {
  const btcC = await fetchCandles("BTC-USDT-SWAP", "5m", 60);
  if (btcC) {
    btcTrend = getBtcTrend(btcC);
    console.log(`BTC trend: ${btcTrend.toUpperCase()}`);
  }
} catch {}

await runBatch(watchlist);

const elapsed = Date.now() - t0;
console.log(`─── Tur #${cycle} bitti (${(elapsed/1000).toFixed(1)}s) | ${watchlist.length} coin ───`);

const wait = Math.max(0, SCAN_INTERVAL_MS - elapsed);
if (wait) await sleep(wait);
```

}
}

main().catch(e => {
console.error(”[FATAL]”, e);
process.exit(1);
});
