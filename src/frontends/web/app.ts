/// <reference lib="dom" />
// The operator console (browser). Bundled by Bun.build at daemon start and served as /app.js; the
// page shell is ./index.html. Every user-facing string comes from ./locales/<lang>/console.json
// through i18next (./i18n.ts) — `t()` for markup (interpolated values escaped), `tx()` for plain text.
// Live data: /api/state (polled), /stream (SSE, the bounded feed window — ADR-0014), and the paged
// history endpoints (/api/threads, /api/threads/:id, /api/search — ADR-0017).
import { createConsoleI18n, isLang } from "./i18n";

const root = document.documentElement;
const i18n = createConsoleI18n(isLang(root.lang) ? root.lang : "en");
type Vars = Record<string, string | number>;
/** Markup text: interpolated values are HTML-escaped. */
const t = (key: string, vars?: Vars): string => i18n.t(key, vars ?? {});
/** Plain text (textContent, title, placeholder, dialogs): the DOM does not parse it, so no escaping. */
const tx = (key: string, vars?: Vars): string => i18n.t(key, { ...vars, interpolation: { escapeValue: false } });

const FEED_WINDOW = Number(root.dataset.feedWindow) || 500;
const POLL_MS = 15000;
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const val = (id: string): string => ($(id) as HTMLInputElement).value;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let S: Any = { projects: [], sdk: { provider: "subscription", label: "", choices: [] }, usage: null, loops: [], recent: [], repos: [], todos: [] };

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

/** The page shell's static text: every `data-i18n*` attribute is filled from the catalogue. */
function applyStatic(): void {
  document.title = tx("meta.title");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = tx(el.dataset.i18n!)));
  document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => (el.placeholder = tx(el.dataset.i18nPlaceholder!)));
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => (el.title = tx(el.dataset.i18nTitle!)));
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
    b.onclick = () => setSdk(c.provider);
    seg.appendChild(b);
  });
  box.appendChild(seg);
}
function setSdk(provider: string): void {
  void post("/api/sdk", { provider })
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok) {
        alert(d.error || tx("sdk.switchFailed"));
        return;
      }
      S.sdk = d.sdk;
      renderSdk();
    });
}

// ctx% against the sweet spot (ADR-0021): the band colours the chip; the last reset rides along.
function ctxChip(p: Any): string {
  if (p.ctxPct == null && !p.lastReset) return "";
  const b = p.ctxBand || "healthy";
  const text = (p.ctxPct != null ? tx("ctx.chip", { pct: p.ctxPct }) : tx("ctx.chipNone")) + (p.lastReset ? " · " + tx("ctx.reset", { age: age(Date.now() - p.lastReset.at) }) : "");
  const verdict = p.lastReset ? p.lastReset.verdict + (p.lastReset.reason ? ` (${p.lastReset.reason})` : "") : "";
  const tip = tx(`ctx.band.${b}`) + (p.lastReset ? " — " + tx("ctx.lastReset", { verdict }) : "");
  return `<span class="ctx ${esc(b)}" title="${esc(tip)}">${esc(text)}</span>`;
}
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
      setFilter(p.name);
      tab("activity");
      void post("/select", { id: p.id }).then(loadState);
    };
    const k = document.createElement("button");
    k.className = "kbtn";
    k.textContent = "✕";
    k.title = tx("projects.kill");
    k.onclick = (ev) => {
      ev.stopPropagation();
      void post("/kill", { id: p.id }).then(loadState);
    };
    d.appendChild(k);
    box.appendChild(d);
    if (p.active) active = p;
  });
  $("who").textContent = active ? tx("projects.active", { name: active.name }) : tx("projects.openNoneActive", { count: S.projects.length });
}

