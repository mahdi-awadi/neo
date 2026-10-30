// Web operator console: a second frontend (alongside Telegram) for the operator to talk to
// the engine. Auth is Telegram Login Widget -> trust-on-first-use admin -> signed session
// cookie; messages drive the same source:"neo" SDK pipeline via the web-channel adapter, and
// worker output streams back over SSE. createWebApp() is a pure Request->Response handler
// (unit-tested); startWeb() is the Bun.serve bind (e2e).
import { bearerOk } from "../engine/bearer";
import type { RunningBuild } from "../engine/producers/restart";
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
import type { Inbox } from "../engine/inbox";
import type { OperatorBus } from "../engine/operator-bus";
import { faults } from "../engine/fault";
import { DEFAULT_WEB_FEED_WINDOW } from "../config";
import { isPlanAction } from "../engine/plans";
import { readMdFilesCfg, resolveMdFile } from "../engine/md-file";
import { snippetHtml } from "../engine/format";
import { HISTORY_DEFAULTS } from "../engine/history/defaults";
import { checkQuery, PROJECT_MAX, rawFromParams } from "../engine/history/operator";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createConsoleI18n, isLang, LANGS, type Lang } from "./web/i18n";
import { BRAND, ICONS, iconType } from "./web/brand";
import type { ThreadFilter, ThreadOrigin, ThreadState } from "../engine/ledger";
import { THREAD_ORIGINS as ORIGIN_LIST } from "../engine/thread-origins";

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
  /** The secret for POST /inbox (`inboxSecretOf`): its own when set, else `ingressSecret`. */
  inboxSecret?: string;
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
  /** Finished work that does not run (ADR-0054): /list and the console header. */
  deployGap?: CommandDeps["deployGap"];
  /** The running build, fixed at boot: the build label under the logo (ADR-0056). */
  build?: RunningBuild;
  /** Operator-channel broadcast bus — mirror this surface to/from Telegram (see operator-bus.ts). */
  bus?: OperatorBus;
  /** Neo's own repo (the project dashboard's Neo card). Absent → the daemon's working folder. */
  neoFolder?: string;
}

export interface WebApp {
  fetch(req: Request): Promise<Response>;
}

