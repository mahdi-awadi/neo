/// <reference lib="dom" />
// The operator console (browser). Bundled by Bun.build at daemon start and served as /app.js; the
// page shell is ./index.html. Every user-facing string comes from ./locales/<lang>/console.json
// through i18next (./i18n.ts) — `t()` for markup (interpolated values escaped), `tx()` for plain text.
// Live data: /api/state (polled), /stream (SSE, the bounded feed window — ADR-0014), and the paged
// history endpoints (/api/threads, /api/threads/:id, /api/search — ADR-0017).
import { createConsoleI18n, isLang } from "./i18n";
import { pastedImages } from "./paste";
import { INSTALL_DISMISSED_KEY, installMode, isIos } from "./pwa";
import { CONFIRM_WINDOW_MS, armedFor, confirmTap } from "./confirm";
import { type DetailView, backAction, enterAction, popDetail, staleOnLoad } from "./nav";
import { createCodeEnhancer } from "./code-blocks";
import { linkMdPaths } from "./md-links";
import { type Attachment, type SendBody, createAttachments, formatSize } from "./attachments";
import { bindComposeBoxes, clearBox } from "./compose-box";
import { linesHtml } from "./text-lines";
import { buildLabel } from "./build-label";
import { dismissSplash } from "./splash";
import { runAct, type ActResult } from "./act";
import { THREAD_ORIGINS } from "../../engine/thread-origins";

/** The project kill button's icon: an inline SVG, so it never depends on a font having "✕". */
const KILL_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

const root = document.documentElement;
const i18n = createConsoleI18n(isLang(root.lang) ? root.lang : "en");
type Vars = Record<string, string | number>;
/** Markup text: interpolated values are HTML-escaped. */
const t = (key: string, vars?: Vars): string => i18n.t(key, vars ?? {});
/** Plain text (textContent, title, placeholder, dialogs): the DOM does not parse it, so no escaping. */
const tx = (key: string, vars?: Vars): string => i18n.t(key, { ...vars, interpolation: { escapeValue: false } });
/** Syntax colours (lazy, visible blocks only), copy buttons and folding of long blocks for the
 *  server-rendered code blocks (ADR-0025). */
const code = createCodeEnhancer((key, vars) => tx(key, vars));
/** Every rendered row, thread and card: code blocks, then Markdown file links (ADR-0046). */
const enhanceCode = (root: HTMLElement): void => {
  code.enhance(root);
  linkMdPaths(root, tx("files.download"));
};

const FEED_WINDOW = Number(root.dataset.feedWindow) || 500;
const POLL_MS = 15000;
/** How long a toast stays (ADR-0065). */
const TOAST_MS = 4000;
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const val = (id: string): string => ($(id) as HTMLInputElement).value;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let S: Any = { projects: [], sdk: { provider: "subscription", label: "", choices: [] }, usage: null, loops: [], recent: [], repos: [], todos: [], waiting: [] };

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
/** A ref, path, time or id inside text: an isolated left-to-right run, so it never flips in Arabic. */
function ltr(s: unknown): string {
  return `<bdi dir="ltr" class="ref">${esc(s)}</bdi>`;
}
/** A value of unknown direction (a project name, an age) inside a line of the other script: isolated,
 *  so the bidi algorithm never reorders it with its neighbours. */
function iso(s: unknown): string {
  return `<bdi>${esc(s)}</bdi>`;
}
function post(p: string, b: unknown): Promise<Response> {
  return fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
}
/** A toast (ADR-0065): one short line in the polite live region, gone after a few seconds. The text is
 *  set as text, never HTML; `dir="auto"` keeps ids and numbers in their own direction. */
function toast(text: string, ok: boolean): void {
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = "toast" + (ok ? "" : " bad");
  el.setAttribute("dir", "auto");
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild?.remove();
  // Re-shown each time, so it is the newest top-layer element — above an open sheet.
  if (box.matches(":popover-open")) box.hidePopover();
  box.showPopover();
  setTimeout(() => {
    el.remove();
    if (!box.children.length && box.matches(":popover-open")) box.hidePopover();
  }, TOAST_MS);
}
/** Every console button's action (ADR-0065): busy while it runs, then a toast with the engine's reply.
 *  `okText`: the console's own words for a success (a pin), instead of the engine's English reply. */
function act(btn: Element | null, path: string, body: unknown, okText?: string): Promise<ActResult> {
  return runAct(btn as HTMLButtonElement | null, () => post(path, body), { toast: (text, ok) => toast(ok && okText ? okText : text, ok), fallback: (ok) => tx(ok ? "toast.done" : "toast.failed") });
}
function fmt(n: number): string {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return "" + Math.round(n);
}
function age(ms: number): string {
  const s = Math.floor((ms || 0) / 1000);
  if (s < 60) return tx("age.s", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return tx("age.m", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return tx("age.h", { n: h });
  return tx("age.d", { n: Math.floor(h / 24) });
}
/** Dates and times in the page's language, with Latin digits like every other number here. */
const LOCALE = `${root.lang}-u-nu-latn`;
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
}
/** A resume time: the clock today, with the date when it is another day (a weekly limit, ADR-0047). */
function resumeAt(at: number): string {
  if (new Date(at).toDateString() === new Date().toDateString()) return clock(at);
  return new Date(at).toLocaleString(LOCALE, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The page shell's static text: every `data-i18n*` attribute is filled from the catalogue. */
function applyStatic(): void {
  document.title = tx("meta.title");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = tx(el.dataset.i18n!)));
  document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => (el.placeholder = tx(el.dataset.i18nPlaceholder!)));
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => (el.title = tx(el.dataset.i18nTitle!)));
  document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", tx(el.dataset.i18nAria!)));
}

// One /api/state request at a time: a burst of 'projects' events coalesces into one follow-up load.
let stateLoad: Promise<void> | null = null;
let stateAgain = false;
function loadState(): Promise<void> {
  if (stateLoad) {
    stateAgain = true;
    return stateLoad;
  }
  stateLoad = fetch("/api/state?_=" + Date.now(), { cache: "no-store", signal: AbortSignal.timeout(POLL_MS) })
    .then((r) => r.json())
    .then((d) => {
      S = d;
      renderAll();
    })
    .catch(() => {})
    .then(() => {
      loadPins();
      stateLoad = null;
      if (stateAgain) {
        stateAgain = false;
        void loadState();
      }
    });
  return stateLoad;
}
// Re-render a section only when its data changed — a rebuild wipes whatever the operator is typing in it.
const lastJson: Record<string, string> = {};
function changed(k: string, v: unknown): boolean {
  const j = JSON.stringify(v);
  if (lastJson[k] === j) return false;
  lastJson[k] = j;
  return true;
}
function renderAll(): void {
  renderRepos();
  if (changed("sdk", S.sdk)) renderSdk();
  if (changed("projects", S.projects)) renderProjects();
  if (changed("deploy", S.deploy ?? null)) renderDeploy();
  if (changed("build", S.build ?? null)) renderBuild();
  renderRunning(); // clock-dependent ages: always
  renderTodos(); // clock-dependent ("running 4m"): always
  if (changed("loops", S.loops)) renderLoops();
  if (changed("usage", S.usage)) renderUsage();
  if (changed("recent", [S.recent, S.contextEvents])) renderRecent();
}

function renderRepos(): void {
  const sel = $("repo") as HTMLSelectElement;
  if (sel.dataset.n === String(S.repos.length)) return;
  sel.dataset.n = String(S.repos.length);
  const cur = sel.value;
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = tx("newProject.pickRepo");
  sel.appendChild(none);
  S.repos.forEach((r: string) => {
    const o = document.createElement("option");
    o.value = r;
    o.textContent = r.split("/").pop()!;
    sel.appendChild(o);
  });
  if (cur) sel.value = cur;
}

function renderSdk(): void {
  lastJson.sdk = JSON.stringify(S.sdk); // a direct repaint records what it drew, so a later poll compares to it
  const sdk = S.sdk || { provider: "subscription", choices: [] };
  const codex = sdk.provider === "codex";
  $("sdk-label").textContent = tx(codex ? "sdk.codex" : "sdk.claude");
  $("sdk-foot").textContent = tx(codex ? "sdk.codexFoot" : "sdk.claudeFoot");
  const box = $("sdkbox");
  box.innerHTML = "";
  const choices =
    sdk.choices && sdk.choices.length
      ? sdk.choices
      : [
          { provider: "subscription", label: tx("sdk.claudeLabel"), active: !codex },
          { provider: "codex", label: tx("sdk.codexLabel"), active: codex },
        ];
  const seg = document.createElement("div");
  seg.className = "seg";
  choices.forEach((c: Any) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = tx(c.provider === "codex" ? "sdk.codex" : "sdk.claude");
    b.title = c.label;
    b.className = c.active ? "on" : "";
    b.onclick = () => setSdk(c.provider, b);
    seg.appendChild(b);
  });
  box.appendChild(seg);
}
function setSdk(provider: string, btn: Element): void {
  void act(btn, "/api/sdk", { provider }).then((r) => {
    const d = r.data as Any;
    if (!r.ok || !d?.sdk) return;
    S.sdk = d.sdk;
    renderSdk();
  });
}

// ctx% against the sweet spot (ADR-0021): the band colours the chip; the last reset rides along.
function ctxChip(p: Any): string {
  if (p.ctxPct == null && !p.ctxSuspect && !p.lastReset) return "";
  const b = p.ctxBand || "healthy";
  const pct = p.ctxSuspect ? tx("ctx.chipSuspect") : p.ctxPct != null ? tx("ctx.chip", { pct: p.ctxPct }) : tx("ctx.chipNone");
  const text = pct + (p.lastReset ? " · " + tx("ctx.reset", { age: age(Date.now() - p.lastReset.at) }) : "");
  const verdict = p.lastReset ? p.lastReset.verdict + (p.lastReset.reason ? ` (${p.lastReset.reason})` : "") : "";
  const tip = tx(`ctx.band.${b}`) + (p.lastReset ? " — " + tx("ctx.lastReset", { verdict }) : "");
  return `<span class="ctx ${esc(b)}" title="${esc(tip)}">${esc(text)}</span>`;
}
/** Armed kill buttons by project id → when armed (two-tap confirm, ./confirm.ts). */
const killArms = new Map<string | number, number>();
function renderProjects(): void {
  const box = $("projects");
  $("pcount").textContent = S.projects.length || "";
  if (!S.projects.length) {
    box.innerHTML = `<div class="empty">${t("projects.empty")}<br>${t("projects.emptyHint")}</div>`;
    $("who").textContent = tx("projects.noneActive");
    return;
  }
  box.innerHTML = "";
  let active: Any = null;
  S.projects.forEach((p: Any) => {
    const d = document.createElement("div");
    d.className = "proj" + (p.active ? " on" : "");
    const busy = p.state === "working" || p.state === "quiet";
    d.innerHTML = `<span class="dot ${p.state === "wedged" ? "" : busy ? "running" : "idle"}"></span><div class="meta"><div class="nm">${esc(p.name)}${ctxChip(p)}</div><div class="fo">${ltr(p.folder)} · ${esc(p.line || p.state)}</div></div>`;
    d.onclick = () => {
      closeDrawer(false);
      setFilter(p.name);
      tab("activity");
      void post("/select", { id: p.id }).then(loadState);
    };
    const k = document.createElement("button");
    k.className = "kbtn";
    k.innerHTML = KILL_ICON;
    k.title = tx("projects.kill");
    k.setAttribute("aria-label", tx("projects.kill"));
    // Two taps on every pointer (a destructive action; on a phone the button sits next to the row's own
    // tap target). The arm lives in killArms, so a re-render inside the window keeps it.
    const armed = (at: number): void => {
      k.classList.add("arm");
      k.textContent = tx("projects.killConfirm");
      k.setAttribute("aria-label", tx("projects.killConfirm"));
      setTimeout(() => {
        if (killArms.get(p.id) !== at) return; // fired or re-armed since
        killArms.delete(p.id);
        k.classList.remove("arm");
        k.innerHTML = KILL_ICON;
        k.setAttribute("aria-label", tx("projects.kill"));
      }, Math.max(0, at + CONFIRM_WINDOW_MS - Date.now()));
    };
    const live = armedFor(killArms, p.id, Date.now());
    if (live !== undefined) armed(live);
    k.onclick = (ev) => {
      ev.stopPropagation();
      const now = Date.now();
      if (confirmTap(armedFor(killArms, p.id, now), now) === "arm") {
        killArms.set(p.id, now);
        armed(now);
        return;
      }
      killArms.delete(p.id);
      void act(k, "/kill", { id: p.id }).then(loadState);
    };
    d.appendChild(k);
    box.appendChild(d);
    if (p.active) active = p;
  });
  $("who").textContent = active ? tx("projects.active", { name: active.name }) : tx("projects.openNoneActive", { count: S.projects.length });
}
/** "Running now" (ADR-0058): every running tool call, newest first, with Stop (confirmed) and
 *  Background. The command stays LTR in both languages. */