function openProject(): void {
  const folder = val("repo");
  const task = val("task").trim();
  if (!folder || !task) {
    alert(tx("newProject.missing"));
    return;
  }
  void post("/api/open", { folder, task }).then(() => {
    ($("task") as HTMLTextAreaElement).value = "";
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
    `<textarea id="lc-prompt" class="itx" placeholder="${ph("loops.prompt")}"></textarea>` +
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
    run.onclick = () => void post("/api/loop", { name: l.name }).then(() => tab("activity"));
    row.appendChild(run);
    if (l.scheduled) {
      const tg = document.createElement("button");
      tg.className = "chip" + (l.enabled ? " ok" : "");
      tg.textContent = tx(l.enabled ? "loops.on" : "loops.off");
      tg.onclick = () => void post("/api/loop/enable", { name: l.name, on: !l.enabled }).then(loadState);
      row.appendChild(tg);
    }
    if (l.custom) {
      const del = document.createElement("button");
      del.className = "chip no";
      del.textContent = tx("loops.delete");
      del.onclick = () => {
        if (confirm(tx("loops.confirmDelete", { name: l.name }))) void post("/api/loop/delete", { name: l.name }).then(loadState);
      };
      row.appendChild(del);
    }
    card.appendChild(row);
  });
  v.appendChild(card);
}
function submitLoop(): void {
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
  void post("/api/loop/create", body)
    .then((r) => r.json())
    .then((d) => {
      if (d.ok) void loadState();
      else $("lc-err").textContent = d.error || tx("loops.invalid");
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
function todoAct(action: string, arg: number | string): void {
  const b: Any = { action };
  if (typeof arg === "number") b.id = arg;
  else b.project = arg;
  void post("/api/todo", b)
    .then((r) => r.json())
    .then((d) => {
      if (d && d.text) feedMsg("⋯ " + esc(d.text), "me", null);
      void loadState();
    });
}
function renderTodos(): void {
  const v = $("vtodos");
  const T: Any[] = S.todos || [];
  const q = T.filter((x) => x.status === "queued").length;
  const bd = $("tbadge");
  bd.textContent = q ? " " + q : "";
  bd.className = "ibadge" + (q ? " on" : "");
  if (!T.length) {
    v.innerHTML = `<div class="card"><h3>${t("queue.title")}</h3><div class="empty">${t("queue.empty")}</div></div>`;
    return;
  }
  v.innerHTML = "";
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
    pr.onclick = () => todoAct(paused ? "resume" : "pause", p);
    card.appendChild(pr);
    by[p]!.forEach((x) => {
      const row = document.createElement("div");
      row.className = "rrow";
      const lead = x.status === "running" ? t("queue.running", { age: age(Date.now() - (x.startedAt || x.createdAt)) }) : ltr(x.position + ".");
      row.innerHTML = `<span>${lead}</span><div style="flex:1;min-width:0"><div>${ltr("#" + x.id)} ${esc(x.title)}</div></div>`;
      if (x.status === "queued") {
        if (x.position > 1) {
          const up = document.createElement("button");
          up.className = "chip";
          up.textContent = "↑";
          up.title = tx("queue.moveUp");
          up.onclick = () => todoAct("up", x.id);
          row.appendChild(up);
        }
        const c = document.createElement("button");
        c.className = "chip no";
        c.textContent = tx("queue.cancel");
        c.onclick = () => {
          if (confirm(tx("queue.confirmCancel", { id: x.id }))) todoAct("cancel", x.id);
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
    const ic = o.status === "done" ? "✓" : o.status === "error" ? "✗" : "⏳";
    h += `<div class="rrow"><span>${ic}</span><div style="flex:1;min-width:0"><div>${esc(o.task)}</div><div class="rfo">${ltr(o.folder)}</div></div></div>`;
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
      h += `<div class="iact"><input class="iinp" id="instr-${id}" placeholder="${ph("inbox.instructions")}"><button class="run" data-act="inbox-agent" data-id="${id}">${t("inbox.sendToAgent")}</button></div>`;
    } else if (i.status === "with-agent") {
      h += `<div class="iact"><span class="rfo">${t("inbox.drafting")}</span></div>`;
    } else if (i.status === "drafted") {
      h += `<div class="rfo" style="margin-top:9px">${t("inbox.draftHint")}</div>`;
      h += `<textarea class="itx" id="draft-${id}">${esc(i.draft || "")}</textarea>`;
      h += `<div class="iact"><button class="run ok" data-act="inbox-send" data-id="${id}">${t("inbox.sendToCustomer")}</button>`;
      h += `<input class="iinp" id="notes-${id}" placeholder="${ph("inbox.notes")}"><button class="run" data-act="inbox-redraft" data-id="${id}">${t("inbox.redraft")}</button></div>`;
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
function inboxDraft(id: string, field: "instr" | "notes"): void {
  const el = document.getElementById(`${field}-${id}`) as HTMLInputElement | null;
  dim(id, "0.55");
  void post("/api/inbox/draft", { id, instructions: el ? el.value : "" }).then(loadInbox).catch(loadInbox);
  setTimeout(loadInbox, 800);
}
function sendReply(id: string): void {
  const el = document.getElementById("draft-" + id) as HTMLTextAreaElement | null;
  const reply = el ? el.value : "";
  if (!reply.trim() || !confirm(tx("inbox.confirmSend"))) return;
  void post("/api/inbox/send", { id, reply })
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok) alert(tx("inbox.sendFailed"));
      void loadInbox();
    })
    .catch(() => alert(tx("inbox.sendFailed")));
}
function deleteInbox(id: string): void {
  if (!confirm(tx("inbox.confirmDelete"))) return;
  dim(id, "0.4");
  void fetch("/api/inbox/" + encodeURIComponent(id), { method: "DELETE" }).then(loadInbox).catch(loadInbox);
}

const VIEWS = ["activity", "threads", "todos", "loops", "usage", "recent", "inbox"];
function tab(name: string): void {
  VIEWS.forEach((n) => {
    $("v" + n).classList.toggle("on", n === name);
    const b = document.querySelector(`.tab[data-v="${n}"]`);
    if (b) b.classList.toggle("on", n === name);
  });
  if (name === "inbox") void loadInbox();
  if (name === "threads") openThreads();
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
      if (nodeVisible(o!) && !feedNodes.some(nodeVisible)) ph.style.display = "";
    }
  }
  if (v) scheduleTail();
}
function feedMsg(html: string, kind: string, project: string | null | undefined): HTMLElement {
  const d = document.createElement("div") as FeedNode;
  d.className = "row " + (kind === "me" ? "me" : "out");
  d.innerHTML = html;
  pushFeed(d, kind, project);
  return d;
}
function say(text: string): void {
  const v = (text || "").trim();
  if (!v) return;
  feedMsg("› " + esc(v), "me", filterProject);
  void post("/msg", { text: v });
}
function uploadFile(): void {
  const i = $("file") as HTMLInputElement;
  if (!i.files || !i.files.length) return;
  const fd = new FormData();
  fd.append("file", i.files[0]!);
  void fetch("/upload", { method: "POST", body: fd }).then((r) => {
    if (!r.ok) alert(tx("feed.uploadFailed", { status: r.status }));
  });
  i.value = "";
}

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
  fillSelect("torigin", ["", "operator", "loop", "attention", "ingress", "legacy"], (v) => `threads.origin.${v || "all"}`);
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
function threadRowHtml(r: Any): string {
  const counts = r.messages === undefined ? "" : " · " + t("threads.counts", { messages: r.messages, decisions: r.openDecisions, todos: r.activeTodos });
  return (
    `<div class="tt"><span class="tchip st-${esc(r.state)}">${t(`threads.state.${r.state}`)}</span>${r.ref ? ltr(r.ref) : ""}<span class="ttl" dir="auto">${r.title ? esc(r.title) : t("threads.untitled")}</span></div>` +
    `<div class="tm">${r.project ? iso(r.project) + " · " : ""}${iso(age(Date.now() - r.updatedAt))}${counts}</div>`
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
  const who = m.role === "user" ? t("threads.you") : m.project ? iso(m.project) : t("threads.neo");
  // Message text has no fixed direction (an English line in the Arabic console, or the reverse).
  return `<div class="tmsg ${m.role === "user" ? "user" : ""}"><div class="tw">${who} · ${ltr(clock(m.at))}</div><div dir="auto">${html ?? esc(m.content)}</div></div>`;
}
function renderThreadPane(v: Any): void {
  const th = v.thread;
  let h = `<div class="thead">${th.ref ? ltr(th.ref) : ""}${th.project ? " · " + iso(th.project) : ""} <span class="tchip st-${esc(th.state)}">${t(`threads.state.${th.state}`)}</span></div>`;
  h += `<div class="ttitle" dir="auto">${th.title ? esc(th.title) : t("threads.untitled")}</div>`;
  if (v.next) h += `<button class="run" id="tolder" data-act="thread-older">${t("threads.olderMessages")}</button>`;
  h += `<div id="tmsgs">${(v.messages as Any[]).slice().reverse().map((m) => messageHtml(m)).join("")}</div>`;
  if (v.decisions.length) {
    h += `<div class="tsect"><h4>${t("threads.decisions")}</h4>`;
    h += v.decisions.map((d: Any) => `<div class="tart"><span class="tchip">${t(`threads.decisionStatus.${d.status}`)}</span>${iso(d.question)}${d.answer ? ` → ${iso(d.answer)}` : ""}</div>`).join("");
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
        const line = t("threads.planLine", { status: tx(`threads.planStatus.${p.status}`), done: p.stepsDone, total: p.stepsTotal, version: p.version });
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
      if (!v.next) document.getElementById("tolder")?.remove();
    })
    .catch(() => {});
}
/** A live line in the open thread: appended (feed `message` text is already safe HTML). */
function appendThreadLine(m: Any, html?: string): void {
  const box = document.getElementById("tmsgs");
  if (!box) return;
  box.insertAdjacentHTML("beforeend", messageHtml(m, html));
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
function planAction(id: number, action: string, version: number): void {
  void post("/api/plan", { id, action, version })
    .then((r) => r.json())
    .then((d) => {
      feedMsg("⋯ " + esc(d.text || ""), "me", null);
      if (TH.open !== undefined) openThread(TH.open);
    });
}

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
      return submitLoop();
    case "inbox-agent":
      return inboxDraft(id, "instr");
    case "inbox-redraft":
      return inboxDraft(id, "notes");
    case "inbox-send":
      return sendReply(id);
    case "inbox-delete":
      return deleteInbox(id);
    case "thread-project":
      TH.project = el.dataset.project ?? "";
      document.querySelectorAll(".tp").forEach((x) => x.classList.toggle("on", x === el));
      return loadThreads(true);
    case "threads-older":
      return loadThreads(false);
    case "thread-open":
      return openThread(Number(id));
    case "thread-older":
      return olderMessages();
    case "plan":
      return planAction(Number(id), el.dataset.action ?? "", Number(el.dataset.version));
  }
});
$("open-project").onclick = openProject;
$("attach").onclick = () => $("file").click();
$("file").onchange = uploadFile;
$("lang").onclick = () => {
  // The other language, remembered in a cookie the server reads to render the page's lang/dir.
  document.cookie = `neo_lang=${root.lang === "ar" ? "en" : "ar"}; path=/; max-age=31536000; samesite=lax`;
  location.reload();
};
($("ff") as HTMLFormElement).onsubmit = (ev) => {
  ev.preventDefault();
  const m = $("msg") as HTMLInputElement;
  say(m.value);
  m.value = "";
};
($("tform") as HTMLFormElement).onsubmit = (ev) => {
  ev.preventDefault();
  const m = $("tmsg") as HTMLInputElement;
  const text = m.value.trim();
  if (!text || TH.open === undefined) return;
  // The composer inside a thread names it, so the message joins that thread (spec §4.1 rule 2).
  void post("/msg", { text, threadId: TH.open });
  appendThreadLine({ role: "user", content: text, at: Date.now() });
  m.value = "";
};

const es = new EventSource("/stream");
es.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (e.type === "message") {
    feedMsg((e.project ? `<span class="ptag">${esc(e.project)}</span>` : "") + e.text, "out", e.project);
    if (e.threadId !== undefined && e.threadId === TH.open) appendThreadLine({ role: "assistant", project: e.project, at: Date.now() }, e.text);
  } else if (e.type === "echo") {
    feedMsg("› " + esc(e.text), "me", filterProject);
    if (e.threadId !== undefined && e.threadId === TH.open) appendThreadLine({ role: "user", content: e.text, at: Date.now() });
  } else if (e.type === "notice") feedMsg("⋯ " + esc(e.text), "me", filterProject);
  else if (e.type === "projects") void loadState();
  else if (e.type === "sdk") {
    S.sdk = e.sdk;
    renderSdk();
  } else if (e.type === "thread") onThreadEvent(e);
  else if (e.type === "escalation") {
    const c = document.createElement("div") as FeedNode;
    c.className = "escc";
    c.innerHTML = "⚠ " + esc(e.reason);
    const a = document.createElement("div");
    a.className = "acts";
    (["allow", "deny"] as const).forEach((dec) => {
      const b = document.createElement("button");
      b.className = "chip " + (dec === "allow" ? "ok" : "no");
      b.textContent = tx(`feed.${dec}`);
      b.onclick = () => {
        void post("/approve", { id: e.id, decision: dec });
        c.remove();
        const ix = feedNodes.indexOf(c);
        if (ix >= 0) feedNodes.splice(ix, 1);
        refreshFeed();
      };
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
void loadState();
void loadInbox();
setInterval(() => {
  void loadState();
  void loadInbox();
}, POLL_MS);
