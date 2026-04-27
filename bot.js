const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;

const MIN_RR_SNIPER = 2.5;
const MIN_RR_TREND = 2.2;

const OKX = "https://www.okx.com";

let symbols = [];
let activeTrade = null;

console.log("🔥 V14 ELITE MODE START");

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

// ================= FILTER =================
function fakeBreakoutFilter(d){
  const last=d.at(-1);
  const body=Math.abs(last.c-last.o);
  const range=last.h-last.l;

  const upper=last.h-Math.max(last.c,last.o);
  const lower=Math.min(last.c,last.o)-last.l;

  if(body/range < 0.3) return false;
  if(upper/range > 0.5) return false;
  if(lower/range > 0.5) return false;

  return true;
}

// ================= SCAN =================
async function scan(sym){

  const d5 = await klines(sym,"5m");
  const d15 = await klines(sym,"15m");

  if(!d5 || !d15) return null;
  if(d5.length < 80 || d15.length < 80) return null;

  if(!fakeBreakoutFilter(d5)) return null;

  const c5 = d5.map(x=>x.c);
  const c15 = d15.map(x=>x.c);
  const v = d5.map(x=>x.v);

  const e20_5 = ema(c5,20);
  const e50_5 = ema(c5,50);

  const e20_15 = ema(c15,20);
  const e50_15 = ema(c15,50);

  const last = c5.at(-1);
  const prev = c5.at(-2);

  const volNow = v.at(-1);
  const volAvg = avg(v.slice(-20));

  const atrVal = atr(d5);

  // 🔥 ELITE FILTERS
  if((atrVal/last)*100 < 0.25) return null; // volatilite düşük → skip
  if(volNow < volAvg*1.5) return null;      // volume düşük → skip

  const trendUp = e20_5.at(-1)>e50_5.at(-1) && e20_15.at(-1)>e50_15.at(-1);
  const trendDn = e20_5.at(-1)<e50_5.at(-1) && e20_15.at(-1)<e50_15.at(-1);

  const momentumUp = last > prev;
  const momentumDn = last < prev;

  // ================= SNIPER =================
  if(trendUp && prev < e20_5.at(-2) && last > e20_5.at(-1) && momentumUp){

    const entry = last;
    const stop = Math.min(...d5.slice(-10).map(x=>x.l));

    const tp1 = entry + (entry - stop)*1.2;
    const tp2 = entry + (entry - stop)*2.6;

    const R = rr(entry,stop,tp2);
    if(R < MIN_RR_SNIPER) return null;

    return {
      mode:"SNIPER",
      side:"LONG",
      symbol:sym,
      entry,stop,tp1,tp2,rr:R,score:9
    };
  }

  if(trendDn && prev > e20_5.at(-2) && last < e20_5.at(-1) && momentumDn){

    const entry = last;
    const stop = Math.max(...d5.slice(-10).map(x=>x.h));

    const tp1 = entry - (stop-entry)*1.2;
    const tp2 = entry - (stop-entry)*2.6;

    const R = rr(entry,stop,tp2);
    if(R < MIN_RR_SNIPER) return null;

    return {
      mode:"SNIPER",
      side:"SHORT",
      symbol:sym,
      entry,stop,tp1,tp2,rr:R,score:9
    };
  }

  // ================= TREND =================
  if(trendUp){
    const entry=last;
    const stop=Math.min(...d5.slice(-12).map(x=>x.l));

    const tp2=entry+(entry-stop)*2.2;
    const R=rr(entry,stop,tp2);

    if(R<MIN_RR_TREND) return null;

    return {
      mode:"TREND",
      side:"LONG",
      symbol:sym,
      entry,stop,
      tp1:entry+(entry-stop),
      tp2,
      rr:R,
      score:7
    };
  }

  if(trendDn){
    const entry=last;
    const stop=Math.max(...d5.slice(-12).map(x=>x.h));

    const tp2=entry-(stop-entry)*2.2;
    const R=rr(entry,stop,tp2);

    if(R<MIN_RR_TREND) return null;

    return {
      mode:"TREND",
      side:"SHORT",
      symbol:sym,
      entry,stop,
      tp1:entry-(stop-entry),
      tp2,
      rr:R,
      score:7
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

  if(!activeTrade) return;

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

  let bestSniper=null;
  let bestTrend=null;

  for(const s of symbols){

    const sig=await scan(s);
    if(!sig) continue;

    if(sig.mode==="SNIPER"){
      if(!bestSniper || sig.rr>bestSniper.rr) bestSniper=sig;
    }else{
      if(!bestTrend || sig.rr>bestTrend.rr) bestTrend=sig;
    }
  }

  const best = bestSniper || bestTrend;

  if(!best){
    console.log("NO SIGNAL");
    return;
  }

  await send(`🔥 ${best.mode}

${best.symbol} ${best.side}
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
    try{
      await run();
    }catch(e){
      console.log("ERR",e.message);
    }

    await new Promise(r=>setTimeout(r,LOOP_MS));
  }

})();