function renderRunning(): void {
  const el = $("runstrip");
  const R: Any[] = S.running || [];
  el.hidden = !R.length;
  if (!R.length) return void (el.innerHTML = "");
  const now = Date.now();
  el.innerHTML = `<h4>${t("tools.running")}</h4>`;
  for (const c of R) {
    const row = document.createElement("div");
    row.className = "runrow";
    row.innerHTML = `<span class="rp">${iso(c.name)} · ${esc(c.tool)} · ${ltr(age(now - c.since))}</span><span class="rc" title="${esc(c.summary)}">${esc(c.summary)}</span>`;
    const control = (action: "stop" | "background", btn: Element) => {
      void act(btn, `/api/tool/${action}`, { session: c.session, toolUseId: c.toolUseId }).then((r) => {
        if (r.text) feedMsg("⋯ " + esc(r.text), "me", null);
        void loadState();
      });
    };
    if (c.provider === "claude") {
      const bg = document.createElement("button");
      bg.className = "chip";
      bg.textContent = tx("tools.background");
      bg.title = tx("tools.backgroundTitle");
      bg.onclick = () => control("background", bg);
      row.appendChild(bg);
    }
    const stop = document.createElement("button");
    stop.className = "chip no";
    stop.textContent = tx("tools.stop");
    stop.title = tx("tools.stopTitle");
    stop.onclick = () => {
      if (confirm(tx("tools.confirmStop", { cmd: c.summary, project: c.project }))) control("stop", stop);
    };
    row.appendChild(stop);
    el.appendChild(row);
  }
}
/** The build label under the logo (ADR-0056): the running build from the boot record, LTR in both
 *  languages (the element carries dir="ltr"). Hidden when the boot recorded no commit. */
function renderBuild(): void {
  const el = $("ver");
  el.hidden = !S.build;
  if (!S.build) return;
  const { text, title } = buildLabel(tx, S.build);
  el.textContent = text;
  el.title = title;
}
/** Finished work that does not run (ADR-0054): a header chip, loud once it is older than the limit. */
function renderDeploy(): void {
  const el = $("deploy");
  const g = S.deploy;
  el.hidden = !g;
  if (!g) return;
  // The sign stays with its number (`+87`, never `87+` in RTL): one LTR isolate. ltr() escapes.
  el.innerHTML = tx("deploy.gap", { integration: ltr(g.integration), n: ltr("+" + g.commits), days: ltr(g.days) });
  el.title = tx("deploy.title", { integration: g.integration, n: g.commits, days: g.days, running: g.running, branch: g.branch });
  el.className = "tchip " + (g.high ? "deploy-high" : "own-sweep");
}

function openProject(): void {
  const folder = val("repo");
  const task = val("task").trim();
  if (!folder || !task) {
    alert(tx("newProject.missing"));
    return;
  }
  void act($("open-project"), "/api/open", { folder, task }).then((r) => {
    if (!r.ok) return;
    closeDrawer(false);
    clearBox($("task") as HTMLTextAreaElement);
    tab("activity");
    setTimeout(loadState, 500);
  });
}

