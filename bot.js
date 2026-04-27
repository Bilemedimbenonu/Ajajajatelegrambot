const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);

const MIN_SCORE = 4.5;
const MIN_RR = 1.3;

const BASE = "https://fapi.binance.com";

const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

let activeTrade = null;

console.log("🔥 V10 BALANCED START");
console.log("COIN COUNT:", COINS.length);

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function klines(symbol) {
  return await fetchJson(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${ENTRY_TF}&limit=120`);
}

function closes(d){return d.map(x=>+x[4]);}
function highs(d){return d.map(x=>+x[2]);}
function lows(d){return d.map(x=>+x[3]);}
function volumes(d){return d.map(x=>+x[5]);}

function ema(a,p){
  let k=2/(p+1),e=a[0];
  return a.map(v=>e=v*k+e*(1-k));
}

function avg(a){return a.reduce((x,y)=>x+y,0)/a.length;}

function rr(e,s,tp){return Math.abs(tp-e)/Math.abs(e-s);}

function fmt(n){return n.toFixed(4);}

async function send(msg){
  if(!TG_TOKEN||!CHAT_ID)return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:CHAT_ID,text:msg})
  });
}

async function scan(symbol){
  const d = await klines(symbol);
  if(!d) return null;

  const c=closes(d),h=highs(d),l=lows(d),v=volumes(d);
  const last=c.at(-1);

  const breakoutHigh = Math.max(...h.slice(-11,-1));
  const breakoutLow  = Math.min(...l.slice(-11,-1));

  const ema20 = ema(c,20).at(-1);

  const volNow = v.at(-1);
  const volAvg = avg(v.slice(-20,-1));

  let longScore=0, shortScore=0;

  // 🔥 breakout (gevşetildi)
  if(last > breakoutHigh*0.998) longScore+=2.5;
  if(last < breakoutLow*1.002) shortScore+=2.5;

  // 🔥 volume (gevşetildi)
  if(volNow > volAvg*1.05){
    longScore+=1.5;
    shortScore+=1.5;
  }

  // 🔥 EMA yakınlık
  if(Math.abs(last-ema20)/last < 0.015){
    longScore+=1;
    shortScore+=1;
  }

  // 🔥 mini momentum
  if(c.at(-1) > c.at(-3)) longScore+=0.5;
  if(c.at(-1) < c.at(-3)) shortScore+=0.5;

  // DEBUG
  if(longScore>2 || shortScore>2){
    console.log(symbol,"SCORE",longScore,shortScore);
  }

  if(longScore>=MIN_SCORE){
    const stop = breakoutLow;
    const tp = last + (last-stop)*1.5;

    if(rr(last,stop,tp)<MIN_RR) return null;

    return {coin:symbol,side:"LONG",entry:last,stop,tp,score:longScore};
  }

  if(shortScore>=MIN_SCORE){
    const stop = breakoutHigh;
    const tp = last - (stop-last)*1.5;

    if(rr(last,stop,tp)<MIN_RR) return null;

    return {coin:symbol,side:"SHORT",entry:last,stop,tp,score:shortScore};
  }

  return null;
}

async function run(){
  console.log("RUN");

  if(!COINS.length){
    console.log("COIN EMPTY");
    return;
  }

  if(activeTrade){
    console.log("WAIT ACTIVE");
    return;
  }

  let best=null;

  for(const coin of COINS){
    const s = await scan(coin);
    if(s && (!best || s.score>best.score)){
      best=s;
    }
  }

  if(!best){
    console.log("NO SIGNAL");
    return;
  }

  console.log("SIGNAL",best.coin,best.side);

  await send(`🔥 SIGNAL

${best.coin} ${best.side}
Entry: ${fmt(best.entry)}
Stop: ${fmt(best.stop)}
TP: ${fmt(best.tp)}
Score: ${best.score}`);

  activeTrade=best;
}

async function main(){
  while(true){
    try{await run();}catch(e){console.log(e);}
    await new Promise(r=>setTimeout(r,LOOP_MS));
  }
}

main();
