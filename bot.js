const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const TREND_TF = process.env.TREND_TF || "15m";
const HTF = process.env.HTF || "1h";

const MIN_SCORE_SNIPER = parseFloat(process.env.MIN_SCORE_SNIPER || "6.5");
const MIN_SCORE_TREND = parseFloat(process.env.MIN_SCORE_TREND || "5.5");

const MIN_RR_SNIPER = parseFloat(process.env.MIN_RR_SNIPER || "1.8");
const MIN_RR_TREND = parseFloat(process.env.MIN_RR_TREND || "1.5");

const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);
const DUPLICATE_TTL_MS = parseInt(process.env.DUPLICATE_TTL_MS || "1800000", 10);

const BASE_URL = "https://fapi.binance.com";

const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

let activeTrade = null;
const lastSignalAt = new Map();

console.log("V9 BALANCED BOT STARTED");
console.log("COIN COUNT:", COINS.length);

// ===== HELPERS =====
async function fetchJson(path) {
  try {
    const res = await fetch(BASE_URL + path);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchKlines(symbol, interval, limit = 100) {
  return await fetchJson(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
}

async function fetchPrice(symbol) {
  const d = await fetchJson(`/fapi/v1/ticker/price?symbol=${symbol}`);
  return d ? parseFloat(d.price) : null;
}

const closes = d => d.map(x => parseFloat(x[4]));
const highs = d => d.map(x => parseFloat(x[2]));
const lows = d => d.map(x => parseFloat(x[3]));
const volumes = d => d.map(x => parseFloat(x[5]));

function ema(arr, p) {
  const k = 2/(p+1);
  let e = arr[0];
  return arr.map(v => (e = v*k + e*(1-k)));
}

function avg(a){ return a.reduce((x,y)=>x+y,0)/a.length }

function rr(e,s,tp){ return Math.abs(tp-e)/Math.abs(e-s) }

function send(msg){
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{ "Content-Type":"application/json"},
    body:JSON.stringify({chat_id:CHAT_ID,text:msg})
  })
}

// ===== SNIPER (gevşetildi) =====
async function checkSniper(symbol){
  const d = await fetchKlines(symbol, ENTRY_TF);
  if(!d) return null;

  const c = closes(d);
  const h = highs(d);
  const l = lows(d);
  const v = volumes(d);

  const ema20 = ema(c,20);

  const last = c.at(-1);
  const prev = c.at(-2);

  const avgVol = avg(v.slice(-20));
  const volSpike = v.at(-1) > avgVol * 1.1; // gevşetildi

  const nearEMA = Math.abs(last - ema20.at(-1))/last < 0.01; // gevşetildi

  const breakoutHigh = Math.max(...h.slice(-10));
  const breakoutLow = Math.min(...l.slice(-10));

  let score = 0;

  if(last > breakoutHigh) score += 3;
  if(last < breakoutLow) score += 3;

  if(volSpike) score += 1.5;
  if(nearEMA) score += 1;

  if(Math.abs(last-prev)/last > 0.002) score += 1.5;

  if(score < MIN_SCORE_SNIPER) return null;

  const side = last > breakoutHigh ? "LONG" : "SHORT";

  const stop = side==="LONG" ? last*0.99 : last*1.01;
  const tp2 = side==="LONG" ? last*1.02 : last*0.98;

  if(rr(last,stop,tp2) < MIN_RR_SNIPER) return null;

  return {mode:"SNIPER",coin:symbol,side,score,entry:last,stop,tp2};
}

// ===== TREND (aktif edildi) =====
async function checkTrend(symbol){
  const d = await fetchKlines(symbol, TREND_TF);
  if(!d) return null;

  const c = closes(d);
  const ema20 = ema(c,20);
  const ema50 = ema(c,50);

  const last = c.at(-1);

  let score = 0;

  if(ema20.at(-1) > ema50.at(-1)) score += 3;
  if(ema20.at(-1) < ema50.at(-1)) score += 3;

  if(Math.abs(c.at(-1)-c.at(-5))/last > 0.005) score += 2;

  if(score < MIN_SCORE_TREND) return null;

  const side = ema20.at(-1) > ema50.at(-1) ? "LONG" : "SHORT";

  const stop = side==="LONG" ? last*0.995 : last*1.005;
  const tp2 = side==="LONG" ? last*1.015 : last*0.985;

  if(rr(last,stop,tp2) < MIN_RR_TREND) return null;

  return {mode:"TREND",coin:symbol,side,score,entry:last,stop,tp2};
}

// ===== MAIN =====
async function run(){

  if(activeTrade) return;

  let best = null;

  for(const coin of COINS){

    const s = await checkSniper(coin);
    if(s && (!best || s.score > best.score)){
      best = s;
      continue;
    }

    const t = await checkTrend(coin);
    if(!best && t && (!best || t.score > best.score)){
      best = t;
    }
  }

  if(!best){
    console.log("NO SIGNAL");
    return;
  }

  console.log("SIGNAL:", best);

  await send(`🔥 ${best.mode}
${best.coin} ${best.side}
Score: ${best.score}
Entry: ${best.entry}`);

  activeTrade = best;
}

async function main(){
  if(!TG_TOKEN || !CHAT_ID || !COINS.length){
    console.log("ENV ERROR");
    return;
  }

  while(true){
    try{
      await run();
    }catch(e){
      console.log(e);
    }
    await new Promise(r=>setTimeout(r,LOOP_MS));
  }
}

main();
