const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;
const COOLDOWN_MS = 5400000;

const MIN_SCORE = 8;
const MIN_RR = 2.5;

const COINS = [
"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT",
"XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","MATICUSDT","DOTUSDT","LTCUSDT",
"APTUSDT","OPUSDT","ARBUSDT","INJUSDT","SUIUSDT","SEIUSDT","FTMUSDT","NEARUSDT","ATOMUSDT","FILUSDT"
];

const OKX = "https://www.okx.com";

const lastSignal = new Map();

console.log("🔥 V18 RETEST MODE START");

// ================= HELPERS =================
async function fetchJson(url){
  try{
    const r = await fetch(url);
    if(!r.ok) return null;
    return await r.json();
  }catch{
    return null;
  }
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

// ================= INDICATORS =================
function ema(arr,p){
  const k=2/(p+1);
  let e=arr[0];
  return arr.map(v=>e=v*k+e*(1-k));
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

// ================= SCORE =================
function scoreCalc({R,volRatio,trend,momentum}){
  let s=0;

  if(R>=3) s+=3;
  else if(R>=2.5) s+=2.5;

  if(volRatio>=2) s+=2;
  else if(volRatio>=1.5) s+=1.5;

  if(trend) s+=2;
  if(momentum) s+=1.5;

  s+=1;

  return Math.min(10,parseFloat(s.toFixed(1)));
}

// ================= DUPLICATE =================
function isDuplicate(sym,side){
  const key=sym+side;
  if(!lastSignal.has(key)) return false;

  return Date.now()-lastSignal.get(key)<COOLDOWN_MS;
}

function mark(sym,side){
  lastSignal.set(sym+side,Date.now());
}

// ================= SCAN =================
async function scan(sym){

  const d5=await klines(sym,"5m");
  const d15=await klines(sym,"15m");

  if(!d5||!d15||d5.length<80) return null;

  const c=d5.map(x=>x.c);
  const v=d5.map(x=>x.v);

  const e20=ema(c,20);
  const e50=ema(c,50);

  const last=c.at(-1);
  const prev=c.at(-2);

  const volNow=v.at(-1);
  const volAvg=avg(v.slice(-20));
  const volRatio=volNow/volAvg;

  const atrVal=atr(d5);

  if(volRatio<1.4) return null;
  if((atrVal/last)*100<0.2) return null;

  const trendUp=e20.at(-1)>e50.at(-1);
  const trendDn=e20.at(-1)<e50.at(-1);

  // ================= RETEST LOGIC =================

  const high=Math.max(...d5.slice(-10).map(x=>x.h));
  const low=Math.min(...d5.slice(-10).map(x=>x.l));

  // LONG RETEST
  if(trendUp && prev>high && last<high && last>e20.at(-1)){

    const entry=last;
    const stop=Math.min(...d5.slice(-10).map(x=>x.l));

    const tp2=entry+(entry-stop)*2.6;
    const R=rr(entry,stop,tp2);

    if(R<MIN_RR) return null;

    const score=scoreCalc({
      R,
      volRatio,
      trend:true,
      momentum:true
    });

    if(score<MIN_SCORE) return null;

    if(isDuplicate(sym,"LONG")) return null;

    return {
      symbol:sym,
      side:"LONG",
      entry,
      stop,
      tp1:entry+(entry-stop)*1.2,
      tp2,
      rr:R,
      score
    };
  }

  // SHORT RETEST
  if(trendDn && prev<low && last>low && last<e20.at(-1)){

    const entry=last;
    const stop=Math.max(...d5.slice(-10).map(x=>x.h));

    const tp2=entry-(stop-entry)*2.6;
    const R=rr(entry,stop,tp2);

    if(R<MIN_RR) return null;

    const score=scoreCalc({
      R,
      volRatio,
      trend:true,
      momentum:true
    });

    if(score<MIN_SCORE) return null;

    if(isDuplicate(sym,"SHORT")) return null;

    return {
      symbol:sym,
      side:"SHORT",
      entry,
      stop,
      tp1:entry-(stop-entry)*1.2,
      tp2,
      rr:R,
      score
    };
  }

  return null;
}

// ================= TELEGRAM =================
async function send(msg){
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:CHAT_ID,text:msg})
  });
}

// ================= MAIN =================
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

  await send(`🚀 V18 RETEST SIGNAL

${best.symbol} ${best.side}
Score: ${best.score}/10
RR: ${best.rr.toFixed(2)}

Entry: ${best.entry}
TP1: ${best.tp1}
TP2: ${best.tp2}
Stop: ${best.stop}

Logic: Breakout → Retest`);

  mark(best.symbol,best.side);
}

// ================= LOOP =================
(async()=>{
  while(true){
    try{ await run(); }
    catch(e){ console.log("ERR",e.message); }

    await new Promise(r=>setTimeout(r,LOOP_MS));
  }
})();