function renderLoops(): void {
  const v = $("vloops");
  v.innerHTML = "";
  const form = document.createElement("div");
  form.className = "card";
  const ph = (key: string) => esc(tx(key));
  form.innerHTML =
    `<h3>${t("loops.newTitle")}</h3>` +
    `<input id="lc-name" placeholder="${ph("loops.name")}" class="lci">` +
    `<input id="lc-sum" placeholder="${ph("loops.summary")}" class="lci">` +
    `<input id="lc-folder" placeholder="${ph("loops.folder")}" class="lci">` +
    `<textarea id="lc-prompt" class="itx" dir="auto" data-compose="text" placeholder="${ph("loops.prompt")}"></textarea>` +
    `<select id="lc-gk" class="lci"><option value="command">${t("loops.goalCommand")}</option><option value="judge">${t("loops.goalJudge")}</option></select>` +
    `<input id="lc-gv" placeholder="${ph("loops.goalValue")}" class="lci">` +
    `<select id="lc-tk" class="lci"><option value="manual">${t("loops.triggerManual")}</option><option value="interval">${t("loops.triggerInterval")}</option><option value="cron">${t("loops.triggerCron")}</option></select>` +
    `<input id="lc-tv" placeholder="${ph("loops.triggerValue")}" class="lci">` +
    `<input id="lc-mi" type="number" value="3" placeholder="${ph("loops.maxIterations")}" class="lci">` +
    `<input id="lc-bud" type="number" placeholder="${ph("loops.budget")}" class="lci">` +
    `<button class="btn" data-act="create-loop">${t("loops.create")}</button>` +
    `<div id="lc-err" class="ls" style="color:var(--danger)"></div>`;
  v.appendChild(form);
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h3>${t("loops.title")}</h3>`;
  if (!S.loops.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = tx("loops.none");
    card.appendChild(e);
  }
  S.loops.forEach((l: Any) => {
    const row = document.createElement("div");
    row.className = "lrow";
    const badge = " · " + tx(l.custom ? "loops.custom" : "loops.builtin");
    row.innerHTML = `<div class="lm"><div class="lt">${esc(l.name)}</div><div class="ls">${esc(l.summary)} · ${esc(l.triggerDesc || "")}${esc(badge)}</div></div>`;
    const run = document.createElement("button");
    run.className = "run";
    run.textContent = tx("loops.run");
    run.onclick = () => void act(run, "/api/loop", { name: l.name }).then((r) => r.ok && tab("activity"));
    row.appendChild(run);
    if (l.scheduled) {
      const tg = document.createElement("button");
      tg.className = "chip" + (l.enabled ? " ok" : "");
      tg.textContent = tx(l.enabled ? "loops.on" : "loops.off");
      tg.onclick = () => void act(tg, "/api/loop/enable", { name: l.name, on: !l.enabled }).then(loadState);
      row.appendChild(tg);
    }
    if (l.custom) {
      const del = document.createElement("button");
      del.className = "chip no";
      del.textContent = tx("loops.delete");
      del.onclick = () => {
        if (confirm(tx("loops.confirmDelete", { name: l.name }))) void act(del, "/api/loop/delete", { name: l.name }).then(loadState);
      };
      row.appendChild(del);
    }
    card.appendChild(row);
  });
  v.appendChild(card);
}
function submitLoop(btn: Element | null): void {
  const body: Any = {
    name: val("lc-name"),
    summary: val("lc-sum"),
    folder: val("lc-folder"),
    prompt: val("lc-prompt"),
    goalKind: val("lc-gk"),
    triggerKind: val("lc-tk"),
    maxIterations: Number(val("lc-mi")) || 1,
  };
  if (body.goalKind === "command") body.goalCommand = val("lc-gv");
  else body.goalCriteria = val("lc-gv");
  if (body.triggerKind === "interval") body.intervalMinutes = Number(val("lc-tv")) || 0;
  if (body.triggerKind === "cron") body.cronExpr = val("lc-tv");
  const bud = val("lc-bud");
  if (bud) body.budgetUsd = Number(bud);
  void act(btn, "/api/loop/create", body).then((r) => {
    if (r.ok) void loadState();
    else $("lc-err").textContent = r.text || tx("loops.invalid");
  });
}

function renderUsage(): void {
  const v = $("vusage");
  const u = S.usage;
  if (!u) {
    v.innerHTML = `<div class="card"><h3>${t("usage.title")}</h3><div class="empty">${t("usage.unavailable")}</div></div>`;
    return;
  }
  const limitName = (r: Any) => (r.rateLimitType === "five_hour" ? tx("usage.fiveHour") : r.rateLimitType === "seven_day" ? tx("usage.sevenDay") : String(r.rateLimitType));
  let h = `<div class="card"><h3>${t("usage.limits")}</h3>`;
  if (!u.rateLimits || !u.rateLimits.length) h += `<div class="empty">${t("usage.limitsLater")}</div>`;
  (u.rateLimits || []).forEach((r: Any) => {
    if (typeof r.utilization === "number") {
      const used = Math.round(r.utilization <= 1 ? r.utilization * 100 : r.utilization);
      h += `<span class="pill ${used >= 80 ? "warn" : "ok"}">${t("usage.used", { name: limitName(r), used, left: 100 - used })}</span>`;
    } else h += `<span class="pill ok">${t("usage.within", { name: limitName(r) })}</span>`;
  });
  const w = u.perWindow || {};
  const mx = Math.max(1, (w.weekly && w.weekly.consumedTokens) || 1);
  h += '<div style="margin-top:14px">';
  ([["usage.hourly", w.hourly], ["usage.daily", w.daily], ["usage.weekly", w.weekly]] as Array<[string, Any]>).forEach(([key, win]) => {
    const c = (win && win.consumedTokens) || 0;
    h += `<div class="gauge"><div class="glabel"><span>${t(key)}</span><b>${t("usage.tokens", { n: fmt(c) })}</b></div><div class="gbar"><div class="gfill" style="width:${Math.min(100, Math.round((c / mx) * 100))}%"></div></div></div>`;
  });
  h += "</div>";
  if (u.weeklyResetAt) h += `<div class="ls" style="margin-top:8px">${t("usage.weeklyResets", { when: new Date(u.weeklyResetAt).toLocaleString(LOCALE) })}</div>`;
  h += "</div>";
  v.innerHTML = h;
  $("ftl").textContent =
    u.rateLimits && u.rateLimits.length ? u.rateLimits.map((r: Any) => tx(r.rateLimitType === "five_hour" ? "usage.foot5h" : "usage.foot7d")).join(" · ") : tx("usage.live");
}

// Queue — per-project todo queues (ADR-0008): running first, then each queue in order.
function todoAct(action: string, arg: number | string, btn: Element | null): Promise<ActResult> {
  const b: Any = { action };
  if (typeof arg === "number") b.id = arg;
  else b.project = arg;
  return act(btn, "/api/todo", b).then((r) => {
    void loadState();
    return r;
  });
}
function renderTodos(): void {
  const v = $("vtodos");
  const T: Any[] = S.todos || [];
  const q = T.filter((x) => x.status === "queued").length;
  const bd = $("tbadge");
  bd.textContent = q ? " " + q : "";
  bd.className = "ibadge" + (q ? " on" : "");
  // What holds work back, with who owes it (ADR-0054). Parked todos show in their queue below.
  const W: Any[] = (S.waiting || []).filter((i: Any) => i.kind !== "parked_todo");
  const waitingCard = W.length
    ? `<div class="card"><h3>${t("waiting.title")} ${ltr(W.length)}</h3>` +
      W.map(
        (i) =>
          `<div class="rrow"><div style="flex:1;min-width:0"><div class="tw">${waitingLine(i)}</div>` +
          `<div class="tm">${ltr("#" + String(i.id).slice(0, 8))}${i.project ? " · " + iso(i.project) : ""} · ${t("waiting.since", { age: age(Date.now() - i.since) })}</div></div></div>`,
      ).join("") +
      `</div>`
    : "";
  if (!T.length) {
    v.innerHTML = waitingCard + `<div class="card"><h3>${t("queue.title")}</h3><div class="empty">${t("queue.empty")}</div></div>`;
    return;
  }
  v.innerHTML = waitingCard;
  const by: Record<string, Any[]> = {};
  const order: string[] = [];
  T.forEach((x) => {
    if (!by[x.project]) {
      by[x.project] = [];
      order.push(x.project);
    }
    by[x.project]!.push(x);
  });
  order.forEach((p) => {
    const card = document.createElement("div");
    card.className = "card";
    const paused = by[p]![0].paused;
    const h = document.createElement("h3");
    h.textContent = paused ? tx("queue.paused", { project: p, reason: paused }) : p;
    card.appendChild(h);
    const pr = document.createElement("button");
    pr.className = "chip";
    pr.textContent = tx(paused ? "queue.resume" : "queue.pause");
    pr.onclick = () => void todoAct(paused ? "resume" : "pause", p, pr);
    card.appendChild(pr);
    // Main-lane rows first, then the project's side lanes (ADR-0057) under their own heading.
    const rows: Any[] = by[p]!;
    rows.sort((a, b) => Number(a.lane === "side") - Number(b.lane === "side"));
    rows.forEach((x, i) => {
      if (x.lane === "side" && (i === 0 || rows[i - 1].lane !== "side")) {
        const sh = document.createElement("h4");
        sh.textContent = tx("queue.sideLanes");
        card.appendChild(sh);
      }
      const row = document.createElement("div");
      row.className = "rrow";
      const kind = x.lane === "side" ? tx(`queue.kind.${x.kind}`) : "";
      const lead =
        x.lane === "side"
          ? x.status === "running"
            ? t("queue.sideRunning", { kind, age: age(Date.now() - (x.startedAt || x.createdAt)) })
            : x.status === "queued"
              ? t("queue.sideWaiting", { kind })
              : x.status === "retry"
                ? t("queue.retryWait", { n: x.attempts, age: age(Math.max(0, (x.retryAt || Date.now()) - Date.now())) })
                : x.status === "failed"
                  ? t("queue.failed")
                  : t("queue.waiting", { id: (x.waitingOn || "").slice(0, 8) })
          : x.status === "running" && x.limitResumesAt
          ? tx("queue.limitWait", { time: ltr(resumeAt(x.limitResumesAt)) }) // ADR-0047: still running, waiting out a limit
          : x.status === "running" && x.apiResumesAt
          ? tx("queue.apiWait", { time: ltr(resumeAt(x.apiResumesAt)) }) // ADR-0060: an API error backoff
          : x.status === "running"
          ? t("queue.running", { age: age(Date.now() - (x.startedAt || x.createdAt)) })
          : x.status === "retry"
            ? t("queue.retryWait", { n: x.attempts, age: age(Math.max(0, (x.retryAt || Date.now()) - Date.now())) })
            : x.status === "failed"
              ? t("queue.failed")
              : x.status === "waiting"
                ? t("queue.waiting", { id: (x.waitingOn || "").slice(0, 8) })
                : ltr(x.position + ".");
      // ADR-0059: the todo's summary. ADR-0065: the row is one tap target that opens the todo's detail.
      row.innerHTML = todoRowHtml(x, `<span>${lead}</span>`);
      // ADR-0027: kept work — a failed todo or a waiting retry can be re-run (the same todo). ADR-0060: a run
      // held in an API wait resumes now (the same run, the brief re-sent once).
      const held = x.status === "running" && (x.limitResumesAt || x.apiResumesAt);
      if (x.status === "failed" || x.status === "retry" || held) {
        const r = document.createElement("button");
        r.className = "chip";
        r.textContent = tx(held ? "queue.resumeNow" : "queue.retry");
        r.onclick = () => void todoAct("retry", x.id, r);
        row.appendChild(r);
      }
      if (x.status === "queued" || x.status === "retry" || x.status === "waiting" || x.status === "failed") {
        if (x.status === "queued" && x.position > 1) {
          const up = document.createElement("button");
          up.className = "chip";
          up.textContent = "↑";
          up.title = tx("queue.moveUp");
          up.setAttribute("aria-label", tx("queue.moveUp"));
          up.onclick = () => void todoAct("up", x.id, up);
          row.appendChild(up);
        }
        const c = document.createElement("button");
        c.className = "chip no";
        c.textContent = tx("queue.cancel");
        c.onclick = () => {
          if (confirm(tx("queue.confirmCancel", { id: x.id }))) void todoAct("cancel", x.id, c);
        };
        row.appendChild(c);
      }
      card.appendChild(row);
    });
    v.appendChild(card);
  });
}

function renderRecent(): void {
  const v = $("vrecent");
  let h = `<div class="card"><h3>${t("recent.title")}</h3>`;
  if (!S.recent.length) h += `<div class="empty">${t("recent.empty")}</div>`;
  S.recent.forEach((o: Any) => {
    // `interrupted` (ADR-0054): a restart cut it off — not running, so never the ⏳ of pending work.
    const ic = o.status === "done" ? "✓" : o.status === "error" ? "✗" : o.status === "interrupted" ? "⊘" : "⏳";
    const tip = o.status === "interrupted" ? ` title="${esc(tx("recent.interrupted"))}"` : "";
    h += `<div class="rrow"><span${tip}>${ic}</span><div style="flex:1;min-width:0"><div>${esc(o.task)}</div><div class="rfo">${ltr(o.folder)}</div></div></div>`;
  });
  v.innerHTML = h + "</div>" + renderContextEvents();
}
// The context-reset timeline (ADR-0021): every handoff, clear, deferral and resume, with its reason.
const CTX_ICON: Record<string, string> = { handoff: "🔁", clear: "⚠️", deferred: "⏸", resumed: "▶", fresh: "🆕" };
function renderContextEvents(): string {
  const C: Any[] = S.contextEvents || [];
  let h = `<div class="card"><h3>${t("recent.ctxTitle")}</h3>`;
  if (!C.length) h += `<div class="empty">${t("recent.ctxEmpty")}</div>`;
  C.forEach((e) => {
    const verdict = tx(`recent.verdict.${e.verdict}`);
    const what = e.verdict === "resumed" ? verdict : tx("recent.at", { verdict, pct: Math.round(e.occupancy * 100) });
    const why = [e.reason, e.boundary].filter(Boolean).join(" · ");
    const out =
      e.verdict !== "resumed" || e.steps == null
        ? ""
        : e.success === true
          ? tx("recent.resumedClean", { steps: e.steps })
          : e.success === false
            ? tx("recent.slowResume", { steps: e.steps })
            : tx("recent.noEdit", { steps: e.steps });
    h += `<div class="rrow"><span>${CTX_ICON[e.verdict] || "·"}</span><div style="flex:1;min-width:0"><div>${esc(e.project)} · ${esc(what)}${why ? " · " + esc(why) : ""}${out ? " · " + esc(out) : ""}</div><div class="rfo">${t("recent.ago", { age: age(Date.now() - e.at) })}</div></div></div>`;
  });
  return h + "</div>";
}

// Inbox — customer messages the operator reviews (plain data, no AI until 'send to agent').
function loadInbox(): Promise<void> {
  return fetch("/api/inbox?_=" + Date.now(), { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => renderInbox(d.items || []))
    .catch(() => {});
}
function renderInbox(items: Any[]): void {
  const nw = items.filter((i) => i.status === "new").length;
  const bd = $("ibadge");
  bd.textContent = nw ? " " + nw : "";
  bd.className = "ibadge" + (nw ? " on" : "");
  const v = $("vinbox");
  if (!items.length) {
    v.innerHTML = `<div class="card"><h3>${t("inbox.titleEmpty")}</h3><div class="empty">${t("inbox.empty")}</div></div>`;
    return;
  }
  const ph = (key: string) => esc(tx(key));
  let h = `<div class="card"><h3>${t("inbox.title")}</h3>`;
  items.forEach((i) => {
    const id = esc(i.id);
    h += `<div class="irow" id="ir-${id}">`;
    h += `<div class="imeta"><span class="ist ist-${esc(i.status)}">${t(`inbox.status.${i.status}`)}</span> <b>${esc(i.fromName || i.from)}</b> <span class="rfo">&lt;${ltr(i.from)}&gt; · ${esc(i.channel)}</span><button class="idel" title="${ph("inbox.deleteTitle")}" data-act="inbox-delete" data-id="${id}">${t("inbox.delete")}</button></div>`;
    h += `<div class="isubj">${i.subject ? esc(i.subject) : t("inbox.noSubject")}</div>`;
    h += `<div class="ibody">${esc((i.text || "").slice(0, 800))}</div>`;
    if (i.status === "new") {
      h += `<div class="iact"><textarea class="iinp" id="instr-${id}" rows="1" dir="auto" data-compose="send" placeholder="${ph("inbox.instructions")}"></textarea><button class="run" data-act="inbox-agent" data-compose-submit data-id="${id}">${t("inbox.sendToAgent")}</button></div>`;
    } else if (i.status === "with-agent") {
      h += `<div class="iact"><span class="rfo">${t("inbox.drafting")}</span></div>`;
    } else if (i.status === "drafted") {
      h += `<div class="rfo" style="margin-top:9px">${t("inbox.draftHint")}</div>`;
      h += `<textarea class="itx" id="draft-${id}" dir="auto" data-compose="text">${esc(i.draft || "")}</textarea>`;
      h += `<div class="iact"><button class="run ok" data-act="inbox-send" data-id="${id}">${t("inbox.sendToCustomer")}</button>`;
      h += `<textarea class="iinp" id="notes-${id}" rows="1" dir="auto" data-compose="send" placeholder="${ph("inbox.notes")}"></textarea><button class="run" data-act="inbox-redraft" data-compose-submit data-id="${id}">${t("inbox.redraft")}</button></div>`;
    } else if (i.status === "replied") {
      h += `<div class="rfo" style="margin-top:7px">${t("inbox.replied")}${i.draft ? ` — "${esc(i.draft.slice(0, 90))}…"` : ""}</div>`;
    }
    h += "</div>";
  });
  v.innerHTML = h + "</div>";
}
function dim(id: string, o: string): void {
  const row = document.getElementById("ir-" + id);
  if (row) row.style.opacity = o;
}
function inboxDraft(id: string, field: "instr" | "notes", btn: Element | null): void {
  const el = document.getElementById(`${field}-${id}`) as HTMLTextAreaElement | null;
  dim(id, "0.55");
  void act(btn, "/api/inbox/draft", { id, instructions: el ? el.value : "" }).then(loadInbox);
  setTimeout(loadInbox, 800);
}
function sendReply(id: string, btn: Element | null): void {
  const el = document.getElementById("draft-" + id) as HTMLTextAreaElement | null;
  const reply = el ? el.value : "";
  if (!reply.trim() || !confirm(tx("inbox.confirmSend"))) return;
  void act(btn, "/api/inbox/send", { id, reply }).then(() => void loadInbox());
}
function deleteInbox(id: string): void {
  if (!confirm(tx("inbox.confirmDelete"))) return;
  dim(id, "0.4");
  void fetch("/api/inbox/" + encodeURIComponent(id), { method: "DELETE" }).then(loadInbox).catch(loadInbox);
}

// ── Phone and tablet layout (spec 2026-10-07, AC2–AC5) ──────────────────────────────────────────
const MEDIUM = matchMedia("(max-width:1024px)");
const NARROW = matchMedia("(max-width:768px)");
function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}
/** The sidebar as a drawer on medium and narrow screens: closed it is off-canvas and inert (no focus,
 *  no screen reader); the menu button's aria-expanded and label follow the state. */
function setDrawer(open: boolean, moveFocus: boolean): void {
  const app = document.querySelector(".app")!;
  const was = app.classList.contains("drawer-open");
  app.classList.toggle("drawer-open", open);
  const menu = $("menu");
  menu.setAttribute("aria-expanded", String(open));
  menu.setAttribute("aria-label", tx(open ? "nav.close" : "nav.menu"));
  menu.title = tx(open ? "nav.close" : "nav.menu");
  // While the drawer is open, the content behind the scrim is out of reach (Tab, screen readers).
  (document.querySelector("main") as HTMLElement).inert = open;
  // Focus inside a closing drawer goes to the menu button first, so it never drops to <body>.
  if (!open && MEDIUM.matches && $("side").contains(document.activeElement)) $("menu").focus();
  ($("side") as HTMLElement & { inert: boolean }).inert = MEDIUM.matches && !open;
  if (!moveFocus || was === open) return;
  if (open) $("side").querySelector<HTMLElement>("select,textarea,button,[tabindex]")?.focus();
  else $("menu").focus();
}
function closeDrawer(moveFocus = true): void {
  setDrawer(false, moveFocus);
}
/** Narrow master–detail (AC4): opening a thread or a project shows its pane full width. On a narrow
 *  screen the step is a history entry, so the browser's back (Android's back button) returns to the list. */
function enterDetail(view: DetailView): void {
  $(view).classList.add("detail");
  const act = enterAction(history.state, view, NARROW.matches); // ./nav.ts: push, replace or nothing
  if (act === "push") history.pushState({ detail: view }, "");
  else if (act === "replace") history.replaceState({ detail: view }, "");
}
function leaveDetail(): void {
  ["vthreads", "vprojects"].forEach((id) => $(id).classList.remove("detail"));
}
/** The master–detail view on screen (Threads or Projects), or null. */
function detailView(): DetailView | null {
  return (["vthreads", "vprojects"] as const).find((id) => $(id).classList.contains("on")) ?? null;
}
function back(): void {
  const action = backAction(history.state, detailView());
  if (action === "history") return history.back(); // popstate leaves the detail view
  if (action === "local-clear") history.replaceState(null, "");
  leaveDetail();
}
/** The app height follows the visual viewport, so the composer stays above the on-screen keyboard (AC5).
 *  At most one write per animation frame; a browser without visualViewport keeps 100dvh. */
function fitViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  let queued = false;
  const fit = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    });
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

const VIEWS = ["activity", "threads", "projects", "todos", "loops", "usage", "recent", "inbox"];
function tab(name: string): void {
  VIEWS.forEach((n) => {
    $("v" + n).classList.toggle("on", n === name);
    const b = document.querySelector(`.tab[data-v="${n}"]`);
    if (b) b.classList.toggle("on", n === name);
  });
  // On a narrow screen the tab row scrolls sideways: keep the active tab in view (AC3).
  document.querySelector(`.tab[data-v="${name}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reducedMotion() ? "instant" : "smooth" });
  if (name === "inbox") void loadInbox();
  if (name === "threads") openThreads();
  if (name === "projects") loadProjects();
}

// ── Activity feed (ADR-0014: a bounded live window) ─────────────────────────────────────────────
type FeedNode = HTMLElement & { _kind?: string; _project?: string | null };
const feed = $("feed");
const ph = $("ph");
const fbar = $("fbar");
const feedNodes: FeedNode[] = [];
let filterProject: string | null = null; // null = show every project's activity
function nodeVisible(n: FeedNode): boolean {
  return filterProject === null || n._kind === "esc" || n._project === filterProject;
}
function refreshFeed(): void {
  let any = false;
  for (const n of feedNodes) {
    if (!n.isConnected) continue;
    const v = nodeVisible(n);
    n.style.display = v ? "" : "none";
    if (v) any = true;
  }
  ph.style.display = any ? "none" : "";
  ph.textContent = filterProject ? tx("feed.emptyFor", { project: filterProject }) : tx("feed.placeholder");
  fbar.classList.toggle("on", filterProject !== null);
  if (filterProject !== null) fbar.innerHTML = `${t("feed.showing")} <b>${esc(filterProject)}</b><a data-act="clear-filter">${t("feed.showAll")}</a>`;
  if (any) feed.scrollTop = feed.scrollHeight;
}
function setFilter(p: string): void {
  filterProject = p;
  refreshFeed();
}
function clearFilter(): void {
  filterProject = null;
  refreshFeed();
}
// O(1) per event (ADR-0014): style only the new row, keep at most FEED_WINDOW rows (a pending
// escalation card is never dropped), and scroll at most once per animation frame (scheduleTail).
let tailQueued = false;
function scheduleTail(): void {
  if (tailQueued) return;
  tailQueued = true;
  requestAnimationFrame(() => {
    tailQueued = false;
    feed.scrollTop = feed.scrollHeight;
  });
}
function pushFeed(node: FeedNode, kind: string, project: string | null | undefined): void {
  node._kind = kind;
  node._project = project || null;
  const v = nodeVisible(node);
  node.style.display = v ? "" : "none";
  if (v) ph.style.display = "none";
  feedNodes.push(node);
  feed.appendChild(node);
  if (feedNodes.length > FEED_WINDOW) {
    const i = feedNodes.findIndex((o) => o._kind !== "esc");
    if (i >= 0) {
      const [o] = feedNodes.splice(i, 1);
      o!.remove();
      code.forget(o!);
      if (nodeVisible(o!) && !feedNodes.some(nodeVisible)) ph.style.display = "";
    }
  }
  if (v) scheduleTail();
}
/** A feed row. `html` is safe markup (escaped here, or rendered by the server); `tone` colours it. */
function feedMsg(html: string, kind: string, project: string | null | undefined, tone?: string): HTMLElement {
  const d = document.createElement("div") as FeedNode;
  d.className = "row " + (kind === "me" ? "me" : "out") + (tone ? ` tone-${tone}` : "");
  d.innerHTML = html;
  enhanceCode(d);
  pushFeed(d, kind, project);
  return d;
}
// ── Composer attachments (ADR-0026) ─────────────────────────────────────────────────────────────
// Attaching uploads at once and stages a chip; nothing is sent. Send posts the text and the chips'
// tokens as ONE message, so the worker gets the files in the same turn as the words. The 📎 picker and
// a pasted image share this one path, in the main composer and inside a thread.
interface Composer {
  /** Stage files (picked or pasted): a chip each, uploading now. */
  add(files: Iterable<File>): void;
  /** Post the text and the staged files as ONE /msg. Resolves with what was sent (the chips clear), or
   *  null when Send is not allowed or the server refused it (the chips stay and a note says why). */
  send(text: string): Promise<{ body: SendBody; names: string[] } | null>;
  /** Drop every chip and discard its staged file (the thread composer moved to another thread). */
  reset(): void;
}
/** Why /msg or /upload refused, as the composer's note says it. */
const COMPOSE_NOTE: Record<string, string> = { expired: "feed.attExpired", command: "feed.attCommand", "no active project": "feed.attNoProject" };
function attachComposer(o: { form: string; box: string; note: string; input: string; file: string; attach: string; threadId: () => number | undefined }): Composer {
  const s = createAttachments();
  const noteEl = $(o.note);
  let note = "";
  let busy = false; // a /msg is in flight
  const files = new Map<number, File>();
  const uploads = new Map<number, XMLHttpRequest>();
  const box = $(o.box);
  const sendBtn = ($(o.form) as HTMLFormElement).querySelector<HTMLButtonElement>("button[type=submit]")!;
  const discard = (token: string) => void post("/upload/discard", { token }).catch(() => {});
  const status = (a: Attachment) =>
    a.state === "uploading" ? t("feed.attUploading", { pct: a.progress }) : a.state === "failed" ? t("feed.attFailed") : "";
  const chip = (a: Attachment) =>
    `<div class="att ${a.state === "ready" ? "ok" : a.state === "failed" ? "err" : "up"}" role="listitem" data-id="${a.id}" style="--p:${a.progress}%">` +
    `<span class="an" title="${esc(a.name)}">${esc(a.name)}</span><span class="as">${iso(formatSize(a.size, LOCALE))}</span>` +
    `<span class="ast" role="status">${status(a)}</span>` +
    (a.state === "failed" ? `<button type="button" class="aretry" data-act="retry">${t("feed.attRetry")}</button>` : "") +
    `<button type="button" class="ax" data-act="remove" aria-label="${t("feed.attRemove", { name: a.name })}">${KILL_ICON}</button><i class="abar"></i></div>`;
  const render = () => {
    const all = s.list();
    box.hidden = all.length === 0;
    box.innerHTML = all.map(chip).join("");
    sendBtn.disabled = busy || all.some((a) => a.state !== "ready"); // Send waits for every upload
    noteEl.hidden = note === "";
    noteEl.textContent = note;
  };
  // Progress repaints only the bar and the status line, so a chip's buttons keep their focus.
  const paint = (id: number) => {
    const a = s.get(id);
    const el = box.querySelector<HTMLElement>(`.att[data-id="${id}"]`);
    if (!a || !el) return;
    el.style.setProperty("--p", `${a.progress}%`);
    el.querySelector(".ast")!.innerHTML = status(a);
  };
  const upload = (id: number) => {
    const f = files.get(id);
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    const th = o.threadId();
    if (th !== undefined) fd.append("threadId", String(th));
    const x = new XMLHttpRequest();
    uploads.set(id, x);
    x.open("POST", "/upload");
    x.responseType = "json";
    x.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      s.progress(id, e.loaded, e.total);
      paint(id);
    };
    x.onload = () => {
      uploads.delete(id);
      const token = x.status === 200 && typeof x.response?.token === "string" ? (x.response.token as string) : undefined;
      if (!s.get(id)) {
        if (token) discard(token); // the chip was removed while its upload finished
        return;
      }
      if (token) s.ready(id, token);
      else {
        s.fail(id);
        const why = COMPOSE_NOTE[String(x.response?.error)];
        if (why) note = tx(why);
      }
      render();
    };
    x.onerror = () => {
      uploads.delete(id);
      s.fail(id);
      render();
    };
    x.send(fd);
  };
  const drop = (id: number) => {
    uploads.get(id)?.abort();
    uploads.delete(id);
    const a = s.remove(id);
    if (a?.token) discard(a.token);
    files.delete(id);
  };
  box.addEventListener("click", (ev) => {
    const btn = (ev.target as Element).closest<HTMLButtonElement>("button[data-act]");
    const id = Number(btn?.closest<HTMLElement>(".att")?.dataset.id);
    if (!btn || !id) return;
    note = "";
    if (btn.dataset.act === "retry") {
      s.retry(id);
      render();
      upload(id);
      return;
    }
    drop(id);
    render();
    ($(o.input) as HTMLTextAreaElement).focus();
  });
  const add = (list: Iterable<File>) => {
    note = "";
    for (const f of list) {
      const id = s.add(f.name, f.size);
      files.set(id, f);
      upload(id);
    }
    render();
  };
  const picker = $(o.file) as HTMLInputElement;
  $(o.attach).onclick = () => picker.click();
  picker.onchange = () => {
    if (picker.files) add(picker.files);
    picker.value = "";
  };
  $(o.input).addEventListener("paste", (e) => {
    // Pasted images stage like picked files; the default paste is NOT cancelled, so text still lands.
    add(pastedImages((e as ClipboardEvent).clipboardData?.items, Date.now()));
  });
  return {
    add,
    async send(text) {
      if (busy || !s.canSend(text)) return null;
      const out = { body: s.body(text, o.threadId()), names: s.list().map((a) => a.name) };
      busy = true;
      note = "";
      render();
      let error: string | undefined;
      try {
        const r = await post("/msg", out.body);
        if (!r.ok) error = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "failed";
      } catch {
        error = "failed";
      }
      busy = false;
      if (error) {
        if (error === "expired") for (const a of s.list()) s.fail(a.id); // Retry uploads the kept file again
        note = tx(COMPOSE_NOTE[error] ?? "feed.attNotSent");
        render();
        return null;
      }
      s.clear();
      files.clear();
      render();
      return out;
    },
    reset() {
      for (const a of s.list()) drop(a.id);
      note = "";
      render();
    },
  };
}
/** The operator's own line in the feed or a thread: the text line by line, each line in its own
 *  direction (ADR-0033), then the names of the files it carried. */
