// OKX Futures Scalping Scanner v2 — Node.js
// Railway + GitHub için hazır
// Gerekli: npm install axios technicalindicators dotenv

require(“dotenv”).config();
const axios = require(“axios”);
const ti = require(“technicalindicators”);

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const TG_BOT_TOKEN     = process.env.TG_BOT_TOKEN || “”;
const TG_CHAT_ID       = process.env.TG_CHAT_ID   || “”;

const OKX_BASE         = “https://www.okx.com”;

const SCAN_INTERVAL_MS = 90_000;       // 90 saniye
const MIN_SCORE        = 7;            // 9 üzerinden minimum
const VOL_SPIKE_MULT   = 1.8;          // hacim spike çarpanı
const MIN_24H_VOL      = 10_000_000;   // min $10M 24s hacim
const MAX_COINS        = 150;          // hacme göre top N
const FUNDING_LONG_MAX = 0.0008;       // long için max funding
const FUNDING_SHORT_MIN= 0.0003;       // short için min funding
const COOLDOWN_MS      = 300_000;      // 5 dk aynı coin tekrar sinyal yok
const CONCURRENT       = 15;           // aynı anda max paralel coin

const ATR_SL_MULT      = 1.2;
const ATR_TP1_MULT     = 1.5;
const ATR_TP2_MULT     = 3.0;

const SESSION_FILTER   = true;
const PRIME_HOURS_UTC  = new Set([8,9,10,11,12,13,14,15,16,17,18,19,20,21]);

const OB_IMBALANCE_MIN = 0.60;
const BTC_FILTER       = true;

// ─── STATE ───────────────────────────────────────────────────────────────────

const lastSignal = {};   // “BTC-USDT-SWAP_long” → timestamp
let   btcTrend   = “neutral”;
let   watchlist  = [];

// ─── OKX REST ────────────────────────────────────────────────────────────────

async function okxGet(path, params = {}) {
try {
const res = await axios.get(OKX_BASE + path, {
params,
timeout: 12000,
headers: { “User-Agent”: “Mozilla/5.0” },
});
if (res.data?.code === “0”) return res.data;
return null;
} catch {
return null;
}
}

async function fetchAllInstruments() {
const inst = await okxGet(”/api/v5/public/instruments”, { instType: “SWAP” });
if (!inst) { console.error(“Enstrüman listesi alınamadı!”); return []; }

const activeIds = new Set(
inst.data
.filter(d => d.settleCcy === “USDT” && d.state === “live”)
.map(d => d.instId)
);

const tickers = await okxGet(”/api/v5/market/tickers”, { instType: “SWAP” });
if (!tickers) return […activeIds].slice(0, MAX_COINS);

const volMap = {};
for (const t of tickers.data) {
if (activeIds.has(t.instId)) {
volMap[t.instId] = parseFloat(t.volCcy24h || 0);
}
}

const filtered = Object.entries(volMap)
.filter(([, v]) => v >= MIN_24H_VOL)
.sort(([, a], [, b]) => b - a)
.slice(0, MAX_COINS)
.map(([id]) => id);

console.log(`Aktif USDT-SWAP: ${activeIds.size} → Filtre sonrası: ${filtered.length} coin`);
return filtered;
}

async function fetchCandles(instId, bar, limit = 120) {
const data = await okxGet(”/api/v5/market/candles”, { instId, bar, limit });
if (!data?.data?.length) return null;

// OKX sırayı ters verir (en yeni önce) → düzelt
const rows = data.data.reverse().map(r => ({
ts:    parseInt(r[0]),
open:  parseFloat(r[1]),
high:  parseFloat(r[2]),
low:   parseFloat(r[3]),
close: parseFloat(r[4]),
vol:   parseFloat(r[5]),
}));

return rows;
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

// ─── İNDİKATÖRLER ────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
const result = ti.EMA.calculate({ period, values: closes });
// Sonucu closes uzunluğuna hizala
const pad = closes.length - result.length;
return […Array(pad).fill(null), …result];
}

