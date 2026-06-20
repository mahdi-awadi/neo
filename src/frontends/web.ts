// Web operator console: a second frontend (alongside Telegram) for the operator to talk to
// the engine. Auth is Telegram Login Widget -> trust-on-first-use admin -> signed session
// cookie; messages drive the same source:"neo" SDK pipeline via the web-channel adapter, and
// worker output streams back over SSE. createWebApp() is a pure Request->Response handler
// (unit-tested); startWeb() is the Bun.serve bind (e2e).
import type { Ledger } from "../engine/ledger";
import type { AdminStore } from "../engine/admin";
import type { SessionStore } from "../engine/web-session";
import type { UsageMeter } from "../engine/usage";
import { verifyTelegramLogin } from "../engine/telegram-auth";
import { createWebChannel, type EngineDeps, type WebChannel } from "../engine/web-channel";

const WEB_CHAT_ID = 0; // the web operator's session-routing key (Telegram ids are never 0)
const COOKIE = "neo_session";

export interface WebAppDeps {
  engine: EngineDeps; // cfg, ledger, registry, meter, start? — shared with Telegram
  usage?: UsageMeter; // measured subscription usage (for /usage)
  botToken: string;
  botUsername: string; // for the Login Widget (resolved via getMe at startup)
  sessions: SessionStore;
  admin: AdminStore;
  /** Epoch SECONDS clock (auth_date freshness + session expiry). Defaults to wall clock. */
  now?: () => number;
}

export interface WebApp {
  fetch(req: Request): Promise<Response>;
}

export function createWebApp(deps: WebAppDeps): WebApp {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const channel: WebChannel = createWebChannel({ engine: deps.engine, chatId: WEB_CHAT_ID, usage: deps.usage });

  function sessionUser(req: Request): number | undefined {
    const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? deps.sessions.verify(decodeURIComponent(m[1]), now()) : undefined;
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- Telegram Login Widget redirect (data-auth-url) ---
    if (req.method === "GET" && path === "/auth/telegram") {
      const data: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (data[k] = v));
      const res = verifyTelegramLogin(data, deps.botToken, { now: now() });
      if (!res.ok || res.userId === undefined) return new Response("auth failed", { status: 403 });
      if (!deps.admin.claimAdmin(res.userId)) return new Response("not the operator", { status: 403 });
      const token = deps.sessions.issue(res.userId, now());
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
        },
      });
    }

    if (req.method === "GET" && path === "/") {
      const uid = sessionUser(req);
      const html = uid === undefined ? loginPage(deps.botUsername) : consolePage();
      // never cache: the login page embeds the bot username, and a stale copy (e.g. an old
      // bot handle behind Cloudflare/browser cache) silently breaks Telegram login.
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, must-revalidate" },
      });
    }

    // --- everything below requires a valid session ---
    if (sessionUser(req) === undefined) return new Response("unauthorized", { status: 401 });

    if (req.method === "POST" && path === "/msg") {
      const body = (await req.json().catch(() => ({}))) as { text?: unknown };
      if (typeof body.text === "string" && body.text.trim()) void channel.send(body.text.trim());
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && path === "/approve") {
      const body = (await req.json().catch(() => ({}))) as { id?: unknown; decision?: unknown };
      const ok =
        typeof body.id === "string" &&
        channel.resolveApproval(body.id, body.decision === "allow" ? "allow" : "deny");
      return Response.json({ ok });
    }

    if (req.method === "POST" && path === "/select") {
      const body = (await req.json().catch(() => ({}))) as { id?: unknown };
      if (typeof body.id === "string") channel.selectProject(body.id);
      return Response.json({ ok: true });
    }

    if (req.method === "GET" && path === "/stream") {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const unsub = channel.subscribe((e) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)));
          req.signal.addEventListener("abort", () => {
            unsub();
            try {
              controller.close();
            } catch {
              // already closed
            }
          });
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  return { fetch };
}

/** Bun.serve bind for the daemon (e2e-verified). Binds the docker-bridge IP by default so
 * only Traefik (TLS front door) can reach it — never exposed publicly bypassing HTTPS. */
export function startWeb(deps: WebAppDeps, port: number, hostname = "0.0.0.0"): ReturnType<typeof Bun.serve> {
  const appHandler = createWebApp(deps);
  return Bun.serve({ port, hostname, fetch: (req) => appHandler.fetch(req) });
}