function ownLine(text: string, names: string[]): string {
  return linesHtml(text) + (names.length ? `<span class="matt">📎 ${names.map((n) => `<bdi>${esc(n)}</bdi>`).join(", ")}</span>` : "");
}
/** An own line as a feed row's body: the › mark beside the text, never on a line of its own. */
function ownRow(html: string): string {
  return `<span class="mk">›</span><div class="tx">${html}</div>`;
}
const mainComposer = attachComposer({ form: "ff", box: "ffatts", note: "ffnote", input: "msg", file: "file", attach: "attach", threadId: () => undefined });
const threadComposer = attachComposer({ form: "tform", box: "tformatts", note: "tformnote", input: "tmsg", file: "tfile", attach: "tattach", threadId: () => TH.open });

// ── Threads (ADR-0017): project rail · thread list · thread pane, paged from the ledger ─────────
const SINCE_MS: Record<string, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };
const TH = {
  project: "" as string,
  next: undefined as string | undefined,
  open: undefined as number | undefined,
  msgNext: undefined as number | undefined,
  started: false,
  seq: 0,
};
function fillSelect(id: string, values: string[], keyOf: (v: string) => string): void {
  const sel = $(id) as HTMLSelectElement;
  sel.innerHTML = "";
  values.forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = tx(keyOf(v));
    sel.appendChild(o);
  });
}
function threadQuery(): URLSearchParams {
  const p = new URLSearchParams({ limit: "50" });
  if (TH.project) p.set("project", TH.project);
  if (val("tstate")) p.set("state", val("tstate"));
  if (val("torigin")) p.set("origin", val("torigin"));
  const since = SINCE_MS[val("tsince")];
  if (since) p.set("since", String(Date.now() - since));
  if (val("tq").trim()) p.set("q", val("tq").trim());
  return p;
}
function openThreads(): void {
  if (TH.started) return;
  TH.started = true;
  fillSelect("tstate", ["", "open", "waiting", "done", "failed"], (v) => `threads.state.${v || "all"}`);
  fillSelect("torigin", ["", ...THREAD_ORIGINS], (v) => `threads.origin.${v || "all"}`);
  fillSelect("tsince", ["", "day", "week", "month"], (v) => `threads.since.${v || "all"}`);
  ["tstate", "torigin", "tsince"].forEach((id) => ($(id).onchange = () => loadThreads(true)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  $("tq").oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadThreads(true), 300);
  };
  loadThreadProjects();
  loadThreads(true);
}
function loadThreadProjects(): void {
  void fetch("/api/thread-projects", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      const box = $("tprojects");
      const rows: Array<{ project: string; threads: number }> = d.rows || [];
      const item = (project: string, label: string, n?: number) =>
        `<div class="tp${TH.project === project ? " on" : ""}" data-act="thread-project" data-project="${esc(project)}"><span>${esc(label)}</span>${n === undefined ? "" : `<span class="n">${ltr(n)}</span>`}</div>`;
      box.innerHTML = item("", tx("threads.allProjects")) + rows.map((r) => item(r.project, r.project, r.threads)).join("");
    })
    .catch(() => {});
}
/** One waiting item (ADR-0054): who owes it and the next action. Ids stay left-to-right. */
function waitingLine(i: Any): string {
  const next =
    i.next === "resumes"
      ? tx("waiting.next.resumes", { on: ltr("#" + i.on) }) // ltr()/iso() output is already escaped
      : tx(`waiting.next.${i.next}`, { ask: iso(String(i.ask ?? "").replace(/\s+/g, " ").slice(0, 160)) }); // iso(): escaped, isolated
  return (
    `<span class="tchip own-${esc(i.owner)}">${t(`waiting.owner.${i.owner}`)}</span>` +
    (i.keep ? `<span class="tchip keep">${t("waiting.keep")}</span>` : "") +
    `<span class="wn" dir="auto">${next}</span>`
  );
}
function threadRowHtml(r: Any): string {
  const counts = r.messages === undefined ? "" : " · " + t("threads.counts", { messages: r.messages, decisions: r.openDecisions, todos: r.activeTodos });
  const W: Any[] = r.waiting || [];
  const waiting = W.length ? `<div class="tw">${waitingLine(W[0])}${W.length > 1 ? `<span>${t("waiting.more", { n: W.length - 1 })}</span>` : ""}</div>` : "";
  return (
    `<div class="tt"><span class="tchip st-${esc(r.state)}">${t(`threads.state.${r.state}`)}</span>${r.ref ? ltr(r.ref) : ""}<span class="ttl" dir="auto">${r.title ? esc(r.title) : t("threads.untitled")}</span></div>` +
    `<div class="tm">${r.project ? iso(r.project) + " · " : ""}${iso(age(Date.now() - r.updatedAt))}${counts}</div>` +
    waiting
  );
}
function threadRow(r: Any): HTMLElement {
  const d = document.createElement("div");
  d.className = "trow" + (TH.open === r.id ? " on" : "");
  d.dataset.id = String(r.id);
  d.dataset.state = r.state;
  d.dataset.act = "thread-open";
  d.innerHTML = threadRowHtml(r);
  return d;
}
function loadThreads(reset: boolean): void {
  const rows = $("trows");
  const p = threadQuery();
  if (!reset && TH.next) p.set("before", TH.next);
  const seq = ++TH.seq; // a slower older answer never overwrites a newer filter's list
  if (reset) loadHits(p.get("q") ?? "", seq);
  void fetch("/api/threads?" + p.toString(), { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      if (seq !== TH.seq) return;
      if (reset) rows.innerHTML = "";
      document.getElementById("tmore")?.remove();
      (d.rows || []).forEach((r: Any) => rows.appendChild(threadRow(r)));
      TH.next = d.next;
      if (!rows.children.length) rows.innerHTML = `<div class="empty">${t("threads.empty")}</div>`;
      if (d.next) rows.insertAdjacentHTML("beforeend", `<button class="run tmore" id="tmore" data-act="threads-older">${t("threads.loadOlder")}</button>`);
    })
    .catch(() => (rows.innerHTML = `<div class="empty">${t("threads.loadFailed")}</div>`));
}
/** The messages matching the search box (FTS5 snippets, safe HTML from the server); a hit opens its thread. */
function loadHits(q: string, seq: number): void {
  const box = $("thits");
  if (!q) {
    box.innerHTML = "";
    return;
  }
  const p = new URLSearchParams({ q, limit: "20" });
  if (TH.project) p.set("project", TH.project);
  void fetch("/api/search?" + p.toString(), { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      if (seq !== TH.seq) return;
      const rows: Any[] = d.rows || [];
      box.innerHTML = rows.length
        ? `<div class="sec">${t("threads.hits")}</div>` +
          rows
            .map((h) => {
              const open = h.threadId === undefined ? "" : ` data-act="thread-open" data-id="${h.threadId}"`;
              return `<div class="thit"${open}><div class="tm">${h.threadRef ? ltr(h.threadRef) + " · " : ""}${h.project ? iso(h.project) + " · " : ""}${ltr(clock(h.at))}</div><div dir="auto">${h.snippet}</div></div>`;
            })
            .join("")
        : "";
    })
    .catch(() => (box.innerHTML = ""));
}
function openThread(id: number): void {
  // Files staged for another thread went to that thread's project: they never follow to this one.
  if (TH.open !== id) threadComposer.reset();
  TH.open = id;
  document.querySelectorAll(".trow").forEach((el) => el.classList.toggle("on", (el as HTMLElement).dataset.id === String(id)));
  void fetch(`/api/threads/${id}?limit=50`, { cache: "no-store" })
    .then((r) => r.json())
    .then((v) => {
      if (TH.open !== id) return;
      TH.msgNext = v.next;
      renderThreadPane(v);
    })
    .catch(() => ($("tbody").innerHTML = `<div class="empty">${t("threads.loadFailed")}</div>`));
}
function messageHtml(m: Any, html?: string): string {
  // ADR-0061: the chief of staff spoke to a project's session — labelled so, never as the project or "neo".
  const who =
    m.kind === "agent_message" ? tx("threads.agentTo", { project: iso(m.project ?? "") }) : m.role === "user" ? t("threads.you") : m.project ? iso(m.project) : t("threads.neo");
  // Message text has no fixed direction (an English line in the Arabic console, or the reverse).
  // An assistant row arrives rendered by the server (m.html, ADR-0025); the operator's own text is escaped.
  const tone = m.tone ? ` tone-${esc(m.tone)}` : "";
  return `<div class="tmsg ${m.role === "user" ? "user" : ""}${tone}"><div class="tw">${who} · ${ltr(clock(m.at))}</div><div dir="auto" class="tx">${html ?? m.html ?? linesHtml(m.content)}</div></div>`;
}
/** A decision card's body (ADR-0049): the context, then each question's numbered options with what
 *  each one does, the recommended one marked, and the recommendation. Worker text runs in its own
 *  direction; numbers stay LTR. An old multi-question row lists each question first. Empty when the
 *  decision has no spec. */
