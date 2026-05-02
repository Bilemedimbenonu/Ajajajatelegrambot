const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;
const COOLDOWN_MS = 5400000;

const MIN_RR = 2.2;

const OKX = "https://www.okx.com";

const COINS = [
"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT",
"XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT",
"ATOMUSDT","NEARUSDT","FILUSDT","APTUSDT","ARBUSDT","OPUSDT","INJUSDT",
"SUIUSDT","SEIUSDT","MATICUSDT","ICPUSDT","AAVEUSDT","UNIUSDT","TRXUSDT"
];

const lastSignal = new Map();

console.log("🔥 V19 TREND SYSTEM START");

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
function sma(arr,p){
  let res=[];
  for(let i=0;i<arr.length;i++){
    if(i<p) res.push(arr[i]);
    else res.push(arr.slice(i-p,i).reduce((a,b)=>a+b,0)/p);
  }
  return res;
}

function std(arr,p){
  let res=[];
  for(let i=0;i<arr.length;i++){
    if(i<p) res.push(0);
    else{
      let slice=arr.slice(i-p,i);
      let m=slice.reduce((a,b)=>a+b,0)/p;
      let v=slice.reduce((a,b)=>a+(b-m)**2,0)/p;
      res.push(Math.sqrt(v));
    }
  }
  return res;
}

function bollinger(c){
  const mid=sma(c,20);
  const sd=std(c,20);
  const upper=mid.map((m,i)=>m+sd[i]*2);
  const lower=mid.map((m,i)=>m-sd[i]*2);
  return {mid,upper,lower};
}

function vwap(d){
  let cumVol=0, cumPV=0;
  return d.map(x=>{
    cumVol+=x.v;
    cumPV+=x.c*x.v;
    return cumPV/cumVol;
  });
}

// ADX basit versiyon
function adx(d){
  let tr=[],dmPlus=[],dmMinus=[];
  for(let i=1;i<d.length;i++){
    let up=d[i].h-d[i-1].h;
    let down=d[i-1].l-d[i].l;

    dmPlus.push(up>down && up>0?up:0);
    dmMinus.push(down>up && down>0?down:0);

    tr.push(Math.max(
      d[i].h-d[i].l,
      Math.abs(d[i].h-d[i-1].c),
      Math.abs(d[i].l-d[i-1].c)
    ));
  }

  const atr = tr.slice(-14).reduce((a,b)=>a+b,0)/14;
  const pDI = dmPlus.slice(-14).reduce((a,b)=>a+b,0)/atr;
  const mDI = dmMinus.slice(-14).reduce((a,b)=>a+b,0)/atr;

  const dx = Math.abs(pDI-mDI)/(pDI+mDI)*100;
  return dx;
}

function rr(e,s,tp){
  return Math.abs(tp-e)/Math.abs(e-s);
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

  const d=await klines(sym,"5m");
  if(!d||d.length<80) return null;

  const c=d.map(x=>x.c);

  const bb=bollinger(c);
  const vw=vwap(d);

  const last=c.at(-1);
  const prev=c.at(-2);

  const adxVal=adx(d);

  // 🚫 TREND YOKSA TRADE YOK
  if(adxVal<20) return null;

  // ===== LONG =====
  if(
    last>bb.upper.at(-1) &&   // BB breakout
    last>vw.at(-1) &&         // VWAP üstü
    last>prev                 // momentum
  ){

    const entry=last;
    const stop=Math.min(...d.slice(-10).map(x=>x.l));

    const tp2=entry+(entry-stop)*2.3;
    const R=rr(entry,stop,tp2);

    if(R<MIN_RR) return null;
    if(isDuplicate(sym,"LONG")) return null;

    return {sym,side:"LONG",entry,stop,tp1:entry+(entry-stop)*1.1,tp2,rr:R};
  }

  // ===== SHORT =====
  if(
    last<bb.lower.at(-1) &&
    last<vw.at(-1) &&
    last<prev
  ){

    const entry=last;
    const stop=Math.max(...d.slice(-10).map(x=>x.h));

    const tp2=entry-(stop-entry)*2.3;
    const R=rr(entry,stop,tp2);

    if(R<MIN_RR) return null;
    if(isDuplicate(sym,"SHORT")) return null;

    return {sym,side:"SHORT",entry,stop,tp1:entry-(stop-entry)*1.1,tp2,rr:R};
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

  await send(`🚀 V19 TREND SIGNAL

${best.sym} ${best.side}
RR: ${best.rr.toFixed(2)}

Entry: ${best.entry}
TP1: ${best.tp1}
TP2: ${best.tp2}
Stop: ${best.stop}

Logic: ADX Trend + BB Breakout + VWAP`);

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
