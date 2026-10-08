/**
 * Single-file status dashboard. It is static HTML; all data comes from the
 * bearer-protected /api endpoints using a token the owner pastes in (kept in
 * sessionStorage only), so the page itself discloses nothing.
 */
export function renderDashboard(version: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Machine Fabric</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e3e2dd;--ok:#1f7a3a;--bad:#b3261e;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--mut:#9b9a94;--card:#1e1e1c;--line:#2e2d2a;--ok:#5cc27a;--bad:#ff8a80;--warn:#e3b341}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}.mut{color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:600}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
input{width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.wrap{overflow-x:auto}
</style></head><body><main>
<h1>Machine Fabric</h1><div class="mut">hub v${version} · <span id="upd">not loaded</span></div>
<div class="card" id="login"><label>Personal access token (scope fabric:read). Stored in this tab only.<br><input id="tok" type="password" autocomplete="off" placeholder="mmf_pat_…"></label></div>
<div id="machines" class="grid"></div>
<div class="card"><b>Recent requests</b><div class="wrap"><table id="reqs"><thead><tr><th>time</th><th>machine</th><th>tool</th><th>state</th><th>ms</th><th>principal</th><th>request</th></tr></thead><tbody></tbody></table></div></div>
<script>
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let tok=""; try{tok=sessionStorage.getItem("mmf_tok")||""}catch(e){}
$("#tok").value=tok;
$("#tok").addEventListener("change",e=>{tok=e.target.value.trim();try{sessionStorage.setItem("mmf_tok",tok)}catch(_){};load()});
async function api(p){const r=await fetch(p,{headers:{Authorization:"Bearer "+tok}});if(!r.ok)throw new Error(p+" "+r.status);return r.json()}
function stateCls(s){return s==="completed"?"ok":(s==="failed"||s==="dispatched_unknown")?"bad":"warn"}
async function load(){
  if(!tok){return}
  try{
    const st=await api("/api/status");
    $("#machines").innerHTML=st.machines.map(m=>\`<div class="card"><b>\${esc(m.machine)}</b> <span class="pill \${m.ready?"ok":"bad"}">\${m.ready?"ready":esc(m.reason)}</span>
    <div class="mut">\${m.agent?esc(m.agent.platform+"/"+m.agent.arch+" · "+m.agent.hostname+" · agent "+m.agent.agent_version):"no agent"}</div>
    <div>heartbeat: \${m.heartbeat_rtt_ms??"–"} ms rtt, \${m.heartbeat_age_ms==null?"–":Math.round(m.heartbeat_age_ms/1000)+"s ago"}</div>
    <div>executor: \${m.executor?esc(m.executor.active_calls+"/"+m.executor.capacity+" active · "+m.executor.running_jobs+" jobs · lag "+m.executor.loop_lag_ms+"ms"):"–"} · in flight \${m.in_flight}</div>
    <div class="mut">\${m.agent?esc("roots: "+m.agent.policy.roots.join(", ")+(m.agent.policy.read_only?" · read-only":"")+(m.agent.policy.allow_exec?"":" · no exec")):""}</div>
    <div class="mut">last seen \${esc(m.last_seen??"never")}</div></div>\`).join("");
    const rq=await api("/api/requests?limit=50");
    $("#reqs tbody").innerHTML=rq.requests.map(r=>\`<tr><td>\${esc(new Date(r.created_at).toLocaleTimeString())}</td><td>\${esc(r.machine)}</td><td>\${esc(r.tool)}</td><td class="\${stateCls(r.state)}">\${esc(r.state)}\${r.error_code?" ("+esc(r.error_code)+")":""}</td><td>\${r.duration_ms??""}</td><td>\${esc(r.principal)}</td><td><code>\${esc(r.request_id)}</code></td></tr>\`).join("");
    $("#upd").textContent="updated "+new Date().toLocaleTimeString();
  }catch(e){$("#upd").textContent=String(e.message)}
}
load();setInterval(load,5000);
</script></main></body></html>`;
}
