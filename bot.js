const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;
const COOLDOWN_MS = 5400000;

const MIN_RR = 1.6;
const MIN_SCORE = 6.8;

const OKX = "https://www.okx.com";

const COINS = [
"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT",
"XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT",
"APTUSDT","ARBUSDT","OPUSDT","INJUSDT","SUIUSDT","SEIUSDT","NEARUSDT","ATOMUSDT"
];

const lastSignal = new Map();

console.log("🔥 V22 COMPRESSION BREAKOUT START");

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

async function klines(sym){
  const j = await fetchJson(`${OKX}/api/v5/market/candles?instId=${toOkx(sym)}&bar=5m&limit=120`);
  if(!j || j.code!=="0") return null;

  return j.data.reverse().map(x=>({
    o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]
  }));
}

// ===== INDICATORS =====
function avg(a){return a.reduce((x,y)=>x+y,0)/a.length;}

function std(a){
  const m=avg(a);
  return Math.sqrt(avg(a.map(x=>(x-m)**2)));
}

function bb(c){
  const slice=c.slice(-20);
  const mid=avg(slice);
  const dev=std(slice);
  return {
    upper: mid + dev*2,
    lower: mid - dev*2,
    width: (dev*2)/mid
  };
}

function rr(e,s,tp){
  return Math.abs(tp-e)/Math.abs(e-s);
}

function fmt(n){
  return Number(n).toFixed(4);
}

// ===== FILTER =====
function strongCandle(d,side){
  const x=d.at(-1);
  const range=x.h-x.l;
  const body=Math.abs(x.c-x.o);

  if(body/range < 0.5) return false;

  if(side==="LONG" && x.c<=x.o) return false;
  if(side==="SHORT" && x.c>=x.o) return false;

  return true;
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

  const d=await klines(sym);
  if(!d || d.length<50) return null;

  const c=d.map(x=>x.c);
  const last=c.at(-1);
  const prev=c.at(-2);

  const band=bb(c);

  // 🔥 SIKIŞMA ŞARTI
  if(band.width > 0.015) return null;

  const volNow=d.at(-1).v;
  const volAvg=avg(d.map(x=>x.v).slice(-20));
  const volRatio=volNow/volAvg;

  if(volRatio < 1.5) return null;

  // ===== LONG =====
  if(last > band.upper && prev <= band.upper && strongCandle(d,"LONG")){

    const entry=last;
    const stop=Math.min(...d.slice(-8).map(x=>x.l));
    const tp2=entry+(entry-stop)*1.8;

    const R=rr(entry,stop,tp2);
    if(R < MIN_RR) return null;
    if(isDuplicate(sym,"LONG")) return null;

    return {
      sym,side:"LONG",
      entry,stop,
      tp1:entry+(entry-stop)*0.8,
      tp2,
      rr:R,
      score:Math.min(10,(volRatio*2)+(R))
    };
  }

  // ===== SHORT =====
  if(last < band.lower && prev >= band.lower && strongCandle(d,"SHORT")){

    const entry=last;
    const stop=Math.max(...d.slice(-8).map(x=>x.h));
    const tp2=entry-(stop-entry)*1.8;

    const R=rr(entry,stop,tp2);
    if(R < MIN_RR) return null;
    if(isDuplicate(sym,"SHORT")) return null;

    return {
      sym,side:"SHORT",
      entry,stop,
      tp1:entry-(stop-entry)*0.8,
      tp2,
      rr:R,
      score:Math.min(10,(volRatio*2)+(R))
    };
  }

  return null;
}

// ===== MAIN =====
async function run(){

  let best=null;

  for(const s of COINS){

    const sig=await scan(s);
    if(!sig) continue;

    if(!best || sig.score>best.score) best=sig;
  }

  if(!best){
    console.log("NO SIGNAL");
    return;
  }

  await send(`🚀 V22 COMPRESSION SIGNAL

${best.sym} ${best.side}
Güven: ${best.score.toFixed(1)}/10
RR: ${best.rr.toFixed(2)}

Entry: ${fmt(best.entry)}
TP1: ${fmt(best.tp1)}
TP2: ${fmt(best.tp2)}
Stop: ${fmt(best.stop)}

Logic: Volatility squeeze → breakout`);

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
