const $=id=>document.getElementById(id);
function paint(t){
 $('north').textContent=`${Number(t.north_cm||0).toFixed(1)} cm`; $('east').textContent=`${Number(t.east_cm||0).toFixed(1)} cm`;
 $('timer').textContent=`${t.remaining_sec||0} s`; $('mode').textContent=t.mode||'AUTO';
 $('device').textContent=t.device_id||'--';
 $('ns').textContent=t.ns_signal||'RED'; $('ew').textContent=t.ew_signal||'GREEN';
 $('ns').className='signal '+String(t.ns_signal||'RED').toLowerCase(); $('ew').className='signal '+String(t.ew_signal||'GREEN').toLowerCase();
 $('countN').textContent=`${t.north_count||0} vehicles`; $('countE').textContent=`${t.east_count||0} vehicles`;
 $('barN').style.width=Math.min(100,(t.north_count||0)*10)+'%'; $('barE').style.width=Math.min(100,(t.east_count||0)*10)+'%';
 const total=(t.north_count||0)+(t.east_count||0); $('density').textContent=`${total} · ${total>=10?'High':total>=4?'Moderate':'Low'}`;
 $('access').textContent='Security: '+(t.access_granted?'ACCESS GRANTED':'locked');
}
function renderRows(records){
 const body=$('log'); body.replaceChildren();
 for(const t of records){
  const row=document.createElement('tr');
  const values=[new Date(t.ts).toLocaleTimeString(),t.device_id,Number(t.north_cm||0).toFixed(1),Number(t.east_cm||0).toFixed(1),t.ns_signal,t.ew_signal,`${t.remaining_sec||0}s`,t.mode];
  for(const value of values){const cell=document.createElement('td');cell.textContent=value??'';row.append(cell)}
  body.append(row);
 }
}
async function load(){try{const r=await fetch('/api/telemetry?limit=30');if(!r.ok)throw new Error('Telemetry request failed');renderRows(await r.json())}catch(e){}}
async function updateHealth(){
 try{
  const r=await fetch('/health');const health=await r.json();
  $('status').textContent=`MQTT: ${health.mqtt||'unknown'}`;
  $('database-status').textContent=`DB: ${health.database||'unknown'}`;
 }catch(e){$('status').textContent='MQTT: UNAVAILABLE';$('database-status').textContent='DB: UNAVAILABLE'}
}
window.control=async mode=>{
 const response=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})});
 if(!response.ok)alert((await response.json()).error||'Control command failed');
};
$('refresh').onclick=load; load();
updateHealth();setInterval(updateHealth,5000);
const es=new EventSource('/events');es.onmessage=e=>{const t=JSON.parse(e.data);paint(t);load()};es.onerror=()=>{$('status').textContent='MQTT: RECONNECTING'};
