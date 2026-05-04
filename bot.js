require("dotenv").config();
const axios = require("axios");
const ti    = require("technicalindicators");

const TG_BOT_TOKEN      = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID        = process.env.TG_CHAT_ID   || "";
const OKX_BASE          = "https://www.okx.com";
const SCAN_INTERVAL_MS  = 60000;
const MIN_SCORE         = 6;
const VOL_SPIKE_MULT    = 1.5;
const MIN_24H_VOL       = 10000000;
const MAX_COINS         = 100;
const FUNDING_LONG_MAX  = 0.001;
const FUNDING_SHORT_MIN = 0.0001;
const COOLDOWN_MS       = 300000;
const CONCURRENT        = 10;
const ATR_SL_MULT       = 1.0;
const ATR_TP1_MULT      = 1.5;
const ATR_TP2_MULT      = 3.0;
const OB_MIN            = 0.55;
const BTC_FILTER        = false;
const ATR_MIN_RATIO     = 0.7;

const lastSignal = {};
let btcTrend = "neutral";
let watchlist = [];

async function okxGet(path, params) {
  try {
    const res = await axios.get(OKX_BASE + path, { params: params || {}, timeout: 12000, headers: { "User-Agent": "Mozilla/5.0" } });
    if (res.data && res.data.code === "0") return res.data;
    return null;
  } catch(e) { return null; }
}

async function fetchAllInstruments() {
  const inst = await okxGet("/api/v5/public/instruments", { instType: "SWAP" });
  if (!inst) { console.error("[ERR] Enstruman listesi alinamadi"); return []; }
  var active = {};
  inst.data.forEach(function(d) { if (d.settleCcy === "USDT" && d.state === "live") active[d.instId] = true; });
  const tickers = await okxGet("/api/v5/market/tickers", { instType: "SWAP" });
  if (!tickers) return Object.keys(active).slice(0, MAX_COINS);
  var volMap = {};
  tickers.data.forEach(function(t) { if (active[t.instId]) volMap[t.instId] = parseFloat(t.volCcy24h || 0); });
  var filtered = Object.keys(volMap).filter(function(id) { return volMap[id] >= MIN_24H_VOL; }).sort(function(a, b) { return volMap[b] - volMap[a]; }).slice(0, MAX_COINS);
  console.log("[INFO] " + Object.keys(active).length + " coin -> filtre: " + filtered.length + " taranacak");
  return filtered;
}

async function fetchCandles(instId, bar, limit) {
  const data = await okxGet("/api/v5/market/candles", { instId: instId, bar: bar, limit: limit || 120 });
  if (!data || !data.data || !data.data.length) return null;
  return data.data.reverse().map(function(r) { return { ts: parseInt(r[0]), open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]), vol: parseFloat(r[5]) }; });
}

async function fetchFunding(instId) {
  const data = await okxGet("/api/v5/public/funding-rate", { instId: instId });
  if (!data || !data.data || !data.data[0]) return null;
  return parseFloat(data.data[0].fundingRate);
}

async function fetchOrderbook(instId) {
  const data = await okxGet("/api/v5/market/books", { instId: instId, sz: "20" });
  if (!data || !data.data || !data.data[0]) return null;
  return data.data[0];
}

async function fetchTicker(instId) {
  const data = await okxGet("/api/v5/market/ticker", { instId: instId });
  if (!data || !data.data || !data.data[0]) return null;
  return data.data[0];
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
function calcATR(candles, period) { return pad(ti.ATR.calculate({ high: candles.map(function(c) { return c.high; }), low: candles.map(function(c) { return c.low; }), close: candles.map(function(c) { return c.close; }), period: period || 14 }), candles.length); }
function calcMACD(closes) { return pad(ti.MACD.calculate({ values: closes, fastPeriod: 5, slowPeriod: 13, signalPeriod: 1, SimpleMAOscillator: false, SimpleMASignal: false }), closes.length); }
function calcBBWidth(closes) { var bb = ti.BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 }); return pad(bb.map(function(b) { return (b.upper - b.lower) / b.middle; }), closes.length); }
function calcVWAP(candles) { var cumPV = 0, cumVol = 0; return candles.map(function(c) { var tp = (c.high + c.low + c.close) / 3; cumPV += tp * c.vol; cumVol += c.vol; return cumVol > 0 ? cumPV / cumVol : c.close; }); }
function calcCVD(candles) { var cum = 0; return candles.map(function(c) { cum += c.close >= c.open ? c.vol : -c.vol; return cum; }); }

