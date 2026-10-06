// Web operator console: a second frontend (alongside Telegram) for the operator to talk to
// the engine. Auth is Telegram Login Widget -> trust-on-first-use admin -> signed session
// cookie; messages drive the same source:"neo" SDK pipeline via the web-channel adapter, and
// worker output streams back over SSE. createWebApp() is a pure Request->Response handler
// (unit-tested); startWeb() is the Bun.serve bind (e2e).
import { isAttentionAction } from "../engine/attention-actions";
import type { Ledger } from "../engine/ledger";
import type { AdminStore } from "../engine/admin";
import type { SessionStore } from "../engine/web-session";
import type { UsageMeter } from "../engine/usage";
import { verifyTelegramLogin } from "../engine/telegram-auth";
import { createWebChannel, type EngineDeps, type WebChannel } from "../engine/web-channel";
import type { CommandDeps } from "../engine/commands";
import { runCompanyBrief } from "../engine/ingress";
import { draftInboxReply, sendInboxReply } from "../engine/inbox-actions";
import { saveInbound } from "../engine/files";
import type { Inbox } from "../engine/inbox";
import type { OperatorBus } from "../engine/operator-bus";
import { faults } from "../engine/fault";
import { DEFAULT_WEB_FEED_WINDOW } from "../config";
import { isPlanAction } from "../engine/plans";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createConsoleI18n, isLang, type Lang } from "./web/i18n";
import type { ThreadFilter, ThreadOrigin, ThreadState } from "../engine/ledger";

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
  /** Shared secret for machine-to-machine POST /agent/ingress + /inbox. Required to enable them. */
  ingressSecret?: string;
  /** Customer message inbox (plain data — no AI). The gateway POSTs inbound mail here. */
  inbox?: Inbox;
  /** Gateway /send URL — Neo calls it to email an approved reply (Neo holds no Cloudflare creds). */
  gatewaySendUrl?: string;
  /** Graceful reload trigger (daemon-injected drain-then-exit) — enables /reload on the web too. */
  requestReload?: () => void;
  /** The toolchain updater (for /updates, ADR-0009). */
  updates?: CommandDeps["updates"];
  /** The restart-gated list for /gated (spec §8.4). */
  gated?: CommandDeps["gated"];
  /** Operator-channel broadcast bus — mirror this surface to/from Telegram (see operator-bus.ts). */
  bus?: OperatorBus;
}

export interface WebApp {
  fetch(req: Request): Promise<Response>;
}

