const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;

const MIN_SCORE = 8;
const MIN_RR = 2.8;

const OKX = "https://www.okx.com";

let symbols = [];
let activeTrade = null;

console.log("🔥 V15 ULTRA MODE START");

// ================= FETCH =================
async function fetchJson(url){
  try{
    const r = await fetch(url);
    if(!r.ok) return null;
    return await r.json();
  }catch{
    return null;
  }
}

// ================= SYMBOL =================
async function loadSymbols(){
  const j = await fetchJson(`${OKX}/api/v5/public/instruments?instType=SWAP`);
  if(!j || !j.data) return;

  symbols = j.data
    .filter(s => s.instId.endsWith("-USDT-SWAP"))
    .map(s => s.instId.replace("-USDT-SWAP","USDT"));

  console.log("SYMBOLS:", symbols.length);
}

// ================= DATA =================
function toOkx(sym){
  return sym.replace("USDT","-USDT-SWAP");
}

async function klines(sym, tf){
  const j = await fetchJson(`${OKX}/api/v5/market/candles?instId=${toOkx(sym)}&bar=${tf}&limit=120`);
  if(!j || j.code!=="0") return null;

  return j.data.reverse().map(x=>({
    o:+x[1], h:+x[2], l:+x[3], c:+x[4], v:+x[5]
  }));
}

async function price(sym){
  const j = await fetchJson(`${OKX}/api/v5/market/ticker?instId=${toOkx(sym)}`);
  if(!j || j.code!=="0") return null;
  return +j.data[0].last;
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
function calcScore({rr, volRatio, trend, momentum}){

  let score = 0;

  // RR
  if(rr > 3.5) score += 3;
  else if(rr > 3) score += 2.5;
  else if(rr > 2.8) score += 2;

  // volume
  if(volRatio > 2) score += 2;
  else if(volRatio > 1.6) score += 1.5;

  // trend
  if(trend === "strong") score += 2;

  // momentum
  if(momentum === "strong") score += 2;

  // bonus
  score += 1;

  return Math.min(10, parseFloat(score.toFixed(1)));
}

// ================= FILTER =================
function cleanCandle(d){
  const last=d.at(-1);
  const body=Math.abs(last.c-last.o);
  const range=last.h-last.l;

  if(body/range < 0.35) return false;
  return true;
}

// ================= SCAN =================
async function scan(sym){

  const d5 = await klines(sym,"5m");
  const d15 = await klines(sym,"15m");

  if(!d5 || !d15) return null;
  if(d5.length<80 || d15.length<80) return null;

  if(!cleanCandle(d5)) return null;

  const c5=d5.map(x=>x.c);
  const c15=d15.map(x=>x.c);
  const v=d5.map(x=>x.v);

  const e20_5=ema(c5,20);
  const e50_5=ema(c5,50);

  const e20_15=ema(c15,20);
  const e50_15=ema(c15,50);

  const last=c5.at(-1);
  const prev=c5.at(-2);

  const volNow=v.at(-1);
  const volAvg=avg(v.slice(-20));
  const volRatio=volNow/volAvg;

  const atrVal=atr(d5);

  if((atrVal/last)*100 < 0.3) return null;
  if(volRatio < 1.6) return null;

  const trendUp=e20_5.at(-1)>e50_5.at(-1) && e20_15.at(-1)>e50_15.at(-1);
  const trendDn=e20_5.at(-1)<e50_5.at(-1) && e20_15.at(-1)<e50_15.at(-1);

  const momentumUp=last>prev;
  const momentumDn=last<prev;

  // ================= SNIPER =================
  if(trendUp && prev<e20_5.at(-2) && last>e20_5.at(-1) && momentumUp){

    const entry=last;
    const stop=Math.min(...d5.slice(-10).map(x=>x.l));

    const tp2=entry+(entry-stop)*2.8;
    const R=rr(entry,stop,tp2);

    if(R < MIN_RR) return null;

    const score = calcScore({
      rr:R,
      volRatio,
      trend:"strong",
      momentum:"strong"
    });

    if(score < MIN_SCORE) return null;

    return {
      mode:"ULTRA SNIPER",
      side:"LONG",
      symbol:sym,
      entry,
      stop,
      tp1:entry+(entry-stop)*1.2,
      tp2,
      rr:R,
      score
    };
  }

  if(trendDn && prev>e20_5.at(-2) && last<e20_5.at(-1) && momentumDn){

    const entry=last;
    const stop=Math.max(...d5.slice(-10).map(x=>x.h));

    const tp2=entry-(stop-entry)*2.8;
    const R=rr(entry,stop,tp2);

    if(R < MIN_RR) return null;

    const score = calcScore({
      rr:R,
      volRatio,
      trend:"strong",
      momentum:"strong"
    });

    if(score < MIN_SCORE) return null;

    return {
      mode:"ULTRA SNIPER",
      side:"SHORT",
      symbol:sym,
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

// ================= EXIT =================
async function update(){

  if(!activeTrade || !activeTrade.stop) return;

  const p = await price(activeTrade.symbol);
  if(!p) return;

  if(activeTrade.side==="LONG"){

    if(!activeTrade.tp1Hit && p>=activeTrade.tp1){
      activeTrade.tp1Hit=true;
      activeTrade.stop=activeTrade.entry;
      await send("🟡 TP1 → BE");
    }

    if(p>=activeTrade.tp2){
      await send("🟢 TP2 HIT");
      activeTrade=null;
    }

    if(p<=activeTrade.stop){
      await send("🔴 STOP");
      activeTrade=null;
    }

  }else{

    if(!activeTrade.tp1Hit && p<=activeTrade.tp1){
      activeTrade.tp1Hit=true;
      activeTrade.stop=activeTrade.entry;
      await send("🟡 TP1 → BE");
    }

    if(p<=activeTrade.tp2){
      await send("🟢 TP2 HIT");
      activeTrade=null;
    }

    if(p>=activeTrade.stop){
      await send("🔴 STOP");
      activeTrade=null;
    }
  }
}

// ================= MAIN =================
async function run(){

  await update();

  if(activeTrade) return;

  let best=null;

  for(const s of symbols){

    const sig=await scan(s);
    if(!sig) continue;

    if(!best || sig.rr>best.rr) best=sig;
  }

  if(!best){
    console.log("NO SIGNAL");
    return;
  }

  await send(`🚀 ULTRA SIGNAL

${best.symbol} ${best.side}
Score: ${best.score}/10
RR: ${best.rr.toFixed(2)}

Entry: ${best.entry}
TP1: ${best.tp1}
TP2: ${best.tp2}
Stop: ${best.stop}`);

  activeTrade={...best,tp1Hit:false};
}

// ================= LOOP =================
(async()=>{
  await loadSymbols();

  while(true){
    try{ await run(); }
    catch(e){ console.log("ERR",e.message); }

    await new Promise(r=>setTimeout(r,LOOP_MS));
  }
})();
