// Checks a recorded workout against what the planned session asked for.
// Goals are read from the session text the plan already shows (so they follow FTP / pace changes):
//   "3 × 1 min at 200–210 W", "2 × 15 min at 176–188 W", "Zone 2, 112–144 W", "Easy 9:35–10:35/mi",
//   "3 × 8 min at 8:05/mi", "4–6 × 20 s strides", tests ("20 min maximal").
// Data: 5-second power / HR / speed streams from Intervals.icu when available, else the summary numbers.
(function(){
const mmss=s=>{s=Math.round(s);const m=Math.floor(s/60),x=s%60;return m+':'+(x<10?'0':'')+x};
const pace=v=>v>0?mmss(1609.344/v)+'/mi':'–';           // m/s → min/mi
const toSec=(m,s)=>(+m)*60+(+s);

function goalOf(s,st){
  const d=s.detail||'', g={type:s.type,min:s.min,reps:[],steady:null,easy:null,strides:/strides/.test(d),test:s.test||null};
  let m; const rw=/(\d+) × (\d+) (min|s) at ~?(\d+)(?:–(\d+))? W/g;
  while((m=rw.exec(d))) g.reps.push({n:+m[1],sec:+m[2]*(m[3]==='min'?60:1),lo:+m[4],hi:m[5]?+m[5]:Math.round(+m[4]*1.05),unit:'w'});
  const rp=/(\d+) × (\d+) (min|s) at (\d+):(\d\d)\/mi/g;
  while((m=rp.exec(d))){const p=toSec(m[4],m[5]);g.reps.push({n:+m[1],sec:+m[2]*(m[3]==='min'?60:1),lo:p+10,hi:p-10,unit:'pace'});} // lo = slowest OK, hi = fastest OK (s/mi)
  const z=/Zone 2[ ,(]*(\d+)–(\d+) W/.exec(d)||/^(\d+)–(\d+) W/.exec(d)||(!g.reps.length&&/(\d+)–(\d+) W/.exec(d));
  if(z) g.steady={lo:+z[1],hi:+z[2]};
  else if(/Zone 2/.test(d)&&st) g.steady={lo:Math.round(st.ftp*0.56),hi:Math.round(st.ftp*0.72)};
  const e=/[Ee]asy (\d+):(\d\d)–(\d+):(\d\d)\/mi/.exec(d);
  if(e) g.easy={fast:toSec(e[1],e[2]),slow:toSec(e[3],e[4])};
  return g;
}

// n best non-overlapping windows of `len` samples (highest mean), in time order
function bestWindows(a,len,n){
  if(!a||a.length<len) return [];
  const pre=[0];for(let i=0;i<a.length;i++)pre.push(pre[i]+(a[i]||0));
  const means=[];for(let i=0;i+len<=a.length;i++)means.push({i,v:(pre[i+len]-pre[i])/len});
  means.sort((x,y)=>y.v-x.v); const out=[];
  for(const w of means){if(out.length>=n)break;if(out.every(o=>w.i+len<=o.i||w.i>=o.i+len))out.push(w);}
  return out.sort((x,y)=>x.i-y.i);
}
function np(w,dt){const k=Math.max(1,Math.round(30/dt));const r=[];let s=0;for(let i=0;i<w.length;i++){s+=w[i]||0;if(i>=k)s-=w[i-k]||0;if(i>=k-1)r.push(s/k)}
  return r.length?Math.pow(r.reduce((a,v)=>a+v**4,0)/r.length,0.25):null}

function analyze(s,c,stream,st){
  if(!s||!c) return null;
  const g=goalOf(s,st), out={ok:true,bits:[],head:''}; const bad=t=>{out.ok=false;out.bits.push('⚠ '+t)}, good=t=>out.bits.push('✓ '+t), info=t=>out.bits.push(t);
  const dt=stream?.dt||5, W=stream?.w?.some(v=>v>0)?stream.w:null, V=stream?.v?.some(v=>v>0)?stream.v:null, H=stream?.hr?.some(v=>v>0)?stream.hr:null;

  // duration
  if(s.min&&c.min!=null&&s.type!=='brick'){ if(c.min<s.min*0.85) bad(`Short: ${Math.round(c.min)} of ${s.min} min`); }

  if(s.type==='strength'){ out.head='Done'; return out; }

  // ── FTP / durability tests
  if(g.test&&/^ftp/.test(g.test)){
    const b=W?bestWindows(W,Math.round(1200/dt),1)[0]:null;
    if(b){const f=Math.round(b.v*0.95);info(`Best 20 min: ${Math.round(b.v)} W → FTP ≈ ${f} W (now set to ${st.ftp} W)`);
      out.head=`FTP ≈ ${f} W`; if(f>=195) good('Clears the ≥ 195 W line that keeps 5:30 live'); else if(f<=175) bad('At or under 175 W: target moves to sub-5:45'); else info('Between 175 and 195 W: 5:30 stays a stretch');
      info('Upload the FIT under Tests (or set FTP in Setup) to update every target.');}
    else { out.head='Test recorded'; info('No power stream yet. Upload the FIT under Tests to get the result.'); }
    return out;
  }
  if(g.test&&/^dur/.test(g.test)&&W){
    const last=W.slice(-Math.round(2400/dt)); const b=bestWindows(last,Math.round(1200/dt),1)[0];
    if(b){const pct=Math.round(b.v/st.ftp*100);info(`20 min at the end: ${Math.round(b.v)} W = ${pct}% of FTP after the 90 min`);out.head=`${pct}% of FTP after 90 min`;
      pct>=95?good('Durable: little fade'):bad(`Faded ${100-pct}% vs fresh FTP. Long rides and fueling are the fix.`);}
    return out;
  }

  // ── bike
  if(s.type==='bike'||(s.type==='brick'&&c.type==='bike')){
    const wReps=g.reps.filter(r=>r.unit==='w'); const used=[];
    if(W){
      for(const r of wReps){
        const len=Math.max(1,Math.round(r.sec/dt)); const ws=bestWindows(W,len,r.n); ws.forEach(w=>used.push([w.i,w.i+len]));
        const vals=ws.map(w=>Math.round(w.v)), inR=vals.filter(v=>v>=r.lo*0.97&&v<=r.hi*1.03).length, hot=vals.filter(v=>v>r.hi*1.03).length, under=vals.filter(v=>v<r.lo*0.97).length;
        const lbl=`${r.n} × ${r.sec>=60?r.sec/60+' min':r.sec+' s'}`;
        if(vals.length<r.n) bad(`${lbl}: only ${vals.length} found`);
        else if(inR===r.n) good(`${lbl}: ${vals.join(', ')} W (goal ${r.lo}–${r.hi})`);
        else if(under) bad(`${lbl}: ${vals.join(', ')} W, ${under} under ${r.lo} W`);
        else bad(`${lbl}: ${vals.join(', ')} W, ${hot} over ${r.hi} W (harder than asked)`);
      }
      if(g.steady){
        const mask=W.map((_,i)=>used.some(([a,b])=>i>=a&&i<b)); const rest=W.filter((v,i)=>!mask[i]&&v>20);
        if(rest.length>=12){
          const above=rest.filter(v=>v>g.steady.hi*1.05).length/rest.length, inside=rest.filter(v=>v>=g.steady.lo*0.95&&v<=g.steady.hi*1.05).length/rest.length;
          const n2=np(W.map((v,i)=>mask[i]?0:v),dt), avg=rest.reduce((a,v)=>a+v,0)/rest.length;
          const txt=`${wReps.length?'Rest of ride':'Steady'}: avg ${Math.round(avg)} W, ${Math.round(inside*100)}% in ${g.steady.lo}–${g.steady.hi} W`;
          if(above>0.2||avg>g.steady.hi*1.03) bad(`${txt}, ${Math.round(above*100)}% above. Easier next time; easy days make the hard days work.`);
          else if(avg<g.steady.lo*0.9) bad(`${txt}. A bit under: fine on a tired day.`);
          else good(txt);
          if(!wReps.length&&n2) info(`NP ${Math.round(n2)} W`);
        }
      }
    } else if(c.np||c.w){
      if(wReps.length) info(`Intervals not checked yet (no power stream). NP ${Math.round(c.np||c.w)} W`);
      else if(g.steady){const p=c.np||c.w; p>g.steady.hi*1.03?bad(`NP ${Math.round(p)} W: above ${g.steady.hi} W, harder than asked`):p<g.steady.lo*0.9?bad(`NP ${Math.round(p)} W: under ${g.steady.lo} W`):good(`NP ${Math.round(p)} W, in ${g.steady.lo}–${g.steady.hi} W`);}
    } else info('No power (Whoop only): heart rate only, so the targets can’t be checked.');
    if(c.decouple!=null&&c.min>=60&&!wReps.length) (Math.abs(c.decouple)<=5?good:info)(`HR drift ${c.decouple.toFixed(1)}% (under 5% = aerobically solid)`);
  }

  // ── run
  if(s.type==='run'||(s.type==='brick'&&c.type==='run')){
    const pReps=g.reps.filter(r=>r.unit==='pace');
    const moving=V?V.filter(v=>v>1.6):null;   // drop stops and walking (slower than ~16:45/mi)
    if(moving&&moving.length>=12){
      for(const r of pReps){
        const len=Math.max(1,Math.round(r.sec/dt)); const ws=bestWindows(V,len,r.n); const ps=ws.map(w=>1609.344/w.v);
        const lbl=`${r.n} × ${r.sec>=60?r.sec/60+' min':r.sec+' s'}`, shown=ps.map(p=>mmss(p)).join(', ');
        const slow=ps.filter(p=>p>r.lo).length, fast=ps.filter(p=>p<r.hi).length;
        if(ws.length<r.n) bad(`${lbl}: only ${ws.length} found`);
        else if(!slow&&!fast) good(`${lbl}: ${shown}/mi (goal ${mmss((r.lo+r.hi)/2)})`);
        else if(slow) bad(`${lbl}: ${shown}/mi, ${slow} slower than ${mmss(r.lo)}`);
        else bad(`${lbl}: ${shown}/mi, ${fast} faster than ${mmss(r.hi)} (save it for race day)`);
      }
      if(!pReps.length&&g.easy){
        const avgV=moving.reduce((a,v)=>a+v,0)/moving.length, p=1609.344/avgV;
        if(p<g.easy.fast-5) bad(`Avg ${mmss(p)}/mi: faster than easy (${mmss(g.easy.fast)}–${mmss(g.easy.slow)}). Slow down; easy should feel easy.`);
        else good(`Avg ${mmss(p)}/mi, in or slower than easy (${mmss(g.easy.fast)}–${mmss(g.easy.slow)})`);
      }
      if(g.strides){ const k=Math.round(20/dt)||1; const base=moving.reduce((a,v)=>a+v,0)/moving.length; let cnt=0;
        for(let i=0;i+k<=V.length;){const m=V.slice(i,i+k).reduce((a,v)=>a+(v||0),0)/k; if(m>base*1.25){cnt++;i+=k+Math.round(30/dt)}else i++;}
        cnt>=4?good(`${cnt} strides`):info(`${cnt} strides found (goal 4–6)`); }
    } else if(c.dist_m&&c.min&&!pReps.length&&g.easy){
      const p=c.min*60/(c.dist_m/1609.344); p<g.easy.fast-5?bad(`Avg ${mmss(p)}/mi: faster than easy`):good(`Avg ${mmss(p)}/mi`);
    } else {
      const cap=Math.round(st.lthr*0.89);
      if(pReps.length) info('No pace data (no GPS file), so the reps can’t be checked. Record runs on a Garmin to get this.');
      else if(c.hr){ c.hr>cap+3?bad(`Avg HR ${Math.round(c.hr)}: above the easy cap (~${cap}). Slow down.`):good(`Avg HR ${Math.round(c.hr)}, under the easy cap (~${cap})`); }
    }
  }

  if(s.type==='swim') info('Swim logged.');
  const warns=out.bits.filter(b=>b.startsWith('⚠')).length;
  const goods=out.bits.filter(b=>b.startsWith('✓')).length;
  out.head=out.head||(!warns?'On target':goods?'Partly on target':'Off target');
  if(!out.bits.length) out.head='Done';
  return out;
}
const API={analyze,goalOf,bestWindows,pace};
if(typeof window!=='undefined') window.ANALYZE=API;
if(typeof module!=='undefined') module.exports=API;
})();