function calcSupertrend(candles, period, mult) {
  period = period || 10; mult = mult || 3.0;
  var atr = calcATR(candles, period), n = candles.length;
  var upper = new Array(n).fill(null), lower = new Array(n).fill(null), dir = new Array(n).fill(1), st = new Array(n).fill(null);
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

function avg(arr, last) { var vals = arr.filter(function(v) { return v !== null; }).slice(-(last || 20)); if (!vals.length) return 0; return vals.reduce(function(a, b) { return a + b; }, 0) / vals.length; }

function computeAll(candles) {
  var closes = candles.map(function(c) { return c.close; });
  return { ema9: calcEMA(closes, 9), ema21: calcEMA(closes, 21), ema50: calcEMA(closes, 50), rsi7: calcRSI(closes, 7), rsi14: calcRSI(closes, 14), stochRsi: calcStochRSI(closes), atr: calcATR(candles, 14), macd: calcMACD(closes), bbWidth: calcBBWidth(closes), vwap: calcVWAP(candles), cvd: calcCVD(candles), supertrend: calcSupertrend(candles, 10, 3), vols: candles.map(function(c) { return c.vol; }) };
}

function marketRegime(ind, n) {
  var atrVal = ind.atr[n], atrMA = avg(ind.atr, 20), bbW = ind.bbWidth[n], bbWMA = avg(ind.bbWidth, 20);
  if (!atrVal || !bbW) return "unknown";
  if (atrVal > atrMA * 3.0) return "volatile";
  if (bbW < bbWMA * 0.60) return "range";
  return "trend";
}

function detectDivergence(candles, rsi14, direction, n) {
  try {
    if (n < 6) return false;
    var c0 = candles[n].close, c4 = candles[n-4].close, r0 = rsi14[n], r4 = rsi14[n-4];
    if (r0 == null || r4 == null) return false;
    if (direction === "long") return c0 > c4 && r0 < r4;
    if (direction === "short") return c0 < c4 && r0 > r4;
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
    return direction === "long" ? ratio >= OB_MIN : ratio <= (1 - OB_MIN);
  } catch(e) { return true; }
}

function getBtcTrend(candles) {
  var ind = computeAll(candles), n = candles.length - 1;
  if (ind.ema9[n] > ind.ema21[n] && ind.ema21[n] > ind.ema50[n]) return "up";
  if (ind.ema9[n] < ind.ema21[n] && ind.ema21[n] < ind.ema50[n]) return "down";
  return "neutral";
}

function scoreSignal(c5m, c1m, funding, direction, ob) {
  var score = 0, hits = [], atr = 0;
  try {
    var i5 = computeAll(c5m), i1 = computeAll(c1m);
    var n5 = c5m.length - 1, n1 = c1m.length - 1, n1p = n1 - 1;
    atr = i1.atr[n1] || 0;
    var volAvg = avg(i1.vols, 20);
    var cvd = i1.cvd, cvdUp = cvd[n1] > cvd[n1 - 5];
    var srK = i1.stochRsi[n1] ? i1.stochRsi[n1].k : null;
    var srD = i1.stochRsi[n1] ? i1.stochRsi[n1].d : null;
    var srKp = i1.stochRsi[n1p] ? i1.stochRsi[n1p].k : null;
    var srDp = i1.stochRsi[n1p] ? i1.stochRsi[n1p].d : null;
    var macd1 = i1.macd[n1], close5 = c5m[n5].close, vol1 = c1m[n1].vol, rsi7 = i1.rsi7[n1];
    if (direction === "long") {
      if (i5.ema9[n5] > i5.ema21[n5] && i5.ema21[n5] > i5.ema50[n5]) { score++; hits.push("EMA"); }
      if (close5 > i5.vwap[n5]) { score++; hits.push("VWAP"); }
      if (i5.supertrend[n5] === 1) { score++; hits.push("ST"); }
      if (srK != null && srD != null && srK > srD && srKp <= srDp && srK > 20) { score++; hits.push("StRSI"); }
      if (rsi7 != null && rsi7 > 25 && rsi7 < 65) { score++; hits.push("RSI"); }
      if (macd1 && macd1.histogram != null && macd1.histogram > 0) { score++; hits.push("MACD"); }
      if (cvdUp) { score++; hits.push("CVD"); }
      if (vol1 > volAvg * VOL_SPIKE_MULT) { score++; hits.push("VOL"); }
      if (obImbalance(ob, "long")) { score++; hits.push("OB"); }
      if (funding !== null && funding < FUNDING_LONG_MAX) { score++; hits.push("FUND"); }
    } else {
      if (i5.ema9[n5] < i5.ema21[n5] && i5.ema21[n5] < i5.ema50[n5]) { score++; hits.push("EMA"); }
      if (close5 < i5.vwap[n5]) { score++; hits.push("VWAP"); }
      if (i5.supertrend[n5] === -1) { score++; hits.push("ST"); }
      if (srK != null && srD != null && srK < srD && srKp >= srDp && srK < 80) { score++; hits.push("StRSI"); }
      if (rsi7 != null && rsi7 > 35 && rsi7 < 75) { score++; hits.push("RSI"); }
      if (macd1 && macd1.histogram != null && macd1.histogram < 0) { score++; hits.push("MACD"); }
      if (!cvdUp) { score++; hits.push("CVD"); }
      if (vol1 > volAvg * VOL_SPIKE_MULT) { score++; hits.push("VOL"); }
      if (obImbalance(ob, "short")) { score++; hits.push("OB"); }
      if (funding !== null && funding > FUNDING_SHORT_MIN) { score++; hits.push("FUND"); }
    }
  } catch(e) { console.debug("[SCORE ERR]", e.message); }
  return { score: score, hits: hits, atr: atr };
}

async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) { console.warn("[WARN] Token eksik"); return; }
  try { await axios.post("https://api.telegram.org/bot" + TG_BOT_TOKEN + "/sendMessage", { chat_id: TG_CHAT_ID, text: text, parse_mode: "HTML", disable_web_page_preview: true }, { timeout: 8000 }); }
  catch(e) { console.error("[TG ERR]", e.message); }
}

