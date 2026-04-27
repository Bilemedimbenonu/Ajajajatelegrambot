const TG_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

const LOOP_MS = parseInt(process.env.LOOP_MS || "60000", 10);
const ENTRY_TF = process.env.ENTRY_TF || "5m";
const TREND_TF = process.env.TREND_TF || "15m";

const MIN_RR_SNIPER = parseFloat(process.env.MIN_RR_SNIPER || "2.0");
const MIN_RR_TREND = parseFloat(process.env.MIN_RR_TREND || "1.7");

const OKX = "https://www.okx.com";

let symbols = [];
let activeTrade = null;

console.log("🔥 V13 OKX PRO START");

// ================== HELPERS ==================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function toOkx(sym) {
  return sym.replace("USDT", "-USDT-SWAP");
}

function barMap(tf){
  if (tf === "1m") return "1m";
  if (tf === "3m") return "3m";
  if (tf === "5m") return "5m";
  if (tf === "15m") return "15m";
  if (tf === "30m") return "30m";
  if (tf === "1h") return "1H";
  return "5m";
}

async function fetchJson(url){
  try{
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" }});
    clearTimeout(t);
    if(!r.ok) return null;
    return await r.json();
  }catch{
    return null;
  }
}

// ================== DATA ==================
async function loadSymbols(){
  const url = `${OKX}/api/v5/public/instruments?instType=SWAP`;
  const j = await fetchJson(url);
  if(!j || !Array.isArray(j.data)){
    console.log("SYMBOL LOAD FAIL");
    return;
  }
  symbols = j.data
    .filter(s => s.ctValCcy === "USDT")
    .map(s => s.instId.replace(/-/g,""));
  console.log("SYMBOLS:", symbols.length);
}

