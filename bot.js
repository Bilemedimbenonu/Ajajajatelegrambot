const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const TREND_TF = process.env.TREND_TF || "15m";
const HTF = process.env.HTF || "1h";

const MIN_SCORE_SNIPER = parseFloat(process.env.MIN_SCORE_SNIPER || "6.5");
const MIN_SCORE_TREND = parseFloat(process.env.MIN_SCORE_TREND || "5.5");

const MIN_RR_SNIPER = parseFloat(process.env.MIN_RR_SNIPER || "1.7");
const MIN_RR_TREND = parseFloat(process.env.MIN_RR_TREND || "1.4");

const LOOP_MS = parseInt(process.env.LOOP_MS || "90000", 10);
const DUPLICATE_TTL_MS = parseInt(process.env.DUPLICATE_TTL_MS || "2700000", 10);

const BASE_URLS = [
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com"
];

const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

const lastSignalAt = new Map();
const badSymbols = new Set();

let activeTrade = null;

console.log("V8 BALANCED BOT STARTED");
console.log("COIN COUNT:", COINS.length);

async function fetchJson(path) {
  for (const base of BASE_URLS) {
    try {
      const res = await fetch(base + path);
      if (!res.ok) continue;
      return await res.json();
    } catch {}
  }
  return null;
}

async function fetchKlines(symbol, tf) {
  if (badSymbols.has(symbol)) return null;
  const data = await fetchJson(`/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=120`);
  if (!Array.isArray(data)) {
    badSymbols.add(symbol);
    return null;
  }
  return data;
}

function closes(d){return d.map(x=>+x[4])}
function highs(d){return d.map(x=>+x[2])}
function lows(d){return d.map(x=>+x[3])}
function volumes(d){return d.map(x=>+x[5])}

function ema(v,p){
  let k=2/(p+1),r=[v[0]];
  for(let i=1;i<v.length;i++) r.push(v[i]*k+r[i-1]*(1-k));
  return r;
}

function avg(a){return a.reduce((x,y)=>x+y,0)/a.length}

function rr(e,s,tp){return Math.abs(tp-e)/Math.abs(e-s)}

function clamp(n){return Math.max(0,Math.min(10,n))}

function dup(k){
  return lastSignalAt.get(k) && Date.now()-lastSignalAt.get(k)<DUPLICATE_TTL_MS
}

function mark(k){lastSignalAt.set(k,Date.now())}

async function checkSniper(sym){
  const d = await fetchKlines(sym, ENTRY_TF);
  if(!d) return null;

  const c = closes(d);
  const h = highs(d);
  const l = lows(d);
  const v = volumes(d);

  const ema20 = ema(c,20);
  const last = c.at(-1);
  const prev = c.at(-2);

  const avgVol = avg(v.slice(-20,-1));
  const volNow = v.at(-1);

  // 🔥 DENGELENMIS VOLUME
  if(volNow < avgVol * 1.12) return null;

  let score = 0;

  if(last > ema20.at(-1)) score += 2;
  if(prev < ema20.at(-2) && last > ema20.at(-1)) score += 2;

  const range = Math.max(...h.slice(-10)) - Math.min(...l.slice(-10));
  if(range > 0) score += 1;

  score = clamp(score);

  if(score < MIN_SCORE_SNIPER) return null;

  const entry = last;
  const stop = Math.min(...l.slice(-5));
  const tp2 = entry + (entry - stop) * 1.8;

  const R = rr(entry, stop, tp2);
  if(R < MIN_RR_SNIPER) return null;

  return {
    mode:"SNIPER",
    coin:sym,
    side:"LONG",
    score,
    entry,
    stop,
    tp2,
    rr:R
  };
}

async function checkTrend(sym){
  const d = await fetchKlines(sym, ENTRY_TF);
  if(!d) return null;

  const c = closes(d);
  const v = volumes(d);

  const last = c.at(-1);
  const prev = c.at(-5);

  const avgVol = avg(v.slice(-20,-1));
  const volNow = v.at(-1);

  // 🔥 DENGELENMIS VOLUME
  if(volNow < avgVol * 1.15) return null;

  let score = 0;

  if(last > prev) score += 2;
  if(last > c.at(-2)) score += 1;

  score = clamp(score);

  if(score < MIN_SCORE_TREND) return null;

  const entry = last;
  const stop = Math.min(...c.slice(-5));
  const tp2 = entry + (entry - stop) * 1.5;

  const R = rr(entry, stop, tp2);
  if(R < MIN_RR_TREND) return null;

  return {
    mode:"TREND",
    coin:sym,
    side:"LONG",
    score,
    entry,
    stop,
    tp2,
    rr:R
  };
}

async function send(msg){
  if(!TG_TOKEN || !CHAT_ID) return;

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:CHAT_ID,text:msg})
  });
}

function fmt(s){
  return `🔥 ${s.mode}

${s.coin}
Score: ${s.score}/10
RR: ${s.rr.toFixed(2)}

Entry: ${s.entry}
Stop: ${s.stop}
TP: ${s.tp2}`;
}

async function run(){
  console.log("RUN");

  if(activeTrade){
    console.log("ACTIVE TRADE VAR");
    return;
  }

  let bestSniper=null,bestTrend=null;

  for(const c of COINS){
    const s = await checkSniper(c);
    if(s && (!bestSniper || s.score>bestSniper.score)) bestSniper=s;

    const t = await checkTrend(c);
    if(t && (!bestTrend || t.score>bestTrend.score)) bestTrend=t;
  }

  console.log("SNIPER:",bestSniper?bestSniper.coin:"NONE");
  console.log("TREND:",bestTrend?bestTrend.coin:"NONE");

  const best = bestSniper || bestTrend;
  if(!best){
    console.log("NO SIGNAL");
    return;
  }

  const key = best.coin+best.mode;
  if(dup(key)) return;

  mark(key);

  await send(fmt(best));

  activeTrade = best;
}

async function main(){
  if(!TG_TOKEN || !CHAT_ID || !COINS.length){
    console.log("ENV ERROR");
    process.exit(1);
  }

  while(true){
    try{await run()}catch(e){console.log(e)}
    await new Promise(r=>setTimeout(r,LOOP_MS));
  }
}

main();