function fmtPrice(p) { if (p < 0.001) return p.toFixed(7); if (p < 0.01) return p.toFixed(6); if (p < 1) return p.toFixed(5); if (p < 100) return p.toFixed(4); if (p < 10000) return p.toFixed(2); return p.toFixed(1); }

function buildMessage(instId, direction, price, score, hits, funding, atr) {
  var symbol = instId.replace("-USDT-SWAP", "/USDT");
  var emoji = direction === "long" ? "🟢" : "🔴";
  var dirTr = direction === "long" ? "LONG  ▲" : "SHORT ▼";
  var sl  = direction === "long" ? price - atr * ATR_SL_MULT  : price + atr * ATR_SL_MULT;
  var tp1 = direction === "long" ? price + atr * ATR_TP1_MULT : price - atr * ATR_TP1_MULT;
  var tp2 = direction === "long" ? price + atr * ATR_TP2_MULT : price - atr * ATR_TP2_MULT;
  var slPct  = (Math.abs(price - sl)  / price * 100).toFixed(2);
  var tp1Pct = (Math.abs(tp1 - price) / price * 100).toFixed(2);
  var tp2Pct = (Math.abs(tp2 - price) / price * 100).toFixed(2);
  var rr = (parseFloat(tp2Pct) / parseFloat(slPct)).toFixed(1);
  var profPct = (parseFloat(tp2Pct) * 20).toFixed(0);
  var lossPct = (parseFloat(slPct) * 20).toFixed(0);
  var fundStr = funding !== null ? (funding * 100).toFixed(4) + "%" : "-";
  var now = new Date().toUTCString().slice(5, 25) + " UTC";
  var bar = "█".repeat(score) + "░".repeat(10 - score);
  var tier = score === 10 ? "🔥 MUKEMMEL" : score === 9 ? "⭐ GUCLU" : score === 8 ? "✅ IYI" : "⚡ ORTA";
  return emoji + " <b>" + dirTr + " — " + symbol + "</b>\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "💰 Giris:  <b>" + fmtPrice(price) + "</b>\n" +
    "🎯 TP1:    <b>" + fmtPrice(tp1) + "</b>  (+" + tp1Pct + "%)\n" +
    "🎯 TP2:    <b>" + fmtPrice(tp2) + "</b>  (+" + tp2Pct + "%)\n" +
    "🛑 SL:     <b>" + fmtPrice(sl) + "</b>  (-" + slPct + "%)\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "📊 Skor: " + bar + " <b>" + score + "/10</b>  " + tier + "\n" +
    "✅ <code>" + hits.join(" ") + "</code>\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "⚡ 20x → Kar: <b>+%" + profPct + "</b> | Zarar: <b>-%" + lossPct + "</b>\n" +
    "⚖️ R:R: 1:" + rr + "  |  💸 Funding: " + fundStr + "\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "💡 <i>TP1'de %50 kapat → SL'i giris fiyatina cek → TP2 bekle</i>\n" +
    "🕒 " + now + "\n" +
    "<i>⚠ Ticaret tavsiyesi degildir.</i>";
}

