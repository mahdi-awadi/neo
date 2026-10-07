// One feed line as console HTML plus its colour tone (ADR-0025). The engine's own step lines —
// session-runner's "🔧 Tool: target" and "↳ output", the governor's "🔓 auto-approved: reason" — carry
// shell commands and tool output: their payload is shown as code, never parsed as Markdown (a heredoc's
// `# comment` is not a heading). Every other line is worker Markdown, rendered for the web target and
// toned by its leading priority accent (priority.ts) or marker. Deterministic: no AI, no I/O.
import { codeBlock, mdToHtml } from "./format";

export type LineTone = "tool" | "result" | "error" | "warn" | "done" | "approval" | "info" | "";

export interface FeedLine {
  html: string;
  tone: LineTone;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Tools whose milestone detail is a shell command (shown as a bash block, not inline code). */
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "PowerShell"]);

/** Output that reads as a unified diff: a hunk header, or several +/- lines. */
function looksLikeDiff(s: string): boolean {
  if (/^(@@ |diff --git |--- a\/|\+\+\+ b\/)/m.test(s)) return true;
  return (s.match(/^[+-](?![+-])/gm) ?? []).length >= 3 && /^\+/m.test(s) && /^-(?!-)/m.test(s);
}

/** Output that is a JSON document (an object or array), e.g. a script's or an API's reply — read from
 *  how it opens, because the engine cuts long results short ("…") and a cut document does not parse.
 *  An object must open with a quoted key and an array with an object, array or string, so log output
 *  such as "[security] warn" or "[1/3] building" stays plain. */
function looksLikeJson(s: string): boolean {
  return /^\s*(\{\s*("|\}\s*$)|\[\s*([{[]|"[^"\n]*"\s*[,:\]]|\]\s*$))/.test(s);
}

/** The highlight language of a tool's output, read from its shape; "" leaves it plain. */
function outputLang(s: string): string {
  if (looksLikeDiff(s)) return "diff";
  return looksLikeJson(s) ? "json" : "";
}

/** A governor reason (auto-approval note or escalation card): a shell command as a bash block, a
 *  path as inline code, anything else as escaped text. */
export function reasonHtml(reason: string): string {
  const shell = /^(risky shell command): ([\s\S]+)$/.exec(reason);
  if (shell) return `${esc(shell[1]!)}${codeBlock(shell[2]!, "bash")}`;
  const write = /^(file write outside the project folder): ([\s\S]+)$/.exec(reason);
  if (write) return `${esc(write[1]!)}: <code>${esc(write[2]!)}</code>`;
  return esc(reason);
}

/** The line's tone from its leading accent or marker (the priority accents of priority.ts and the
 *  engine's warning/stop markers). */
function proseTone(text: string): LineTone {
  if (/^(🔴|⛔|❌|🛑)/u.test(text)) return "error";
  if (/^⚠/u.test(text)) return "warn";
  if (/^(✅|🟢)/u.test(text)) return "done";
  if (/^🔵/u.test(text)) return "info";
  return "";
}

export function feedLine(text: string): FeedLine {
  // session-runner's milestone shape: one tool token, then a target of at most 60 characters on one
  // line (toolDetail truncates) — or a shell command, which may span lines. Anything else is prose.
  const tool = /^🔧 ([\w.-]+)(?:: ([\s\S]*))?$/u.exec(text);
  const isStep = tool && (SHELL_TOOLS.has(tool[1]!) || /^[^\n]{0,60}$/.test(tool[2] ?? ""));
  if (tool && isStep) {
    const name = tool[1]!;
    const detail = tool[2] ?? "";
    const head = `<span class="ti">🔧</span><span class="tl">${esc(name)}</span>`;
    if (!detail) return { html: head, tone: "tool" };
    if (SHELL_TOOLS.has(name)) return { html: `${head}${codeBlock(detail, "bash")}`, tone: "tool" };
    return { html: `${head} <code>${esc(detail)}</code>`, tone: "tool" };
  }
  const result = /^(⚠️ )?↳ ?([\s\S]*)$/u.exec(text);
  if (result) {
    const out = result[2]!;
    return { html: `<span class="ti">↳</span>${codeBlock(out, outputLang(out), "out")}`, tone: result[1] ? "error" : "result" };
  }
  const approved = /^🔓 auto-approved: ([\s\S]*)$/u.exec(text);
  if (approved) return { html: `<span class="ti">🔓</span><span class="tl">auto-approved</span> ${reasonHtml(approved[1]!)}`, tone: "approval" };
  return { html: mdToHtml(text, { target: "web" }), tone: proseTone(text) };
}
