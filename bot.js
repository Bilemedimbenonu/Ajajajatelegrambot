const axios = require("axios");

const TG_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT  = process.env.TG_CHAT_ID  || "";
const BINANCE  = "https://fapi.binance.com";

const SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT"
];

const SCAN_MS  = 60000;
const COOLDOWN = 30 * 60000;
const MAX_BARS = 6;

async function bGet(path, params) {
  try {
    const r = await axios.get(BINANCE + path, {
      params: params || {},
      timeout: 12000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    return r.data;
  } catch(e) { return null; }
}

async function getCandles(sym, tf, limit) {
  const d = await bGet("/fapi/v1/klines", { symbol: sym, interval: tf, limit: limit || 100 });
  if (!d) return null;
  return d.map(c => ({
    time: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5])
  }));
}

async function getFunding(sym) {
  const d = await bGet("/fapi/v1/premiumIndex", { symbol: sym });
  return d ? parseFloat(d.lastFundingRate || 0) : null;
}

async function getOrderBook(sym) {
  const d = await bGet("/fapi/v1/depth", { symbol: sym, limit: 20 });
  if (!d) return null;
  const bidVol = d.bids.reduce((s, b) => s + parseFloat(b[1]), 0);
  const askVol = d.asks.reduce((s, a) => s + parseFloat(a[1]), 0);
  return { bidVol, askVol, ratio: bidVol / askVol };
}

async function getTakerFlow(sym) {
  const d = await bGet("/fapi/v1/aggTrades", { symbol: sym, limit: 200 });
  if (!d) return null;
  let buyVol = 0, sellVol = 0;
  for (const t of d) {
    const qty = parseFloat(t.q);
    if (t.m) sellVol += qty;
    else buyVol += qty;
  }
  const total = buyVol + sellVol;
  return total > 0 ? { buyVol, sellVol, buyPct: buyVol / total } : null;
}

async function getOI(sym) {
  const d = await bGet("/fapi/v1/openInterest", { symbol: sym });
  return d ? parseFloat(d.openInterest) : null;
}

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  let ema = arr[0];
  const result = [ema];
  for (let i = 1; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcATR(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i-1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  return calcEMA(trs, period);
}

function fmtPrice(p) {
  if (p >= 1000) return p.toFixed(1);
  if (p >= 100)  return p.toFixed(2);
  if (p >= 1)    return p.toFixed(3);
  return p.toFixed(5);
}

function calcEMATrend(candles, fast, slow) {
  const closes = candles.map(c => c.close);
  const emaF = calcEMA(closes, fast);
  const emaS = calcEMA(closes, slow);
  const i = closes.length - 1;
  if (emaF[i] > emaS[i]) return "bull";
  if (emaF[i] < emaS[i]) return "bear";
  return "neutral";
}

function getSwingLow(candles)  { return Math.min.apply(null, candles.slice(-5).map(c => c.low));  }
function getSwingHigh(candles) { return Math.max.apply(null, candles.slice(-5).map(c => c.high)); }

function findStructuralResistance(candles, currentPrice) {
  const recent = candles.slice(-30);
  let nearest = null;
  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i].high > recent[i-1].high && recent[i].high > recent[i+1].high) {
      if (recent[i].high > currentPrice * 1.001) {
        if (nearest === null || recent[i].high < nearest) {
          nearest = recent[i].high;
        }
      }
    }
  }
  return nearest;
}

function findStructuralSupport(candles, currentPrice) {
  const recent = candles.slice(-30);
  let nearest = null;
  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i].low < recent[i-1].low && recent[i].low < recent[i+1].low) {
      if (recent[i].low < currentPrice * 0.999) {
        if (nearest === null || recent[i].low > nearest) {
          nearest = recent[i].low;
        }
      }
    }
  }
  return nearest;
}

async function tgSend(text) {
  try {
    await axios.post("https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage", {
      chat_id: TG_CHAT,
      text: text,
      parse_mode: "HTML"
    });
  } catch(e) {}
}

var lastSignal = {};
var pendingConfirmations = {};
var btcTrend15m = "neutral";

