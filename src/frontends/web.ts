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
import { runCompanyBrief } from "../engine/ingress";
import { saveInbound } from "../engine/files";
import { basename } from "node:path";

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
  /** Shared secret for machine-to-machine POST /agent/ingress. Required to enable the endpoint. */
  ingressSecret?: string;
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

    // --- machine-to-machine: POST /agent/ingress (bearer auth, no session cookie) ---
    if (req.method === "POST" && path === "/agent/ingress") {
      const auth = req.headers.get("authorization") ?? "";
      if (!deps.ingressSecret || auth !== `Bearer ${deps.ingressSecret}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = (await req.json().catch(() => ({}))) as { brief?: unknown };
      if (typeof body.brief !== "string" || !body.brief.trim()) {
        return Response.json({ ok: false, result: "missing brief" }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      const result = await runCompanyBrief(body.brief.trim(), {
        cfg: deps.engine.cfg, ledger: deps.engine.ledger, registry: deps.engine.registry,
        meter: deps.engine.meter, trust: deps.engine.trust, usage: deps.usage,
        reply: (_c, text, project) => channel.notify(text, project),
        askApproval: async () => "deny",
      });
      return Response.json({ ok: true, result }, { headers: { "cache-control": "no-store" } });
    }

    // --- everything below requires a valid session ---
    if (sessionUser(req) === undefined) return new Response("unauthorized", { status: 401 });

    if (req.method === "POST" && path === "/msg") {
      const body = (await req.json().catch(() => ({}))) as { text?: unknown };
      if (typeof body.text === "string" && body.text.trim()) void channel.send(body.text.trim());
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && path === "/upload") {
      const form = await req.formData().catch(() => null);
      const f = form?.get("file");
      if (!(f instanceof File)) return Response.json({ ok: false }, { status: 400 });
      const target = deps.engine.registry.findByChat(WEB_CHAT_ID) ?? deps.engine.registry.getDefault();
      if (!target) return Response.json({ ok: false, error: "no active project" }, { status: 409 });
      const bytes = new Uint8Array(await f.arrayBuffer());
      const saved = saveInbound(target.order.folder, f.name || "file", bytes);
      const caption = typeof form?.get("caption") === "string" ? (form.get("caption") as string) : "";
      void channel.send(`📎 operator attached \`${basename(saved)}\` at \`${saved}\`\n${caption}`);
      return Response.json({ ok: true });
    }

    if (req.method === "GET" && path === "/file") {
      const token = url.searchParams.get("token") ?? "";
      const abs = channel.getFile(token);
      if (!abs) return new Response("not found", { status: 404 });
      const safeName = basename(abs).replace(/[\r\n"]/g, "_");
      return new Response(Bun.file(abs), {
        headers: { "content-disposition": `attachment; filename="${safeName}"`, "cache-control": "no-store" },
      });
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

    if (req.method === "POST" && path === "/kill") {
      const body = (await req.json().catch(() => ({}))) as { id?: unknown };
      if (typeof body.id === "string") channel.killProject(body.id);
      return Response.json({ ok: true });
    }

    // --- dashboard API: structured state + form-driven actions (no command typing) ---
    if (req.method === "GET" && path === "/api/state") {
      // MUST be uncacheable: Cloudflare was caching this GET (max-age=14400) and serving the
      // dashboard a stale, empty snapshot — projects never appeared even while live. The client
      // also appends a cache-buster query. (Telegram /list was unaffected — it bypasses the web.)
      return Response.json(channel.state(), { headers: { "cache-control": "no-store, must-revalidate" } });
    }

    if (req.method === "POST" && path === "/api/open") {
      const body = (await req.json().catch(() => ({}))) as { folder?: unknown; task?: unknown };
      if (typeof body.folder === "string" && typeof body.task === "string" && body.folder.trim() && body.task.trim()) {
        void channel.openProject(body.folder.trim(), body.task.trim());
      }
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && path === "/api/loop") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      if (typeof body.name === "string") channel.runLoop(body.name);
      return Response.json({ ok: true });
    }

    if (req.method === "GET" && path === "/stream") {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const unsub = channel.subscribe((e) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)));
          // Keepalive comment every 15s so Bun's idleTimeout never closes this long-lived
          // SSE connection (the default 10s drop was killing live dashboard updates).
          const ping = setInterval(() => {
            try {
              controller.enqueue(enc.encode(`: ping\n\n`));
            } catch {
              clearInterval(ping);
            }
          }, 15000);
          req.signal.addEventListener("abort", () => {
            clearInterval(ping);
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
  // idleTimeout 0 = no per-request idle drop; the SSE /stream is long-lived (kept warm by its
  // own 15s keepalive). Without this Bun closed connections after 10s, stalling live updates.
  return Bun.serve({ port, hostname, idleTimeout: 0, fetch: (req) => appHandler.fetch(req) });
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
<title>Neo · dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#080b10;--panel:#0d121a;--panel2:#10171f;--border:#1a2530;--fg:#d7e2ee;--muted:#67788c;--faint:#3a4655;--accent:#3fe0a2;--accent-dim:#1f7a5c;--glow:rgba(63,224,162,.22);--warn:#f5b14c;--danger:#ff6b6b;--mono:'JetBrains Mono',ui-monospace,monospace;--sans:'Manrope',system-ui,sans-serif}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--ink);color:var(--fg);font-family:var(--sans);font-size:14px;display:flex;overflow:hidden;background-image:radial-gradient(900px 520px at 82% -12%,rgba(63,224,162,.06),transparent 60%),radial-gradient(680px 420px at -8% 112%,rgba(63,150,224,.05),transparent 60%)}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.42;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:46px 46px;mask-image:radial-gradient(circle at 30% 0,rgba(0,0,0,.16),transparent 72%)}
.app{display:flex;width:100%;height:100%;position:relative;z-index:1}
aside{width:300px;min-width:300px;background:linear-gradient(180deg,var(--panel),var(--ink));border-right:1px solid var(--border);display:flex;flex-direction:column;animation:slide .5s cubic-bezier(.2,.8,.2,1) both}
.brand{padding:18px 18px 14px;border-bottom:1px solid var(--border)}
.wm{font-family:var(--mono);font-weight:700;font-size:17px;letter-spacing:.32em;display:flex;align-items:center;gap:11px}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--glow);animation:pulse 2.4s infinite}
.sub{font-family:var(--mono);font-size:9.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted);margin-top:7px}
.sec{font-family:var(--mono);font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);padding:15px 18px 7px;display:flex;justify-content:space-between}
.np{padding:0 16px 8px}
.np select,.np textarea{width:100%;background:var(--ink);border:1px solid var(--border);color:var(--fg);border-radius:9px;padding:9px 11px;font-size:12.5px;margin-bottom:7px;outline:none}
.np select{font-family:var(--mono)}.np textarea{resize:vertical;min-height:52px;font-family:var(--sans)}
.np select:focus,.np textarea:focus{border-color:var(--accent-dim);box-shadow:0 0 0 3px var(--glow)}
.btn{width:100%;padding:10px;border-radius:9px;border:0;background:var(--accent);color:#06241a;font-weight:700;font-family:var(--mono);font-size:11px;letter-spacing:.06em;cursor:pointer;transition:opacity .12s}
.btn:hover{opacity:.9}
#projects{flex:1;overflow-y:auto;padding:0 10px 8px}
.proj{display:flex;align-items:center;gap:10px;padding:10px;margin:2px 0;border-radius:11px;cursor:pointer;border:1px solid transparent;transition:background .12s,border-color .12s}
.proj:hover{background:var(--panel2)}
.proj.on{background:color-mix(in srgb,var(--accent) 9%,transparent);border-color:color-mix(in srgb,var(--accent) 38%,transparent)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0}
.dot.running{background:var(--accent);box-shadow:0 0 8px var(--glow)}.dot.idle{background:var(--warn)}
.meta{flex:1;min-width:0}.nm{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fo{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.kbtn{opacity:0;background:transparent;border:0;color:var(--faint);cursor:pointer;font-size:13px;padding:3px 5px;border-radius:6px;transition:opacity .12s,color .12s}
.proj:hover .kbtn{opacity:1}.kbtn:hover{color:var(--danger)}
.empty{padding:14px 18px;color:var(--muted);font-size:12px;line-height:1.6}
.foot{padding:10px 18px;border-top:1px solid var(--border);font-family:var(--mono);font-size:10px;color:var(--muted);display:flex;justify-content:space-between}
main{flex:1;display:flex;flex-direction:column;min-width:0;animation:fade .5s .08s both}
.top{height:56px;display:flex;align-items:center;gap:2px;padding:0 14px;border-bottom:1px solid var(--border);background:rgba(13,18,26,.55);backdrop-filter:blur(7px)}
.tab{height:36px;padding:0 15px;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--muted);cursor:pointer;font-family:var(--mono);font-size:11px;letter-spacing:.05em;transition:color .12s,border-color .12s}
.tab:hover{color:var(--fg)}.tab.on{color:var(--accent);border-bottom-color:var(--accent)}
.spacer{flex:1}.who{font-family:var(--mono);font-size:10.5px;color:var(--muted);padding-right:6px}
.view{flex:1;overflow-y:auto;padding:20px 22px;flex-direction:column;display:none}
.view.on{display:flex}
#vactivity{padding:0}
#feed{flex:1;overflow-y:auto;padding:20px 22px;display:flex;flex-direction:column}
.row{padding:6px 0;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.row.me{color:var(--muted);font-family:var(--mono);font-size:12.5px}
.row.out{border-left:2px solid var(--accent-dim);padding-left:13px;margin:5px 0}
.ptag{display:inline-block;font-family:var(--mono);font-size:10px;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--accent) 30%,var(--border));padding:1px 7px;border-radius:6px;margin-right:8px;vertical-align:1px}
#fbar{display:none;align-items:center;gap:8px;padding:8px 22px;border-bottom:1px solid var(--border);background:var(--panel);font-family:var(--mono);font-size:11px;color:var(--muted)}
#fbar.on{display:flex}#fbar b{color:var(--accent)}
#fbar a{margin-left:auto;color:var(--muted);cursor:pointer;text-decoration:underline;text-underline-offset:2px}#fbar a:hover{color:var(--fg)}
.row.out code{font-family:var(--mono);font-size:12px;background:var(--panel2);border:1px solid var(--border);border-radius:5px;padding:1px 5px}
.row.out pre{font-family:var(--mono);font-size:12px;background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:11px 13px;overflow-x:auto;margin:8px 0;line-height:1.45}
.row.out a{color:var(--accent)}
table.md{border-collapse:collapse;margin:9px 0;font-size:13px;width:auto;max-width:100%;display:block;overflow-x:auto}
table.md th,table.md td{border:1px solid var(--border);padding:6px 12px;text-align:left;white-space:nowrap}
table.md th{background:color-mix(in srgb,var(--accent) 9%,var(--panel));color:var(--fg);font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;font-weight:500}
table.md tbody tr:nth-child(even){background:var(--panel2)}
.fe{margin:auto;color:var(--faint);font-family:var(--mono);font-size:12px;text-align:center;line-height:1.7}
.compose{display:flex;gap:10px;padding:13px 18px;border-top:1px solid var(--border);background:var(--panel)}
.compose input{flex:1;padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--ink);color:var(--fg);font-family:var(--sans);font-size:14px;outline:none}
.compose input:focus{border-color:var(--accent-dim);box-shadow:0 0 0 3px var(--glow)}
.compose input::placeholder{color:var(--faint);font-family:var(--mono);font-size:12px}
.compose button{padding:0 18px;border-radius:10px;border:0;background:var(--accent);color:#06241a;font-weight:700;font-family:var(--mono);font-size:11px;letter-spacing:.06em;cursor:pointer}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px 18px;margin-bottom:14px}
.card h3{margin:0 0 13px;font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);font-weight:500}
.lrow{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border)}.lrow:first-of-type{border-top:0}
.lm{flex:1;min-width:0}.lt{font-weight:600;font-size:13px}.ls{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:2px}
.run{padding:7px 15px;border-radius:8px;border:1px solid color-mix(in srgb,var(--accent) 50%,var(--border));background:transparent;color:var(--accent);font-family:var(--mono);font-size:11px;cursor:pointer;transition:background .12s}
.run:hover{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.gauge{margin:11px 0}.glabel{display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:5px}.glabel b{color:var(--fg);font-weight:500}
.gbar{height:7px;background:var(--panel2);border-radius:6px;overflow:hidden}.gfill{height:100%;background:linear-gradient(90deg,var(--accent-dim),var(--accent));border-radius:6px}
.pill{display:inline-flex;align-items:center;padding:6px 12px;border-radius:999px;border:1px solid var(--border);font-family:var(--mono);font-size:11px;margin:0 7px 7px 0}
.pill.ok{border-color:color-mix(in srgb,var(--accent) 45%,var(--border));color:var(--accent)}.pill.warn{border-color:color-mix(in srgb,var(--warn) 50%,var(--border));color:var(--warn)}
.rrow{display:flex;gap:11px;padding:9px 0;border-top:1px solid var(--border);font-size:13px}.rrow:first-of-type{border-top:0}
.rfo{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:1px}
.escc{border:1px solid color-mix(in srgb,var(--warn) 50%,var(--border));background:color-mix(in srgb,var(--warn) 7%,var(--panel));border-radius:13px;padding:13px 15px;margin:9px 0}
.acts{display:flex;gap:8px;margin-top:11px}
.chip{padding:6px 13px;border-radius:999px;border:1px solid var(--border);background:var(--panel2);color:var(--fg);font-family:var(--mono);font-size:11px;cursor:pointer}
.chip.ok{border-color:color-mix(in srgb,var(--accent) 60%,var(--border));color:var(--accent)}.chip.no{border-color:color-mix(in srgb,var(--danger) 50%,var(--border));color:var(--danger)}
@keyframes pulse{0%{box-shadow:0 0 0 0 var(--glow)}70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}
@keyframes slide{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:none}}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
::-webkit-scrollbar{width:10px}::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px;border:3px solid var(--ink)}
</style></head>
<body><div class="app">
 <aside>
  <div class="brand"><div class="wm"><span class="pulse"></span>NEO</div><div class="sub">operator deck</div></div>
  <div class="sec">New project</div>
  <div class="np">
   <select id="repo"></select>
   <textarea id="task" placeholder="What should Neo do in this project?"></textarea>
   <button class="btn" onclick="openProject()">Open project</button>
  </div>
  <div class="sec"><span>Projects</span><span id="pcount"></span></div>
  <div id="projects"><div class="empty">No open projects yet.</div></div>
  <div class="foot"><span id="ftl">—</span><span>subscription</span></div>
 </aside>
 <main>
  <div class="top">
   <button class="tab on" data-v="activity" onclick="tab('activity');clearFilter()">Activity</button>
   <button class="tab" data-v="loops" onclick="tab('loops')">Loops</button>
   <button class="tab" data-v="usage" onclick="tab('usage')">Usage</button>
   <button class="tab" data-v="recent" onclick="tab('recent')">Recent</button>
   <span class="spacer"></span><span class="who" id="who">no active project</span>
  </div>
  <div class="view on" id="vactivity">
   <div id="fbar"></div>
   <div id="feed"><div class="fe" id="ph">Open a project, or select one on the left — its activity streams here.</div></div>
   <form class="compose" id="ff"><input id="msg" autocomplete="off" placeholder="message the active project — a follow-up for the AI…"><input type="file" id="file" style="display:none" onchange="uploadFile()"><button class="chip" type="button" onclick="document.getElementById('file').click()">📎</button><button type="submit">Send</button></form>
  </div>
  <div class="view" id="vloops"></div>
  <div class="view" id="vusage"></div>
  <div class="view" id="vrecent"></div>
 </main>