function calcRSI(closes, period) {
const result = ti.RSI.calculate({ period, values: closes });
const pad = closes.length - result.length;
return […Array(pad).fill(null), …result];
}

function calcStochRSI(closes) {
// StochRSI: period=14, k=3, d=3
const result = ti.StochasticRSI.calculate({
values: closes,
rsiPeriod: 14,
stochasticPeriod: 14,
kPeriod: 3,
dPeriod: 3,
});
const pad = closes.length - result.length;
const empty = Array(pad).fill({ k: null, d: null });
return […empty, …result];
}

function calcATR(candles, period = 14) {
const highs  = candles.map(c => c.high);
const lows   = candles.map(c => c.low);
const closes = candles.map(c => c.close);
const result = ti.ATR.calculate({ high: highs, low: lows, close: closes, period });
const pad = candles.length - result.length;
return […Array(pad).fill(null), …result];
}

function calcBBWidth(closes, period = 20) {
const result = ti.BollingerBands.calculate({ period, values: closes, stdDev: 2 });
const pad = closes.length - result.length;
return […Array(pad).fill(null), …result.map(b => (b.upper - b.lower) / b.middle)];
}

function calcVWAP(candles) {
// Basit VWAP: (high+low+close)/3 × vol kümülatif / kümülatif vol
let cumPV = 0, cumVol = 0;
return candles.map(c => {
const tp = (c.high + c.low + c.close) / 3;
cumPV  += tp * c.vol;
cumVol += c.vol;
return cumVol > 0 ? cumPV / cumVol : c.close;
});
}

function calcCVD(candles) {
let cum = 0;
return candles.map(c => {
cum += c.close >= c.open ? c.vol : -c.vol;
return cum;
});
}

function computeAll(candles) {
const closes = candles.map(c => c.close);
const vols   = candles.map(c => c.vol);

return {
ema9:     calcEMA(closes, 9),
ema21:    calcEMA(closes, 21),
ema50:    calcEMA(closes, 50),
rsi7:     calcRSI(closes, 7),
rsi14:    calcRSI(closes, 14),
stochRsi: calcStochRSI(closes),
atr:      calcATR(candles, 14),
bbWidth:  calcBBWidth(closes, 20),
vwap:     calcVWAP(candles),
cvd:      calcCVD(candles),
vols,
};
}

// ─── FİLTRELER ───────────────────────────────────────────────────────────────

function marketRegime(ind, n) {
const atr    = ind.atr[n];
const atrArr = ind.atr.filter(v => v !== null).slice(-20);
const atrMA  = atrArr.reduce((a, b) => a + b, 0) / atrArr.length;

const bbArr  = ind.bbWidth.filter(v => v !== null).slice(-20);
const bbW    = ind.bbWidth[n];
const bbWMA  = bbArr.reduce((a, b) => a + b, 0) / bbArr.length;

if (atr > atrMA * 2.5)   return “volatile”;
if (bbW < bbWMA * 0.70)  return “range”;
return “trend”;
}

function detectDivergence(closes, rsi14, direction, n) {
try {
const c4 = closes[n - 4], c0 = closes[n];
const r4 = rsi14[n - 4],  r0 = rsi14[n];
if (r4 === null || r0 === null) return false;
if (direction === “long”)  return c0 > c4 && r0 < r4;   // bearish div
if (direction === “short”) return c0 < c4 && r0 > r4;   // bullish div
} catch { return false; }
return false;
}

function obImbalance(ob, direction) {
if (!ob) return true;
try {
const bidVol = ob.bids.slice(0, 10).reduce((s, b) => s + parseFloat(b[1]), 0);
const askVol = ob.asks.slice(0, 10).reduce((s, a) => s + parseFloat(a[1]), 0);
const total  = bidVol + askVol;
if (total === 0) return true;
const ratio = bidVol / total;
return direction === “long” ? ratio >= OB_IMBALANCE_MIN : ratio <= (1 - OB_IMBALANCE_MIN);
} catch { return true; }
}

function sessionOk() {
if (!SESSION_FILTER) return true;
return PRIME_HOURS_UTC.has(new Date().getUTCHours());
}