function decisionCardHtml(spec: Any): string {
  const qs: Any[] = spec?.questions ?? [];
  if (!qs.length) return "";
  let h = spec.context ? `<div dir="auto" class="rfo">${esc(spec.context)}</div>` : "";
  for (const q of qs) {
    if (qs.length > 1) h += `<div dir="auto">${esc(q.header ? `${q.header}: ${q.question}` : q.question)}</div>`;
    h += (q.options as string[])
      .map((label, i) => {
        const star = q.recommended === i ? ` <span class="tchip">⭐ ${t("decision.recommended")}</span>` : "";
        const detail = q.optionDetails?.[i] ? ` — <span dir="auto">${esc(q.optionDetails[i])}</span>` : "";
        return `<div>${ltr(i + 1 + ".")} <bdi dir="auto">${esc(label)}</bdi>${star}${detail}</div>`;
      })
      .join("");
  }
  const q0 = qs.length === 1 ? qs[0] : undefined;
  if (q0 && q0.recommended !== undefined) {
    const why = spec.recommendation ? ` — <span dir="auto">${esc(spec.recommendation)}</span>` : "";
    h += `<div>⭐ ${t("decision.recommended")}: ${ltr(q0.recommended + 1 + ".")} <bdi dir="auto">${esc(q0.options[q0.recommended])}</bdi>${why}</div>`;
  }
  return h;
}
function renderThreadPane(v: Any): void {
  const th = v.thread;
  // The operator may close any thread that is not closed yet (ADR-0038): it stops waiting.
  const close = !th.closedByOperator ? ` <button class="chip" data-act="thread-close" data-id="${th.id}">${t("threads.close")}</button>` : "";
  let h = `<div class="thead">${th.ref ? ltr(th.ref) : ""}${th.project ? " · " + iso(th.project) : ""} <span class="tchip st-${esc(th.state)}">${t(`threads.state.${th.state}`)}</span>${close}</div>`;
  h += `<div class="ttitle" dir="auto">${th.title ? esc(th.title) : t("threads.untitled")}</div>`;
  if (v.next) h += `<button class="run" id="tolder" data-act="thread-older">${t("threads.olderMessages")}</button>`;
  h += `<div id="tmsgs">${(v.messages as Any[]).slice().reverse().map((m) => messageHtml(m)).join("")}</div>`;
  if (v.decisions.length) {
    h += `<div class="tsect"><h4>${t("threads.decisions")}</h4>`;
    h += v.decisions.map((d: Any) => `<div class="tart"><span class="tchip">${t(`threads.decisionStatus.${d.status}`)}</span>${iso(d.question)}${d.answer ? ` → ${iso(d.answer)}` : ""}${d.status === "open" ? decisionCardHtml(d.spec) : ""}</div>`).join("");
    h += "</div>";
  }
  if (v.todos.length) {
    h += `<div class="tsect"><h4>${t("threads.todos")}</h4>`;
    h += v.todos.map((x: Any) => `<div class="tart">${ltr("#" + x.id)}<span class="tchip">${t(`threads.todoStatus.${x.status}`)}</span>${esc(x.project)}</div>`).join("");
    h += "</div>";
  }
  if (v.plans.length) {
    h += `<div class="tsect"><h4>${t("threads.plans")}</h4>`;
    h += v.plans
      .map((p: Any) => {
        const line = t("threads.planLine", { status: tx(`threads.planState.${p.state}`), done: p.stepsDone, total: p.stepsTotal, version: p.version });
        const buttons = (p.actions as string[])
          .filter((a) => a !== "changes")
          .map((a) => `<button class="chip" data-act="plan" data-id="${p.id}" data-action="${esc(a)}" data-version="${p.version}">${t(`threads.planAction.${a}`)}</button>`)
          .join("");
        return `<div class="tart"><b>${iso(p.title)}</b><span class="rfo">${line}</span>${ltr(p.path)}${buttons}</div>${(p.actions as string[]).includes("changes") ? `<div class="rfo">${t("threads.changesHint")}</div>` : ""}`;
      })
      .join("");
    h += "</div>";
  }
  h += `<div class="tsect rfo">${t("threads.toolActions", { count: v.toolActions })}</div>`;
  $("tbody").innerHTML = h;
  enhanceCode($("tbody"));
  ($("tform") as HTMLFormElement).hidden = false;
  const msgs = $("tbody");
  msgs.scrollTop = msgs.scrollHeight;
}
function olderMessages(): void {
  const id = TH.open;
  if (id === undefined || TH.msgNext === undefined) return;
  void fetch(`/api/threads/${id}?limit=50&before=${TH.msgNext}`, { cache: "no-store" })
    .then((r) => r.json())
    .then((v) => {
      if (TH.open !== id) return;
      TH.msgNext = v.next;
      $("tmsgs").insertAdjacentHTML("afterbegin", (v.messages as Any[]).slice().reverse().map((m) => messageHtml(m)).join(""));
      enhanceCode($("tmsgs"));
      if (!v.next) document.getElementById("tolder")?.remove();
    })
    .catch(() => {});
}
/** A live line in the open thread: appended (feed `message` text is already safe HTML). */
function appendThreadLine(m: Any, html?: string): void {
  const box = document.getElementById("tmsgs");
  if (!box) return;
  box.insertAdjacentHTML("beforeend", messageHtml(m, html));
  enhanceCode(box);
  const b = $("tbody");
  b.scrollTop = b.scrollHeight;
}
/** A thread changed (SSE — a new line or a new state): its row moves to the top with its counts, or
 *  a new matching thread appears. The event is the whole list row. */
