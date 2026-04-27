const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const ENTRY_TF = process.env.ENTRY_TF || "5m";
const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);

const MIN_SCORE = parseFloat(process.env.MIN_SCORE || "5.5");
const MIN_RR = parseFloat(process.env.MIN_RR || "1.4");

const BASE = "https://fapi.binance.com";

const COINS = (process.env.COIN_LIST || "")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

let activeTrade = null;

console.log("🔥 V11 HYBRID START");
console.log("COIN COUNT:", COINS.length);

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function klines(symbol) {
  return await fetchJson(`${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${ENTRY_TF}&limit=120`);
}

async function price(symbol) {
  const d = await fetchJson(`${BASE}/fapi/v1/ticker/price?symbol=${symbol}`);
  return d?.price ? parseFloat(d.price) : null;
}

function closes(d){return d.map(x=>+x[4]);}
function highs(d){return d.map(x=>+x[2]);}
function lows(d){return d.map(x=>+x[3]);}
function volumes(d){return d.map(x=>+x[5]);}

function ema(a,p){
  let k=2/(p+1),e=a[0];
  return a.map(v=>e=v*k+e*(1-k));
}

function avg(a){
  if (!a.length) return 0;
  return a.reduce((x,y)=>x+y,0)/a.length;
}

function rr(e,s,tp){
  const risk = Math.abs(e-s);
  if (risk <= 0) return 0;
  return Math.abs(tp-e)/risk;
}

function fmt(n){
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(4);
}

async function send(msg){
  if(!TG_TOKEN || !CHAT_ID){
    console.log("TG ENV MISSING");
    return false;
  }

  try{
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:CHAT_ID,text:msg})
    });
    return true;
  }catch{
    return false;
  }
}

async function scan(symbol, debug){
  debug.checked++;

  const d = await klines(symbol);
  if(!d || d.length < 30){
    debug.dataFail++;
    return null;
  }

  const c = closes(d);
  const h = highs(d);
  const l = lows(d);
  const v = volumes(d);

  const last = c.at(-1);
  const prev = c.at(-2);

  const ema20 = ema(c,20).at(-1);

  const breakoutHigh = Math.max(...h.slice(-10,-1));
  const breakoutLow = Math.min(...l.slice(-10,-1));

  const volNow = v.at(-1);
  const volAvg = avg(v.slice(-20,-1));

  // ---- CANDIDATE ----
  let candidateLong = last > breakoutHigh * 0.995;
  let candidateShort = last < breakoutLow * 1.005;

  if(candidateLong || candidateShort){
    debug.candidates++;
  } else {
    return null;
  }

  // ---- CONFIRM ----
  let score = 0;

  const volumeOk = volNow > volAvg * 1.05;
  const emaOk = Math.abs(last - ema20) / last < 0.02;
  const momentum = Math.abs((last-prev)/prev*100);

  if(volumeOk) score += 2;
  if(emaOk) score += 1.5;
  if(momentum > 0.15) score += 2;
  if(momentum > 0.3) score += 1;

  if(score < MIN_SCORE){
    debug.scoreFail++;
    return null;
  }

  const side = candidateLong ? "LONG" : "SHORT";

  const stop = candidateLong ? breakoutLow : breakoutHigh;
  const tp = candidateLong
    ? last + (last - stop) * 1.6
    : last - (stop - last) * 1.6;

  const R = rr(last, stop, tp);

  if(R < MIN_RR){
    debug.rrFail++;
    return null;
  }

  debug.passed++;

  return {
    coin: symbol,
    side,
    entry: last,
    stop,
    tp,
    rr: R,
    score
  };
}

async function updateTrade(){
  if(!activeTrade) return;

  const p = await price(activeTrade.coin);
  if(!p) return;

  if(activeTrade.side === "LONG"){
    if(p <= activeTrade.stop){
      await send(`🔴 STOP\n${activeTrade.coin}\n${fmt(p)}`);
      activeTrade = null;
    }
    if(p >= activeTrade.tp){
      await send(`🟢 TP\n${activeTrade.coin}\n${fmt(p)}`);
      activeTrade = null;
    }
  }

  if(activeTrade.side === "SHORT"){
    if(p >= activeTrade.stop){
      await send(`🔴 STOP\n${activeTrade.coin}\n${fmt(p)}`);
      activeTrade = null;
    }
    if(p <= activeTrade.tp){
      await send(`🟢 TP\n${activeTrade.coin}\n${fmt(p)}`);
      activeTrade = null;
    }
  }
}

async function run(){
  console.log("RUN");

  await updateTrade();

  if(activeTrade){
    console.log("ACTIVE TRADE WAIT");
    return;
  }

  const debug = {
    checked:0,
    candidates:0,
    scoreFail:0,
    rrFail:0,
    passed:0,
    dataFail:0
  };

  let best = null;

  for(const coin of COINS){
    const s = await scan(coin, debug);

    if(s && (!best || s.score > best.score)){
      best = s;
    }
  }

  console.log("DEBUG:", debug);

  if(!best){
    console.log("NO SIGNAL");
    return;
  }

  console.log("SIGNAL:", best.coin, best.side);

  const sent = await send(
`🔥 HYBRID SIGNAL

${best.coin} ${best.side}
Score: ${best.score}
RR: ${best.rr.toFixed(2)}

Entry: ${fmt(best.entry)}
Stop: ${fmt(best.stop)}
TP: ${fmt(best.tp)}`
  );

  if(sent){
    activeTrade = best;
  }
}

async function main(){
  if(!COINS.length){
    console.log("COIN LIST EMPTY");
    return;
  }

  while(true){
    try{
      await run();
    }catch(e){
      console.log("ERR:", e.message);
    }

    await new Promise(r=>setTimeout(r, LOOP_MS));
  }
}

main();
