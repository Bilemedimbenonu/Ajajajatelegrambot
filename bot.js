const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);

const MIN_RR_SNIPER = 2.0;
const MIN_RR_TREND = 1.7;

const OKX = "https://www.okx.com";

let symbols = [];
let activeTrade = null;

console.log("🔥 V13 OKX PRO START");

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

// ================= SYMBOL FIX =================
async function loadSymbols(){
  const url = `${OKX}/api/v5/public/instruments?instType=SWAP`;
  const j = await fetchJson(url);

  if(!j || !Array.isArray(j.data)){
    console.log("SYMBOL LOAD FAIL");
    return;
  }

  // 🔥 FIXED VERSION
  symbols = j.data
    .filter(s => s.instId.endsWith("-USDT-SWAP"))
    .map(s => s.instId.replace("-USDT-SWAP","USDT"));

  console.log("SYMBOLS:", symbols.length);
}

// ================= DATA =================
function toOkx(sym){
  return sym.replace("USDT","-USDT-SWAP");
}

async function klines(sym, tf="5m"){
  const url = `${OKX}/api/v5/market/candles?instId=${toOkx(sym)}&bar=${tf}&limit=120`;
  const j = await fetchJson(url);

  if(!j || j.code!=="0") return null;

  return j.data.reverse().map(x=>({
    o:+x[1], h:+x[2], l:+x[3], c:+x[4], v:+x[5]
  }));
}

async function price(sym){
  const url = `${OKX}/api/v5/market/ticker?instId=${toOkx(sym)}`;
  const j = await fetchJson(url);
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
function fakeFilter(c){
  const last=c.at(-1);
  const body=Math.abs(last.c-last.o);
  const range=last.h-last.l;

  if(body/range<0.25) return false;
  if((last.h-last.c)/range>0.5) return false;

  return true;
}

// ================= SCAN =================
async function scan(sym){
  const d=await klines(sym);
  if(!d||d.length<80) return null;

  const c=d.map(x=>x.c);
  const v=d.map(x=>x.v);

  const e20=ema(c,20);
  const e50=ema(c,50);

  const last=c.at(-1);
  const prev=c.at(-2);

  const volNow=v.at(-1);
  const volAvg=avg(v.slice(-20));

  const trendUp=e20.at(-1)>e50.at(-1);
  const trendDn=e20.at(-1)<e50.at(-1);

  const volOk=volNow>volAvg*1.2;

  if(!fakeFilter(d)) return null;

  // ===== SNIPER =====
  if(trendUp && prev<e20.at(-2) && last>e20.at(-1) && volOk){
    let stop=Math.min(...d.slice(-8).map(x=>x.l));
    let tp2=last+(last-stop)*2;
    let R=rr(last,stop,tp2);
    if(R<MIN_RR_SNIPER) return null;

    return {
      mode:"SNIPER",
      side:"LONG",
      symbol:sym,
      entry:last,
      stop,
      tp1:last+(last-stop),
      tp2,
      rr:R,
      score:8
    };
  }

  if(trendDn && prev>e20.at(-2) && last<e20.at(-1) && volOk){
    let stop=Math.max(...d.slice(-8).map(x=>x.h));
    let tp2=last-(stop-last)*2;
    let R=rr(last,stop,tp2);
    if(R<MIN_RR_SNIPER) return null;

    return {
      mode:"SNIPER",
      side:"SHORT",
      symbol:sym,
      entry:last,
      stop,
      tp1:last-(stop-last),
      tp2,
      rr:R,
      score:8
    };
  }

  // ===== TREND =====
  if(trendUp && volOk){
    let stop=Math.min(...d.slice(-10).map(x=>x.l));
    let tp2=last+(last-stop)*1.8;
    let R=rr(last,stop,tp2);
    if(R<MIN_RR_TREND) return null;

    return {
      mode:"TREND",
      side:"LONG",
      symbol:sym,
      entry:last,
      stop,
      tp1:last+(last-stop)*0.9,
      tp2,
      rr:R,
      score:6
    };
  }

  if(trendDn && volOk){
    let stop=Math.max(...d.slice(-10).map(x=>x.h));
    let tp2=last-(stop-last)*1.8;
    let R=rr(last,stop,tp2);
    if(R<MIN_RR_TREND) return null;

    return {
      mode:"TREND",
      side:"SHORT",
      symbol:sym,
      entry:last,
      stop,
      tp1:last-(stop-last)*0.9,
      tp2,
      rr:R,
      score:6
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

  const p=await price(activeTrade.symbol);
  if(!p) return;

  if(activeTrade.side==="LONG"){
    if(!activeTrade.tp1Hit && p>=activeTrade.tp1){
      activeTrade.tp1Hit=true;
      activeTrade.stop=activeTrade.entry;
      await send("TP1 HIT BE");
    }
    if(p>=activeTrade.tp2){
      await send("TP2 HIT");
      activeTrade=null;
    }
    if(p<=activeTrade.stop){
      await send("STOP EXIT");
      activeTrade=null;
    }
  }else{
    if(!activeTrade.tp1Hit && p<=activeTrade.tp1){
      activeTrade.tp1Hit=true;
      activeTrade.stop=activeTrade.entry;
      await send("TP1 HIT BE");
    }
    if(p<=activeTrade.tp2){
      await send("TP2 HIT");
      activeTrade=null;
    }
    if(p>=activeTrade.stop){
      await send("STOP EXIT");
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
    try{ await run(); }
    catch(e){ console.log("ERR",e.message); }

    await new Promise(r=>setTimeout(r,LOOP_MS));
  }
})();