function onThreadEvent(e: Any): void {
  if (!TH.started) return;
  const rows = $("trows");
  const old = rows.querySelector(`.trow[data-id="${e.id}"]`);
  const matches =
    (!TH.project || e.project === TH.project) && (!val("tstate") || e.state === val("tstate")) && !val("torigin") && !val("tq").trim() && !val("tsince");
  if (!old && !matches) return;
  if (old && val("tstate") && e.state !== val("tstate")) {
    old.remove();
    return;
  }
  const stateChanged = (old as HTMLElement | null)?.dataset.state !== e.state;
  old?.remove();
  rows.querySelector(".empty")?.remove();
  rows.prepend(threadRow(e));
  // New lines already append live (appendThreadLine); only a new state needs the pane re-read.
  if (TH.open === e.id && stateChanged) openThread(e.id);
}
/** One attention item's buttons (ADR-0018) — remove, → todo, snooze, dismiss — through the one engine
 *  path, POST /api/attention. The feed's `/attention` list and the project dashboard both use it.
 *  `answer` shows the engine's reply; a snoozed, dismissed or removed item's `row` goes (`drop`), and
 *  `dropped` runs after; a refusal keeps the row (its answer may point at → todo). */
function attentionButtons(it: Any, snoozeHours: number, box: HTMLElement, row: HTMLElement, answer: (text: string) => void, dropped?: () => void): void {
  ((it.actions as string[] | undefined) ?? ["todo", "snooze", "dismiss"]).forEach((action) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = tx(`attention.${action}`, { id: it.id, hours: snoozeHours });
    b.onclick = () => {
      // The toast carries the reply ("→ todo #912", or why it was refused); the row keeps it too.
      void act(b, "/api/attention", { id: it.id, action }).then((r) => {
        answer(r.text);
        if ((r.data as Any)?.drop) {
          row.remove();
          dropped?.();
        }
      });
    };
    box.appendChild(b);
  });
}
/** `/attention` (ADR-0018): the list, then one row of buttons per item — → todo, snooze, dismiss. A
 *  snoozed or dismissed item's row goes; → todo stays (a second tap shows the todo). */
function renderAttention(e: Any): void {
  const d = feedMsg(`<div dir="auto" style="white-space:pre-wrap">${esc(e.text)}</div>`, "out", null);
  for (const it of e.items as Any[]) {
    const row = document.createElement("div");
    row.className = "acts";
    attentionButtons(it, e.snoozeHours, row, row, (text) => feedMsg("⋯ " + esc(text), "me", null));
    d.appendChild(row);
  }
}

