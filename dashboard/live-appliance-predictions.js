(() => {
"use strict";
const cfg=window.SMART_BUILDING_CONFIG||{};
if(!window.supabase||!cfg.SUPABASE_URL||!cfg.SUPABASE_PUBLISHABLE_KEY){document.getElementById("status").textContent="تنظیمات Supabase پیدا نشد.";return;}
const db=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false}});
const TZ=cfg.DISPLAY_TIME_ZONE||"Asia/Tehran";
const MODEL="v17_hybrid";
const $=id=>document.getElementById(id);
const fmtTime=x=>x?new Intl.DateTimeFormat("fa-IR",{timeZone:TZ,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date(x)):"—";
const pct=x=>x==null?"—":`${(Number(x)*100).toFixed(1)}%`;
const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function humanClass(c){return String(c||"—").replaceAll("_"," ");}
function statusClass(s){return s==="CORRECT"?"good":s==="WRONG"?"bad":s==="WAITING_GROUND_TRUTH"?"warning":"";}

function renderLatest(p){
 if(!p)return;
 $("latest-class").textContent=humanClass(p.prediction_class);
 $("latest-confidence").textContent=pct(p.confidence);
 $("latest-delta").textContent=p.current_delta_a==null?"—":`${Number(p.current_delta_a)>=0?"+":""}${Number(p.current_delta_a).toFixed(4)} A`;
 $("latest-routing").textContent=p.routing||"—";
 $("latest-sequence").textContent=p.sequence_role||"—";
 $("latest-time").textContent=fmtTime(p.event_started_at);
 $("model-version").textContent=p.model_version||"—";
 $("live-dot").classList.add("on");
 const flags=[];
 if(p.uncertain)flags.push("UNCERTAIN");
 if(p.power_recovery)flags.push("POWER RECOVERY");
 if(p.backfilled)flags.push("BACKFILLED");
 $("latest-flags").innerHTML=flags.map(x=>`<span class="flag">${x}</span>`).join("");
}

function renderRecent(rows){
 $("recent").innerHTML=rows.map(r=>`<tr>
 <td>${esc(fmtTime(r.event_started_at))}</td>
 <td>${esc(r.predicted_appliance)}</td><td>${esc(r.predicted_action)}</td>
 <td class="pct">${esc(pct(r.confidence))}</td>
 <td>${esc(r.sequence_role||"—")}</td>
 <td>${r.uncertain?'<span class="warning">UNCERTAIN</span>':r.power_recovery?'<span class="warning">RECOVERY</span>':'عادی'}</td>
 </tr>`).join("")||`<tr><td colspan="6">داده‌ای وجود ندارد.</td></tr>`;
}

function renderEvalSummary(row){
 if(!row)return;
 $("eval-count").textContent=row.evaluated??0;
 $("eval-correct").textContent=row.correct??0;
 $("eval-accuracy").textContent=pct(row.accuracy);
 $("eval-f1").textContent=pct(row.macro_f1);
 $("eval-waiting").textContent=row.waiting_ground_truth??0;
 $("eval-combined").textContent=row.combined_excluded??0;
}

function renderClassMetrics(rows){
 $("class-metrics").innerHTML=rows.map(r=>`<tr><td>${esc(humanClass(r.class_name))}</td><td>${esc(pct(r.precision))}</td><td>${esc(pct(r.recall))}</td><td><strong>${esc(pct(r.f1))}</strong></td><td>${esc(r.support)}</td></tr>`).join("")||`<tr><td colspan="5">هنوز Ground Truth کافی نیست.</td></tr>`;
}

function renderEvalHistory(rows){
 $("evaluation-history").innerHTML=rows.map(r=>`<tr>
 <td>${esc(fmtTime(r.event_started_at))}</td>
 <td>${esc(humanClass(r.prediction_class))}</td>
 <td>${esc(humanClass(r.ground_truth_class||"—"))}</td>
 <td class="${statusClass(r.evaluation_status)}">${esc(r.evaluation_status)}</td></tr>`).join("")||`<tr><td colspan="4">هنوز مقایسه‌ای وجود ندارد.</td></tr>`;
}

function timelineIntervals(rows, appliance, startMs, endMs){
 const ev=rows.filter(r=>r.predicted_appliance===appliance).slice().sort((a,b)=>new Date(a.event_started_at)-new Date(b.event_started_at));
 const bars=[]; const markers=[]; let open=null;
 for(const r of ev){
   const t=new Date(r.event_started_at).getTime();
   if(r.sequence_role==="CONTINUATION")continue;
   if(r.predicted_action==="ON"){if(open==null)open=t;}
   else if(r.predicted_action==="OFF"){if(open!=null){bars.push([Math.max(open,startMs),Math.min(t,endMs)]);open=null;}else markers.push(t);}
 }
 if(open!=null)bars.push([Math.max(open,startMs),endMs]);
 return {bars,markers};
}
function renderTimeline(rows){
 const now=Date.now(), start=now-24*3600e3, appliances=["FRIDGE","PORTABLE_AC","MAIN_ROOM_LIGHT","UNKNOWN"];
 $("timeline").innerHTML=appliances.map(a=>{
   const x=timelineIntervals(rows,a,start,now);
   const bars=x.bars.filter(([s,e])=>e>s).map(([s,e])=>`<span class="timeline-bar" style="right:${((s-start)/(now-start)*100).toFixed(3)}%;width:${((e-s)/(now-start)*100).toFixed(3)}%" title="${esc(fmtTime(s))} – ${esc(fmtTime(e))}"></span>`).join("");
   const marks=x.markers.filter(t=>t>=start&&t<=now).map(t=>`<span class="timeline-marker" style="right:${((t-start)/(now-start)*100).toFixed(3)}%" title="OFF بدون ON قبلی"></span>`).join("");
   return `<div class="timeline-row"><div class="timeline-name">${esc(a.replaceAll("_"," "))}</div><div class="timeline-track">${bars}${marks}</div></div>`;
 }).join("");
}

function renderConfidence(rows){
 const data=rows.slice().reverse();
 const W=1000,H=240,pad=35;
 if(!data.length){$("confidence-chart").innerHTML="<p class='muted'>داده‌ای نیست.</p>";return;}
 const minT=Math.min(...data.map(r=>new Date(r.event_started_at).getTime())), maxT=Math.max(...data.map(r=>new Date(r.event_started_at).getTime()));
 const dx=Math.max(1,maxT-minT);
 const points=data.map(r=>{const x=pad+(new Date(r.event_started_at).getTime()-minT)/dx*(W-2*pad);const y=H-pad-Number(r.confidence)*(H-2*pad);return `${x.toFixed(1)},${y.toFixed(1)}`}).join(" ");
 $("confidence-chart").innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Confidence trend">
 <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H-pad}" stroke="currentColor" opacity=".25"/>
 <line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" stroke="currentColor" opacity=".25"/>
 <line x1="${pad}" y1="${pad}" x2="${W-pad}" y2="${pad}" stroke="currentColor" opacity=".12"/>
 <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="3" opacity=".8"/>
 <text x="3" y="${pad+5}" font-size="12" fill="currentColor">100%</text><text x="10" y="${H-pad+4}" font-size="12" fill="currentColor">0%</text>
 </svg>`;
}

async function loadAll(){
 $("status").textContent="در حال دریافت داده‌های کوچک prediction/evaluation…";
 const since=new Date(Date.now()-24*3600e3).toISOString();
 const [pRes,sRes,cRes,eRes]=await Promise.all([
  db.from("live_appliance_predictions").select("event_id,event_started_at,current_delta_a,prediction_class,predicted_appliance,predicted_action,confidence,routing,uncertain,sequence_role,power_recovery,backfilled,model_version").eq("model_version",MODEL).gte("event_started_at",since).order("event_started_at",{ascending:false}).limit(200),
  db.from("live_appliance_evaluation_summary").select("model_version,total_predictions,waiting_ground_truth,combined_excluded,evaluated,correct,incorrect,accuracy,macro_f1").eq("model_version",MODEL).maybeSingle(),
  db.from("live_appliance_evaluation_class_metrics").select("class_name,precision,recall,f1,support").eq("model_version",MODEL).order("class_name"),
  db.from("live_appliance_prediction_evaluation").select("event_id,event_started_at,prediction_class,ground_truth_class,evaluation_status,confidence").eq("model_version",MODEL).order("event_started_at",{ascending:false}).limit(50)
 ]);
 for(const r of [pRes,sRes,cRes,eRes])if(r.error)throw r.error;
 const preds=pRes.data||[];
 renderLatest(preds[0]);renderRecent(preds.slice(0,50));renderTimeline(preds);renderConfidence(preds.slice(0,100));
 renderEvalSummary(sRes.data);renderClassMetrics(cRes.data||[]);renderEvalHistory(eRes.data||[]);
 $("status").textContent=`آخرین به‌روزرسانی: ${fmtTime(new Date())} · prediction rows=${preds.length}`;
}

$("refresh").addEventListener("click",()=>loadAll().catch(showErr));
function showErr(e){console.error(e);$("status").textContent=`خطا: ${e?.message||e}`;}
loadAll().catch(showErr);

// Realtime ONLY on the tiny prediction table.
const channel=db.channel("live-appliance-predictions-v20")
 .on("postgres_changes",{event:"INSERT",schema:"public",table:"live_appliance_predictions",filter:`model_version=eq.${MODEL}`},payload=>{
    renderLatest(payload.new);
    // Refresh compact lists/metrics once after a new prediction.
    loadAll().catch(showErr);
 })
 .subscribe(status=>{if(status==="SUBSCRIBED")$("status").textContent="Realtime prediction متصل است.";});

// Ground-truth responses are intentionally NOT subscribed to avoid extra payload.
// Small evaluation views are refreshed every 60 seconds.
setInterval(()=>loadAll().catch(showErr),60000);
})();