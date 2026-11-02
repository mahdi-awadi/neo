/// <reference lib="dom" />
// The console's History tab (ADR-0067, spec "Surfaces"): search past work by meaning, words and ids, with
// filters (project, kinds as chips, a date range) that fold away on a phone; a mode banner that says when
// meaning search is partial, off or skipped; hit cards (kind, title, project, date, ref, the lists that
// found it, archived, the snippet, commits, the plan file and a way to the source); "Remember" for a new
// fact; "Forget" behind a confirm dialog that asks for the reason. The render functions are pure (they get
// the page's escaping and translation helpers) so they are unit-tested; `mountHistory` wires the DOM once.
// Every string comes from the catalogues; ids, dates, shas and counts are LTR isolates (`ltr`).
import { RTL_SCRIPT, numbersLtr } from "../../engine/bidi";
import { QUERY_KINDS } from "../../engine/history/defaults";
import { mdFileHref } from "./md-links";

/** The page's helpers (app.ts): escaping, LTR and unknown-direction isolates, translation, a date. */
export interface Fmt {
  esc(s: unknown): string;
  ltr(s: unknown): string;
  iso(s: unknown): string;
  /** Markup text: interpolated values escaped. */
  t(key: string, vars?: Record<string, string | number>): string;
  /** Plain text, or markup whose values the caller already made safe. */
  tx(key: string, vars?: Record<string, string | number>): string;
  date(at: number): string;
}

export type Mode = { meaning: "on" } | { meaning: "partial"; coverage: number } | { meaning: "off"; reason: string } | { meaning: "skipped" };

/** One hit as `GET /api/history` sends it: `snippet` is already safe HTML (escaped, the match in <mark>). */
export interface HitView {
  ref: string;
  kind: string;
  project?: string;
  at: number;
  title: string;
  snippet: string;
  todo?: number;
  order?: string;
  thread?: number;
  path?: string;
  commits: string[];
  archived: boolean;
  via: string[];
  alsoIn?: string[];
}

export type PanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; code: string }
  | { kind: "done"; mode: Mode; hits: HitView[] };

/** The reason codes the catalogue names (`history.error.<code>`); any other reply reads as `other`. */
export const ERROR_CODES = [
  "query_empty", "query_too_long", "query_stopwords", "unknown_kind", "bad_range", "bad_date", "bad_limit", "bad_project",
  "history_off", "history_unreadable", "text_required", "empty", "too_short", "too_long", "secret", "rate_limited",
  "bad_ref", "reason_required", "reason_too_long", "unknown_ref", "not_forgettable", "network",
] as const;
const KNOWN_ERRORS = new Set<string>(ERROR_CODES);
/** The meaning-off reasons the catalogue names (`history.reason.<code>`). */
export const OFF_REASONS = [
  "not_configured", "config_refused", "embedder_down", "embedder_slow", "embedder_refused", "embedder_wrong_model",
  "vectors_down", "vectors_slow", "vectors_refused", "vectors_key_rejected", "collection_missing", "embedder_busy",
] as const;
const KNOWN_REASONS = new Set<string>(OFF_REASONS);
export const VIA = ["exact", "meaning", "words", "lines"] as const;
export { QUERY_KINDS };

/** Worker lines live in the ledger, not in `history.db`: there is nothing to forget. */
export const forgettable = (ref: string): boolean => !ref.startsWith("line:");

/** A refusal code from the engine as plain words (`secret: <pattern>` is the `secret` reason). */
export function errorText(code: string, f: Fmt): string {
  const c = code.startsWith("secret") ? "secret" : code;
  return KNOWN_ERRORS.has(c) ? f.tx(`history.error.${c}`) : f.tx("history.error.other", { code });
}

/** The banner above the hits: nothing when meaning search is on. */
export function modeBanner(mode: Mode, f: Fmt): string {
  if (mode.meaning === "on") return "";
  let text: string;
  if (mode.meaning === "partial") text = f.tx("history.mode.partial", { pct: f.ltr(`${Math.floor(mode.coverage * 100)}%`) });
  else if (mode.meaning === "off") {
    const reason = KNOWN_REASONS.has(mode.reason) ? f.esc(f.tx(`history.reason.${mode.reason}`)) : f.ltr(mode.reason);
    text = f.tx("history.mode.off", { reason });
  } else text = f.esc(f.tx("history.mode.skipped"));
  return `<div class="hbanner hb-${f.esc(mode.meaning)}" role="status">${text}</div>`;
}