// ── Projects (P6, spec §9): one card per project · one project's dashboard ──────────────────────
const PJ = { open: undefined as string | undefined, seq: 0 };
/** Health reuses the thread-state chip colours: ok green, attention amber, down red, unknown plain. */
const HEALTH_CLASS: Record<string, string> = { ok: "st-done", attention: "st-waiting", down: "st-failed", unknown: "" };
const SEV_ICON: Record<string, string> = { high: "🔴", normal: "🟡", low: "⚪" };
function healthChip(h: string): string {
  return `<span class="tchip ${HEALTH_CLASS[h] ?? ""}">${t(`pj.health.${h}`)}</span>`;
}
/** ADR-0065: what needs the operator, then housekeeping — never the producers' severities. */
function attentionCounts(s: Any): string {
  const parts = [...(s.needs ? [tx("pj.needs", { n: ltr(s.needs) })] : []), ...(s.housekeeping ? [tx("pj.housekeeping", { n: ltr(s.housekeeping) })] : [])];
  return parts.length ? parts.join(" · ") : t("pj.noAttention");
}
function projectCard(s: Any): string {
  const state = s.state ? t(`pj.state.${s.state}`) : t("pj.noSession");
  return (
    `<div class="trow${PJ.open === s.name ? " on" : ""}" data-act="project-open" data-project="${esc(s.name)}">` +
    `<div class="tt">${healthChip(s.health)}<span class="ttl">${iso(s.name)}</span></div>` +
    `<div class="tm">${state} · ${t("pj.queueCount", { n: s.queue })} · ${attentionCounts(s)}</div></div>`
  );
}
function loadProjects(): void {
  const seq = ++PJ.seq; // a slower older answer never overwrites a newer list
  void fetch("/api/projects", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      if (seq !== PJ.seq) return;
      const rows: Any[] = d.rows || [];
      const box = $("pjrows");
      box.innerHTML = rows.length ? rows.map(projectCard).join("") : `<div class="empty">${t("pj.empty")}</div>`;
      if (d.total > rows.length) box.insertAdjacentHTML("beforeend", `<div class="empty">${t("pj.more", { n: d.total - rows.length })}</div>`);
    })
    .catch(() => ($("pjrows").innerHTML = `<div class="empty">${t("pj.loadFailed")}</div>`));
}
function showProject(name: string): void {
  PJ.open = name;
  document.querySelectorAll<HTMLElement>("#pjrows .trow").forEach((el) => el.classList.toggle("on", el.dataset.project === name));
  $("pjbody").innerHTML = `<div class="fe">${t("pj.loading")}</div>`;
  void fetch(`/api/projects/${encodeURIComponent(name)}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => {
      if (PJ.open !== name) return;
      if (!v) $("pjbody").innerHTML = `<div class="empty">${tx("pj.unknown", { name: iso(name) })}</div>`;
      else renderProjectPane(v);
    })
    .catch(() => ($("pjbody").innerHTML = `<div class="empty">${t("pj.loadFailed")}</div>`));
}
/** A section of the dashboard: its heading and its rows, or "nothing here". */
function pjSect(key: string, rows: string[], vars?: Vars): string {
  return `<div class="tsect"><h4>${t(key, vars)}</h4>${rows.length ? rows.join("") : `<div class="tart rfo">${t("pj.none")}</div>`}</div>`;
}
function threadChip(th: Any): string {
  return `<button class="chip" data-act="project-thread" data-id="${th.id}">${ltr(th.ref)}</button>`;
}
function renderProjectPane(v: Any): void {
  const now = Date.now();
  let h = `<div class="thead">${healthChip(v.health)}${ltr(v.folder)}</div><div class="ttitle">${iso(v.name)}</div>`;
  // NOW — what runs, and the thread it works.
  const n = v.now;
  h += pjSect("pj.sect.now", [
    n
      ? `<div class="tart"><span class="tchip">${t(`pj.state.${n.state}`)}</span><span dir="auto">${esc(n.line)}</span>${n.thread ? threadChip(n.thread) + `<span dir="auto">${esc(n.thread.title)}</span>` : ""}</div>`
      : `<div class="tart rfo">${t("pj.noSession")}</div>`,
  ]);
  // QUEUE — running first, then the queue in order.
  h += pjSect(
    "pj.sect.queue",
    (v.queue as Any[]).map((x) => todoRowHtml(x, `<span class="tchip">${x.status === "running" ? t("pj.running") : t("pj.queued", { pos: x.position })}</span>`)),
  );
  // GIT — read live; a failed read is named, never hidden.
  const g = v.git || {};
  const git: string[] = [];
  if (g.branch || g.lastCommit) {
    const [sha, ...subject] = String(g.lastCommit || "").split(" ");
    const when = g.lastCommitAt ? `<span class="rfo">${t("pj.ago", { age: age(now - g.lastCommitAt) })}</span>` : "";
    git.push(`<div class="tart">${g.branch ? ltr(g.branch) : ""}${sha ? ltr(sha) : ""}<span dir="auto">${esc(subject.join(" "))}</span>${when}</div>`);
  }
  const facts: string[] = [];
  if (g.noUpstream) facts.push(t("pj.git.noUpstream"));
  else if (g.unpushed !== undefined) facts.push(t("pj.git.unpushed", { n: g.unpushed }));
  if (g.dirty !== undefined) facts.push(t("pj.git.dirty", { n: g.dirty }));
  if (g.worktrees !== undefined) facts.push(t("pj.git.worktrees", { n: g.worktrees }));
  if (facts.length) git.push(`<div class="tart rfo">${facts.join(" · ")}</div>`);
  if (g.drift) git.push(`<div class="tart">${ltr(`${g.drift.from} → ${g.drift.to}`)}<span class="rfo">${t("pj.git.ahead", { n: g.drift.ahead })}</span></div>`);
  // DEPLOY — only when the project configures deployedVersionUrl (the scan's probe, P6 6.3).
  if (g.undeployed !== undefined) git.push(`<div class="tart">${tx("pj.git.undeployed", { n: g.undeployed, branch: ltr(g.deployBranch), sha: ltr(g.deployedSha) })}</div>`);
  else if (g.deployError) git.push(`<div class="tart pjerr">${t("pj.git.deployError")}${ltr(g.deployError)}</div>`);
  if (g.error) git.push(`<div class="tart pjerr">${t("pj.git.error")}${ltr(g.error)}</div>`);
  h += pjSect("pj.sect.git", git);
  // GITHUB — the last scan's counts, when it last worked, and its error.
  const gh = v.github || {};
  const ghRows = [`<div class="tart">${t("pj.gh.counts", { prs: gh.prs || 0, ci: gh.ciFailed || 0, issues: gh.issues || 0, alerts: gh.alerts || 0 })}</div>`];
  ghRows.push(`<div class="tart rfo">${gh.scannedAt ? t("pj.gh.scanned", { age: age(now - gh.scannedAt) }) : t("pj.gh.never")}</div>`);
  if (gh.error) ghRows.push(`<div class="tart pjerr">${t("pj.gh.error")}${ltr(gh.error)}</div>`);
  h += pjSect("pj.sect.github", ghRows);
  // DECIDE — open decisions, oldest first.
  h += pjSect(
    "pj.sect.decide",
    (v.decisions as Any[]).map((d) => `<div class="tart"><span dir="auto">${esc(d.question)}</span><span class="rfo">${esc(age(d.ageMs))}</span>${d.ref ? ltr(d.ref) : ""}${decisionCardHtml(d.spec)}</div>`),
  );
  // PLANS — status and steps; a plan whose file is gone says so (spec §11.7).
  h += pjSect(
    "pj.sect.plans",
    (v.plans as Any[]).map(
      (p) =>
        `<div class="tart"><b>${iso(p.title)}</b><span class="rfo">${tx("pj.planLine", { status: esc(tx(`threads.planStatus.${p.status}`)), steps: ltr(p.steps) })}</span>` +
        `${p.fileMissing ? `<span class="tchip st-failed">${t("pj.fileMissing")}</span>` : ""}${p.ref ? ltr(p.ref) : ""}</div>`,
    ),
  );
  // ATTENTION — each item with the shared one-tap buttons (filled in below).
  // ADR-0065: what needs the operator first; housekeeping collapsed under its count.
  // Grouped by the needs-you list itself, so the section always matches the badge: a hidden needs-you
  // item moves to housekeeping (where Pin brings it back), a pinned housekeeping item moves up.
  const needRefs = new Set(((v.needsYou ?? []) as Any[]).map((it) => it.ref));
  const needs = (v.attention as Any[]).filter((it) => needRefs.has(`att:${it.id}`));
  const house = (v.attention as Any[]).filter((it) => !needRefs.has(`att:${it.id}`));
  // The section is the project's share of the needs-you list (the badge's count): plans, decisions and
  // failed todos as strip rows, then the needs-you attention items with their own buttons.
  const others = ((v.needsYou ?? []) as Any[]).filter((it) => it.kind !== "attention");
  h +=
    `<div class="tsect"><h4 id="pjatth">${tx("pj.sect.needsYou", { n: ltr(others.length + needs.length) })}</h4><div class="rfo pjnote" id="pjnote"></div><div id="pjneeds" class="pinl"></div><div id="pjatt"></div>` +
    (house.length ? `<details class="hk"><summary id="pjhkh">${tx("pj.sect.housekeeping", { n: ltr(house.length) })}</summary><div id="pjhk"></div></details>` : "") +
    `</div>`;
  // THREADS — each opens in the Threads tab.
  h += pjSect(
    "pj.sect.threads",
    (v.threads as Any[]).map(
      (th) => `<div class="tart">${threadChip(th)}<span class="tchip st-${esc(th.state)}">${t(`threads.state.${th.state}`)}</span><span dir="auto">${esc(th.title)}</span><span class="rfo">${esc(age(now - th.updatedAt))}</span></div>`,
    ),
  );
  // RESTART-GATED — Neo only: built but not running.
  if (v.restartGated) h += pjSect("pj.sect.restart", (v.restartGated as Any[]).map((r) => `<div class="tart"><span dir="auto">${esc(r.title)}</span></div>`));
  $("pjbody").innerHTML = h;
  const box = $("pjatt");
  const reload = (): void => (loadPins(), showProject(v.name));
  for (const it of others) $("pjneeds").appendChild(pinRow(it, reload));
  if (!needs.length && !others.length) box.innerHTML = `<div class="tart rfo">${t("pj.none")}</div>`;
  const recount = (): void => {
    $("pjatth").innerHTML = tx("pj.sect.needsYou", { n: ltr(others.length + box.querySelectorAll(".tart[data-att]").length) });
    const hk = document.getElementById("pjhk");
    if (hk) $("pjhkh").innerHTML = tx("pj.sect.housekeeping", { n: ltr(hk.querySelectorAll(".tart[data-att]").length) });
  };
  [...needs, ...house].forEach((it) => {
    const row = document.createElement("div");
    row.className = "tart";
    row.dataset.att = String(it.id);
    // A project note names its sender (ADR-0043).
    const from = it.fromProject ? `<span class="rfo" dir="auto">${tx("pj.noteFrom", { project: esc(it.fromProject) })}</span>` : "";
    // A note's kind (`question` too) and, once it moved on, its state (`acknowledged`, `answered`) — ADR-0050.
    const chip = it.noteKind ? `<span class="rfo">${tx(`notes.kind.${it.noteKind}`)}${it.noteState && it.noteState !== "open" ? " · " + tx(`notes.state.${it.noteState}`) : ""}</span>` : "";
    row.innerHTML = attentionItemHtml(it, chip, from);
    attentionButtons(it, v.snoozeHours, row, row, (text) => ($("pjnote").textContent = text), () => {
      recount();
      loadProjects();
    });
    // Pin puts any item on the strip (and brings back a hidden one); a needs-you item is already there.
    if (it.pinned || !needRefs.has(`att:${it.id}`)) {
      const b = document.createElement("button");
      b.className = "chip";
      b.type = "button";
      b.textContent = tx(it.pinned ? "pins.unpin" : "pins.pin");
      b.onclick = () => void act(b, "/api/pin", { ref: `att:${it.id}`, state: it.pinned ? null : "pinned" }, tx(it.pinned ? "pins.unpinned" : "pins.pinned")).then(() => (loadPins(), showProject(v.name)));
      row.appendChild(b);
    }
    (needRefs.has(`att:${it.id}`) ? box : $("pjhk")).appendChild(row);
  });
}
/** The facts a description template may name (ADR-0059). A fact an item lacks reads `att.unknown`. */
/** Facts that are references: shown as "#N". */
const ATT_REFS = new Set(["pr", "issue", "alert", "decision"]);
const ATT_FACTS = ["age", "label", "reason", "decision", "pct", "model", "files", "days", "pr", "dep", "from", "to", "workflow", "branch", "issue", "severity", "alert", "secretType", "ahead", "upstream", "base", "hours"];
/** One attention item, self-explaining (ADR-0059): severity, #id, its kind badge and project, a plain title,
 *  why it is there (`att.why.<badge>` from its facts), its links, what → todo will do (`att.next.<badge>`)
 *  and the exact brief on tap. Every value is escaped and isolated (`iso`), so ids and branch names stay
 *  left-to-right in Arabic. */
function attentionItemHtml(it: Any, noteChip: string, from: string): string {
  const facts = (it.facts ?? {}) as Record<string, string | number>;
  const vars: Record<string, string> = {};
  // A ref keeps its "#", a percentage its "%", and both stay one left-to-right unit in Arabic (#31, not 31#).
  for (const k of ATT_FACTS) {
    const v = facts[k];
    vars[k] = v === undefined || v === "" ? iso(tx("att.unknown")) : ATT_REFS.has(k) ? ltr(`#${v}`) : k === "pct" ? ltr(`${v}%`) : typeof v === "number" ? ltr(v) : iso(v);
  }
  if (typeof facts.since === "number") vars.age = iso(age(Date.now() - facts.since));
  const badge = esc(it.badge ?? "other");
  const links = ((it.links ?? []) as Any[])
    .map((l) => (typeof l.href === "string" && /^https?:\/\//.test(l.href) ? `<a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${l.kind === "url" ? esc(tx("att.openLink")) : ltr(l.label)}</a>` : ltr(l.label)))
    .join(" · ");
  const next = it.brief
    ? `<div class="rfo">${esc(tx("att.nextLabel"))} ${esc(tx(`att.next.${badge}`))}</div><details class="rfo"><summary>${esc(tx("att.showBrief"))}</summary><div dir="auto" style="white-space:pre-wrap">${esc(it.brief)}</div></details>`
    : `<div class="rfo">${esc(tx("att.noBrief"))}</div>`;
  return (
    `<div style="flex:1 1 100%;min-width:0"><div><span>${SEV_ICON[it.severity] ?? ""}</span> ${ltr("#" + it.id)} <span class="tchip">${esc(tx(`att.kind.${badge}`))}</span> ${iso(it.project ?? "")}${noteChip}${from} <span class="rfo">${esc(age(it.ageMs))}</span></div>` +
    `<div dir="auto"><b>${esc(it.plain ?? it.title)}</b></div>` +
    // A reason with a gap (an older row, until its next scan) is not shown: the item's own title stands in.
    `<div class="rfo" dir="auto">${it.reasonOk === false ? esc(it.title) : tx(`att.why.${badge}`, vars)}</div>` +
    (links ? `<div class="rfo">${links}</div>` : "") +
    next +
    `</div>`
  );
}
/** A console link `#project=<name>` (the Telegram dashboard's "open console") opens that project. */
function openFromHash(): void {
  const m = /^#project=(.+)$/.exec(location.hash);
  if (!m) return;
  let name: string;
  try {
    name = decodeURIComponent(m[1]!);
  } catch {
    return; // a malformed link (`#project=%E0`) is ignored — it must never stop the console starting
  }
  tab("projects");
  enterDetail("vprojects");
  showProject(name);
}
/** Close a thread (ADR-0038): confirm, then the engine's one close action, then redraw the thread. */
function closeThread(id: number, btn: Element | null): void {
  if (!confirm(tx("threads.confirmClose"))) return;
  void act(btn, "/api/thread/close", { id }).then((r) => {
      const d = (r.data ?? {}) as Any;
      // linesHtml: dir="auto" and the count stays an LTR run inside Arabic (the numbers rule).
      if (d.ok) feedMsg("⋯ " + linesHtml(tx("threads.closedNote", { decisions: d.decisions })), "me", null);
      openThread(id);
      loadThreads(true);
  });
}
function planAction(id: number, action: string, version: number, btn: Element | null): void {
  void act(btn, "/api/plan", { id, action, version }).then((r) => {
      const d = (r.data ?? {}) as Any;
      const row = feedMsg("⋯ " + linesHtml(r.text), "me", null);
      // A done plan (ADR-0034): the reply says why nothing started and offers Run anyway.
      if (d.offer === "anyway") {
        const b = document.createElement("button");
        b.className = "chip";
        b.textContent = tx("threads.planAction.anyway");
        b.onclick = () => planAction(id, "anyway", version, b);
        row.appendChild(b);
      }
      if (TH.open !== undefined) openThread(TH.open);
      loadPins();
  });
}

// ── Pinned — needs you (ADR-0065): on every tab, what only the operator can move ─────────────────
/** Rows the strip shows before "show all". */
const PIN_SHOWN = 5;
/** Unchanged items still re-render this often, so their ages stay true. */
const PIN_AGE_MS = 60_000;
const PIN = { items: [] as Any[], json: "", at: 0, all: false, shut: localStorage.getItem("neo.pins.shut") === "1", seq: 0 };
/** Read the strip. It re-renders only when its items changed (or their ages are a minute old), and never
 *  under a busy or focused control — a rebuild would drop the busy state and let a second tap through. */
function loadPins(): void {
  const seq = ++PIN.seq;
  void fetch("/api/needs-you?_=" + Date.now(), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (seq !== PIN.seq || !d || !Array.isArray(d.items)) return;
      const box = $("pins");
      if (box.querySelector(".busy")) return; // its action reloads the strip when it ends
      const json = JSON.stringify(d.items);
      const same = json === PIN.json;
      if (same && (box.contains(document.activeElement) || Date.now() - PIN.at < PIN_AGE_MS)) return;
      PIN.items = d.items;
      PIN.json = json;
      renderPins();
    })
    .catch(() => {});
}
function renderPins(): void {
  const box = $("pins");
  const items = PIN.items;
  PIN.at = Date.now();
  box.hidden = !items.length;
  if (!items.length) return void (box.innerHTML = "");
  box.classList.toggle("shut", PIN.shut);
  box.innerHTML =
    `<button class="pinh" type="button" id="pinh" aria-expanded="${PIN.shut ? "false" : "true"}" aria-controls="pinl" title="${esc(tx("pins.toggle"))}">` +
    `<span>${esc(tx("pins.title"))}</span><span class="n">${ltr(items.length)}</span><span class="car" aria-hidden="true">▾</span></button><div class="pinl" id="pinl"></div>`;
  $("pinh").onclick = () => {
    PIN.shut = !PIN.shut;
    localStorage.setItem("neo.pins.shut", PIN.shut ? "1" : "0");
    renderPins();
  };
  const list = $("pinl");
  for (const it of PIN.all ? items : items.slice(0, PIN_SHOWN)) list.appendChild(pinRow(it, loadPins));
  if (items.length > PIN_SHOWN) {
    const m = document.createElement("button");
    m.type = "button";
    m.className = "chip pinmore";
    m.innerHTML = PIN.all ? esc(tx("pins.less")) : tx("pins.more", { n: ltr(items.length) });
    m.onclick = () => ((PIN.all = !PIN.all), renderPins());
    list.appendChild(m);
  }
}
/** One needs-you row (the strip and a project's "Needs you" section): kind, project, age, the one-line why,
 *  its action, and × to take it off the list. `after` runs once a hide is answered. */
function pinRow(it: Any, after: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "pinr";
  row.innerHTML =
    `<div class="pw"><div class="pt"><span class="tchip">${esc(tx(`pins.kind.${it.kind}`))}</span>${iso(it.project ?? tx("pins.noProject"))}<span>${iso(age(Date.now() - it.since))}</span></div>` +
    `<div class="py" dir="auto" title="${esc(it.why)}">${esc(it.why)}</div></div>`;
  const a = document.createElement("button");
  a.type = "button";
  a.className = "pinact";
  a.textContent = it.action === "approve" ? tx("threads.planAction.approve") : tx(`pins.action.${it.action}`);
  a.onclick = () => pinAction(it, a);
  row.appendChild(a);
  const x = document.createElement("button");
  x.type = "button";
  x.className = "pinx";
  x.innerHTML = KILL_ICON;
  x.title = tx("pins.hide");
  x.setAttribute("aria-label", tx("pins.hide"));
  x.onclick = () => void act(x, "/api/pin", { ref: it.ref, state: "unpinned" }, tx("pins.hidden")).then(after);
  row.appendChild(x);
  return row;
}
/** A strip row's button: approve a plan, retry a todo, open a todo, or open where the item's own buttons are. */
function pinAction(it: Any, btn: HTMLElement): void {
  if (it.action === "approve" && it.plan) return planAction(it.plan.id, "approve", it.plan.version, btn);
  if (it.action === "retry" && it.todoId !== undefined) return void todoAct("retry", it.todoId, btn).then(loadPins);
  if (it.kind === "todo" && it.todoId !== undefined) return openTodo(it.todoId, btn);
  if (it.threadId !== undefined) {
    tab("threads");
    enterDetail("vthreads");
    return openThread(it.threadId);
  }
  tab("projects");
  if (it.project) {
    enterDetail("vprojects");
    showProject(it.project);
  }
}

// ── Todo detail (ADR-0065): a tap on any todo row opens it ───────────────────────────────────────
/** One todo row: a button (one tap target) with its lead, #id and summary. */
function todoRowHtml(x: Any, lead: string): string {
  return (
    `<button class="qrow" type="button" data-act="todo-open" data-id="${esc(x.id)}" aria-label="${esc(tx("todoDetail.open", { id: x.id }))}: ${esc(x.title)}">` +
    `${lead}${ltr("#" + x.id)}<span class="qt" dir="auto">${esc(x.title)}</span><span class="car" aria-hidden="true">›</span></button>`
  );
}
function sheet(): HTMLDialogElement {
  return $("tdsheet") as HTMLDialogElement;
}
function openTodo(id: number, btn: Element | null): void {
  if (btn?.classList.contains("busy")) return;
  btn?.classList.add("busy");
  btn?.setAttribute("aria-busy", "true");
  void fetch(`/api/todo/${encodeURIComponent(String(id))}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return toast(tx("todoDetail.notFound"), false);
      renderTodoSheet(d);
      if (!sheet().open) sheet().showModal();
    })
    .catch(() => toast(tx("toast.failed"), false))
    .finally(() => {
      btn?.classList.remove("busy");
      btn?.removeAttribute("aria-busy");
    });
}
function renderTodoSheet(d: Any): void {
  const now = Date.now();
  const when = (at?: number): string => (at ? `${ltr(clock(at))} · ${tx("todoDetail.ago", { age: iso(age(now - at)) })}` : "");
  $("tdhead").innerHTML = `${ltr("#" + d.id)} <span class="tchip">${esc(tx(`todoDetail.status.${d.status}`))}</span>`;
  const rows: Array<[string, string]> = [
    ["todoDetail.project", iso(d.project)],
    ["todoDetail.lane", d.lane === "side" ? tx("todoDetail.laneSide", { kind: iso(tx(`queue.kind.${d.kind}`)) }) : esc(tx("todoDetail.laneMain"))],
    ["todoDetail.state", esc(tx(`todoDetail.status.${d.status}`)) + (d.position ? " · " + tx("todoDetail.position", { pos: ltr(d.position) }) : "")],
    ["todoDetail.created", when(d.createdAt)],
  ];
  if (d.startedAt) rows.push(["todoDetail.started", when(d.startedAt)]);
  if (d.endedAt) rows.push(["todoDetail.ended", when(d.endedAt)]);
  if (d.attempts) rows.push(["todoDetail.attempts", ltr(d.attempts)]);
  if (d.failure) rows.push(["todoDetail.failure", ltr(d.failure)]);
  let h = `<h2 id="tdtitle" dir="auto">${esc(d.title)}</h2><dl>${rows.map(([k, v]) => `<dt>${esc(tx(k))}</dt><dd>${v}</dd>`).join("")}</dl>`;
  if (d.result) h += `<h4>${esc(tx("todoDetail.result"))}</h4><pre dir="auto">${esc(d.result)}</pre>`;
  if ((d.attention ?? []).length) h += `<h4>${esc(tx("todoDetail.items"))}</h4>` + (d.attention as Any[]).map((a) => `<div class="rfo" dir="auto">${ltr("#" + a.id)} ${esc(a.title)}</div>`).join("");
  h += `<details><summary>${esc(tx("todoDetail.brief"))}</summary><pre dir="auto">${esc(d.brief)}</pre></details><div class="acts" id="tdacts"></div>`;
  $("tdbody").innerHTML = h;
  const acts = $("tdacts");
  const button = (label: string, cls: string, onclick: (b: HTMLButtonElement) => void): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + cls;
    b.textContent = label;
    b.onclick = () => onclick(b);
    acts.appendChild(b);
  };
  for (const a of d.actions as string[]) {
    const label = a === "retry" ? tx(d.status === "running" ? "queue.resumeNow" : "queue.retry") : a === "up" ? tx("queue.moveUp") : tx("queue.cancel");
    button(label, a === "cancel" ? " no" : "", (b) => {
      if (a === "cancel" && !confirm(tx("queue.confirmCancel", { id: d.id }))) return;
      void todoAct(a, d.id, b).then((r) => r.ok && (loadPins(), openTodo(d.id, null)));
    });
  }
  if (d.threadId !== undefined) {
    button(tx("todoDetail.openThread"), "", () => {
      sheet().close();
      tab("threads");
      enterDetail("vthreads");
      openThread(d.threadId);
    });
  }
  button(tx(d.pinned ? "pins.unpin" : "pins.pin"), "", (b) => void act(b, "/api/pin", { ref: `todo:${d.id}`, state: d.pinned ? null : "pinned" }, tx(d.pinned ? "pins.unpinned" : "pins.pinned")).then(() => (loadPins(), openTodo(d.id, null))));
}
$("tdclose").onclick = () => sheet().close();
// A tap on the backdrop (outside the sheet's box) closes it.
sheet().addEventListener("click", (ev) => {
  if (ev.target === sheet()) sheet().close();
});

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────
document.addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-act],[data-v]");
  if (!el) return;
  if (el.dataset.v) {
    tab(el.dataset.v);
    if (el.dataset.v === "activity") clearFilter();
    return;
  }
  const id = el.dataset.id ?? "";
  switch (el.dataset.act) {
    case "clear-filter":
      return clearFilter();
    case "create-loop":
      return submitLoop(el);
    case "inbox-agent":
      return inboxDraft(id, "instr", el);
    case "inbox-redraft":
      return inboxDraft(id, "notes", el);
    case "inbox-send":
      return sendReply(id, el);
    case "inbox-delete":
      return deleteInbox(id);
    case "thread-project":
      TH.project = el.dataset.project ?? "";
      document.querySelectorAll(".tp").forEach((x) => x.classList.toggle("on", x === el));
      return loadThreads(true);
    case "threads-older":
      return loadThreads(false);
    case "thread-open":
      enterDetail("vthreads");
      return openThread(Number(id));
    case "thread-older":
      return olderMessages();
    case "plan":
      return planAction(Number(id), el.dataset.action ?? "", Number(el.dataset.version), el);
    case "thread-close":
      return closeThread(Number(id), el);
    case "todo-open":
      return openTodo(Number(id), el);
    case "project-open":
      enterDetail("vprojects");
      return showProject(el.dataset.project ?? "");
    case "project-thread":
      tab("threads");
      enterDetail("vthreads");
      return openThread(Number(id));
    case "back":
      return back();
  }
});
$("open-project").onclick = openProject;
// Every message/brief field is a compose box (ADR-0033): one delegated binding for the whole page.
bindComposeBoxes(document);
$("menu").onclick = () => setDrawer(!document.querySelector(".app")!.classList.contains("drawer-open"), true);
$("scrim").onclick = () => closeDrawer();
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && document.querySelector(".app")!.classList.contains("drawer-open")) closeDrawer();
});
// Back to a wide screen: the sidebar is a column again, never a stuck-open drawer.
MEDIUM.addEventListener("change", () => setDrawer(false, false));
window.addEventListener("popstate", () => {
  leaveDetail();
  const v = popDetail(history.state, detailView());
  if (v) $(v).classList.add("detail");
});
// A detail entry that survived a reload names a view no longer in detail: clear it.
if (staleOnLoad(history.state)) history.replaceState(null, "");
setDrawer(false, false);
fitViewport();
$("lang").onclick = () => {
  // The other language, remembered in a cookie the server reads to render the page's lang/dir.
  document.cookie = `neo_lang=${root.lang === "ar" ? "en" : "ar"}; path=/; max-age=31536000; samesite=lax`;
  location.reload();
};

// The installable console (ADR-0022): the shell-only service worker, registered only where browsers
// allow it. A failed registration is logged and ignored — the console never depends on the worker.
if (isSecureContext && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => console.warn("service worker registration failed", err));
}
// The install chip follows installMode(): the browser's own prompt where it offers one, the iOS share
// hint on iPhone/iPad, nothing once installed or dismissed.
type InstallPrompt = Event & { prompt(): Promise<unknown> };
let installPrompt: InstallPrompt | null = null;
function installDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_DISMISSED_KEY) === "1";
  } catch {
    return false; // storage blocked: offer it again, never break the page
  }
}
function renderInstall(): void {
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as Any).standalone === true;
  const mode = installMode({ standalone, prompt: installPrompt !== null, ios: isIos(navigator.userAgent, navigator.maxTouchPoints), dismissed: installDismissed() });
  $("install").hidden = mode === "none";
  $("install").dataset.mode = mode;
  if (mode === "none") $("ioshint").hidden = true;
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // keep it for the chip instead of the browser's own banner
  installPrompt = e as InstallPrompt;
  renderInstall();
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  renderInstall();
});
$("install").onclick = () => {
  if ($("install").dataset.mode === "ios-hint") {
    $("ioshint").hidden = false;
    return;
  }
  const p = installPrompt;
  installPrompt = null; // a prompt event is single-use
  renderInstall();
  if (p) void p.prompt().catch((err) => console.warn("install prompt failed", err));
};
$("ioshint-x").onclick = () => {
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
  } catch {
    // storage blocked: the hint just closes for this page
  }
  $("ioshint").hidden = true;
  renderInstall();
};
renderInstall();
($("ff") as HTMLFormElement).onsubmit = (ev) => {
  ev.preventDefault();
  const m = $("msg") as HTMLTextAreaElement;
  const typed = m.value;
  void mainComposer.send(typed).then((sent) => {
    if (!sent) return; // refused: the text and the chips stay
    feedMsg(ownRow(ownLine(sent.body.text, sent.names)), "me", filterProject);
    if (m.value === typed) clearBox(m);
  });
};
($("tform") as HTMLFormElement).onsubmit = (ev) => {
  ev.preventDefault();
  const m = $("tmsg") as HTMLTextAreaElement;
  if (TH.open === undefined) return;
  // The composer inside a thread names it, so the message joins that thread (spec §4.1 rule 2).
  const typed = m.value;
  void threadComposer.send(typed).then((sent) => {
    if (!sent) return; // refused: the text and the chips stay
    appendThreadLine({ role: "user", content: sent.body.text, at: Date.now() }, ownLine(sent.body.text, sent.names));
    if (m.value === typed) clearBox(m);
  });
};

const es = new EventSource("/stream");
// Thread events are live only (never replayed): after a reconnect, re-read the list so changes made
// during the gap show.
let streamOpened = false;
es.onopen = () => {
  if (streamOpened && TH.started) loadThreads(true);
  streamOpened = true;
};
es.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (e.type === "message") {
    // The body takes its direction from its own text (an English line in the Arabic UI stays LTR).
    feedMsg((e.project ? `<span class="ptag">${esc(e.project)}</span>` : "") + `<div class="tx" dir="auto">${e.text}</div>`, "out", e.project, e.tone);
    if (e.threadId !== undefined && e.threadId === TH.open) appendThreadLine({ role: "assistant", project: e.project, at: Date.now(), tone: e.tone }, e.text);
  } else if (e.type === "echo") {
    feedMsg(ownRow(ownLine(e.text, [])), "me", filterProject);
    if (e.threadId !== undefined && e.threadId === TH.open) appendThreadLine({ role: "user", content: e.text, at: Date.now() });
  } else if (e.type === "notice") feedMsg("⋯ " + esc(e.text), "me", filterProject);
  else if (e.type === "projects") void loadState();
  else if (e.type === "attention") renderAttention(e);
  else if (e.type === "sdk") {
    S.sdk = e.sdk;
    renderSdk();
  } else if (e.type === "thread") onThreadEvent(e);
  else if (e.type === "escalation") {
    const c = document.createElement("div") as FeedNode;
    c.className = "escc";
    // The server renders the reason (a shell command as a code block); an older daemon sends text only.
    c.innerHTML = "⚠ " + (e.html ?? esc(e.reason));
    enhanceCode(c);
    const a = document.createElement("div");
    a.className = "acts";
    (["allow", "deny"] as const).forEach((dec) => {
      const b = document.createElement("button");
      b.className = "chip " + (dec === "allow" ? "ok" : "no");
      b.textContent = tx(`feed.${dec}`);
      b.onclick = () =>
        void act(b, "/approve", { id: e.id, decision: dec }).then((r) => {
          // No reply (offline): the card stays for another tap. A reply — decided, or already gone — removes it.
          if (r.data === undefined) return;
          c.remove();
          const ix = feedNodes.indexOf(c);
          if (ix >= 0) feedNodes.splice(ix, 1);
          refreshFeed();
        });
      a.appendChild(b);
    });
    c.appendChild(a);
    pushFeed(c, "esc", null);
    tab("activity");
  } else if (e.type === "file") {
    const d = document.createElement("div") as FeedNode;
    d.className = "row out";
    d.innerHTML = `📎 <a href="${esc(e.url)}">${esc(e.name)}</a>`;
    pushFeed(d, "out", e.project);
  }
};

applyStatic();
renderSdk();
$("who").textContent = tx("projects.noneActive");
// The first state load is "ready": the Core splash fades once it settles and its intro has played.
dismissSplash(loadState());
void loadInbox();
openFromHash();
window.addEventListener("hashchange", openFromHash);
setInterval(() => {
  void loadState();
  void loadInbox();
  if ($("vprojects").classList.contains("on")) loadProjects(); // the list only: a project's view reads git
}, POLL_MS);