</div>
<script>
var S={projects:[],usage:null,loops:[],recent:[],repos:[]};
function esc(s){return (s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function post(p,b){return fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});}
function fmt(n){n=n||0;if(n>=1e9)return (n/1e9).toFixed(1)+'B';if(n>=1e6)return (n/1e6).toFixed(1)+'M';if(n>=1e3)return (n/1e3).toFixed(1)+'k';return ''+Math.round(n);}
function age(ms){var s=Math.floor((ms||0)/1000);if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+'m';var h=Math.floor(m/60);if(h<24)return h+'h';return Math.floor(h/24)+'d';}

function loadState(){return fetch('/api/state?_='+Date.now(),{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){S=d;renderAll();});}
function renderAll(){renderRepos();renderProjects();renderLoops();renderUsage();renderRecent();}

function renderRepos(){var sel=document.getElementById('repo');if(sel.dataset.n==String(S.repos.length))return;sel.dataset.n=String(S.repos.length);
 var cur=sel.value;sel.innerHTML='<option value="">— pick a repo —</option>';
 S.repos.forEach(function(r){var o=document.createElement('option');o.value=r;o.textContent=r.split('/').pop();sel.appendChild(o);});
 if(cur)sel.value=cur;}

function renderProjects(){var box=document.getElementById('projects');document.getElementById('pcount').textContent=S.projects.length||'';
 if(!S.projects.length){box.innerHTML='<div class="empty">No open projects yet.<br>Pick a repo above and open one.</div>';document.getElementById('who').textContent='no active project';return;}
 box.innerHTML='';var active=null;
 S.projects.forEach(function(p){var d=document.createElement('div');d.className='proj'+(p.active?' on':'');
  d.innerHTML='<span class="dot '+(p.status==='running'?'running':(p.status==='idle'?'idle':''))+'"></span><div class="meta"><div class="nm">'+esc(p.name)+'</div><div class="fo">'+esc(p.folder)+' · '+p.status+' · '+age(p.ageMs)+'</div></div>';
  d.onclick=function(){setFilter(p.name);tab('activity');post('/select',{id:p.id}).then(loadState);};
  var k=document.createElement('button');k.className='kbtn';k.textContent='✕';k.title='kill';
  k.onclick=function(ev){ev.stopPropagation();post('/kill',{id:p.id}).then(loadState);};
  d.appendChild(k);box.appendChild(d);if(p.active)active=p;});
 document.getElementById('who').textContent=active?('active · '+active.name):(S.projects.length+' open · none active');}