export function createWebApp(deps: WebAppDeps): WebApp {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const channel: WebChannel = createWebChannel({ engine: deps.engine, chatId: WEB_CHAT_ID, usage: deps.usage, requestReload: deps.requestReload, bus: deps.bus, updates: deps.updates, gated: deps.gated });

  function sessionUser(req: Request): number | undefined {
    const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? deps.sessions.verify(decodeURIComponent(m[1]), now()) : undefined;
  }

  // The web request is a unit of work (ADR-0010): a throw in any route is reported and answered with
  // a 500 — it never reaches Bun.serve's error page or the process.
  async function fetch(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (e) {
      faults.report("web.request", e, { method: req.method, path: new URL(req.url).pathname });
      return Response.json({ ok: false, error: "internal error" }, { status: 500, headers: { "cache-control": "no-store" } });
    }
  }

  async function route(req: Request): Promise<Response> {
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
      const lang = pageLang(req, deps.engine.cfg.consoleLang ?? "en");
      const html = uid === undefined ? loginPage(deps.botUsername, lang) : consolePage({ feedWindow: deps.engine.cfg.webFeedWindow, lang });
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
        meter: deps.engine.meter, trust: deps.engine.trust, usage: deps.usage, trace: deps.engine.trace,
        reply: (_c, text, project) => channel.notify(text, project),
        askApproval: async () => "deny",
      });
      return Response.json({ ok: true, result }, { headers: { "cache-control": "no-store" } });
    }

    // --- machine-to-machine: POST /inbox — the gateway parks a customer message here. PLAIN DATA,
    //     no AI: it is just stored and shown in the dashboard for the operator to review. ---
    if (req.method === "POST" && path === "/inbox") {
      const auth = req.headers.get("authorization") ?? "";
      if (!deps.ingressSecret || auth !== `Bearer ${deps.ingressSecret}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (!deps.inbox || typeof b.from !== "string" || !b.from.trim()) {
        return Response.json({ ok: false }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      const item = deps.inbox.record({
        channel: typeof b.channel === "string" ? b.channel : "email",
        from: b.from,
        fromName: typeof b.fromName === "string" ? b.fromName : "",
        to: typeof b.to === "string" ? b.to : "",
        subject: typeof b.subject === "string" ? b.subject : "",
        text: typeof b.text === "string" ? b.text : "",
        html: typeof b.html === "string" ? b.html : "",
        messageId: typeof b.messageId === "string" ? b.messageId : "",
      });
      return Response.json({ ok: true, id: item.id }, { headers: { "cache-control": "no-store" } });
    }

    // --- everything below requires a valid session ---
    if (sessionUser(req) === undefined) return new Response("unauthorized", { status: 401 });

    if (req.method === "GET" && path === "/app.js") {
      return new Response(await consoleAppJs(), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
    }

    // Inbox list for the dashboard (operator-only).
    if (req.method === "GET" && path === "/api/inbox") {
      return Response.json({ items: deps.inbox?.list(deps.engine.cfg.inboxListDefault) ?? [] }, { headers: { "cache-control": "no-store" } });
    }

    // Operator sends an inbox item to the agent → the COMPANY drafts a reply (stored as a draft,
    // never sent). `instructions` (optional) steers it; on a re-draft it carries the revision notes.
    if (req.method === "POST" && path === "/api/inbox/draft") {
      const b = (await req.json().catch(() => ({}))) as { id?: unknown; instructions?: unknown };
      const item = typeof b.id === "string" ? deps.inbox?.get(b.id) : undefined;
      if (!item || !deps.inbox) return Response.json({ ok: false }, { status: 404, headers: { "cache-control": "no-store" } });
      const instr = typeof b.instructions === "string" ? b.instructions.trim() : "";
      // Shared with the Telegram /inbox loop — single source of truth for the brief (inbox-actions).
      const draft = await draftInboxReply(deps.inbox, item.id, instr, {
        cfg: deps.engine.cfg, ledger: deps.engine.ledger, registry: deps.engine.registry,
        meter: deps.engine.meter, trust: deps.engine.trust, usage: deps.usage, trace: deps.engine.trace,
        reply: (_c, text, project) => channel.notify(text, project),
        askApproval: async () => "deny",
      });
      return Response.json({ ok: true, draft }, { headers: { "cache-control": "no-store" } });
    }

    // Operator approves & sends the (possibly edited) reply to the customer, via the gateway.
    if (req.method === "POST" && path === "/api/inbox/send") {
      const b = (await req.json().catch(() => ({}))) as { id?: unknown; reply?: unknown };
      const item = typeof b.id === "string" ? deps.inbox?.get(b.id) : undefined;
      const reply = typeof b.reply === "string" ? b.reply.trim() : "";
      if (!item || !reply || !deps.inbox || !deps.gatewaySendUrl || !deps.ingressSecret) {
        return Response.json({ ok: false }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      // Shared with the Telegram /inbox loop — single source of truth for the gateway send path.
      const outcome = await sendInboxReply(deps.inbox, item.id, reply, { url: deps.gatewaySendUrl, secret: deps.ingressSecret });
      if (outcome === "busy") return Response.json({ ok: false, error: "send in progress" }, { status: 409, headers: { "cache-control": "no-store" } });
      if (outcome !== "sent") return Response.json({ ok: false, error: "send failed" }, { status: 502, headers: { "cache-control": "no-store" } });
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }

    // Operator deletes (dismisses) a customer inbox item. Local-only data change — no external send.
    if (req.method === "DELETE" && path.startsWith("/api/inbox/")) {
      const id = decodeURIComponent(path.slice("/api/inbox/".length));
      if (!id || !deps.inbox) return Response.json({ ok: false }, { status: 404, headers: { "cache-control": "no-store" } });
      deps.inbox.delete(id);
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }

    // Console history (ADR-0017): paged JSON from the ledger, never a replay of the live feed.
    if (req.method === "GET" && path === "/api/threads") {
      const p = url.searchParams;
      const f: ThreadFilter = {
        ...(p.get("project") ? { project: p.get("project")! } : {}),
        ...(THREAD_STATES.has(p.get("state") ?? "") ? { state: p.get("state") as ThreadState } : {}),
        ...(THREAD_ORIGINS.has(p.get("origin") ?? "") ? { origin: p.get("origin") as ThreadOrigin } : {}),
        ...(intParam(p, "since") !== undefined ? { since: intParam(p, "since") } : {}),
        ...(p.get("q") ? { q: p.get("q")! } : {}),
      };
      return Response.json(channel.threads(f, { before: p.get("before") ?? undefined, limit: intParam(p, "limit") ?? PAGE_DEFAULT }), NO_STORE);
    }
    if (req.method === "GET" && path === "/api/thread-projects") {
      return Response.json({ rows: channel.threadProjects() }, NO_STORE);
    }
    if (req.method === "GET" && /^\/api\/threads\/\d+$/.test(path)) {
      const view = channel.thread(Number(path.slice("/api/threads/".length)), { before: intParam(url.searchParams, "before"), limit: intParam(url.searchParams, "limit") ?? PAGE_DEFAULT });
      return view ? Response.json(view, NO_STORE) : Response.json({ ok: false, error: "no such thread" }, { status: 404, ...NO_STORE });
    }
    if (req.method === "GET" && path === "/api/search") {
      const p = url.searchParams;
      const r = channel.search(p.get("q") ?? "", { ...(p.get("project") ? { project: p.get("project")! } : {}), before: intParam(p, "before"), limit: intParam(p, "limit") ?? PAGE_DEFAULT });
      return Response.json(r, NO_STORE);
    }

    // The thread tree behind a message ref (spec §4.4) — the same tree /trace renders, as JSON.
    if (req.method === "GET" && path.startsWith("/api/trace/")) {
      const trace = deps.engine.trace;
      const id = trace?.parseRef(decodeURIComponent(path.slice("/api/trace/".length)));
      if (!trace || id === undefined || !deps.engine.ledger.messageById(id)) {
        return Response.json({ ok: false, error: "no such message" }, { status: 404, headers: { "cache-control": "no-store" } });
      }
      return Response.json({ ref: trace.ref(id), ...trace.tree(id) }, { headers: { "cache-control": "no-store" } });
    }

    if (req.method === "POST" && path === "/msg") {
      const body = (await req.json().catch(() => ({}))) as { text?: unknown; threadId?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      // The composer opened inside a thread names it (spec §4.1 rule 2); anything else starts a new one.
      const threadId = typeof body.threadId === "number" && Number.isSafeInteger(body.threadId) ? body.threadId : undefined;
      if (text) faults.contain("web.send", () => channel.send(text, threadId === undefined ? undefined : { threadId }));
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
      const cap = form?.get("caption"); const caption = typeof cap === "string" ? cap : "";
      faults.contain("web.send", () => channel.send(`📎 operator attached \`${basename(saved)}\` at \`${saved}\`\n${caption}`), { project: target.name });
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

    if (req.method === "POST" && path === "/api/sdk") {
      const body = (await req.json().catch(() => ({}))) as { provider?: unknown; sdk?: unknown };
      const provider = typeof body.provider === "string" ? body.provider : typeof body.sdk === "string" ? body.sdk : "";
      return Response.json(channel.setSdk(provider), { headers: { "cache-control": "no-store" } });
    }

    if (req.method === "POST" && path === "/api/open") {
      const body = (await req.json().catch(() => ({}))) as { folder?: unknown; task?: unknown };
      if (typeof body.folder === "string" && typeof body.task === "string" && body.folder.trim() && body.task.trim()) {
        const folder = body.folder.trim();
        const task = body.task.trim();
        faults.contain("web.openProject", () => channel.openProject(folder, task), { folder });
      }
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && path === "/api/loop") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      if (typeof body.name === "string") channel.runLoop(body.name);
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && path === "/api/loop/create") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json(channel.createLoop(body as never));
    }

    if (req.method === "POST" && path === "/api/loop/update") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      if (typeof body.name !== "string") return Response.json({ ok: false, error: "name required" });
      return Response.json(channel.updateLoop(body.name, body as never));
    }

    if (req.method === "POST" && path === "/api/loop/delete") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      if (typeof body.name !== "string") return Response.json({ ok: false, error: "name required" });
      return Response.json(channel.deleteLoop(body.name));
    }

    if (req.method === "POST" && path === "/api/todo") {
      // Queue-tab actions: { action: "cancel"|"up"|"pause"|"resume", id?, project? } → the shared /todo command.
      const body = (await req.json().catch(() => ({}))) as { action?: unknown; id?: unknown; project?: unknown };
      const action = typeof body.action === "string" && ["cancel", "up", "pause", "resume"].includes(body.action) ? body.action : "";
      const arg = typeof body.id === "number" ? String(body.id) : typeof body.project === "string" ? body.project.trim() : "";
      if (!action || !arg) return Response.json({ ok: false, error: "action + id/project required" }, { status: 400 });
      return Response.json(channel.todo(`${action} ${arg}`), { headers: { "cache-control": "no-store" } });
    }

    if (req.method === "POST" && path === "/api/plan") {
      // A plan card action (ADR-0019): { id, action } → the shared engine rules.
      const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown; version?: unknown };
      if (typeof body.id !== "number" || typeof body.action !== "string" || !isPlanAction(body.action)) {
        return Response.json({ ok: false, error: "id + action (approve|changes|execute|done|drop) required" }, { status: 400 });
      }
      const version = typeof body.version === "number" ? body.version : undefined;
      return Response.json(await channel.planAction(body.id, body.action, version), { headers: { "cache-control": "no-store" } });
    }

    if (req.method === "POST" && path === "/api/attention") {
      // An attention item's one-tap action (ADR-0018): { id, action } → the shared engine rules.
      const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown };
      if (typeof body.id !== "number" || typeof body.action !== "string" || !isAttentionAction(body.action)) {
        return Response.json({ ok: false, error: "id + action (remove|todo|snooze|dismiss) required" }, { status: 400 });
      }
      return Response.json(await channel.attentionAction(body.id, body.action), { headers: { "cache-control": "no-store" } });
    }

    if (req.method === "POST" && path === "/api/loop/enable") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown; on?: unknown };
      if (typeof body.name === "string") channel.setLoopEnabled(body.name, body.on === true);
      return Response.json({ ok: true });
    }

    if (req.method === "GET" && path === "/stream") {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // Each event carries its feed id; a reconnecting EventSource sends it back as Last-Event-ID
          // and gets only the later events — never the whole history again (ADR-0014).
          const after = Number(req.headers.get("last-event-id")) || 0;
          const unsub = channel.subscribe((e, id) => controller.enqueue(enc.encode(`id: ${id}\ndata: ${JSON.stringify(e)}\n\n`)), { after });
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
/** Console list pages default to this many rows; the ledger clamps every page to PAGE_MAX. */
const PAGE_DEFAULT = 50;
const NO_STORE = { headers: { "cache-control": "no-store" } };
const THREAD_STATES = new Set<string>(["open", "waiting", "done", "failed"]);
const THREAD_ORIGINS = new Set<string>(["operator", "loop", "attention", "ingress", "legacy"]);

/** A non-negative integer query parameter, else undefined (a bad value is ignored, never a 500). */
function intParam(p: URLSearchParams, name: string): number | undefined {
  const v = p.get(name);
  if (v === null || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function startWeb(deps: WebAppDeps, port: number, hostname = "0.0.0.0"): ReturnType<typeof Bun.serve> {
  const appHandler = createWebApp(deps);
  // Build the console bundle at start, so the first page load does not wait for it.
  faults.contain("web.bundle", () => consoleAppJs());
  // idleTimeout 0 = no per-request idle drop; the SSE /stream is long-lived (kept warm by its
  // own 15s keepalive). Without this Bun closed connections after 10s, stalling live updates.
  return Bun.serve({ port, hostname, idleTimeout: 0, fetch: (req) => appHandler.fetch(req) });
}

// The console page shell and the login page (ADR-0017): HTML templates in ./web, the browser bundle
// built once from ./web/app.ts, every string from ./web/locales through i18next.
const WEB_DIR = join(import.meta.dir, "web");
const CONSOLE_HTML = readFileSync(join(WEB_DIR, "index.html"), "utf8");
const LOGIN_HTML = readFileSync(join(WEB_DIR, "login.html"), "utf8");

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Fill a page template's `%NAME%` slots in one pass (values are already safe for HTML). */
function fill(template: string, slots: Record<string, string>): string {
  return template.replace(/%([A-Z_]+)%/g, (whole, k: string) => slots[k] ?? whole);
}

/** The page language: the operator's `neo_lang` cookie (the console's language switch), else config `consoleLang`. */
function pageLang(req: Request, fallback: Lang): Lang {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)neo_lang=([a-z]+)/);
  return m && isLang(m[1]) ? m[1] : fallback;
}

export function loginPage(botUsername: string, lang: Lang = "en"): string {
  const i18n = createConsoleI18n(lang);
  return fill(LOGIN_HTML, { LANG: lang, DIR: i18n.dir(lang), TITLE: escHtml(i18n.t("meta.loginTitle")), SUB: escHtml(i18n.t("login.sub")), BOT: escHtml(botUsername) });
}

export function consolePage(opts: { feedWindow?: number; lang?: Lang } = {}): string {
  const lang = opts.lang ?? "en";
  return fill(CONSOLE_HTML, { LANG: lang, DIR: createConsoleI18n(lang).dir(lang), FEED_WINDOW: String(opts.feedWindow ?? DEFAULT_WEB_FEED_WINDOW) });
}

let consoleApp: Promise<string> | undefined;
/** The console's browser bundle, built once per daemon from ./web/app.ts by Bun.build (no other
 *  build tool). A failed build is reported by the request that asked and retried by the next one. */
export function consoleAppJs(): Promise<string> {
  if (!consoleApp) {
    const build = Bun.build({ entrypoints: [join(WEB_DIR, "app.ts")], target: "browser", format: "esm", minify: true }).then((r) => {
      if (!r.success || !r.outputs[0]) throw new AggregateError(r.logs, "console bundle failed");
      return r.outputs[0].text();
    });
    consoleApp = build;
    build.catch(() => {
      if (consoleApp === build) consoleApp = undefined;
    });
  }
  return consoleApp;
}
