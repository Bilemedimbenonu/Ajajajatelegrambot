const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;
const COOLDOWN_MS = 5400000;

const MIN_SCORE = 7.8;
const MIN_RR = 2.4;

const OKX = "https://www.okx.com";

const COINS = [
"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT",
"XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT",
"ATOMUSDT","NEARUSDT","FILUSDT","APTUSDT","ARBUSDT","OPUSDT","INJUSDT",
"SUIUSDT","SEIUSDT","FTMUSDT","MATICUSDT","ALGOUSDT","ICPUSDT",
"ETCUSDT","AAVEUSDT","UNIUSDT","XLMUSDT","EOSUSDT","TRXUSDT",
"SNXUSDT","RUNEUSDT","GRTUSDT","KAVAUSDT","FLOWUSDT",
"AXSUSDT","CHZUSDT","CRVUSDT","DYDXUSDT","GMXUSDT",
"LDOUSDT","STXUSDT","IMXUSDT","ENSUSDT","ZILUSDT"
];

const lastSignal = new Map();

console.log("🔥 V18.4 REACTION MODE START");

// ===== FETCH =====
async function fetchJson(url){
  try{
    const r = await fetch(url);
    if(!r.ok) return null;
    return await r.json();
  }catch{return null;}
}

function toOkx(sym){
  return sym.replace("USDT","-USDT-SWAP");
}

async function klines(sym, tf="5m"){
  const j = await fetchJson(`${OKX}/api/v5/market/candles?instId=${toOkx(sym)}&bar=${tf}&limit=120`);
  if(!j || j.code!=="0") return null;

  return j.data.reverse().map(x=>({
    o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]
  }));
}

// ===== INDICATORS =====
function ema(a,p){
  const k=2/(p+1); let e=a[0];
  return a.map(v=>e=v*k+e*(1-k));
}
function avg(a){return a.reduce((x,y)=>x+y,0)/a.length;}
function atr(d){
  let r=[];
  for(let i=1;i<d.length;i++){
    r.push(Math.max(
      d[i].h-d[i].l,
      Math.abs(d[i].h-d[i-1].c),
      Math.abs(d[i].l-d[i-1].c)
    ));
  }
  return avg(r.slice(-14));
}
function rr(e,s,tp){
  return Math.abs(tp-e)/Math.abs(e-s);
}

// ===== CLEAN CANDLE =====
function strongBullish(d){
  const x=d.at(-1);
  const body=Math.abs(x.c-x.o);
  const range=x.h-x.l;
  return x.c>x.o && body/range>0.4;
}

function strongBearish(d){
  const x=d.at(-1);
  const body=Math.abs(x.c-x.o);
  const range=x.h-x.l;
  return x.c<x.o && body/range>0.4;
}

// ===== DUP =====
function isDuplicate(sym,side){
  const key=sym+side;
  if(!lastSignal.has(key)) return false;
  return Date.now()-lastSignal.get(key)<COOLDOWN_MS;
}
function mark(sym,side){
  lastSignal.set(sym+side,Date.now());
}

// ===== TELEGRAM =====
async function send(msg){
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:CHAT_ID,text:msg})
  });
}

// ===== SCAN =====
async function scan(sym){

  const d5=await klines(sym,"5m");
  if(!d5||d5.length<80) return null;

  const c=d5.map(x=>x.c);
  const v=d5.map(x=>x.v);

  const e20=ema(c,20);
  const e50=ema(c,50);

  const last=c.at(-1);
  const prev=c.at(-2);
  const prev2=c.at(-3);

  const atrVal=atr(d5);

  const volNow=v.at(-1);
  const volAvg=avg(v.slice(-20));
  const volRatio=volNow/volAvg;

  if(volRatio<1.3) return null;
  if((atrVal/last)*100<0.18) return null;

  const trendUp=e20.at(-1)>e50.at(-1);
  const trendDn=e20.at(-1)<e50.at(-1);

  const high=Math.max(...d5.slice(-12,-2).map(x=>x.h));
  const low=Math.min(...d5.slice(-12,-2).map(x=>x.l));

  // ===== LONG =====
  if(
    trendUp &&
    prev>high &&                     // breakout
    last<high &&                    // retest
    last>e20.at(-1) &&
    strongBullish(d5) &&            // 🔥 REACTION
    prev2<prev                      // momentum
  ){

    const entry=last;
    const swing=Math.min(...d5.slice(-10).map(x=>x.l));
    const stop=Math.min(swing, entry-atrVal*1.5);

    const tp2=entry+(entry-stop)*2.6;
    const R=rr(entry,stop,tp2);

    if(R<MIN_RR) return null;
    if(isDuplicate(sym,"LONG")) return null;

    return {sym,side:"LONG",entry,stop,tp1:entry+(entry-stop)*1.2,tp2,rr:R};
  }

  // ===== SHORT =====
  if(
    trendDn &&
    prev<low &&
    last>low &&
    last<e20.at(-1) &&
    strongBearish(d5) &&           // 🔥 REACTION
    prev2>prev
  ){

    const entry=last;
    const swing=Math.max(...d5.slice(-10).map(x=>x.h));
    const stop=Math.max(swing, entry+atrVal*1.5);

    const tp2=entry-(stop-entry)*2.6;
    const R=rr(entry,stop,tp2);

    if(R<MIN_RR) return null;
    if(isDuplicate(sym,"SHORT")) return null;

    return {sym,side:"SHORT",entry,stop,tp1:entry-(stop-entry)*1.2,tp2,rr:R};
  }

  return null;
}

// ===== MAIN =====
async function run(){

  let best=null;

  for(const s of COINS){

    const sig=await scan(s);
    if(!sig) continue;

    if(!best || sig.rr>best.rr) best=sig;
  }

  if(!best){
    console.log("NO SIGNAL");
    return;
  }

  await send(`🚀 V18.4 REACTION SIGNAL

${best.sym} ${best.side}
RR: ${best.rr.toFixed(2)}

Entry: ${best.entry}
TP1: ${best.tp1}
TP2: ${best.tp2}
Stop: ${best.stop}

Logic: Retest + Reaction Candle`);

  mark(best.sym,best.side);
}

// ===== LOOP =====
(async()=>{
  while(true){
    try{ await run(); }
    catch(e){ console.log("ERR",e.message); }

    await new Promise(r=>setTimeout(r,LOOP_MS));
  }
})();