function openProject(){var folder=document.getElementById('repo').value;var task=document.getElementById('task').value.trim();
 if(!folder||!task){alert('Pick a repo and describe the task.');return;}
 post('/api/open',{folder:folder,task:task}).then(function(){document.getElementById('task').value='';tab('activity');setTimeout(loadState,500);});}

function renderLoops(){var v=document.getElementById('vloops');v.innerHTML='';
 var card=document.createElement('div');card.className='card';card.innerHTML='<h3>Loops — run a verifiable job</h3>';
 if(!S.loops.length){var e=document.createElement('div');e.className='empty';e.textContent='No loops configured.';card.appendChild(e);}
 S.loops.forEach(function(l){var row=document.createElement('div');row.className='lrow';
  row.innerHTML='<div class="lm"><div class="lt">'+esc(l.usage.replace('/loop ',''))+'</div><div class="ls">'+esc(l.summary)+'</div></div>';
  var b=document.createElement('button');b.className='run';b.textContent='▶ Run';
  b.onclick=function(){post('/api/loop',{name:l.name}).then(function(){tab('activity');});};
  row.appendChild(b);card.appendChild(row);});
 v.appendChild(card);}

function renderUsage(){var v=document.getElementById('vusage');var u=S.usage;
 if(!u){v.innerHTML='<div class="card"><h3>Subscription usage</h3><div class="empty">Usage unavailable.</div></div>';return;}
 var h='<div class="card"><h3>Subscription limits</h3>';
 if(!u.rateLimits||!u.rateLimits.length)h+='<div class="empty">Limit status appears after the next run.</div>';
 (u.rateLimits||[]).forEach(function(r){var nm=r.rateLimitType==='five_hour'?'5-hour':(r.rateLimitType==='seven_day'?'7-day':r.rateLimitType);
  if(typeof r.utilization==='number'){var used=Math.round(r.utilization<=1?r.utilization*100:r.utilization);h+='<span class="pill '+(used>=80?'warn':'ok')+'">'+nm+': '+used+'% used · '+(100-used)+'% left</span>';}
  else h+='<span class="pill ok">'+nm+': within limit</span>';});
 var w=u.perWindow||{};var mx=Math.max(1,(w.weekly&&w.weekly.consumedTokens)||1);h+='<div style="margin-top:14px">';
 [['hourly',w.hourly],['daily',w.daily],['weekly',w.weekly]].forEach(function(p){var c=(p[1]&&p[1].consumedTokens)||0;
  h+='<div class="gauge"><div class="glabel"><span>'+p[0]+'</span><b>'+fmt(c)+' tokens</b></div><div class="gbar"><div class="gfill" style="width:'+Math.min(100,Math.round(c/mx*100))+'%"></div></div></div>';});
 h+='</div>';if(u.weeklyResetAt)h+='<div class="ls" style="margin-top:8px">weekly resets '+new Date(u.weeklyResetAt).toLocaleString()+'</div>';
 h+='</div>';v.innerHTML=h;
 var fr=document.getElementById('ftl');fr.textContent=(u.rateLimits&&u.rateLimits.length)?u.rateLimits.map(function(r){return (r.rateLimitType==='five_hour'?'5h':'7d')+' ✓';}).join(' · '):'live';}

