const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = 60000;
const COOLDOWN_MS = 7200000;
const MIN_RR = 2.4;
const MIN_SCORE = 7.2;

const OKX = "https://www.okx.com";

const COINS = [
"BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT",
"XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT",
"ATOMUSDT","NEARUSDT","FILUSDT","APTUSDT","ARBUSDT","OPUSDT","INJUSDT",
"SUIUSDT","SEIUSDT","MATICUSDT","ICPUSDT","AAVEUSDT","UNIUSDT","TRXUSDT"
];

const lastSignal = new Map();

console.log("🔥 V19.1 OPTIMIZED START");

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

  return j.data.slice().reverse().map(x=>({
    o:+x[1], h:+x[2], l:+x[3], c:+x[4], v:+x[5]
  }));
}

function avg(a){
  if(!a.length) return 0;
  return a.reduce((x,y)=>x+y,0)/a.length;
}

function std(a){
  const m=avg(a);
  return Math.sqrt(avg(a.map(x=>(x-m)**2)));
}

function bb(c,p=20,mult=2){
  const s=c.slice(-p);
  const mid=avg(s);
  const dev=std(s);
  return {upper:mid+dev*mult, mid, lower:mid-dev*mult};
}

function vwap(d){
  let pv=0, vol=0;
  for(const x of d.slice(-40)){
    const typ=(x.h+x.l+x.c)/3;
    pv+=typ*x.v;
    vol+=x.v;
  }
  return vol ? pv/vol : d.at(-1).c;
}

function atr(d,p=14){
  const tr=[];
  for(let i=1;i<d.length;i++){
    tr.push(Math.max(
      d[i].h-d[i].l,
      Math.abs(d[i].h-d[i-1].c),
      Math.abs(d[i].l-d[i-1].c)
    ));
  }
  return avg(tr.slice(-p));
}

function adx(d,p=14){
  const tr=[], plus=[], minus=[];
  for(let i=1;i<d.length;i++){
    const up=d[i].h-d[i-1].h;
    const down=d[i-1].l-d[i].l;

    plus.push(up>down && up>0 ? up : 0);
    minus.push(down>up && down>0 ? down : 0);

    tr.push(Math.max(
      d[i].h-d[i].l,
      Math.abs(d[i].h-d[i-1].c),
      Math.abs(d[i].l-d[i-1].c)
    ));
  }

  const trAvg=avg(tr.slice(-p));
  if(!trAvg) return 0;

  const pdi=100*avg(plus.slice(-p))/trAvg;
  const mdi=100*avg(minus.slice(-p))/trAvg;

  return Math.abs(pdi-mdi)/Math.max(pdi+mdi,0.000001)*100;
}

function rr(entry,stop,tp){
  const risk=Math.abs(entry-stop);
  if(risk<=0) return 0;
  return Math.abs(tp-entry)/risk;
}

function fmt(n){
  if(!Number.isFinite(n)) return "-";
  return n.toFixed(4);
}

function candleOk(d,side){
  const x=d.at(-1);
  const range=Math.max(x.h-x.l,0.0000001);
  const body=Math.abs(x.c-x.o);
  const upper=x.h-Math.max(x.c,x.o);
  const lower=Math.min(x.c,x.o)-x.l;

  if(body/range < 0.38) return false;

  if(side==="LONG"){
    if(x.c<=x.o) return false;
    if(upper/range > 0.35) return false;
  }

  if(side==="SHORT"){
    if(x.c>=x.o) return false;
    if(lower/range > 0.35) return false;
  }

  return true;
}

function scoreCalc({adxVal,volRatio,R,vwapOk,bbBreak,candle}){
  let s=0;

  if(adxVal>=35) s+=2.5;
  else if(adxVal>=28) s+=2;
  else if(adxVal>=22) s+=1.5;

  if(volRatio>=2) s+=2;
  else if(volRatio>=1.5) s+=1.5;
  else if(volRatio>=1.25) s+=1;

  if(R>=3) s+=2;
  else if(R>=2.4) s+=1.5;

  if(vwapOk) s+=1.2;
  if(bbBreak) s+=1.2;
  if(candle) s+=1.1;

  return Math.min(10,Number(s.toFixed(1)));
}

function isDuplicate(sym,side){
  const key=`${sym}:${side}`;
  const t=lastSignal.get(key);
  return t && Date.now()-t < COOLDOWN_MS;
}

function mark(sym,side){
  lastSignal.set(`${sym}:${side}`,Date.now());
}