function loginPage(botUsername: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neo · sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Manrope:wght@400;500;600&display=swap" rel="stylesheet">
<style>
 :root{--ink:#080b10;--fg:#d7e2ee;--muted:#67788c;--accent:#3fe0a2;--glow:rgba(63,224,162,.25);--border:#1a2530}
 *{box-sizing:border-box}html,body{height:100%}
 body{margin:0;background:var(--ink);color:var(--fg);font-family:'Manrope',system-ui,sans-serif;display:grid;place-items:center;overflow:hidden;
  background-image:radial-gradient(720px 470px at 50% -12%,rgba(63,224,162,.10),transparent 60%)}
 body::before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.5;
  background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);
  background-size:46px 46px;mask-image:radial-gradient(circle at 50% 42%,rgba(0,0,0,.2),transparent 70%)}
 .card{text-align:center;position:relative;z-index:1;animation:rise .6s cubic-bezier(.2,.8,.2,1) both}
 .wm{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:42px;letter-spacing:.34em;margin:0 0 6px;display:inline-flex;align-items:center;gap:15px}
 .pulse{width:11px;height:11px;border-radius:50%;background:var(--accent);box-shadow:0 0 18px var(--glow);animation:pulse 2.4s infinite}
 .sub{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.26em;text-transform:uppercase;color:var(--muted);margin:0 0 28px}
 @keyframes pulse{0%{box-shadow:0 0 0 0 var(--glow)}70%{box-shadow:0 0 0 13px transparent}100%{box-shadow:0 0 0 0 transparent}}
 @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
</style></head>
<body><div class="card">
 <h1 class="wm"><span class="pulse"></span>NEO</h1>
 <p class="sub">operator deck — sign in to command</p>
 <script async src="https://telegram.org/js/telegram-widget.js?22"
  data-telegram-login="${botUsername}" data-size="large" data-userpic="false" data-auth-url="/auth/telegram" data-request-access="write"></script>