function getBtcTrend(candles1m) {
const ind = computeAll(candles1m);
const n   = candles1m.length - 1;
const { ema9, ema21, ema50 } = ind;
if (ema9[n] > ema21[n] && ema21[n] > ema50[n]) return “up”;
if (ema9[n] < ema21[n] && ema21[n] < ema50[n]) return “down”;
return “neutral”;
}

// ─── SKOR MOTORU ─────────────────────────────────────────────────────────────

function scoreSignal(candles5m, candles1m, funding, direction, ob) {
let score = 0;
const hits = [];
let atr = 0;

try {
const ind5 = computeAll(candles5m);
const ind1 = computeAll(candles1m);
const n5   = candles5m.length - 1;
const n1   = candles1m.length - 1;
const n1p  = n1 - 1;  // önceki bar

```
atr = ind1.atr[n1] || 0;

const vols1  = ind1.vols;
const volAvg = vols1.slice(-20).reduce((a, b) => a + b, 0) / 20;
const atr1   = ind1.atr.filter(v => v !== null).slice(-20);
const atrAvg = atr1.reduce((a, b) => a + b, 0) / atr1.length;

const cvd1   = ind1.cvd;
const cvdUp  = cvd1[n1] > cvd1[n1 - 5];

const srK = ind1.stochRsi[n1]?.k;
const srD = ind1.stochRsi[n1]?.d;
const srKp= ind1.stochRsi[n1p]?.k;
const srDp= ind1.stochRsi[n1p]?.d;

const vwap5 = ind5.vwap[n5];
const close5 = candles5m[n5].close;
const close1 = candles1m[n1].close;
const vol1   = candles1m[n1].vol;
const rsi7   = ind1.rsi7[n1];

if (direction === "long") {
  // 1. EMA dizilimi (5m)
  if (ind5.ema9[n5] > ind5.ema21[n5] && ind5.ema21[n5] > ind5.ema50[n5]) {
    score++; hits.push("EMA✓");
  }
  // 2. VWAP üzeri (5m)
  if (close5 > vwap5) { score++; hits.push("VWAP✓"); }
  // 3. Stoch RSI crossover yukarı (1m)
  if (srK != null && srD != null && srK > srD && srKp <= srDp && srK > 20) {
    score++; hits.push("StRSI✓");
  }
  // 4. RSI(7) momentum bandı
  if (rsi7 != null && rsi7 > 25 && rsi7 < 60) { score++; hits.push("RSI✓"); }
  // 5. CVD pozitif
  if (cvdUp) { score++; hits.push("CVD✓"); }
  // 6. Hacim spike
  if (vol1 > volAvg * VOL_SPIKE_MULT) { score++; hits.push("VOL✓"); }
  // 7. ATR aktif
  if (atr > atrAvg) { score++; hits.push("ATR✓"); }
  // 8. Funding uygun
  if (funding !== null && funding < FUNDING_LONG_MAX) { score++; hits.push("FUND✓"); }
  // 9. Order book alıcı baskısı
  if (obImbalance(ob, "long")) { score++; hits.push("OB✓"); }

} else {
  if (ind5.ema9[n5] < ind5.ema21[n5] && ind5.ema21[n5] < ind5.ema50[n5]) {
    score++; hits.push("EMA✓");
  }
  if (close5 < vwap5) { score++; hits.push("VWAP✓"); }
  if (srK != null && srD != null && srK < srD && srKp >= srDp && srK < 80) {
    score++; hits.push("StRSI✓");
  }
  if (rsi7 != null && rsi7 > 40 && rsi7 < 75) { score++; hits.push("RSI✓"); }
  if (!cvdUp) { score++; hits.push("CVD✓"); }
  if (vol1 > volAvg * VOL_SPIKE_MULT) { score++; hits.push("VOL✓"); }
  if (atr > atrAvg) { score++; hits.push("ATR✓"); }
  if (funding !== null && funding > FUNDING_SHORT_MIN) { score++; hits.push("FUND✓"); }
  if (obImbalance(ob, "short")) { score++; hits.push("OB✓"); }
}
```

} catch (e) {
// hata → skor 0
}

return { score, hits, atr };
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
console.warn(“TG_BOT_TOKEN veya TG_CHAT_ID eksik!”);
return;
}
try {
await axios.post(
`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
{ chat_id: TG_CHAT_ID, text, parse_mode: “HTML”, disable_web_page_preview: true },
{ timeout: 8000 }
);
} catch (e) {
console.error(“Telegram gönderim hatası:”, e.message);
}
}

function formatPrice(price) {
if (price < 0.01)    return price.toFixed(6);
if (price < 1)       return price.toFixed(5);
if (price < 100)     return price.toFixed(4);
if (price < 10000)   return price.toFixed(2);
return price.toFixed(1);
}

function buildMessage(instId, direction, price, score, hits, funding, atr) {
const symbol = instId.replace(”-USDT-SWAP”, “/USDT”).replace(”-SWAP”, “”);
const emoji  = direction === “long” ? “🟢” : “🔴”;
const dirTr  = direction === “long” ? “LONG  ▲” : “SHORT ▼”;

const slDist  = atr * ATR_SL_MULT;
const tp1Dist = atr * ATR_TP1_MULT;
const tp2Dist = atr * ATR_TP2_MULT;

const sl  = direction === “long” ? price - slDist  : price + slDist;
const tp1 = direction === “long” ? price + tp1Dist : price - tp1Dist;
const tp2 = direction === “long” ? price + tp2Dist : price - tp2Dist;

const slPct  = (Math.abs(price - sl)  / price * 100).toFixed(2);
const tp1Pct = (Math.abs(tp1 - price) / price * 100).toFixed(2);
const tp2Pct = (Math.abs(tp2 - price) / price * 100).toFixed(2);
const rr     = slPct > 0 ? (tp2Pct / slPct).toFixed(1) : “—”;

const fundingStr = funding !== null ? `${(funding * 100).toFixed(4)}%` : “—”;
const now = new Date().toUTCString().slice(17, 25) + “ UTC”;

return (
`${emoji} <b>${dirTr} — ${symbol}</b>\n` +
`━━━━━━━━━━━━━━━━━━━━\n` +
`💰 Giriş:  <b>${formatPrice(price)}</b>\n` +
`🎯 TP1:    <b>${formatPrice(tp1)}</b>  (+${tp1Pct}%)\n` +
`🎯 TP2:    <b>${formatPrice(tp2)}</b>  (+${tp2Pct}%)\n` +
`🛑 SL:     <b>${formatPrice(sl)}</b>  (-${slPct}%)\n` +
`━━━━━━━━━━━━━━━━━━━━\n` +
`📊 Skor:   <b>${score}/9</b>\n` +
`✅ Sinyal: ${hits.join("  ")}\n` +
`💸 Funding: ${fundingStr}\n` +
`⚖️ R:R:    1:${rr}\n` +
`⚡ Kaldıraç: 20x\n` +
`━━━━━━━━━━━━━━━━━━━━\n` +
`💡 <i>TP1'de %50 kapat → SL'i giriş fiyatına çek</i>\n` +
`🕒 ${now}\n` +
`<i>⚠ Ticaret tavsiyesi değildir.</i>`
);
}

// ─── TEK COİN TARAMA ─────────────────────────────────────────────────────────

async function scanCoin(instId) {
try {
if (!sessionOk()) return;

```
const ticker = await fetchTicker(instId);
if (!ticker) return;
const price = parseFloat(ticker.last || 0);
if (price <= 0) return;

const [candles1m, candles5m] = await Promise.all([
  fetchCandles(instId, "1m", 120),
  fetchCandles(instId, "5m", 120),
]);
if (!candles1m || !candles5m || candles1m.length < 60 || candles5m.length < 60) return;

const [funding, ob] = await Promise.all([
  fetchFunding(instId),
  fetchOrderbook(instId),
]);

const ind1 = computeAll(candles1m);
const n1   = candles1m.length - 1;

for (const direction of ["long", "short"]) {
  const key = `${instId}_${direction}`;
  if (Date.now() - (lastSignal[key] || 0) < COOLDOWN_MS) continue;

  // ── Hard filtreler ────────────────────────────────────────────────────
  const regime = marketRegime(ind1, n1);
  if (regime === "range" || regime === "volatile") continue;

  if (detectDivergence(candles1m.map(c => c.close), ind1.rsi14, direction, n1)) continue;

  if (BTC_FILTER && !instId.includes("BTC-USDT-SWAP")) {
    if (direction === "long"  && btcTrend === "down") continue;
    if (direction === "short" && btcTrend === "up")   continue;
  }

  // ── Skor ─────────────────────────────────────────────────────────────
  const { score, hits, atr } = scoreSignal(candles5m, candles1m, funding, direction, ob);

  if (score >= MIN_SCORE) {
    console.log(`🚀 SİNYAL → ${instId} ${direction.toUpperCase()} ${score}/9`, hits);
    const msg = buildMessage(instId, direction, price, score, hits, funding, atr);
    await sendTelegram(msg);
    lastSignal[key] = Date.now();
  } else {
    // console.debug(`${instId} ${direction} ${score}/9 — yetersiz`);
  }
}
```

} catch (e) {
console.error(`${instId} tarama hatası:`, e.message);
}
}

// ─── PARALEL TARAMA ──────────────────────────────────────────────────────────

async function runBatch(list) {
// CONCURRENT kadar aynı anda çalıştır
for (let i = 0; i < list.length; i += CONCURRENT) {
const batch = list.slice(i, i + CONCURRENT);
await Promise.all(batch.map(id => scanCoin(id)));
}
}

// ─── ANA DÖNGÜ ───────────────────────────────────────────────────────────────

async function main() {
console.log(”=”.repeat(55));
console.log(”  OKX Scalping Scanner v2 — Node.js”);
console.log(`  Min skor: ${MIN_SCORE}/9 | Cooldown: ${COOLDOWN_MS / 1000}s`);
console.log(`  Tarama: ${SCAN_INTERVAL_MS / 1000}s | Max coin: ${MAX_COINS}`);
console.log(`  Session filtresi: ${SESSION_FILTER ? "AÇIK" : "KAPALI"}`);
console.log(`  BTC filtresi:     ${BTC_FILTER ? "AÇIK" : "KAPALI"}`);
console.log(”=”.repeat(55));

await sendTelegram(
`🤖 <b>OKX Scanner v2 aktif</b>\n` +
`Min skor: ${MIN_SCORE}/9 | Cooldown: ${COOLDOWN_MS / 1000}s\n` +
`Session: ${SESSION_FILTER ? "✅" : "❌"} | BTC filtre: ${BTC_FILTER ? "✅" : "❌"}`
);

let cycle = 0;

while (true) {
cycle++;
const t0 = Date.now();
console.log(`─── Tur #${cycle} başladı ───`);

```
// Her 5 turda bir coin listesini yenile
if (cycle === 1 || cycle % 5 === 0) {
  watchlist = await fetchAllInstruments();
  if (!watchlist.length) {
    console.error("Coin listesi boş! 30s sonra tekrar...");
    await sleep(30_000);
    continue;
  }
}

// BTC trend güncelle
try {
  const btcCandles = await fetchCandles("BTC-USDT-SWAP", "5m", 60);
  if (btcCandles) btcTrend = getBtcTrend(btcCandles);
  console.log(`BTC trend: ${btcTrend.toUpperCase()}`);
} catch {}

// Paralel tara
await runBatch(watchlist);

const elapsed = Date.now() - t0;
console.log(`─── Tur #${cycle} bitti (${(elapsed / 1000).toFixed(1)}s) | ${watchlist.length} coin ───`);

const wait = Math.max(0, SCAN_INTERVAL_MS - elapsed);
if (wait > 0) await sleep(wait);
```

}
}

function sleep(ms) {
return new Promise(r => setTimeout(r, ms));
}

main().catch(e => {
console.error(“Fatal hata:”, e);
process.exit(1);
});