function renderRecent(){var v=document.getElementById('vrecent');var h='<div class="card"><h3>Recent orders</h3>';
 if(!S.recent.length)h+='<div class="empty">Nothing run yet.</div>';
 S.recent.forEach(function(o){var ic=o.status==='done'?'✓':(o.status==='error'?'✗':'⏳');
  h+='<div class="rrow"><span>'+ic+'</span><div style="flex:1;min-width:0"><div>'+esc(o.task)+'</div><div class="rfo">'+esc(o.folder)+'</div></div></div>';});
 h+='</div>';v.innerHTML=h;}

function tab(name){['activity','loops','usage','recent'].forEach(function(n){
 document.getElementById('v'+n).classList.toggle('on',n===name);
 var b=document.querySelector('.tab[data-v="'+n+'"]');if(b)b.classList.toggle('on',n===name);});}

var feed=document.getElementById('feed');var ph=document.getElementById('ph');var fbar=document.getElementById('fbar');
var feedNodes=[];var filterProject=null; // null = show every project's activity
function nodeVisible(n){return filterProject===null||n._kind==='esc'||n._project===filterProject;}
function refreshFeed(){
 var any=false;
 for(var i=0;i<feedNodes.length;i++){var n=feedNodes[i];if(!n.isConnected){continue;}var v=nodeVisible(n);n.style.display=v?'':'none';if(v)any=true;}
 ph.style.display=any?'none':'';
 ph.textContent=filterProject?('No activity yet for '+filterProject+'.'):'Open a project, or select one on the left — its activity streams here.';
 fbar.classList.toggle('on',filterProject!==null);
 if(filterProject!==null)fbar.innerHTML='Showing <b>'+esc(filterProject)+'</b><a onclick="clearFilter()">show all activity</a>';
 if(any)feed.scrollTop=feed.scrollHeight;
}
function setFilter(p){filterProject=p;refreshFeed();}
function clearFilter(){filterProject=null;refreshFeed();}
function pushFeed(node,kind,project){node._kind=kind;node._project=project||null;feedNodes.push(node);feed.appendChild(node);refreshFeed();}
function feedMsg(html,kind,project){var d=document.createElement('div');d.className='row '+(kind==='me'?'me':'out');d.innerHTML=html;pushFeed(d,kind,project);return d;}
function say(text){var v=(text||'').trim();if(!v)return;feedMsg('› '+esc(v),'me',filterProject);post('/msg',{text:v});}
function uploadFile(){var i=document.getElementById('file');if(!i.files.length)return;var fd=new FormData();fd.append('file',i.files[0]);fetch('/upload',{method:'POST',body:fd});i.value='';}