export function createWebApp(deps: WebAppDeps): WebApp {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const channel: WebChannel = createWebChannel({ engine: deps.engine, chatId: WEB_CHAT_ID, usage: deps.usage, requestReload: deps.requestReload, bus: deps.bus, updates: deps.updates, gated: deps.gated, deployGap: deps.deployGap, ...(deps.build ? { build: deps.build } : {}), neoFolder: deps.neoFolder });

  function sessionToken(req: Request): string | undefined {
    const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : undefined;
  }
  function sessionUser(req: Request): number | undefined {
    const token = sessionToken(req);
    return token === undefined ? undefined : deps.sessions.verify(token, now());
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
      // The console loads its bundle by content version (ADR-0023); a failed build still serves the page.
      const html = uid === undefined
        ? loginPage(deps.botUsername, lang)
        : consolePage({ feedWindow: deps.engine.cfg.webFeedWindow, lang, appJs: await consoleAppJsVersion().then((v) => `/app.js?v=${v}`, () => "/app.js") });
      // never cache: the login page embeds the bot username, and a stale copy (e.g. an old
      // bot handle behind Cloudflare/browser cache) silently breaks Telegram login.
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, must-revalidate" },
      });
    }

    // --- the installable app shell (ADR-0022): public, static, not personal ---
    if (req.method === "GET" && path === "/manifest.webmanifest") {
      return new Response(JSON.stringify(manifest(pageLang(req, deps.engine.cfg.consoleLang ?? "en"))), {
        headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    if (req.method === "GET" && path === "/sw.js") {
      return new Response(await consoleSwJs(), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
    }
    if (req.method === "GET" && path === "/offline.html") {
      return new Response(offlinePage(pageLang(req, deps.engine.cfg.consoleLang ?? "en")), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    if (req.method === "GET" && path.startsWith("/icons/")) {
      // Only the listed files: the name is looked up, never joined into a path from the request.
      const icon = ICONS.find((i) => i.file === path.slice("/icons/".length));
      if (!icon) return new Response("not found", { status: 404 });
      return new Response(Bun.file(join(WEB_DIR, "icons", icon.file)), {
        headers: { "content-type": iconType(icon.file), "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
      });
    }

    // --- machine-to-machine: POST /agent/ingress (bearer auth, no session cookie) ---
    if (req.method === "POST" && path === "/agent/ingress") {
      const auth = req.headers.get("authorization") ?? "";
      if (!bearerOk(auth, deps.ingressSecret)) {
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
      if (!bearerOk(auth, deps.inboxSecret ?? deps.ingressSecret)) {
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
      // Only the current versioned URL may be kept, and only by the browser (`private`: never a CDN,
      // the bundle is behind the session). A CDN rewrote plain `no-cache` to hours (ADR-0023).
      const js = await consoleAppJs();
      const current = url.searchParams.get("v") === (await consoleAppJsVersion());
      return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": current ? "private, max-age=31536000, immutable" : "private, no-cache" } });
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

    // The project dashboard (P6, spec §9): the list (bounded, PAGE_MAX) and one project's view.
    if (req.method === "GET" && path === "/api/projects") {
      return Response.json(channel.projects(), NO_STORE);
    }
    if (req.method === "GET" && path.startsWith("/api/projects/")) {
      const name = decodeURIComponent(path.slice("/api/projects/".length));
      const view = name && !name.includes("/") ? await channel.project(name) : undefined;
      return view ? Response.json(view, NO_STORE) : Response.json({ ok: false, error: "no such project" }, { status: 404, ...NO_STORE });
    }

    // ADR-0065: the "Pinned — needs you" strip, a pin, and a todo's detail.
    if (req.method === "GET" && path === "/api/needs-you") {
      return Response.json({ items: channel.needsYou() }, NO_STORE);
    }
    if (req.method === "POST" && path === "/api/pin") {
      const body = (await req.json().catch(() => ({}))) as { ref?: unknown; state?: unknown };
      const state = body.state === "pinned" || body.state === "unpinned" || body.state === null ? body.state : undefined;
      if (typeof body.ref !== "string" || state === undefined) {
        return Response.json({ ok: false, error: "ref + state (pinned|unpinned|null) required" }, { status: 400, ...NO_STORE });
      }
      return Response.json(channel.pin(body.ref, state), NO_STORE);
    }
    if (req.method === "GET" && path.startsWith("/api/todo/")) {
      const raw = path.slice("/api/todo/".length);
      const id = /^\d{1,9}$/.test(raw) ? Number(raw) : undefined;
      const d = id !== undefined ? channel.todoDetail(id) : undefined;
      return d ? Response.json(d, NO_STORE) : Response.json({ ok: false, error: "no such todo" }, { status: 404, ...NO_STORE });
    }

    // The task history (ADR-0066): search, remember, forget. Every field is checked before the seam is asked;
    // a refused value is a 400 with its reason code, a history that is off or unreadable a 503.
    if (path === "/api/history" || path.startsWith("/api/history/")) return historyRoute(req, url);

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
      const body = (await req.json().catch(() => ({}))) as { text?: unknown; threadId?: unknown; attachments?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      // The composer opened inside a thread names it (spec §4.1 rule 2); anything else starts a new one.
      const threadId = typeof body.threadId === "number" && Number.isSafeInteger(body.threadId) ? body.threadId : undefined;
      // Staged attachment tokens (ADR-0026): the files go with this text as one message.
      const attachments = Array.isArray(body.attachments) ? body.attachments.filter((t): t is string => typeof t === "string") : [];
      if (text || attachments.length) {
        // Refused before anything is sent, so the composer keeps its text and chips (ADR-0026).
        const checked = channel.check(text, { attachments });
        if ("error" in checked) return Response.json({ ok: false, error: checked.error }, { status: 409 });
        faults.contain("web.send", () => channel.send(text, { ...(threadId === undefined ? {} : { threadId }), ...(attachments.length ? { attachments } : {}) }));
      }
      return Response.json({ ok: true });
    }

    // Attaching only stages the file (ADR-0026): saved to an inbox, nothing sent. The composer sends
    // the returned token with its text through /msg, so the worker gets both in one turn.
    if (req.method === "POST" && path === "/upload") {
      const form = await req.formData().catch(() => null);
      const f = form?.get("file");
      if (!(f instanceof File)) return Response.json({ ok: false }, { status: 400 });
      const t = Number(form?.get("threadId"));
      const threadId = Number.isSafeInteger(t) && t > 0 ? t : undefined;
      const staged = channel.stage({ name: f.name || "file", bytes: new Uint8Array(await f.arrayBuffer()) }, threadId === undefined ? undefined : { threadId });
      if ("error" in staged) return Response.json({ ok: false, error: staged.error }, { status: 409 });
      return Response.json({ ok: true, ...staged }, NO_STORE);
    }
    if (req.method === "POST" && path === "/upload/discard") {
      const body = (await req.json().catch(() => ({}))) as { token?: unknown };
      return Response.json({ ok: typeof body.token === "string" && channel.discard(body.token) });
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

    // A Markdown file link (ADR-0046): md-file.ts decides and reads; here only the headers and the audit.
    if (req.method === "GET" && path === "/md-file") {
      const asked = url.searchParams.get("path") ?? "";
      const cfg = deps.engine.cfg.mdFiles ?? readMdFilesCfg(undefined, deps.engine.cfg.workRoot);
      const r = resolveMdFile(asked, cfg);
      const session = createHash("sha256").update(sessionToken(req) ?? "").digest("hex").slice(0, 12);
      deps.engine.ledger.recordEvent("md_file", {
        data: { path: asked.slice(0, 1024), ...(r.real ? { real: r.real } : {}), status: r.ok ? 200 : r.status, ...(r.ok ? {} : { reason: r.reason }), uid: sessionUser(req), session },
      });
      if (!r.ok) return new Response(r.reason, { status: r.status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      return new Response(r.bytes, {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${r.name.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${rfc5987(r.name)}`,
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
          "cache-control": "no-store",
        },
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

    // ADR-0058: stop or background ONE running tool call — { session, toolUseId } → the shared seam.
    const toolAct = /^\/api\/tool\/(stop|background)$/.exec(path);
    if (req.method === "POST" && path.startsWith("/api/tool/")) {
      if (!toolAct) return Response.json({ ok: false, error: "unknown action" }, { status: 404 });
      const body = (await req.json().catch(() => ({}))) as { session?: unknown; toolUseId?: unknown };
      if (typeof body.session !== "string" || typeof body.toolUseId !== "string" || !body.session || !body.toolUseId) {
        return Response.json({ ok: false, error: "session + toolUseId required" }, { status: 400 });
      }
      const r = await channel.toolControl(body.session, body.toolUseId, toolAct[1] as "stop" | "background");
      return Response.json(r, { headers: { "cache-control": "no-store" } });
    }

    if (req.method === "POST" && path === "/api/todo") {
      // Queue-tab actions: { action: "cancel"|"up"|"retry"|"pause"|"resume", id?, project? } → the shared /todo command.
      const body = (await req.json().catch(() => ({}))) as { action?: unknown; id?: unknown; project?: unknown };
      const action = typeof body.action === "string" && ["cancel", "up", "retry", "pause", "resume"].includes(body.action) ? body.action : "";
      const arg = typeof body.id === "number" ? String(body.id) : typeof body.project === "string" ? body.project.trim() : "";
      if (!action || !arg) return Response.json({ ok: false, error: "action + id/project required" }, { status: 400 });
      return Response.json(channel.todo(`${action} ${arg}`), { headers: { "cache-control": "no-store" } });
    }

    if (req.method === "POST" && path === "/api/plan") {
      // A plan card action (ADR-0019): { id, action } → the shared engine rules.
      const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown; version?: unknown };
      if (typeof body.id !== "number" || typeof body.action !== "string" || !isPlanAction(body.action)) {
        return Response.json({ ok: false, error: "id + action (approve|changes|execute|anyway|done|drop) required" }, { status: 400 });
      }
      const version = typeof body.version === "number" ? body.version : undefined;
      return Response.json(await channel.planAction(body.id, body.action, version), { headers: { "cache-control": "no-store" } });
    }

    if (req.method === "POST" && path === "/api/thread/close") {
      // The operator closes a thread (ADR-0038): { id } → the engine's one close action.
      const body = (await req.json().catch(() => ({}))) as { id?: unknown };
      if (typeof body.id !== "number" || !Number.isSafeInteger(body.id) || body.id <= 0) {
        return Response.json({ ok: false, error: "id (a thread id) required" }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      const r = channel.closeThread(body.id);
      if (!r) return Response.json({ ok: false, error: "no such thread" }, { status: 404, headers: { "cache-control": "no-store" } });
      return Response.json(r, { headers: { "cache-control": "no-store" } });
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

  async function historyRoute(req: Request, url: URL): Promise<Response> {
    const history = deps.engine.history;
    const refuse = (error: string, status = 400): Response => Response.json({ ok: false, error }, { status, ...NO_STORE });
    const known = req.method === "GET" ? url.pathname === "/api/history" : req.method === "POST" && ["/api/history/remember", "/api/history/forget"].includes(url.pathname);
    if (!known) return refuse("not found", 404);
    if (!history) return refuse("history_off", 503);
    const unavailable = (e?: string): number => (e === "history_unreadable" ? 503 : 400);

    if (req.method === "GET") {
      const checked = checkQuery(rawFromParams(url.searchParams), (deps.engine.cfg.history ?? HISTORY_DEFAULTS).search);
      if (!checked.ok) return refuse(checked.error);
      const r = await history.search(checked.q);
      if (!r.ok) return refuse(r.error ?? "history_unreadable", unavailable(r.error));
      // The snippet goes out as safe HTML (escaped, the match in <mark>), like /api/search.
      return Response.json({ ok: true, mode: r.mode, hits: r.hits.map((h) => ({ ...h, snippet: snippetHtml(h.snippet) })) }, NO_STORE);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (url.pathname === "/api/history/remember") {
      if (typeof body.text !== "string") return refuse("text_required");
      if (body.project !== undefined && (typeof body.project !== "string" || body.project.length > PROJECT_MAX)) return refuse("bad_project");
      const project = typeof body.project === "string" ? body.project.trim() : "";
      const r = history.remember({ text: body.text, ...(project ? { project } : {}), by: "operator", session: "console" });
      if (!r.ok) return refuse(r.error, unavailable(r.error));
      return Response.json({ ok: true, ref: r.ref, duplicate: r.duplicate }, NO_STORE);
    }

    if (typeof body.ref !== "string" || !body.ref || body.ref.length > FORGET_FIELD_MAX) return refuse("bad_ref");
    if (typeof body.reason !== "string" || !body.reason.trim()) return refuse("reason_required");
    if (body.reason.length > FORGET_FIELD_MAX) return refuse("reason_too_long");
    const r = await history.forget(body.ref, body.reason.trim(), Date.now());
    if (!r.ok) return refuse(r.error ?? "history_unreadable", r.error === "unknown_ref" ? 404 : unavailable(r.error));
    return Response.json({ ok: true, chunks: r.chunks, points: r.points, pendingPoints: r.pendingPoints }, NO_STORE);
  }

  return { fetch };
}

/** Bun.serve bind for the daemon (e2e-verified). Binds the docker-bridge IP by default so
 * only Traefik (TLS front door) can reach it — never exposed publicly bypassing HTTPS. */
/** Console list pages default to this many rows; the ledger clamps every page to PAGE_MAX. */
const PAGE_DEFAULT = 50;
const NO_STORE = { headers: { "cache-control": "no-store" } };
/** A forget ref or reason longer than this is refused (a ref is short; a reason is one line). */
const FORGET_FIELD_MAX = 500;
const THREAD_STATES = new Set<string>(["open", "waiting", "done", "failed"]);
const THREAD_ORIGINS = new Set<string>(ORIGIN_LIST);

/** A file name as an RFC 5987 `filename*` value: `encodeURIComponent` leaves `'()*` raw, which that
 *  grammar does not allow. */
function rfc5987(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A non-negative integer query parameter, else undefined (a bad value is ignored, never a 500). */
function intParam(p: URLSearchParams, name: string): number | undefined {
  const v = p.get(name);
  if (v === null || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function startWeb(
  deps: WebAppDeps,
  port: number,
  hostname: string,
  bindOpts: { retryMs: number; onFail: (err: unknown) => void; onBound: () => void },
): { stop(): void } {
  // The app is built once (it registers with the operator bus); only the bind is retried.
  const appHandler = createWebApp(deps);
  // Build the console bundle at start, so the first page load does not wait for it.
  faults.contain("web.bundle", () => consoleAppJs());
  faults.contain("web.bundle", () => consoleSwJs());
  // idleTimeout 0 = no per-request idle drop; the SSE /stream is long-lived (kept warm by its
  // own 15s keepalive). Without this Bun closed connections after 10s, stalling live updates.
  return keepBinding(() => Bun.serve({ port, hostname, idleTimeout: 0, fetch: (req) => appHandler.fetch(req) }), bindOpts);
}

/** Bind, and on failure report it and try again every `retryMs` — never throw. The web host can be a
 *  Docker bridge IP that does not exist until Docker is up (2026-10-17: after a reboot the missing
 *  bridge made the bind throw, the daemon exit, and Telegram went silent too). `stop()` cancels a
 *  pending retry on shutdown. */
export function keepBinding<T>(
  bind: () => T,
  o: {
    retryMs: number;
    onFail: (err: unknown) => void;
    onBound: (server: T) => void;
    schedule?: (fn: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
  },
): { stop(): void } {
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = o.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let pending: unknown;
  let stopped = false;
  const attempt = (): void => {
    pending = undefined;
    if (stopped) return;
    let server: T;
    try {
      server = bind();
    } catch (e) {
      o.onFail(e);
      pending = schedule(attempt, o.retryMs);
      return;
    }
    o.onBound(server);
  };
  attempt();
  return {
    stop() {
      stopped = true;
      if (pending !== undefined) cancel(pending);
    },
  };
}

// The console page shell and the login page (ADR-0017): HTML templates in ./web, the browser bundle
// built once from ./web/app.ts, every string from ./web/locales through i18next.
const WEB_DIR = join(import.meta.dir, "web");
const CONSOLE_HTML = readFileSync(join(WEB_DIR, "index.html"), "utf8");
const LOGIN_HTML = readFileSync(join(WEB_DIR, "login.html"), "utf8");
const OFFLINE_HTML = readFileSync(join(WEB_DIR, "offline.html"), "utf8");
/** The theme-color meta slots every page fills (ADR-0022). */
const THEME_SLOTS = { THEME_DARK: BRAND.inkDark, THEME_LIGHT: BRAND.inkLight };

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
  return fill(LOGIN_HTML, { ...THEME_SLOTS, LANG: lang, DIR: i18n.dir(lang), TITLE: escHtml(i18n.t("meta.loginTitle")), SUB: escHtml(i18n.t("login.sub")), BOT: escHtml(botUsername) });
}

export function consolePage(opts: { feedWindow?: number; lang?: Lang; appJs?: string } = {}): string {
  const lang = opts.lang ?? "en";
  return fill(CONSOLE_HTML, { ...THEME_SLOTS, LANG: lang, DIR: createConsoleI18n(lang).dir(lang), FEED_WINDOW: String(opts.feedWindow ?? DEFAULT_WEB_FEED_WINDOW), APP_JS: escHtml(opts.appJs ?? "/app.js") });
}

/** The offline page the service worker shows when a navigation fails (localized, public). */
export function offlinePage(lang: Lang = "en"): string {
  const i18n = createConsoleI18n(lang);
  return fill(OFFLINE_HTML, { ...THEME_SLOTS, LANG: lang, DIR: i18n.dir(lang), TITLE: escHtml(i18n.t("offline.title")), BODY: escHtml(i18n.t("offline.body")), RETRY: escHtml(i18n.t("offline.retry")), STRINGS: OFFLINE_STRINGS });
}

/** Every language's offline strings as JSON for the page's inline script: the cached page then follows
 *  the current language cookie on the client. `<` is escaped so the JSON can never close its <script>. */
const OFFLINE_STRINGS = JSON.stringify(
  Object.fromEntries(
    LANGS.map((l) => {
      const i = createConsoleI18n(l);
      return [l, { dir: i.dir(l), title: i.t("offline.title"), body: i.t("offline.body"), retry: i.t("offline.retry") }];
    }),
  ),
).replace(/</g, "\\u003c");

/** The web app manifest (AC11): strings from the catalogue, colours from brand.ts, icons from ICONS. */
function manifest(lang: Lang) {
  const i18n = createConsoleI18n(lang);
  return {
    id: "/", name: i18n.t("pwa.name"), short_name: i18n.t("pwa.shortName"), description: i18n.t("pwa.description"),
    lang, dir: i18n.dir(lang), start_url: "/", scope: "/", display: "standalone",
    background_color: BRAND.inkDark, theme_color: BRAND.inkDark,
    icons: ICONS.flatMap((i) => ("purpose" in i ? [{ src: `/icons/${i.file}`, sizes: `${i.size}x${i.size}`, type: "image/png", purpose: i.purpose }] : [])),
  };
}

const bundles = new Map<string, Promise<string>>();
/** A browser bundle, built once per daemon from ./web/<entry> by Bun.build (no other build tool). A
 *  failed build is reported by the request that asked and retried by the next one. */
function bundle(entry: string): Promise<string> {
  let built = bundles.get(entry);
  if (!built) {
    const build = Bun.build({ entrypoints: [join(WEB_DIR, entry)], target: "browser", format: "esm", minify: true }).then((r) => {
      if (!r.success || !r.outputs[0]) throw new AggregateError(r.logs, `${entry} bundle failed`);
      return r.outputs[0].text();
    });
    bundles.set(entry, build);
    build.catch(() => {
      if (bundles.get(entry) === build) bundles.delete(entry);
    });
    built = build;
  }
  return built;
}

/** The console's browser bundle (/app.js, behind the session). */
export function consoleAppJs(): Promise<string> {
  return bundle("app.ts");
}

/** The bundle's content version (ADR-0023): the page asks for `/app.js?v=<version>`, so a changed
 *  bundle is a new URL that no browser or CDN copy of the old one can answer. */
export async function consoleAppJsVersion(): Promise<string> {
  return createHash("sha256").update(await consoleAppJs()).digest("hex").slice(0, 16);
}

/** The service worker (/sw.js, public — ADR-0022). */
export function consoleSwJs(): Promise<string> {
  return bundle("sw.ts");
}