async function scanCoin(instId) {
  try {
    var ticker = await fetchTicker(instId);
    if (!ticker) return;
    var price = parseFloat(ticker.last || 0);
    if (price <= 0) return;
    var results = await Promise.all([fetchCandles(instId, "1m", 120), fetchCandles(instId, "5m", 150), fetchFunding(instId), fetchOrderbook(instId)]);
    var c1m = results[0], c5m = results[1], funding = results[2], ob = results[3];
    if (!c1m || !c5m) return;
    if (c1m.length < 60 || c5m.length < 60) return;
    var atr1 = calcATR(c1m, 14), atrVal = atr1[atr1.length - 1], atrMA = avg(atr1, 20);
    if (!atrVal || atrVal < atrMA * ATR_MIN_RATIO) return;
    var i1m = computeAll(c1m), n1 = c1m.length - 1;
    var regime = marketRegime(i1m, n1);
    if (regime === "volatile") return;
    var directions = ["long", "short"];
    for (var d = 0; d < directions.length; d++) {
      var direction = directions[d];
      var key = instId + "_" + direction;
      if (Date.now() - (lastSignal[key] || 0) < COOLDOWN_MS) continue;
      if (detectDivergence(c1m, i1m.rsi14, direction, n1)) continue;
      if (BTC_FILTER) { if (direction === "long" && btcTrend === "down") continue; if (direction === "short" && btcTrend === "up") continue; }
      var result = scoreSignal(c5m, c1m, funding, direction, ob);
      if (result.score >= MIN_SCORE) {
        console.log("🚀 SINYAL → " + instId + " " + direction.toUpperCase() + " " + result.score + "/10 " + result.hits.join(" "));
        await sendTelegram(buildMessage(instId, direction, price, result.score, result.hits, funding, result.atr));
        lastSignal[key] = Date.now();
      }
    }
  } catch(e) { console.error("[ERR] " + instId + ": " + e.message); }
}

async function runBatch(list) { for (var i = 0; i < list.length; i += CONCURRENT) { await Promise.all(list.slice(i, i + CONCURRENT).map(function(id) { return scanCoin(id); })); } }
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
  console.log("OKX Scalping Scanner v3 | Min: " + MIN_SCORE + "/10 | " + MAX_COINS + " coin");
  await sendTelegram("🤖 <b>OKX Scanner v3 aktif</b>\nSkor: " + MIN_SCORE + "/10 | Cooldown: " + (COOLDOWN_MS/60000) + "dk\nSinyal bekleniyor...");
  var cycle = 0;
  while (true) {
    cycle++;
    var t0 = Date.now();
    if (cycle === 1 || cycle % 5 === 0) {
      watchlist = await fetchAllInstruments();
      if (!watchlist.length) { await sleep(30000); continue; }
    }
    try { var btcC = await fetchCandles("BTC-USDT-SWAP", "5m", 60); if (btcC) { btcTrend = getBtcTrend(btcC); console.log("BTC: " + btcTrend.toUpperCase()); } } catch(e) {}
    await runBatch(watchlist);
    var elapsed = Date.now() - t0;
    console.log("Tur #" + cycle + " (" + (elapsed/1000).toFixed(1) + "s) | " + watchlist.length + " coin");
    var wait = Math.max(0, SCAN_INTERVAL_MS - elapsed);
    if (wait) await sleep(wait);
  }
}

main().catch(function(e) { console.error("[FATAL]", e); process.exit(1); });
