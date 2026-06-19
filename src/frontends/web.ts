// Web operator console: a second frontend (alongside Telegram) for the operator to talk to
// the engine. Auth is Telegram Login Widget -> trust-on-first-use admin -> signed session
// cookie; messages drive the same source:"neo" SDK pipeline via the web-channel adapter, and
// worker output streams back over SSE. createWebApp() is a pure Request->Response handler
// (unit-tested); startWeb() is the Bun.serve bind (e2e).
import type { Ledger } from "../engine/ledger";
import type { AdminStore } from "../engine/admin";
import type { SessionStore } from "../engine/web-session";
import { verifyTelegramLogin } from "../engine/telegram-auth";
import { createWebChannel, type EngineDeps, type WebChannel } from "../engine/web-channel";

const WEB_CHAT_ID = 0; // the web operator's session-routing key (Telegram ids are never 0)
const COOKIE = "neo_session";

export interface WebAppDeps {
  engine: EngineDeps; // cfg, ledger, registry, meter, start? — shared with Telegram
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
  const channel: WebChannel = createWebChannel({ engine: deps.engine, chatId: WEB_CHAT_ID });

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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Neo — sign in</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui;background:#0b0f14;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}
.card{text-align:center}</style></head>
<body><div class="card"><h1>Neo</h1><p>Sign in with Telegram to open your console.</p>
<script async src="https://telegram.org/js/telegram-widget.js?22"
  data-telegram-login="${botUsername}" data-size="large" data-auth-url="/auth/telegram"
  data-request-access="write"></script></div></body></html>`;
}

function consolePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Neo</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font-family:system-ui;background:#0b0f14;color:#e6edf3;margin:0;display:flex;flex-direction:column;height:100vh}
 header{padding:10px 16px;border-bottom:1px solid #20262d;font-weight:600}
 #log{flex:1;overflow:auto;padding:16px;white-space:pre-wrap}
 .msg{margin:6px 0}.esc{background:#2d2410;border:1px solid #6b5b16;padding:10px;border-radius:8px;margin:8px 0}
 form{display:flex;gap:8px;padding:12px;border-top:1px solid #20262d}
 input{flex:1;padding:10px;border-radius:8px;border:1px solid #20262d;background:#0e141b;color:#e6edf3}
 button{padding:10px 14px;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer}
</style></head><body>
<header>Neo — operator console</header>
<div id="log"></div>
<form id="f"><input id="t" placeholder="/open <folder> <task>   or just chat to follow up" autocomplete="off"><button>Send</button></form>
<script>
const log=document.getElementById('log');
function line(html,cls){const d=document.createElement('div');d.className=cls||'msg';d.innerHTML=html;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
const es=new EventSource('/stream');
es.onmessage=(ev)=>{const e=JSON.parse(ev.data);
  if(e.type==='message'){line(escapeHtml(e.text));}
  else if(e.type==='escalation'){const d=line('⚠️ '+escapeHtml(e.reason)+'<br>','esc');
    for(const dec of ['allow','deny']){const b=document.createElement('button');b.textContent=dec;
      b.onclick=()=>{fetch('/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:e.id,decision:dec})});d.remove();};
      d.appendChild(b);}}
};
function escapeHtml(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
document.getElementById('f').onsubmit=(ev)=>{ev.preventDefault();const t=document.getElementById('t');const v=t.value.trim();if(!v)return;
  line('› '+escapeHtml(v));t.value='';fetch('/msg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:v})});};
</script></body></html>`;
}