/** One hit card. Every value is escaped; the snippet is the server's safe HTML, its numbers LTR in Arabic. */
export function hitCard(h: HitView, f: Fmt): string {
  const kind = (QUERY_KINDS as readonly string[]).includes(h.kind) ? f.esc(f.tx(`history.kind.${h.kind}`)) : f.ltr(h.kind);
  const meta = [
    `<span class="tchip hk">${kind}</span>`,
    ...(h.archived ? [`<span class="tchip harc">${f.esc(f.tx("history.archived"))}</span>`] : []),
    ...(h.project ? [f.iso(h.project)] : []),
    f.ltr(f.date(h.at)),
    f.ltr(h.ref),
  ].join(" ");
  const snippet = h.snippet ? `<div class="hsn" dir="auto">${RTL_SCRIPT.test(h.snippet) ? numbersLtr(h.snippet) : h.snippet}</div>` : "";
  const via = h.via.map((v) => `<span class="hvia">${(VIA as readonly string[]).includes(v) ? f.esc(f.tx(`history.via.${v}`)) : f.ltr(v)}</span>`).join("");
  const facts = [
    ...(h.commits.length ? [`<span>${f.esc(f.tx("history.commits"))} ${h.commits.map((c) => f.ltr(c)).join(" ")}</span>`] : []),
    ...(h.path ? [`<a class="mdl" href="${f.esc(mdFileHref(h.path))}" dir="ltr" title="${f.esc(f.tx("history.plan"))}">${f.esc(h.path)}</a>`] : []),
    ...(h.alsoIn?.length ? [`<span>${f.esc(f.tx("history.alsoIn"))} ${h.alsoIn.map((r) => f.ltr(r)).join(" ")}</span>`] : []),
  ];
  const acts = [
    ...(h.todo !== undefined ? [`<button class="chip" type="button" data-act="todo-open" data-id="${f.esc(h.todo)}">${f.esc(f.tx("history.openTodo"))} ${f.ltr("#" + h.todo)}</button>`] : []),
    ...(h.thread !== undefined ? [`<button class="chip" type="button" data-act="project-thread" data-id="${f.esc(h.thread)}">${f.esc(f.tx("history.openThread"))}</button>`] : []),
    ...(forgettable(h.ref) ? [`<button class="chip no" type="button" data-act="history-forget" data-ref="${f.esc(h.ref)}">${f.esc(f.tx("history.forget"))}</button>`] : []),
  ];
  return (
    `<article class="hcard" data-ref="${f.esc(h.ref)}"><div class="hm">${meta}</div>` +
    `<h3 class="ht" dir="auto">${f.esc(h.title)}</h3>${snippet}` +
    `<div class="hx"><span class="hvias">${via}</span>${facts.join("")}</div>` +
    (acts.length ? `<div class="acts">${acts.join("")}</div>` : "") +
    `</article>`
  );
}

/** The results area for each state: the first hint, searching, an error, no hits, or the banner and cards. */
export function resultsHtml(s: PanelState, f: Fmt): string {
  if (s.kind === "idle") return `<div class="hstate">${f.esc(f.tx("history.idle"))}</div>`;
  if (s.kind === "loading") return `<div class="hstate" aria-busy="true">${f.esc(f.tx("history.loading"))}</div>`;
  if (s.kind === "error") return `<div class="hstate herr" role="alert" dir="auto">${f.esc(errorText(s.code, f))}</div>`;
  const banner = modeBanner(s.mode, f);
  if (!s.hits.length) return `${banner}<div class="hstate">${f.esc(f.tx("history.none"))}</div>`;
  return `${banner}<div class="hcount">${f.tx("history.count", { n: f.ltr(s.hits.length) })}</div>${s.hits.map((h) => hitCard(h, f)).join("")}`;
}