async function scanSymbol(sym) {
  try {
    if (Date.now() - (lastSignal[sym] || 0) < COOLDOWN) return;

    const [c5m, c15m, funding, ob, taker, oi] = await Promise.all([
      getCandles(sym, "5m", 100),
      getCandles(sym, "15m", 100),
      getFunding(sym),
      getOrderBook(sym),
      getTakerFlow(sym),
      getOI(sym)
    ]);

    if (!c5m || !c15m || !ob || !taker) return;
    if (c5m.length < 50 || c15m.length < 50) return;

    const n5 = c5m.length - 1;
    const price = c5m[n5].close;
    const lastClosed = c5m[n5 - 1];

    const trend5  = calcEMATrend(c5m,  9, 21);
    const trend15 = calcEMATrend(c15m, 9, 21);
    const isBtc   = sym === "BTCUSDT";

    let trendDir = null;
    if (trend5 === "bull" && trend15 === "bull" && (isBtc || btcTrend15m === "bull")) trendDir = "long";
    if (trend5 === "bear" && trend15 === "bear" && (isBtc || btcTrend15m === "bear")) trendDir = "short";
    if (!trendDir) return;

    const atr5 = calcATR(c5m, 14);
    const atrNow = atr5[n5];
    const atrAvg = atr5.slice(-50).reduce((a,b) => a+b, 0) / 50;
    const atrRatio = atrNow / atrAvg;
    if (atrRatio < 0.6 || atrRatio > 1.5) return;

    const body = Math.abs(lastClosed.close - lastClosed.open);
    const range = lastClosed.high - lastClosed.low;
    if (range === 0) return;
    if (body / range < 0.5) return;

    const volAvg = c5m.slice(-20, -1).reduce((s, c) => s + c.volume, 0) / 19;
    if (lastClosed.volume < volAvg * 1.1) return;

    const mumYon = lastClosed.close > lastClosed.open ? "bull" : "bear";
    if (trendDir === "long"  && mumYon !== "bull") return;
    if (trendDir === "short" && mumYon !== "bear") return;

    const obBullish = ob.ratio > 1.3;
    const obBearish = ob.ratio < 0.77;
    const takerBullish = taker.buyPct > 0.55;
    const takerBearish = taker.buyPct < 0.45;

    var oiKey = sym + "_oi";
    var oiPrev = global[oiKey] || oi;
    global[oiKey] = oi;
    const oiUp = oi > oiPrev * 1.001;
    const oiDown = oi < oiPrev * 0.999;

    let orderFlowOk = false;
    if (trendDir === "long"  && obBullish && takerBullish && (oiUp || oiPrev === oi)) orderFlowOk = true;
    if (trendDir === "short" && obBearish && takerBearish && (oiDown || oiPrev === oi)) orderFlowOk = true;
    if (!orderFlowOk) return;

    let tp1Level, slLevel;
    if (trendDir === "long") {
      tp1Level = findStructuralResistance(c5m, price);
      slLevel  = getSwingLow(c5m) - atrNow * 0.2;
      if (!tp1Level) tp1Level = price + atrNow * 2;
    } else {
      tp1Level = findStructuralSupport(c5m, price);
      slLevel  = getSwingHigh(c5m) + atrNow * 0.2;
      if (!tp1Level) tp1Level = price - atrNow * 2;
    }

    const slDist  = Math.abs(price - slLevel);
    const tp1Dist = Math.abs(tp1Level - price);
    const rr1 = tp1Dist / slDist;
    if (rr1 < 1.0) return;

    let tp2Level;
    if (trendDir === "long") {
      const next = findStructuralResistance(c5m, tp1Level);
      tp2Level = next || price + slDist * 2.5;
    } else {
      const next = findStructuralSupport(c5m, tp1Level);
      tp2Level = next || price - slDist * 2.5;
    }

    let bonusScore = 0;
    let bonusReasons = [];

    if (funding !== null) {
      if (trendDir === "long"  && funding < 0) { bonusScore++; bonusReasons.push("Funding-"); }
      if (trendDir === "short" && funding > 0.0003) { bonusScore++; bonusReasons.push("Funding+"); }
    }

    if (trendDir === "long"  && ob.ratio > 1.5) { bonusScore++; bonusReasons.push("OB-Strong"); }
    if (trendDir === "short" && ob.ratio < 0.67) { bonusScore++; bonusReasons.push("OB-Strong"); }

    if (trendDir === "long"  && taker.buyPct > 0.65) { bonusScore++; bonusReasons.push("Taker-Strong"); }
    if (trendDir === "short" && taker.buyPct < 0.35) { bonusScore++; bonusReasons.push("Taker-Strong"); }

    if (oi > oiPrev * 1.003 && trendDir === "long")  { bonusScore++; bonusReasons.push("OI-Spike"); }
    if (oi < oiPrev * 0.997 && trendDir === "short") { bonusScore++; bonusReasons.push("OI-Spike"); }

    if (bonusScore < 2) return;

    const pendKey = sym + "_" + trendDir;
    const lastBarTime = lastClosed.time;

    if (!pendingConfirmations[pendKey] || pendingConfirmations[pendKey].barTime !== lastBarTime) {
      pendingConfirmations[pendKey] = {
        barTime: lastBarTime,
        direction: trendDir,
        snapshot: { price, tp1Level, tp2Level, slLevel, atrNow, funding, bonusScore, bonusReasons }
      };
      console.log("[PENDING] " + sym + " " + trendDir.toUpperCase() + " - waiting N+1 confirmation");
      return;
    }

    return;

  } catch(e) {
    console.error("[ERR] " + sym + ": " + e.message);
  }
}