</div></body></html>`;
}

function consolePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neo · operator deck</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#080b10;--panel:#0d121a;--panel2:#10171f;--border:#1a2530;--fg:#d7e2ee;--muted:#67788c;--faint:#3a4655;
 --accent:#3fe0a2;--accent-dim:#1f7a5c;--glow:rgba(63,224,162,.22);--warn:#f5b14c;--danger:#ff6b6b;
 --mono:'JetBrains Mono',ui-monospace,monospace;--sans:'Manrope',system-ui,sans-serif}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--ink);color:var(--fg);font-family:var(--sans);font-size:14px;display:flex;overflow:hidden;
 background-image:radial-gradient(900px 520px at 82% -12%,rgba(63,224,162,.06),transparent 60%),radial-gradient(680px 420px at -8% 112%,rgba(63,150,224,.05),transparent 60%)}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.5;
 background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);
 background-size:46px 46px;mask-image:radial-gradient(circle at 50% 0,rgba(0,0,0,.16),transparent 72%)}
.app{display:flex;width:100%;height:100%;position:relative;z-index:1}
aside{width:290px;min-width:290px;background:linear-gradient(180deg,var(--panel),var(--ink));border-right:1px solid var(--border);display:flex;flex-direction:column;animation:slide .5s cubic-bezier(.2,.8,.2,1) both}
.brand{padding:18px 18px 14px;border-bottom:1px solid var(--border)}
.wm{font-family:var(--mono);font-weight:700;font-size:17px;letter-spacing:.32em;display:flex;align-items:center;gap:11px}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--glow);animation:pulse 2.4s infinite}
.sub{font-family:var(--mono);font-size:9.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-top:7px}
.sec{font-family:var(--mono);font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);padding:16px 18px 6px}
#projects{flex:1;overflow-y:auto;padding:0 10px 10px}
.proj{display:flex;align-items:center;gap:10px;padding:10px;margin:2px 0;border-radius:11px;cursor:pointer;border:1px solid transparent;transition:background .12s,border-color .12s}
.proj:hover{background:var(--panel2)}
.proj.on{background:color-mix(in srgb,var(--accent) 9%,transparent);border-color:color-mix(in srgb,var(--accent) 38%,transparent)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0}
.dot.running{background:var(--accent);box-shadow:0 0 8px var(--glow)}.dot.idle{background:var(--warn)}
.meta{flex:1;min-width:0}
.nm{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fo{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.empty{padding:16px 18px;color:var(--muted);font-size:12.5px;line-height:1.7}
.empty b{color:var(--accent);font-family:var(--mono);font-weight:500}
.foot{padding:11px 18px;border-top:1px solid var(--border);font-family:var(--mono);font-size:10px;color:var(--muted);display:flex;justify-content:space-between;letter-spacing:.04em}
main{flex:1;display:flex;flex-direction:column;min-width:0;animation:fade .5s .08s both}
.bar{height:54px;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid var(--border);background:rgba(13,18,26,.55);backdrop-filter:blur(7px)}
.now{font-family:var(--mono);font-size:11px;letter-spacing:.05em;color:var(--muted);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.now b{color:var(--accent);font-weight:500}
.rail{display:flex;gap:6px}
.ib{height:31px;padding:0 11px;display:inline-flex;align-items:center;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:8px;cursor:pointer;font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;transition:all .12s}
.ib:hover{color:var(--fg);border-color:var(--accent-dim);background:var(--panel2)}
#log{flex:1;overflow-y:auto;padding:20px 22px 8px;display:flex;flex-direction:column}
.row{padding:6px 0;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.row.me{color:var(--muted);font-family:var(--mono);font-size:12.5px}
.row.out{border-left:2px solid var(--accent-dim);padding-left:13px;margin:5px 0;color:var(--fg)}
.card{background:var(--panel);border:1px solid var(--border);border-radius:13px;padding:13px 15px;margin:9px 0;white-space:pre-wrap}
.card.esc{border-color:color-mix(in srgb,var(--warn) 50%,var(--border));background:color-mix(in srgb,var(--warn) 7%,var(--panel))}
.acts{display:flex;gap:8px;margin-top:11px}
.chip{padding:6px 13px;border-radius:999px;border:1px solid var(--border);background:var(--panel2);color:var(--fg);font-family:var(--mono);font-size:11px;cursor:pointer;transition:all .12s}
.chip:hover{border-color:var(--accent-dim)}
.chip.ok{border-color:color-mix(in srgb,var(--accent) 60%,var(--border));color:var(--accent)}
.chip.no{border-color:color-mix(in srgb,var(--danger) 50%,var(--border));color:var(--danger)}
form{display:flex;gap:10px;padding:13px 16px;border-top:1px solid var(--border);background:var(--panel)}
#t{flex:1;padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--ink);color:var(--fg);font-family:var(--sans);font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}
#t:focus{border-color:var(--accent-dim);box-shadow:0 0 0 3px var(--glow)}
#t::placeholder{color:var(--faint);font-family:var(--mono);font-size:12px}
.send{padding:0 18px;border-radius:10px;border:0;background:var(--accent);color:#06241a;font-weight:700;font-family:var(--mono);font-size:11px;letter-spacing:.08em;cursor:pointer;transition:opacity .12s}
.send:hover{opacity:.9}
@keyframes pulse{0%{box-shadow:0 0 0 0 var(--glow)}70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}
@keyframes slide{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:none}}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
::-webkit-scrollbar{width:11px}::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px;border:3px solid var(--ink)}::-webkit-scrollbar-thumb:hover{background:var(--faint)}
</style></head>
<body><div class="app">
 <aside>
  <div class="brand"><div class="wm"><span class="pulse"></span>NEO</div><div class="sub">operator deck</div></div>
  <div class="sec">Projects</div>
  <div id="projects"><div class="empty">No open projects.<br>Use <b>/open &lt;folder&gt; &lt;task&gt;</b> below.</div></div>
  <div class="foot"><span>live</span><span>subscription</span></div>
 </aside>
 <main>
  <div class="bar">
   <div class="now" id="now">no active project</div>
   <div class="rail">
    <button class="ib" onclick="send('/usage')">usage</button>
    <button class="ib" onclick="send('/recent')">recent</button>
    <button class="ib" onclick="send('/loop')">loops</button>
    <button class="ib" onclick="send('/help')">help</button>
   </div>
  </div>
  <div id="log"></div>
  <form id="f"><input id="t" autocomplete="off" placeholder="/open <folder> <task>   ·   or message the active project"><button class="send" type="submit">SEND</button></form>
 </main>
</div>
<script>
var log=document.getElementById('log');
function esc(s){return s.replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function post(p,b){return fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});}
function add(html,cls){var d=document.createElement('div');d.className='row '+(cls||'');d.innerHTML=html;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
function send(text,e){var v=(text||'').trim();if(!v)return;if(e!==false)add('› '+esc(v),'me');post('/msg',{text:v});}
function dotcls(s){return s==='running'?'running':(s==='idle'?'idle':'');}
function renderProjects(items){
 var box=document.getElementById('projects');box.innerHTML='';
 if(!items||!items.length){box.innerHTML='<div class="empty">No open projects.<br>Use <b>/open &lt;folder&gt; &lt;task&gt;</b> below.</div>';document.getElementById('now').innerHTML='no active project';return;}
 var active=null;
 for(var i=0;i<items.length;i++){(function(p){
  var d=document.createElement('div');d.className='proj'+(p.active?' on':'');
  d.innerHTML='<span class="dot '+dotcls(p.status)+'"></span><div class="meta"><div class="nm">'+esc(p.label)+'</div><div class="fo">'+esc(p.folder||'')+'</div></div>';
  d.onclick=function(){post('/select',{id:p.id});};
  box.appendChild(d);if(p.active)active=p;
 })(items[i]);}
 document.getElementById('now').innerHTML=active?('active · <b>'+esc(active.label)+'</b>'):(items.length+' open · none active');
}
var es=new EventSource('/stream');
es.onmessage=function(ev){var e=JSON.parse(ev.data);
 if(e.type==='message'){add(esc(e.text),'out');}
 else if(e.type==='projects'){renderProjects(e.items);}
 else if(e.type==='escalation'){
  var c=document.createElement('div');c.className='card esc';c.innerHTML='⚠ '+esc(e.reason);
  var acts=document.createElement('div');acts.className='acts';
  ['allow','deny'].forEach(function(dec){var b=document.createElement('button');b.className='chip '+(dec==='allow'?'ok':'no');b.textContent=dec;
   b.onclick=function(){post('/approve',{id:e.id,decision:dec});c.remove();};acts.appendChild(b);});
  c.appendChild(acts);log.appendChild(c);log.scrollTop=log.scrollHeight;}
};
document.getElementById('f').onsubmit=function(ev){ev.preventDefault();var t=document.getElementById('t');send(t.value);t.value='';};
setTimeout(function(){send('/list',false);},200);
</script></body></html>`;
}
