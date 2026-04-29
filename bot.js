const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;
const COOLDOWN_MS = 5400000;

const MIN_SCORE = 7.6;
const MIN_RR = 2.3;

const OKX = "https://www.okx.com";

// 🔥 GENİŞ AMA TEMİZ LİSTE (~45 COIN)
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

console.log("🔥 V18.3 EXPANDED START");

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

// ===== SCORE =====
function scoreCalc({R,volRatio,trend,retest,momentum,clean}){
  let s=0;

  if(R>=3) s+=3;
  else if(R>=2.5) s+=2.5;
  else if(R>=2.3) s+=2;

  if(volRatio>=2) s+=2;
  else if(volRatio>=1.5) s+=1.5;
  else if(volRatio>=1.25) s+=1;

  if(trend) s+=2;
  if(retest) s+=1.5;
  if(momentum) s+=1;
  if(clean) s+=0.8;

  return Math.min(10,parseFloat(s.toFixed(1)));
}

// ===== FILTER =====
function cleanCandle(d,side){
  const x=d.at(-1);
  const range=Math.max(x.h-x.l,1e-9);
  const body=Math.abs(x.c-x.o);
  const upper=x.h-Math.max(x.c,x.o);
  const lower=Math.min(x.c,x.o)-x.l;

  if(body/range<0.25) return false;
  if(side==="LONG" && upper/range>0.45) return false;
  if(side==="SHORT" && lower/range>0.45) return false;

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

  const d5=await klines(sym,"5m");
  const d15=await klines(sym,"15m");

  if(!d5||!d15||d5.length<80) return null;

  const c=d5.map(x=>x.c);
  const v=d5.map(x=>x.v);

  const e20=ema(c,20);
  const e50=ema(c,50);

  const last=c.at(-1);
  const prev=c.at(-2);
  const prev2=c.at(-3);

  const volNow=v.at(-1);
  const volAvg=avg(v.slice(-20));
  const volRatio=volNow/volAvg;

  const atrVal=atr(d5);

  if(volRatio<1.25) return null;
  if((atrVal/last)*100<0.15) return null;

  const trendUp=e20.at(-1)>e50.at(-1);
  const trendDn=e20.at(-1)<e50.at(-1);

  const high=Math.max(...d5.slice(-12,-2).map(x=>x.h));
  const low=Math.min(...d5.slice(-12,-2).map(x=>x.l));

  // LONG
  if(trendUp && prev>high && last<=high*1.004 && last>e20.at(-1) && last>prev2){

    if(!cleanCandle(d5,"LONG")) return null;

    const entry=last;
    const swing=Math.min(...d5.slice(-10).map(x=>x.l));
    const atrStop=entry-atrVal*1.45;
    const stop=Math.min(swing,atrStop);

    const tp2=entry+(entry-stop)*2.5;
    const R=rr(entry,stop,tp2);

    if(R<MIN_RR) return null;

    const score=scoreCalc({
      R,volRatio,trend:true,retest:true,momentum:true,clean:true
    });

    if(score<MIN_SCORE) return null;
    if(isDuplicate(sym,"LONG")) return null;

    return {sym,side:"LONG",entry,stop,tp1:entry+(entry-stop)*1.1,tp2,rr:R,score};
  }

  // SHORT
  if(trendDn && prev<low && last>=low*0.996 && last<e20.at(-1) && last<prev2){

    if(!cleanCandle(d5,"SHORT")) return null;

    const entry=last;
    const swing=Math.max(...d5.slice(-10).map(x=>x.h));
    const atrStop=entry+atrVal*1.45;
    const stop=Math.max(swing,atrStop);

    const tp2=entry-(stop-entry)*2.5;
    const R=rr(entry,stop,tp2);

    if(R<MIN_RR) return null;

    const score=scoreCalc({
      R,volRatio,trend:true,retest:true,momentum:true,clean:true
    });

    if(score<MIN_SCORE) return null;
    if(isDuplicate(sym,"SHORT")) return null;

    return {sym,side:"SHORT",entry,stop,tp1:entry-(stop-entry)*1.1,tp2,rr:R,score};
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

  await send(`🚀 V18.3 EXPANDED

${best.sym} ${best.side}
Score: ${best.score}/10
RR: ${best.rr.toFixed(2)}

Entry: ${best.entry}
TP1: ${best.tp1}
TP2: ${best.tp2}
Stop: ${best.stop}`);

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
