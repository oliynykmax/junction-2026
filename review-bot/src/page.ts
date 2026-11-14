// The review page. A static shell that polls the review's JSON view.

export function reviewPage(
  api: string,
  prUrl: string,
  label: string,
): Response {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review ${esc(label)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--critical:#b91c1c;--high:#c2410c;--medium:#a16207;--low:#2563eb;--info:#78716c;--ok:#15803d;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--critical:#f87171;--high:#fb923c;--medium:#facc15;--low:#60a5fa;--info:#a8a29e;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:56rem;margin:0 auto;padding:24px 16px 64px}a{color:inherit}
h1{font-size:1.25rem;margin:0 0 4px}h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:32px 0 8px}
.meta{color:var(--muted);font-size:.85rem;display:flex;flex-wrap:wrap;gap:4px 16px}.meta code,code{font-family:var(--mono);font-size:.85em}
.pill{display:inline-block;padding:1px 10px;border-radius:99px;border:1px solid currentColor;font-size:.8rem;font-weight:600}
.running{color:var(--high)}.done{color:var(--ok)}.failed{color:var(--critical)}.not_started{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:8px 0}
.finding{border-left:4px solid var(--sev)}.finding header{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.sev{color:var(--sev);font-weight:700;font-size:.75rem;text-transform:uppercase}.loc{font-family:var(--mono);font-size:.8rem;color:var(--muted)}
.finding p,.verdict p{margin:6px 0 0;white-space:pre-wrap}
.critical{--sev:var(--critical)}.high{--sev:var(--high)}.medium{--sev:var(--medium)}.low{--sev:var(--low)}.info{--sev:var(--info)}
.tag{font-family:var(--mono);font-size:.72rem;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 5px}
.counts{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.85rem;margin:0 0 4px}.counts span{color:var(--sev);font-weight:600}
ul{margin:6px 0 0;padding-left:20px}
.feed{font-size:.85rem}.feed .row{border-top:1px solid var(--line);padding:6px 0}.feed .tag{font-family:var(--mono);color:var(--muted);margin-right:6px}
.feed pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font:12px/1.4 var(--mono);color:var(--muted);max-height:12rem;overflow:auto}
.err{color:var(--critical)}.empty{color:var(--muted)}.scanning{color:var(--high)}
.badge{font-family:var(--mono);font-size:.72rem;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--muted)}
details{margin-top:8px}summary{cursor:pointer;color:var(--muted);font-size:.85rem}
details pre{white-space:pre;overflow:auto;font:12px/1.4 var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0}
button{font:inherit;font-size:.85rem;padding:4px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--muted)}
.tool header{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.diag{font-size:.85rem;border-top:1px solid var(--line);padding:5px 0;display:flex;gap:8px;flex-wrap:wrap}
.diag .sev{min-width:4.5rem}.error{--sev:var(--critical)}.warning{--sev:var(--high)}
</style>
<main>
<h1>Review of <a href="${esc(prUrl)}">${esc(label)}</a></h1>
<div class="meta" id="meta">loading…</div>
<div id="verdict"></div>
<h2>Findings</h2><div id="counts" class="counts"></div><div id="findings" class="empty">none yet</div>
<h2>Scanners</h2><div id="scanners" class="empty">waiting for the scan</div>
<h2>Docs consulted</h2><div id="docs" class="empty">no documentation looked up yet</div>
<h2>Not checked</h2><div id="notchecked" class="empty">reported when the review finishes</div>
<h2>Agent activity</h2><div id="feed" class="feed"></div>
</main>
<script>
const API=${JSON.stringify(api)},BLOB=${JSON.stringify(prUrl.replace(/\/pull\/\d+$/, ""))};
const SEV=["critical","high","medium","low","info"],LEGACY={blocker:"critical",major:"high",minor:"low"};
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>"&#"+c.charCodeAt(0)+";");
let timer;
async function tick(){
  let v;
  try{const r=await fetch(API,{cache:"no-store"});v=await r.json();if(!r.ok)throw new Error(v.error||r.status)}
  catch(e){$("meta").innerHTML='<span class="err">'+esc(e.message)+'</span>';timer=setTimeout(tick,5000);return}
  render(v);
  if(["running","scanning","not_started"].includes(v.status))timer=setTimeout(tick,2000);
}
function linkDocs(html){return html.replace(/Docs: (https?:\\/\\/[^\\s<]+)/g,(_,u)=>'Docs: <a href="'+u+'">'+u+'</a>')}
function render(v){
  const r=v.review,t=r.target;
  $("meta").innerHTML='<span class="pill '+v.status+'">'+v.status.replace("_"," ")+'</span>'
    +(t?'<span>commit <code>'+t.headSha.slice(0,7)+'</code></span>':'')
    +(r.model?'<span>model <code>'+esc(r.model)+'</code></span>':'')
    +(r.prompt?'<span>rubric <a href="'+esc(r.prompt.url)+'">prompt</a> <code>sha256:'+r.prompt.sha256.slice(0,12)+'</code></span>':'')
    +'<span>cost $'+v.costUsd.toFixed(4)+'</span>'
    +(v.failure?'<span class="err">'+esc(v.failure)+'</span>':'');
  $("verdict").innerHTML=r.verdict?'<div class="card verdict"><strong>AI advice: '+esc(r.verdict.decision.replaceAll("_"," "))+'</strong><p>'+esc(r.verdict.summary)+'</p><p class="empty">This is advice. A named human owns the merge decision.</p></div>':'';
  const fs=r.findings.map((f)=>({...f,severity:LEGACY[f.severity]||f.severity})).sort((a,b)=>SEV.indexOf(a.severity)-SEV.indexOf(b.severity)||String(a.class||"").localeCompare(String(b.class||"")));
  $("counts").innerHTML=SEV.map((s)=>[s,fs.filter((f)=>f.severity===s).length]).filter(([,n])=>n).map(([s,n])=>'<span class="'+s+'">'+n+' '+s+'</span>').join("");
  $("findings").className=fs.length?"":"empty";
  if(fs.length)$("findings").innerHTML=fs.map((f)=>{
    const loc=f.path+(f.line?":"+f.line:"");
    const href=t?BLOB+"/blob/"+t.headSha+"/"+f.path+(f.line?"#L"+f.line:""):"#";
    return '<div class="card finding '+(SEV.includes(f.severity)?f.severity:"info")+'"><header><span class="sev">'+esc(f.severity)+'</span>'+(f.class?'<span class="tag">'+esc(f.class)+'</span>':'')+(f.confidence?'<span class="tag">'+esc(f.confidence)+'</span>':'')+'<strong>'+esc(f.title)+'</strong><a class="loc" href="'+esc(href)+'">'+esc(loc)+'</a><span class="badge">'+esc(f.source||"agent")+'</span></header><p>'+linkDocs(esc(f.body))+'</p>'
      +(f.suggestedPatch?'<details><summary>Suggested fix</summary><pre>'+esc(f.suggestedPatch)+'</pre><button disabled title="Not wired up yet">Open fix PR (coming soon)</button></details>':'')+'</div>';
  }).join("");
  const ls=r.lookups||[];
  $("docs").className=ls.length?"":"empty";
  $("docs").innerHTML=ls.length?'<ul>'+ls.map((l)=>'<li><code>'+esc(l.tool.replace(/^mcp__/,"").replace("__"," "))+'</code> <code>'+esc(l.args)+'</code></li>').join("")+'</ul>':(r.verdict?"none":"no documentation looked up yet");
  renderScan(r.scan,r.verdict,t);
  if(r.verdict){const n=r.verdict.notChecked;$("notchecked").className=n.length?"":"empty";$("notchecked").innerHTML=n.length?'<ul>'+n.map((x)=>'<li>'+esc(x)+'</li>').join("")+'</ul>':"nothing listed"}
  $("feed").innerHTML=v.activity.map((a)=>{
    if(a.kind==="say")return '<div class="row"><span class="tag">agent</span>'+esc(a.text)+'</div>';
    if(a.kind==="call")return '<div class="row"><span class="tag">call</span><code>'+esc(a.name)+'</code> <code>'+esc(JSON.stringify(a.args))+'</code></div>';
    return '<div class="row"><span class="tag">'+(a.isError?'<span class="err">error</span>':'result')+'</span><code>'+esc(a.name)+'</code><pre>'+esc(a.text)+'</pre></div>';
  }).join("")||'<span class="empty">no activity yet</span>';
}
function renderScan(scan,verdict,t){
  const el=$("scanners");
  if(!scan||scan.status==="pending"){el.className="empty";el.textContent=scan?"running zizmor, ty and oxlint on the changed files…":"no scan for this review";return}
  if(scan.status==="skipped"){el.className="empty";el.textContent="no scanner applies to the changed files";return}
  if(scan.status==="failed"){el.className="err";el.textContent="scanners did not run: "+scan.error;return}
  el.className="";
  const dismissed=(verdict&&verdict.dismissed)||[];
  el.innerHTML=scan.results.map((x)=>{
    const head='<header><strong>'+esc(x.tool)+'</strong><span class="badge">'+esc(x.version)+'</span><span class="loc">'+x.durationMs+' ms · '+x.paths.length+' file(s) · '+(x.status==="ok"?x.diagnostics.length+' diagnostic(s)':'<span class="err">failed</span>')+'</span></header>';
    const rows=x.status==="ok"?x.diagnostics.map((d)=>{
      const href=t?BLOB+"/blob/"+t.headSha+"/"+d.path+(d.line?"#L"+d.line:""):"#";
      const dis=dismissed.find((m)=>m.tool===x.tool&&m.rule===d.rule&&m.path===d.path);
      return '<div class="diag '+d.severity+'"><span class="sev">'+d.severity+'</span>'+(d.url?'<a href="'+esc(d.url)+'"><code>'+esc(d.rule)+'</code></a>':'<code>'+esc(d.rule)+'</code>')+'<a class="loc" href="'+esc(href)+'">'+esc(d.path+(d.line?":"+d.line:""))+'</a><span>'+esc(d.message)+'</span>'+(dis?'<span class="empty">dismissed by the agent: '+esc(dis.reason)+'</span>':'')+'</div>';
    }).join(""):'<div class="diag err">'+esc(x.error)+'</div>';
    return '<div class="card tool">'+head+rows+'</div>';
  }).join("");
}
tick();
</script></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