/** The form's fields as the `GET /api/history` query string (empty fields left out). */
export function historyQuery(form: { q: string; project?: string; kinds?: string[]; since?: string; until?: string }): string {
  const p = new URLSearchParams({ q: form.q.trim() });
  if (form.project?.trim()) p.set("project", form.project.trim());
  if (form.kinds?.length) p.set("kinds", form.kinds.join(","));
  if (form.since) p.set("since", form.since);
  if (form.until) p.set("until", form.until);
  return p.toString();
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** A hit's day as digits only (local time, `YYYY-MM-DD`): it sits in an LTR isolate, where a localized
 *  month name (an Arabic one) would be reordered with the digits. */
export function numericDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The entry line of the forget dialog: the ref as an LTR isolate, the title as an isolate of its own
 *  direction, so in Arabic the ref never lands inside an English title (or the other way). */
export function forgetEntryHtml(ref: string, title: string | undefined, f: Fmt): string {
  return title !== undefined ? `${f.ltr(ref)} ${f.iso(title)}` : f.ltr(ref);
}

/** The toast after a forget: the counts, and the vectors that still wait for the shared index. */
export function forgetToast(d: { chunks?: number; points?: number; pendingPoints?: number }, f: Fmt): string {
  const done = f.tx("history.forgotten", { chunks: d.chunks ?? 0, points: d.points ?? 0 });
  return d.pendingPoints ? `${done} ${f.tx("history.forgetPending", { n: d.pendingPoints })}` : done;
}

/** What the panel needs from the page. */
export interface PanelDeps {
  fmt: Fmt;
  $: (id: string) => HTMLElement;
  /** app.ts `act()`: busy while the request runs, then a toast; `words` turns the reply into the toast. */
  act(btn: Element | null, path: string, body: unknown, okText?: string, words?: (ok: boolean, text: string, data: unknown) => string): Promise<{ ok: boolean; data?: unknown }>;
  toast(text: string, ok: boolean): void;
  /** Code blocks and Markdown file links in the rendered cards. */
  enhance(root: HTMLElement): void;
}

export interface HistoryPanel {
  /** Search for `q` now (the `#history=` link, a Telegram `/find` hand-off). */
  search(q: string): void;
  /** The confirm dialog for one card's Forget. */
  forget(ref: string): void;
}

/** Wire the History tab once. Each search cancels the one before it. */
export function mountHistory(d: PanelDeps): HistoryPanel {
  const { fmt: f, $ } = d;
  const val = (id: string): string => ($(id) as HTMLInputElement).value;
  const picked = new Set<string>();
  let ctl: AbortController | undefined;
  let state: PanelState = { kind: "idle" };
  const draw = (s: PanelState): void => {
    state = s;
    const box = $("hres");
    box.innerHTML = resultsHtml(s, f);
    d.enhance(box);
  };

  // The kind chips: one toggle each (aria-pressed), from the engine's own list.
  const kinds = $("hkinds");
  kinds.innerHTML = QUERY_KINDS.map((k) => `<button class="chip hkc" type="button" aria-pressed="false" data-kind="${f.esc(k)}">${f.esc(f.tx(`history.kind.${k}`))}</button>`).join("");
  kinds.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-kind]");
    if (!b) return;
    const k = b.dataset.kind!;
    if (picked.has(k)) picked.delete(k);
    else picked.add(k);
    b.setAttribute("aria-pressed", String(picked.has(k)));
  };
  // On a phone the filters fold away behind one button.
  $("hfbtn").onclick = () => {
    const open = !$("hfil").classList.contains("open");
    $("hfil").classList.toggle("open", open);
    $("hfbtn").setAttribute("aria-expanded", String(open));
  };
  $("hfclear").onclick = () => {
    picked.clear();
    kinds.querySelectorAll("[data-kind]").forEach((b) => b.setAttribute("aria-pressed", "false"));
    for (const id of ["hproj", "hsince", "huntil"]) ($(id) as HTMLInputElement).value = "";
  };

  function run(): void {
    const q = val("hq").trim();
    if (!q) return draw({ kind: "idle" });
    ctl?.abort();
    const mine = (ctl = new AbortController());
    draw({ kind: "loading" });
    const qs = historyQuery({ q, project: val("hproj"), kinds: [...picked], since: val("hsince"), until: val("huntil") });
    void fetch(`/api/history?${qs}`, { cache: "no-store", signal: mine.signal })
      .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as { ok?: boolean; error?: string; mode?: Mode; hits?: HitView[] } | null }))
      .then(({ body }) => {
        if (mine !== ctl) return;
        if (!body?.ok || !Array.isArray(body.hits) || !body.mode) return draw({ kind: "error", code: body?.error ?? "network" });
        draw({ kind: "done", mode: body.mode, hits: body.hits });
      })
      .catch(() => mine === ctl && !mine.signal.aborted && draw({ kind: "error", code: "network" }));
  }
  ($("hform") as HTMLFormElement).onsubmit = (ev) => {
    ev.preventDefault();
    run();
  };

  // Remember: the engine checks the text; the toast names the new ref or the reason.
  $("hrsave").onclick = () => {
    const text = val("hrtext");
    void d.act($("hrsave"), "/api/history/remember", { text, project: val("hrproj") }, undefined, (ok, code, data) => {
      if (!ok) return errorText(code, f);
      const r = (data ?? {}) as { ref?: string; duplicate?: boolean };
      return f.tx(r.duplicate ? "history.remember.duplicate" : "history.remember.saved", { ref: r.ref ?? "" });
    }).then((r) => {
      if (!r.ok) return;
      ($("hrtext") as HTMLTextAreaElement).value = "";
      if (state.kind === "done") run();
    });
  };

  // Forget: a modal that shows the entry and asks why; nothing is sent without a reason.
  const dlg = $("hfsheet") as HTMLDialogElement;
  let target = "";
  $("hfcancel").onclick = () => dlg.close();
  dlg.addEventListener("click", (ev) => {
    if (ev.target === dlg) dlg.close();
  });
  $("hfgo").onclick = () => {
    const reason = val("hfreason").trim();
    if (!reason) {
      d.toast(f.tx("history.error.reason_required"), false);
      return $("hfreason").focus();
    }
    const ref = target;
    void d.act($("hfgo"), "/api/history/forget", { ref, reason }, undefined, (ok, code, data) => (ok ? forgetToast((data ?? {}) as never, f) : errorText(code, f))).then((r) => {
      if (!r.ok) return;
      dlg.close();
      if (state.kind === "done") draw({ ...state, hits: state.hits.filter((h) => h.ref !== ref) });
    });
  };

  return {
    search(q) {
      ($("hq") as HTMLInputElement).value = q;
      run();
    },
    forget(ref) {
      if (!forgettable(ref)) return;
      target = ref;
      const hit = state.kind === "done" ? state.hits.find((h) => h.ref === ref) : undefined;
      $("hfentry").innerHTML = forgetEntryHtml(ref, hit?.title, f);
      ($("hfreason") as HTMLTextAreaElement).value = "";
      dlg.showModal();
      $("hfreason").focus();
    },
  };
}