async function checkPendingConfirmations() {
  for (const key in pendingConfirmations) {
    const pending = pendingConfirmations[key];
    const sym = key.split("_")[0];

    try {
      const c5m = await getCandles(sym, "5m", 5);
      if (!c5m) continue;

      const n1bar = c5m.find(c => c.time > pending.barTime);
      if (!n1bar) continue;

      let confirmed = false;
      if (pending.direction === "long"  && n1bar.close > n1bar.open && n1bar.close > pending.snapshot.price) confirmed = true;
      if (pending.direction === "short" && n1bar.close < n1bar.open && n1bar.close < pending.snapshot.price) confirmed = true;

      if (confirmed) {
        await fireSignal(sym, pending);
        lastSignal[sym] = Date.now();
      } else {
        console.log("[CANCEL] " + sym + " " + pending.direction + " - N+1 closed against");
      }

      delete pendingConfirmations[key];

    } catch(e) {
      console.error("[CONFIRM ERR] " + sym + ": " + e.message);
    }
  }
}

async function fireSignal(sym, pending) {
  const s = pending.snapshot;
  const dir = pending.direction;

  const c = await getCandles(sym, "5m", 2);
  if (!c) return;
  const entry = c[c.length - 1].open;

  const sl  = s.slLevel;
  const tp1 = s.tp1Level;
  const tp2 = s.tp2Level;

  const slDist  = Math.abs(entry - sl);
  const tp1Dist = Math.abs(tp1 - entry);
  const tp2Dist = Math.abs(tp2 - entry);
  const slPct   = (slDist / entry * 100).toFixed(2);
  const tp1Pct  = (tp1Dist / entry * 100).toFixed(2);
  const tp2Pct  = (tp2Dist / entry * 100).toFixed(2);
  const rr1 = (tp1Dist / slDist).toFixed(2);
  const rr2 = (tp2Dist / slDist).toFixed(2);

  const lev = 20;
  const label = dir === "long" ? "LONG" : "SHORT";
  const fund = s.funding !== null ? (s.funding * 100).toFixed(4) + "%" : "-";

  const msg =
    "<b>[" + label + "] " + sym + "</b>\n" +
    "-------------\n" +
    "<b>Giris:</b> " + fmtPrice(entry) + "\n\n" +
    "<b>TP1:</b> " + fmtPrice(tp1) + " (" + tp1Pct + "% | " + lev + "x: " + (parseFloat(tp1Pct)*lev).toFixed(0) + "%) %60\n" +
    "<b>TP2:</b> " + fmtPrice(tp2) + " (" + tp2Pct + "% | " + lev + "x: " + (parseFloat(tp2Pct)*lev).toFixed(0) + "%) %40\n" +
    "<b>SL :</b> " + fmtPrice(sl)  + " (-" + slPct + "% | " + lev + "x: -" + (parseFloat(slPct)*lev).toFixed(0) + "%)\n" +
    "-------------\n" +
    "<b>R:R TP1:</b> 1:" + rr1 + " | <b>TP2:</b> 1:" + rr2 + "\n" +
    "<b>Funding:</b> " + fund + "\n" +
    "<b>Bonus:</b> " + s.bonusScore + "/4 (" + s.bonusReasons.join(", ") + ")\n" +
    "-------------\n" +
    "Max 6 mum (30dk) - Otomatik kapat\n" +
    "<i>TP1 sonrasi SL girise cek!</i>\n" +
    new Date().toUTCString().slice(5, 25) + " UTC";

  console.log("[SIGNAL] " + sym + " " + dir.toUpperCase() + " @ " + fmtPrice(entry));
  await tgSend(msg);

  trackTrade(sym, dir, entry, sl, tp1, tp2);
}