async function send(msg){
  if(!TG_TOKEN || !CHAT_ID){
    console.log("TELEGRAM ENV MISSING");
    return false;
  }

  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:CHAT_ID,text:msg})
  });

  const t = await r.text();
  console.log("TELEGRAM:",t);
  return r.ok;
}

async function scan(sym){
  const d5=await klines(sym,"5m");
  const d15=await klines(sym,"15m");

  if(!Array.isArray(d5) || !Array.isArray(d15)) return null;
  if(d5.length<80 || d15.length<80) return null;

  const c=d5.map(x=>x.c);
  const last=c.at(-1);
  const prev=c.at(-2);

  const band=bb(c,20,2);
  const vw=vwap(d5);
  const a=atr(d5,14);
  const adx5=adx(d5,14);
  const adx15=adx(d15,14);

  if(!a || (a/last)*100 < 0.18) return null;
  if(adx5 < 22 || adx15 < 18) return null;

  const volNow=d5.at(-1).v;
  const volAvg=avg(d5.map(x=>x.v).slice(-20));
  const volRatio=volNow/volAvg;

  if(volRatio < 1.25) return null;

  const longBreak = last > band.upper && prev <= band.upper;
  const shortBreak = last < band.lower && prev >= band.lower;

  if(longBreak && last > vw && candleOk(d5,"LONG")){
    const entry = last;

    const swingStop = Math.min(...d5.slice(-8).map(x=>x.l));
    const atrStop = entry - a*1.25;
    const stop = Math.min(swingStop,atrStop);

    const tp1 = entry + (entry-stop)*1.1;
    const tp2 = entry + (entry-stop)*2.6;
    const R = rr(entry,stop,tp2);

    if(R < MIN_RR) return null;

    const score = scoreCalc({
      adxVal:adx5,
      volRatio,
      R,
      vwapOk:true,
      bbBreak:true,
      candle:true
    });

    if(score < MIN_SCORE) return null;
    if(isDuplicate(sym,"LONG")) return null;

    return {sym,side:"LONG",entry,stop,tp1,tp2,rr:R,score,adx:adx5,volRatio};
  }

  if(shortBreak && last < vw && candleOk(d5,"SHORT")){
    const entry = last;

    const swingStop = Math.max(...d5.slice(-8).map(x=>x.h));
    const atrStop = entry + a*1.25;
    const stop = Math.max(swingStop,atrStop);

    const tp1 = entry - (stop-entry)*1.1;
    const tp2 = entry - (stop-entry)*2.6;
    const R = rr(entry,stop,tp2);

    if(R < MIN_RR) return null;

    const score = scoreCalc({
      adxVal:adx5,
      volRatio,
      R,
      vwapOk:true,
      bbBreak:true,
      candle:true
    });

    if(score < MIN_SCORE) return null;
    if(isDuplicate(sym,"SHORT")) return null;

    return {sym,side:"SHORT",entry,stop,tp1,tp2,rr:R,score,adx:adx5,volRatio};
  }

  return null;
}

async function run(){
  console.log("RUN");

  let best=null;
  let checked=0;
  let candidates=0;

  for(const s of COINS){
    checked++;

    const sig=await scan(s);
    if(!sig) continue;

    candidates++;

    console.log(
      "CANDIDATE:",
      sig.sym,
      sig.side,
      "RR:",
      sig.rr.toFixed(2),
      "SCORE:",
      sig.score
    );

    if(!best || sig.score>best.score || (sig.score===best.score && sig.rr>best.rr)){
      best=sig;
    }
  }

  console.log("CHECKED:",checked,"CANDIDATES:",candidates);

  if(!best){
    console.log("NO SIGNAL");
    return;
  }

  const sent = await send(`🚀 V19.1 OPTIMIZED SIGNAL

${best.sym} ${best.side}
Güven: ${best.score}/10
RR: ${best.rr.toFixed(2)}
ADX: ${best.adx.toFixed(1)}
Volume: ${best.volRatio.toFixed(2)}x

Entry: ${fmt(best.entry)}
TP1: ${fmt(best.tp1)}
TP2: ${fmt(best.tp2)}
Stop: ${fmt(best.stop)}

Logic: ADX + BB Breakout + VWAP + Clean Candle`);

  if(sent){
    mark(best.sym,best.side);
    console.log("SIGNAL SENT:",best.sym,best.side);
  }
}

(async()=>{
  while(true){
    try{
      await run();
    }catch(e){
      console.log("ERR:",e.message);
    }

    console.log("SLEEPING:",LOOP_MS);
    await new Promise(r=>setTimeout(r,LOOP_MS));
  }
})();