async function klines(sym, tf=ENTRY_TF, limit=120){
  const instId = toOkx(sym);
  const bar = barMap(tf);
  const url = `${OKX}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
  const j = await fetchJson(url);
  if(!j || j.code !== "0" || !Array.isArray(j.data)) return null;

  return j.data.slice().reverse().map(x => ({
    o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5]
  }));
}

async function price(sym){
  const instId = toOkx(sym);
  const url = `${OKX}/api/v5/market/ticker?instId=${instId}`;
  const j = await fetchJson(url);
  if(!j || j.code !== "0" || !j.data?.[0]?.last) return null;
  return +j.data[0].last;
}

// ================== INDICATORS ==================
function ema(arr, p){
  const k = 2/(p+1);
  let e = arr[0];
  const out = [e];
  for(let i=1;i<arr.length;i++){
    e = arr[i]*k + e*(1-k);
    out.push(e);
  }
  return out;
}

function avg(a){ return a.reduce((x,y)=>x+y,0)/a.length; }

function atr(d, p=14){
  const tr = [];
  for(let i=1;i<d.length;i++){
    const {h,l} = d[i];
    const pc = d[i-1].c;
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return avg(tr.slice(-p));
}

function rr(entry, stop, tp){
  const risk = Math.abs(entry-stop);
  if(risk<=0) return 0;
  return Math.abs(tp-entry)/risk;
}

function fmt(n){
  if(!Number.isFinite(n)) return "-";
  return Math.abs(n)>=1 ? n.toFixed(4) : n.toFixed(6);
}

// ================== FILTERS ==================
function fakePumpFilter(d){
  const last = d.at(-1);
  const body = Math.abs(last.c - last.o);
  const range = Math.max(last.h - last.l, 1e-9);
  const upperWick = last.h - Math.max(last.c, last.o);
  const lowerWick = Math.min(last.c, last.o) - last.l;

  // büyük fitil + küçük body ise reject
  if(body/range < 0.25) return false;
  if(upperWick/range > 0.5) return false;
  if(lowerWick/range > 0.5) return false;
  return true;
}

function confidenceScore({trend, breakout, volume, momentum, nearEma}){
  let s = 0;
  if(trend) s += 3.0;
  if(breakout) s += 2.0;
  if(volume) s += 1.5;
  if(momentum) s += 1.5;
  if(nearEma) s += 1.0;
  return Math.min(10, s);
}

// ================== SCAN ==================
async function scanSymbol(sym){
  const d = await klines(sym, ENTRY_TF, 120);
  if(!d || d.length<80) return null;

  const c = d.map(x=>x.c);
  const h = d.map(x=>x.h);
  const l = d.map(x=>x.l);
  const v = d.map(x=>x.v);

  const last = c.at(-1);
  const prev = c.at(-2);

  const e20 = ema(c,20);
  const e50 = ema(c,50);
  const a = atr(d,14);

  if(!a || (a/last)*100 < 0.12) return null;
  if(!fakePumpFilter(d)) return null;

  const volNow = v.at(-1);
  const volAvg = avg(v.slice(-20));
  const volOk = volNow > volAvg*1.2;

  const trendUp = e20.at(-1) > e50.at(-1);
  const trendDn = e20.at(-1) < e50.at(-1);

  const recentHigh = Math.max(...h.slice(-10));
  const recentLow  = Math.min(...l.slice(-10));

  const breakoutUp = last > recentHigh;
  const breakoutDn = last < recentLow;

  const momentumUp = last > prev;
  const momentumDn = last < prev;

  const nearEma = Math.abs(last - e20.at(-1))/last < 0.01;

  // ---------- SNIPER (pullback + continuation) ----------
  if(trendUp && prev < e20.at(-2) && last > e20.at(-1) && volOk){
    const entry = last;
    const stop = Math.min(...l.slice(-8));
    const tp1 = entry + (entry - stop)*1.0;
    const tp2 = entry + (entry - stop)*2.1;
    const R = rr(entry, stop, tp2);
    if(R < MIN_RR_SNIPER) return null;

    return {
      mode: "SNIPER",
      side: "LONG",
      symbol: sym,
      entry, stop, tp1, tp2, rr: R,
      score: confidenceScore({trend:true, breakout:false, volume:volOk, momentum:momentumUp, nearEma})
    };
  }

  if(trendDn && prev > e20.at(-2) && last < e20.at(-1) && volOk){
    const entry = last;
    const stop = Math.max(...h.slice(-8));
    const tp1 = entry - (stop - entry)*1.0;
    const tp2 = entry - (stop - entry)*2.1;
    const R = rr(entry, stop, tp2);
    if(R < MIN_RR_SNIPER) return null;

    return {
      mode: "SNIPER",
      side: "SHORT",
      symbol: sym,
      entry, stop, tp1, tp2, rr: R,
      score: confidenceScore({trend:true, breakout:false, volume:volOk, momentum:momentumDn, nearEma})
    };
  }

  // ---------- TREND (breakout) ----------
  if(trendUp && breakoutUp && volOk){
    const entry = last;
    const stop = recentLow;
    const tp1 = entry + (entry - stop)*0.9;
    const tp2 = entry + (entry - stop)*1.8;
    const R = rr(entry, stop, tp2);
    if(R < MIN_RR_TREND) return null;

    return {
      mode: "TREND",
      side: "LONG",
      symbol: sym,
      entry, stop, tp1, tp2, rr: R,
      score: confidenceScore({trend:true, breakout:true, volume:volOk, momentum:momentumUp, nearEma})
    };
  }

  if(trendDn && breakoutDn && volOk){
    const entry = last;
    const stop = recentHigh;
    const tp1 = entry - (stop - entry)*0.9;
    const tp2 = entry - (stop - entry)*1.8;
    const R = rr(entry, stop, tp2);
    if(R < MIN_RR_TREND) return null;

    return {
      mode: "TREND",
      side: "SHORT",
      symbol: sym,
      entry, stop, tp1, tp2, rr: R,
      score: confidenceScore({trend:true, breakout:true, volume:volOk, momentum:momentumDn, nearEma})
    };
  }

  return null;
}

// ================== TELEGRAM ==================
async function send(msg){
  if(!TG_TOKEN || !CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
  });
}

// ================== SMART EXIT ==================
async function updateActive(){
  if(!activeTrade) return;

  const p = await price(activeTrade.symbol);
  if(!p) return;

  const e20Data = await klines(activeTrade.symbol, ENTRY_TF, 50);
  if(!e20Data) return;
  const e20 = ema(e20Data.map(x=>x.c),20).at(-1);

  if(activeTrade.side==="LONG"){
    if(!activeTrade.tp1Hit && p >= activeTrade.tp1){
      activeTrade.tp1Hit = true;
      activeTrade.stop = activeTrade.entry;
      await send(`🟡 TP1 HIT / BE\n${activeTrade.symbol} LONG\n${fmt(p)}`);
    }
    if(p >= activeTrade.tp2){
      await send(`🟢 TP2 HIT\n${activeTrade.symbol} LONG\n${fmt(p)}`);
      activeTrade=null; return;
    }
    if(p <= activeTrade.stop || p < e20){
      await send(`🔴 EXIT\n${activeTrade.symbol} LONG\n${fmt(p)}\nReason: STOP/EMA`);
      activeTrade=null; return;
    }
  }else{
    if(!activeTrade.tp1Hit && p <= activeTrade.tp1){
      activeTrade.tp1Hit = true;
      activeTrade.stop = activeTrade.entry;
      await send(`🟡 TP1 HIT / BE\n${activeTrade.symbol} SHORT\n${fmt(p)}`);
    }
    if(p <= activeTrade.tp2){
      await send(`🟢 TP2 HIT\n${activeTrade.symbol} SHORT\n${fmt(p)}`);
      activeTrade=null; return;
    }
    if(p >= activeTrade.stop || p > e20){
      await send(`🔴 EXIT\n${activeTrade.symbol} SHORT\n${fmt(p)}\nReason: STOP/EMA`);
      activeTrade=null; return;
    }
  }
}

// ================== MAIN ==================
async function run(){
  await updateActive();
  if(activeTrade) return;

  let bestSniper=null, bestTrend=null;

  for(const s of symbols){
    const sig = await scanSymbol(s);
    if(!sig) continue;

    if(sig.mode==="SNIPER"){
      if(!bestSniper || sig.score>bestSniper.score || sig.rr>bestSniper.rr){
        bestSniper=sig;
      }
    }else{
      if(!bestTrend || sig.score>bestTrend.score || sig.rr>bestTrend.rr){
        bestTrend=sig;
      }
    }
  }

  const best = bestSniper || bestTrend;
  if(!best){
    console.log("NO SIGNAL");
    return;
  }

  const msg = `🔥 ${best.mode} SIGNAL

Coin: ${best.symbol}
Side: ${best.side}
Score: ${best.score.toFixed(1)}/10
RR: ${best.rr.toFixed(2)}

Entry: ${fmt(best.entry)}
Stop: ${fmt(best.stop)}
TP1: ${fmt(best.tp1)}
TP2: ${fmt(best.tp2)}
`;

  await send(msg);

  activeTrade = { ...best, tp1Hit:false };
}

// ================== LOOP ==================
(async()=>{
  await loadSymbols();

  while(true){
    try{ await run(); }
    catch(e){ console.log("ERR", e.message); }

    await sleep(LOOP_MS);
  }
})();
