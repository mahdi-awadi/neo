// The operator's own text (typed here, mirrored from Telegram, or read back in a thread) as safe HTML:
// one dir="auto" block per line, so an Arabic line runs right-to-left and an English line
// left-to-right, and every line break shows (ADR-0033). Numbers in Arabic text stay an LTR run,
// by the same rule the server renderer uses (../../engine/bidi.ts).
import { RTL_SCRIPT, numbersLtr } from "../../engine/bidi";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function linesHtml(text: string): string {
  const rtl = RTL_SCRIPT.test(text);
  return text
    .split(/\r?\n/)
    .map((line) => `<div dir="auto">${line ? (rtl ? numbersLtr(esc(line)) : esc(line)) : "<br>"}</div>`)
    .join("");
}
