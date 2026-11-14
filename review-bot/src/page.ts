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
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--blocker:#b91c1c;--major:#c2410c;--minor:#a16207;--ok:#15803d;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#e7e5e4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--blocker:#f87171;--major:#fb923c;--minor:#facc15;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:56rem;margin:0 auto;padding:24px 16px 64px}a{color:inherit}
h1{font-size:1.25rem;margin:0 0 4px}h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:32px 0 8px}
.meta{color:var(--muted);font-size:.85rem;display:flex;flex-wrap:wrap;gap:4px 16px}.meta code,code{font-family:var(--mono);font-size:.85em}
.pill{display:inline-block;padding:1px 10px;border-radius:99px;border:1px solid currentColor;font-size:.8rem;font-weight:600}
.running{color:var(--major)}.done{color:var(--ok)}.failed{color:var(--blocker)}.not_started{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:8px 0}
.finding{border-left:4px solid var(--sev)}.finding header{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.sev{color:var(--sev);font-weight:700;font-size:.75rem;text-transform:uppercase}.loc{font-family:var(--mono);font-size:.8rem;color:var(--muted)}
.finding p,.verdict p{margin:6px 0 0;white-space:pre-wrap}
.blocker{--sev:var(--blocker)}.major{--sev:var(--major)}.minor{--sev:var(--minor)}
ul{margin:6px 0 0;padding-left:20px}
.feed{font-size:.85rem}.feed .row{border-top:1px solid var(--line);padding:6px 0}.feed .tag{font-family:var(--mono);color:var(--muted);margin-right:6px}
.feed pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font:12px/1.4 var(--mono);color:var(--muted);max-height:12rem;overflow:auto}
.err{color:var(--blocker)}.empty{color:var(--muted)}
</style>
<main>
<h1>Review of <a href="${esc(prUrl)}">${esc(label)}</a></h1>
<div class="meta" id="meta">loading…</div>
<div id="verdict"></div>
<h2>Findings</h2><div id="findings" class="empty">none yet</div>
<h2>Not checked</h2><div id="notchecked" class="empty">reported when the review finishes</div>
<h2>Agent activity</h2><div id="feed" class="feed"></div>
</main>
<script>
const API=${JSON.stringify(api)},BLOB=${JSON.stringify(prUrl.replace(/\/pull\/\d+$/, ""))};
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>"&#"+c.charCodeAt(0)+";");
let timer;
async function tick(){
  let v;
  try{const r=await fetch(API,{cache:"no-store"});v=await r.json();if(!r.ok)throw new Error(v.error||r.status)}
  catch(e){$("meta").innerHTML='<span class="err">'+esc(e.message)+'</span>';timer=setTimeout(tick,5000);return}
  render(v);
  if(v.status==="running"||v.status==="not_started")timer=setTimeout(tick,2000);
}
function render(v){
  const r=v.review,t=r.target;
  $("meta").innerHTML='<span class="pill '+v.status+'">'+v.status.replace("_"," ")+'</span>'
    +(t?'<span>commit <code>'+t.headSha.slice(0,7)+'</code></span>':'')
    +(r.model?'<span>model <code>'+esc(r.model)+'</code></span>':'')
    +(r.prompt?'<span>rubric <a href="'+esc(r.prompt.url)+'">prompt</a> <code>sha256:'+r.prompt.sha256.slice(0,12)+'</code></span>':'')
    +'<span>cost $'+v.costUsd.toFixed(4)+'</span>'
    +(v.failure?'<span class="err">'+esc(v.failure)+'</span>':'');
  $("verdict").innerHTML=r.verdict?'<div class="card verdict"><strong>AI advice: '+esc(r.verdict.decision.replaceAll("_"," "))+'</strong><p>'+esc(r.verdict.summary)+'</p><p class="empty">This is advice. A named human owns the merge decision.</p></div>':'';
  const order={blocker:0,major:1,minor:2};
  const fs=[...r.findings].sort((a,b)=>order[a.severity]-order[b.severity]);
  $("findings").className=fs.length?"":"empty";
  if(fs.length)$("findings").innerHTML=fs.map((f)=>{
    const loc=f.path+(f.line?":"+f.line:"");
    const href=t?BLOB+"/blob/"+t.headSha+"/"+f.path+(f.line?"#L"+f.line:""):"#";
    return '<div class="card finding '+f.severity+'"><header><span class="sev">'+f.severity+'</span><strong>'+esc(f.title)+'</strong><a class="loc" href="'+esc(href)+'">'+esc(loc)+'</a></header><p>'+esc(f.body)+'</p></div>';
  }).join("");
  if(r.verdict){const n=r.verdict.notChecked;$("notchecked").className=n.length?"":"empty";$("notchecked").innerHTML=n.length?'<ul>'+n.map((x)=>'<li>'+esc(x)+'</li>').join("")+'</ul>':"nothing listed"}
  $("feed").innerHTML=v.activity.map((a)=>{
    if(a.kind==="say")return '<div class="row"><span class="tag">agent</span>'+esc(a.text)+'</div>';
    if(a.kind==="call")return '<div class="row"><span class="tag">call</span><code>'+esc(a.name)+'</code> <code>'+esc(JSON.stringify(a.args))+'</code></div>';
    return '<div class="row"><span class="tag">'+(a.isError?'<span class="err">error</span>':'result')+'</span><code>'+esc(a.name)+'</code><pre>'+esc(a.text)+'</pre></div>';
  }).join("")||'<span class="empty">no activity yet</span>';
}
tick();
</script></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