var es=new EventSource('/stream');
es.onmessage=function(ev){var e=JSON.parse(ev.data);
 if(e.type==='message'){feedMsg((e.project?'<span class="ptag">'+esc(e.project)+'</span>':'')+e.text,'out',e.project);}
 else if(e.type==='projects'){loadState();}
 else if(e.type==='escalation'){
  var c=document.createElement('div');c.className='escc';c.innerHTML='⚠ '+esc(e.reason);
  var a=document.createElement('div');a.className='acts';
  ['allow','deny'].forEach(function(dec){var b=document.createElement('button');b.className='chip '+(dec==='allow'?'ok':'no');b.textContent=dec;
   b.onclick=function(){post('/approve',{id:e.id,decision:dec});c.remove();refreshFeed();};a.appendChild(b);});
  c.appendChild(a);pushFeed(c,'esc',null);tab('activity');}
 else if(e.type==='file'){var d=document.createElement('div');d.className='row out';d.innerHTML='📎 <a href="'+e.url+'">'+esc(e.name)+'</a>';pushFeed(d,'out',e.project);}
};
document.getElementById('ff').onsubmit=function(ev){ev.preventDefault();var m=document.getElementById('msg');say(m.value);m.value='';};
loadState();setInterval(loadState,15000);
</script></body></html>`;
}
