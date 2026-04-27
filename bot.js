const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const TREND_TF = process.env.TREND_TF || "15m";
const HTF = process.env.HTF || "1h";

const MIN_SCORE_SNIPER = parseFloat(process.env.MIN_SCORE_SNIPER || "7.0");
const MIN_SCORE_TREND = parseFloat(process.env.MIN_SCORE_TREND || "6.0");

const MIN_RR_SNIPER = parseFloat(process.env.MIN_RR_SNIPER || "1.8");
const MIN_RR_TREND = parseFloat(process.env.MIN_RR_TREND || "1.5");

const LOOP_MS = parseInt(process.env.LOOP_MS || "90000", 10);
const DUPLICATE_TTL_MS = parseInt(process.env.DUPLICATE_TTL_MS || "2700000", 10);

const BASE_URLS = [
  "https://fapi.binance.com",
];

const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

const lastSignalAt = new Map();
let activeTrade = null;

console.log("🔥 V10 BALANCED + DEBUG START");
console.log("COIN COUNT:", COINS.length);

async function fetchJson(path) {
  try {
    const res = await fetch(BASE_URLS[0] + path);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchKlines(symbol, tf) {
  return await fetchJson(`/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=120`);
}

function closes(k) { return k.map(x => parseFloat(x[4])); }

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0];
  return values.map(v => prev = v * k + prev * (1 - k));
}

function avg(arr) {
  return arr.reduce((a,b)=>a+b,0)/arr.length;
}

function rr(entry, stop, tp) {
  return Math.abs(tp-entry)/Math.abs(entry-stop);
}

function clampScore(n){
  return Math.max(0, Math.min(10,n));
}

async function checkSniper(symbol) {
  const data = await fetchKlines(symbol, ENTRY_TF);
  if (!data) return null;

  const c = closes(data);
  const e20 = ema(c,20);

  const last = c.at(-1);
  const prev = c.at(-2);

  const move = Math.abs((last-prev)/prev*100);

  if (move < 0.25) return null;

  let score = move * 10;

  score = clampScore(score);

  if (score < MIN_SCORE_SNIPER) return null;

  const stop = prev;
  const tp = last + (last - stop) * 2;

  const r = rr(last, stop, tp);
  if (r < MIN_RR_SNIPER) return null;

  return {
    mode: "SNIPER",
    coin: symbol,
    side: last > prev ? "LONG" : "SHORT",
    score,
    entry: last,
    stop,
    tp,
    rr: r
  };
}

async function checkTrend(symbol) {
  const data = await fetchKlines(symbol, TREND_TF);
  if (!data) return null;

  const c = closes(data);
  const e20 = ema(c,20);
  const e50 = ema(c,50);

  const trendUp = e20.at(-1) > e50.at(-1);
  const trendDown = e20.at(-1) < e50.at(-1);

  let score = 0;

  if (trendUp || trendDown) score += 6;

  score = clampScore(score);

  if (score < MIN_SCORE_TREND) return null;

  const last = c.at(-1);
  const stop = c.at(-2);
  const tp = last + (last - stop) * 1.8;

  const r = rr(last, stop, tp);
  if (r < MIN_RR_TREND) return null;

  return {
    mode: "TREND",
    coin: symbol,
    side: trendUp ? "LONG" : "SHORT",
    score,
    entry: last,
    stop,
    tp,
    rr: r
  };
}

function shouldSkipDuplicate(key) {
  const t = lastSignalAt.get(key);
  return t && Date.now() - t < DUPLICATE_TTL_MS;
}

function markSignal(key){
  lastSignalAt.set(key, Date.now());
}

async function sendTelegram(msg){
  if (!TG_TOKEN || !CHAT_ID) return;

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{ "Content-Type":"application/json"},
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg
    })
  });
}

function formatSignal(s){
  return `🔥 ${s.mode}

${s.coin} ${s.side}
Score: ${s.score.toFixed(1)}

Entry: ${s.entry}
Stop: ${s.stop}
TP: ${s.tp}
RR: ${s.rr.toFixed(2)}`;
}

async function run(){

  console.log("RUN");

  let debug = {
    checked: 0,
    sniperPassed: 0,
    trendPassed: 0
  };

  let best = null;

  for (const coin of COINS){

    debug.checked++;

    const s = await checkSniper(coin);
    if (s){
      debug.sniperPassed++;
      if (!best || s.score > best.score) best = s;
    }

    const t = await checkTrend(coin);
    if (t){
      debug.trendPassed++;
      if (!best || t.score > best.score) best = t;
    }
  }

  console.log("DEBUG:", debug);

  if (!best){
    console.log("NO SIGNAL");
    return;
  }

  const key = `${best.mode}-${best.coin}-${best.side}`;
  if (shouldSkipDuplicate(key)){
    console.log("DUPLICATE");
    return;
  }

  markSignal(key);

  console.log("SIGNAL:", best.coin);

  await sendTelegram(formatSignal(best));
}

async function main(){

  if (!COINS.length){
    console.log("COIN LIST EMPTY");
    return;
  }

  while(true){
    try{
      await run();
    }catch(e){
      console.log("ERROR:", e.message);
    }

    await new Promise(r=>setTimeout(r, LOOP_MS));
  }
}

main();