async function trackTrade(sym, dir, entry, sl, tp1, tp2) {
  var startTime = Date.now();
  var tp1Hit = false, tp2Hit = false, slHit = false;
  var barCount = 0;
  var lastBarTime = 0;

  const interval = setInterval(async function() {
    try {
      const c = await getCandles(sym, "5m", 2);
      if (c && c.length > 0) {
        const curBarTime = c[c.length - 1].time;
        if (lastBarTime !== 0 && curBarTime !== lastBarTime) barCount++;
        lastBarTime = curBarTime;
      }

      const d = await bGet("/fapi/v1/ticker/price", { symbol: sym });
      if (!d) return;
      const cur = parseFloat(d.price);

      if (dir === "long") {
        if (!tp1Hit && cur >= tp1) {
          tp1Hit = true;
          await tgSend("<b>TP1 HIT</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\n%60 kapat, SL girise cek (" + fmtPrice(entry) + ")");
        }
        if (!tp2Hit && cur >= tp2) {
          tp2Hit = true;
          await tgSend("<b>TP2 HIT</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\nPozisyonu tamamen kapat!");
          clearInterval(interval);
          return;
        }
        if (!slHit && cur <= sl) {
          slHit = true;
          await tgSend("<b>SL HIT</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\nPozisyon kapandi: " + fmtPrice(sl));
          clearInterval(interval);
          return;
        }
      } else {
        if (!tp1Hit && cur <= tp1) {
          tp1Hit = true;
          await tgSend("<b>TP1 HIT</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\n%60 kapat, SL girise cek (" + fmtPrice(entry) + ")");
        }
        if (!tp2Hit && cur <= tp2) {
          tp2Hit = true;
          await tgSend("<b>TP2 HIT</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\nPozisyonu tamamen kapat!");
          clearInterval(interval);
          return;
        }
        if (!slHit && cur >= sl) {
          slHit = true;
          await tgSend("<b>SL HIT</b> " + sym + "\nFiyat: " + fmtPrice(cur) + "\nPozisyon kapandi: " + fmtPrice(sl));
          clearInterval(interval);
          return;
        }
      }

      if (barCount >= MAX_BARS) {
        await tgSend("<b>VAKIT DOLDU</b> " + sym + " " + dir.toUpperCase() + "\n6 mum gecti, TP/SL vurulmadi.\nFiyat: " + fmtPrice(cur) + "\n<b>Pozisyonu manuel kapat!</b>");
        clearInterval(interval);
        return;
      }

      if (Date.now() - startTime > 60 * 60000) {
        clearInterval(interval);
      }

    } catch(e) {}
  }, 20000);
}

async function updateBtcTrend() {
  const c = await getCandles("BTCUSDT", "15m", 50);
  if (c) btcTrend15m = calcEMATrend(c, 9, 21);
}

async function main() {
  console.log("ScalpMaster v2.0 starting...");
  console.log("Symbols: " + SYMBOLS.join(", "));
  console.log("System: Triple Confirmation + Order Flow");

  await tgSend(
    "<b>ScalpMaster v2.0</b>\n\n" +
    "Sistem: Uclu Onay + Order Flow\n" +
    "Semboller: " + SYMBOLS.length + " coin\n" +
    "Confirmation: 1-Bar (5dk)\n" +
    "Max sure: 6 mum (30dk)\n" +
    "Kaldirac: 20x\n\n" +
    "<i>Basladi! Sinyal bekleniyor...</i>"
  );

  while (true) {
    const t0 = Date.now();
    try {
      await updateBtcTrend();
      await checkPendingConfirmations();
      for (const sym of SYMBOLS) {
        await scanSymbol(sym);
        await new Promise(r => setTimeout(r, 200));
      }
    } catch(e) {
      console.error("[MAIN ERR] " + e.message);
    }
    await new Promise(r => setTimeout(r, Math.max(0, SCAN_MS - (Date.now() - t0))));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
