const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;
const COOLDOWN_MS = 7200000;

const MIN_SCORE = 7.0;
const MIN_RR = 1.5;

const OKX = "https://www.okx.com";

const COINS = [
"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT",
"XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT",
"APTUSDT","ARBUSDT","OPUSDT","INJUSDT","SUIUSDT","SEIUSDT","NEARUSDT","ATOMUSDT"
];

const lastSignal = new Map();

console.log("🔥 V30 VWAP EMA RSI START");

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
function ema(arr,p){
  const k=2/(p+1); let e=arr[0];
  return arr.map(v=>e=v*k+e*(1-k));
}

function avg(a){return a.reduce((x,y)=>x+y,0)/a.length;}

function rsi(arr,p=14){
  let gains=0, losses=0;

  for(let i=arr.length-p;i<arr.length;i++){
    let diff=arr[i]-arr[i-1];
    if(diff>0) gains+=diff;
    else losses-=diff;
  }

  let rs = gains/(losses||1e-9);
  return 100-(100/(1+rs));
}

function vwap(d){
  let pv=0, vol=0;
  for(const x of d.slice(-40)){
    const typ=(x.h+x.l+x.c)/3;
    pv+=typ*x.v;
    vol+=x.v;
  }
  return pv/vol;
}

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

function fmt(n){
  return Number(n).toFixed(4);
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
  if(!d || d.length<80) return null;

  const c=d.map(x=>x.c);
  const last=c.at(-1);

  const ema20=ema(c,20);
  const ema50=ema(c,50);

  const vwapVal=vwap(d);
  const rsiVal=rsi(c,14);

  const atrVal=atr(d);
  if(!atrVal) return null;

  // ===== LONG =====
  const trendLong = last>vwapVal && ema20.at(-1)>ema50.at(-1);

  const pullbackLong = rsiVal<50 && rsiVal>40;

  if(trendLong && pullbackLong){

    const entry=last;

    const stop=Math.min(...d.slice(-10).map(x=>x.l));
    const tp2=entry+(entry-stop)*1.6;

    const R=rr(entry,stop,tp2);
    if(R<MIN_RR) return null;
    if(isDuplicate(sym,"LONG")) return null;

    const score=Math.min(10,(R*2)+(rsiVal/10));

    if(score<MIN_SCORE) return null;

    return {sym,side:"LONG",entry,stop,tp1:entry+(entry-stop)*0.8,tp2,rr:R,score};
  }

  // ===== SHORT =====
  const trendShort = last<vwapVal && ema20.at(-1)<ema50.at(-1);

  const pullbackShort = rsiVal>50 && rsiVal<60;

  if(trendShort && pullbackShort){

    const entry=last;

    const stop=Math.max(...d.slice(-10).map(x=>x.h));
    const tp2=entry-(stop-entry)*1.6;

    const R=rr(entry,stop,tp2);
    if(R<MIN_RR) return null;
    if(isDuplicate(sym,"SHORT")) return null;

    const score=Math.min(10,(R*2)+(rsiVal/10));

    if(score<MIN_SCORE) return null;

    return {sym,side:"SHORT",entry,stop,tp1:entry-(stop-entry)*0.8,tp2,rr:R,score};
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

  await send(`🚀 V30 CONTINUATION SIGNAL

${best.sym} ${best.side}
Güven: ${best.score.toFixed(1)}/10
RR: ${best.rr.toFixed(2)}

Entry: ${fmt(best.entry)}
TP1: ${fmt(best.tp1)}
TP2: ${fmt(best.tp2)}
Stop: ${fmt(best.stop)}

Logic: VWAP + EMA Trend + RSI Pullback`);

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
