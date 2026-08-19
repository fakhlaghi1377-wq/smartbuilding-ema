(()=>{
"use strict";
const cfg=window.SMART_BUILDING_CONFIG||{};
const $=id=>document.getElementById(id);
if(!window.supabase||!cfg.SUPABASE_URL||!cfg.SUPABASE_PUBLISHABLE_KEY){$("status").textContent="تنظیمات Supabase پیدا نشد.";return;}
const db=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false}});
const MODEL="v17_hybrid",TZ=cfg.DISPLAY_TIME_ZONE||"Asia/Tehran";
const pct=x=>x==null?"—":`${(Number(x)*100).toFixed(1)}%`;
const tm=x=>x?new Intl.DateTimeFormat("fa-IR",{timeZone:TZ,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(x)):"—";
const faApp=x=>({FRIDGE:"یخچال",PORTABLE_AC:"کولر پرتابل",MAIN_ROOM_LIGHT:"چراغ اتاق اصلی",UNKNOWN:"نامشخص"}[x]||x||"—");
const faAct=x=>x==="ON"?"روشن":x==="OFF"?"خاموش":"—";
const cls=x=>String(x||"—").replaceAll("_"," ");
function renderLatest(p){
 if(!p)return;
 $("latest-device").textContent=faApp(p.interpreted_appliance||p.predicted_appliance);
 $("latest-action").textContent=faAct(p.interpreted_action||p.predicted_action);
 const c=p.interpreted_confidence??p.confidence;$("latest-confidence").textContent=pct(c);$("bar").style.width=`${Math.max(0,Math.min(100,Number(c)*100))}%`;
 $("latest-time").textContent=`زمان: ${tm(p.event_started_at)}`;$("dot").classList.add("on");
 const f=[];if(p.interpretation_applied)f.push("CONTEXT APPLIED");if(p.uncertain)f.push("UNCERTAIN");if(p.power_recovery)f.push("POWER RECOVERY");if(p.backfilled)f.push("BACKFILLED");
 $("flags").innerHTML=f.map(x=>`<span class="flag">${x}</span>`).join("");
}
function estimateAddedWatts(deltaA){
 const a=Math.abs(Number(deltaA)||0);
 return a*220*0.90;
}
function loadWarning(watts,action){
 if(action!=="ON")return {text:"خاموش / بدون بار فعال",klass:"neutral"};
 if(watts>=1000)return {text:"⚠ مصرف بسیار بالا",klass:"very-high"};
 if(watts>=500)return {text:"⚠ مصرف بالا",klass:"high"};
 if(watts>=150)return {text:"مصرف متوسط",klass:"low"};
 return {text:"مصرف کم",klass:"low"};
}
function states(rows){
 for(const a of ["FRIDGE","PORTABLE_AC","MAIN_ROOM_LIGHT","UNKNOWN"]){
   const r=rows.find(x=>(x.interpreted_appliance||x.predicted_appliance)===a&&x.sequence_role!=="CONTINUATION");
   const e=$(`state-${a}`),t=$(`time-${a}`);
   if(!e||!t)continue;
   if(!r){
     e.textContent="نامشخص";e.className="";t.textContent="—";
     if(a==="UNKNOWN"){
       $("unknown-power").textContent="توان افزوده تقریبی: —";
       $("unknown-warning").textContent="در انتظار بار نامشخص";
       $("unknown-warning").className="load-warning neutral";
     }
     continue;
   }
   const act=r.interpreted_action||r.predicted_action;
   e.textContent=faAct(act);e.className=act==="ON"?"on":"off";t.textContent=tm(r.event_started_at);

   if(a==="UNKNOWN"){
     const watts=estimateAddedWatts(r.current_delta_a);
     $("unknown-power").textContent=
       act==="ON"
       ? `توان افزوده تقریبی: ${Math.round(watts)} W · ΔI ${Number(r.current_delta_a)>=0?"+":""}${Number(r.current_delta_a).toFixed(3)} A`
       : `آخرین ΔI: ${Number(r.current_delta_a)>=0?"+":""}${Number(r.current_delta_a).toFixed(3)} A`;
     const w=loadWarning(watts,act);
     $("unknown-warning").textContent=w.text;
     $("unknown-warning").className=`load-warning ${w.klass}`;
   }
 }
}
function recent(rows){
 $("recent").innerHTML=rows.slice(0,12).map(r=>{
   const raw=cls(r.prediction_class),ctx=cls(r.interpreted_prediction_class||r.prediction_class),changed=raw!==ctx;
   return `<div class="recent"><span>${tm(r.event_started_at)}</span><span><b>${faApp(r.interpreted_appliance||r.predicted_appliance)}</b> · ${faAct(r.interpreted_action||r.predicted_action)}</span><span>${pct(r.interpreted_confidence??r.confidence)}</span><span class="${changed?"changed":""}">${changed?"Context":"Raw"}</span></div>`;
 }).join("")||"<p class='muted'>داده‌ای نیست.</p>";
}
function summary(s){if(!s)return;$("raw-acc").textContent=pct(s.raw_accuracy);$("ctx-acc").textContent=pct(s.interpreted_accuracy);$("raw-f1").textContent=pct(s.raw_macro_f1);$("ctx-f1").textContent=pct(s.interpreted_macro_f1);$("evaluated").textContent=s.evaluated??0;$("ctx-count").textContent=s.context_applied??0;}
function evalRows(rows){$("eval-history").innerHTML=rows.map(r=>`<tr><td>${tm(r.event_started_at)}</td><td>${cls(r.raw_prediction_class)}</td><td>${cls(r.interpreted_prediction_class)}</td><td>${cls(r.ground_truth_class)}</td><td class="${r.raw_status==="CORRECT"?"good":r.raw_status==="WRONG"?"bad":"waiting"}">${r.raw_status}</td><td class="${r.interpreted_status==="CORRECT"?"good":r.interpreted_status==="WRONG"?"bad":"waiting"}">${r.interpreted_status}</td></tr>`).join("");}

function estimatedPowerW(deltaA){
 return Math.abs(Number(deltaA)||0)*220*0.90;
}

function timelineIntervals(rows, appliance, startMs, endMs){
 const relevant=rows
  .filter(r=>(r.interpreted_appliance||r.predicted_appliance)===appliance)
  .filter(r=>r.sequence_role!=="CONTINUATION")
  .slice()
  .sort((a,b)=>new Date(a.event_started_at)-new Date(b.event_started_at));

 const bars=[];
 const markers=[];
 let open=null;

 for(const r of relevant){
   const t=new Date(r.event_started_at).getTime();
   const action=r.interpreted_action||r.predicted_action;

   if(appliance==="UNKNOWN"){
     if(t>=startMs&&t<=endMs)markers.push({t,row:r});
     continue;
   }

   if(action==="ON"){
     if(open==null)open=t;
   }else if(action==="OFF"){
     if(open!=null){
       bars.push([Math.max(open,startMs),Math.min(t,endMs)]);
       open=null;
     }else{
       markers.push({t,row:r});
     }
   }
 }
 if(appliance!=="UNKNOWN"&&open!=null){
   bars.push([Math.max(open,startMs),endMs]);
 }
 return {bars,markers};
}

function renderActivityTimeline(rows){
 const end=Date.now();
 const start=end-24*3600e3;
 const apps=[
  ["FRIDGE","یخچال"],
  ["PORTABLE_AC","کولر پرتابل"],
  ["MAIN_ROOM_LIGHT","چراغ اتاق اصلی"],
  ["UNKNOWN","بار نامشخص"]
 ];

 const scale=`<div class="timeline-scale"><span>۲۴ ساعت قبل</span><span>۱۸ ساعت</span><span>۱۲ ساعت</span><span>۶ ساعت</span><span>اکنون</span></div>`;

 $("activity-timeline").innerHTML=apps.map(([app,label])=>{
   const x=timelineIntervals(rows,app,start,end);

   const bars=x.bars
    .filter(([s,e])=>e>s)
    .map(([s,e])=>{
      const right=((s-start)/(end-start))*100;
      const width=((e-s)/(end-start))*100;
      return `<span class="timeline-segment" style="right:${right.toFixed(3)}%;width:${width.toFixed(3)}%" title="${tm(s)} تا ${tm(e)}"></span>`;
    }).join("");

   const markers=x.markers
    .filter(m=>m.t>=start&&m.t<=end)
    .map(m=>{
      const right=((m.t-start)/(end-start))*100;
      const p=estimatedPowerW(m.row.current_delta_a);
      const cls=app==="UNKNOWN"?"timeline-marker timeline-unknown":"timeline-marker";
      return `<span class="${cls}" style="right:${right.toFixed(3)}%" title="${tm(m.t)} · ${Math.round(p)} W"></span>`;
    }).join("");

   return `<div class="timeline-row">
     <div class="timeline-label">${label}</div>
     <div><div class="timeline-track">${bars}${markers}</div>${scale}</div>
   </div>`;
 }).join("");
}

function renderLoadEventChart(rows){
 const data=rows
  .slice(0,100)
  .slice()
  .reverse()
  .map(r=>({
    t:new Date(r.event_started_at).getTime(),
    power:(Number(r.current_delta_a)>=0?1:-1)*estimatedPowerW(r.current_delta_a),
    app:r.interpreted_appliance||r.predicted_appliance,
    action:r.interpreted_action||r.predicted_action,
    conf:r.interpreted_confidence??r.confidence,
    context:!!r.interpretation_applied,
    eventId:r.event_id
  }))
  .filter(d=>Number.isFinite(d.t)&&Number.isFinite(d.power));

 if(!data.length){
   $("load-event-chart").innerHTML="<p class='muted'>داده‌ای نیست.</p>";
   return;
 }

 const W=1080,H=340;
 const padL=76,padR=28,padT=34,padB=48;
 const minT=Math.min(...data.map(d=>d.t));
 const maxT=Math.max(...data.map(d=>d.t));
 const spanT=Math.max(1,maxT-minT);

 // Give the largest event a little headroom so labels do not touch the border.
 const rawMax=Math.max(100,...data.map(d=>Math.abs(d.power)));
 const maxAbs=Math.ceil(rawMax*1.18/50)*50;

 const x=d=>padL+(d.t-minT)/spanT*(W-padL-padR);
 const y=p=>padT+(maxAbs-p)/(2*maxAbs)*(H-padT-padB);
 const zeroY=y(0);

 const fmtW=v=>{
   const abs=Math.abs(v);
   if(abs>=1000)return `${(v/1000).toFixed(abs>=10000?0:1)}kW`;
   return `${Math.round(v)}W`;
 };

 const gridFractions=[-1,-0.5,0,0.5,1];
 const grid=gridFractions.map(k=>{
   const val=maxAbs*k;
   const yy=y(val);
   const strong=k===0;
   return `
     <line
       x1="${padL}" y1="${yy}"
       x2="${W-padR}" y2="${yy}"
       class="${strong?"load-zero-line":"load-grid-line"}"
     />
     <text x="${padL-10}" y="${yy+4}" text-anchor="end" class="load-axis-label">${fmtW(val)}</text>
   `;
 }).join("");

 // Time ticks: start, 25%, 50%, 75%, end.
 const timeTicks=[0,.25,.5,.75,1].map(f=>{
   const tt=minT+spanT*f;
   const xx=padL+(W-padL-padR)*f;
   return `
     <line x1="${xx}" y1="${padT}" x2="${xx}" y2="${H-padB}" class="load-time-grid"/>
     <text x="${xx}" y="${H-17}" text-anchor="middle" class="load-axis-label">${tm(tt)}</text>
   `;
 }).join("");

 const appShort=app=>({
   FRIDGE:"یخچال",
   PORTABLE_AC:"کولر",
   MAIN_ROOM_LIGHT:"چراغ",
   UNKNOWN:"نامشخص"
 }[app]||app||"—");

 function radiusFor(power){
   // Magnitude-aware but capped so one microwave event does not dominate.
   const scaled=4+Math.sqrt(Math.abs(power)/Math.max(1,maxAbs))*8;
   return Math.max(4,Math.min(12,scaled));
 }

 function pointClass(d){
   if(d.app==="UNKNOWN")return "load-point unknown";
   if(d.power>=0)return "load-point load-on";
   return "load-point load-off";
 }

 function shape(d,cx,cy,r){
   const title=`event ${d.eventId} | ${appShort(d.app)} ${faAct(d.action)} | ${d.power>=0?"+":""}${Math.round(d.power)} W | اطمینان ${pct(d.conf)}${d.context?" | Context":""}`;

   // UNKNOWN = diamond, ON = triangle up, OFF = triangle down.
   if(d.app==="UNKNOWN"){
     const pts=[
       [cx,cy-r],[cx+r,cy],[cx,cy+r],[cx-r,cy]
     ].map(p=>p.join(",")).join(" ");
     return `<polygon points="${pts}" class="${pointClass(d)}${d.context?" context-point":""}"><title>${title}</title></polygon>`;
   }

   if(d.power>=0){
     const pts=[
       [cx,cy-r],[cx+r*.95,cy+r*.8],[cx-r*.95,cy+r*.8]
     ].map(p=>p.join(",")).join(" ");
     return `<polygon points="${pts}" class="${pointClass(d)}${d.context?" context-point":""}"><title>${title}</title></polygon>`;
   }

   const pts=[
     [cx,cy+r],[cx+r*.95,cy-r*.8],[cx-r*.95,cy-r*.8]
   ].map(p=>p.join(",")).join(" ");
   return `<polygon points="${pts}" class="${pointClass(d)}${d.context?" context-point":""}"><title>${title}</title></polygon>`;
 }

 const points=data.map(d=>{
   const cx=x(d),cy=y(d.power),r=radiusFor(d.power);
   const highUnknown=d.app==="UNKNOWN"&&Math.abs(d.power)>=500;
   const veryHighUnknown=d.app==="UNKNOWN"&&Math.abs(d.power)>=1000;

   // Direct labels only where they add information.
   const shouldLabel=veryHighUnknown || d.context || Math.abs(d.power)>=maxAbs*.72;
   const label=shouldLabel
     ? `<g class="load-direct-label">
          <rect x="${Math.min(W-padR-118,cx+10)}" y="${Math.max(padT,cy-28)}" width="108" height="22" rx="7"></rect>
          <text x="${Math.min(W-padR-110,cx+18)}" y="${Math.max(padT+15,cy-13)}">${appShort(d.app)} · ${fmtW(d.power)}</text>
        </g>`
     : "";

   const bolt=veryHighUnknown
     ? `<text x="${cx+10}" y="${cy-12}" class="high-load-bolt">⚡</text>`
     : "";

   const halo=highUnknown
     ? `<circle cx="${cx}" cy="${cy}" r="${r+6}" class="unknown-high-halo"></circle>`
     : "";

   return `<g class="load-event-node">${halo}${shape(d,cx,cy,r)}${bolt}${label}</g>`;
 }).join("");

 $("load-event-chart").innerHTML=`
 <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="تایم‌لاین تغییر بار وسایل">
   <text x="${padL}" y="18" class="load-zone-label load-zone-on">افزایش بار / روشن‌شدن</text>
   <text x="${padL}" y="${H-2}" class="load-zone-label load-zone-off">کاهش بار / خاموش‌شدن</text>

   ${grid}
   ${timeTicks}

   <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H-padB}" class="load-axis-line"/>
   ${points}
 </svg>`;
}

function renderEventHistory(rows){
 $("event-history").innerHTML=rows.slice(0,30).map(r=>{
   const app=r.interpreted_appliance||r.predicted_appliance;
   const action=r.interpreted_action||r.predicted_action;
   const watts=(Number(r.current_delta_a)>=0?1:-1)*estimatedPowerW(r.current_delta_a);
   const absW=Math.abs(watts);
   let powerClass="";
   if(absW>=1000)powerClass="event-very-high";
   else if(absW>=500)powerClass="event-high";
   const type=r.interpretation_applied?"Context":r.sequence_role==="CONTINUATION"?"Continuation":"Raw";
   return `<tr>
    <td>${tm(r.event_started_at)}</td>
    <td>${faApp(app)}</td>
    <td>${faAct(action)}</td>
    <td>${Number(r.current_delta_a)>=0?"+":""}${Number(r.current_delta_a).toFixed(3)} A</td>
    <td class="${powerClass}">${watts>=0?"+":""}${Math.round(watts)} W</td>
    <td>${pct(r.interpreted_confidence??r.confidence)}</td>
    <td class="${r.interpretation_applied?"event-context":""}">${type}</td>
   </tr>`;
 }).join("")||`<tr><td colspan="7">داده‌ای نیست.</td></tr>`;
}

async function load(){
 $("status").textContent="در حال دریافت…";
 const since=new Date(Date.now()-24*3600e3).toISOString();
 const [p,s,e]=await Promise.all([
  db.from("live_appliance_predictions").select("event_id,event_started_at,current_delta_a,prediction_class,predicted_appliance,predicted_action,confidence,interpreted_prediction_class,interpreted_appliance,interpreted_action,interpreted_confidence,interpretation_applied,uncertain,sequence_role,power_recovery,backfilled").eq("model_version",MODEL).gte("event_started_at",since).order("event_started_at",{ascending:false}).limit(100),
  db.from("live_appliance_evaluation_summary_v21").select("*").eq("model_version",MODEL).maybeSingle(),
  db.from("live_appliance_prediction_evaluation_v21").select("event_started_at,raw_prediction_class,interpreted_prediction_class,ground_truth_class,raw_status,interpreted_status").eq("model_version",MODEL).order("event_started_at",{ascending:false}).limit(30)
 ]);
 for(const r of [p,s,e])if(r.error)throw r.error;
 const rows=p.data||[];renderLatest(rows[0]);states(rows);recent(rows);renderActivityTimeline(rows);renderLoadEventChart(rows);renderEventHistory(rows);summary(s.data);evalRows(e.data||[]);$("status").textContent=`آخرین به‌روزرسانی: ${tm(new Date())} · نمودارها از همین ${rows.length} prediction ساخته شدند`;
}
function err(e){console.error(e);$("status").textContent=`خطا: ${e?.message||e}`;}
$("refresh").addEventListener("click",()=>load().catch(err));load().catch(err);
db.channel("pred-v21").on("postgres_changes",{event:"*",schema:"public",table:"live_appliance_predictions",filter:`model_version=eq.${MODEL}`},()=>load().catch(err)).subscribe();
setInterval(()=>load().catch(err),60000);
})();