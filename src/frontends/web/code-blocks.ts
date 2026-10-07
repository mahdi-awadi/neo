// The console's code blocks (ADR-0025): the server renders `<pre class="code" data-lang>` with the text
// already escaped; here they get syntax colours and a copy button. Highlighting is lazy — a block is
// coloured only when it scrolls into view, once — so a long feed stays fast. highlight.js core with a
// small set of registered languages (no auto-detection: it is slow and guesses wrong on short output).
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGS = { bash, css, diff, dockerfile, go, ini, javascript, json, markdown, python, sql, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);

/** Fence names and file extensions that mean one of the registered languages. */
const ALIASES: Record<string, keyof typeof LANGS> = {
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  ts: "typescript", tsx: "typescript", mts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  yml: "yaml", html: "xml", svg: "xml", golang: "go", py: "python",
  docker: "dockerfile", toml: "ini", env: "ini", md: "markdown", patch: "diff",
};

/** Blocks larger than this stay plain: highlighting them costs more than it helps. */
export const HIGHLIGHT_MAX = 20_000;

/** Blocks longer than this many lines start folded to about this height, with a "show all" toggle,
 *  so one long heredoc or query result does not push the rest of the feed off a phone screen. */
export const COLLAPSE_LINES = 16;

/** The block's line count (a trailing newline does not start a line). */
export function lineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

export function shouldCollapse(text: string): boolean {
  return lineCount(text) > COLLAPSE_LINES;
}

export function resolveLang(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  if (n in LANGS) return n;
  return ALIASES[n];
}

/** Highlighted HTML for a block's text (highlight.js escapes the text itself), or undefined when the
 *  block should stay plain: no or unknown language, or too large. */
export function highlightHtml(text: string, lang: string): string | undefined {
  const language = resolveLang(lang);
  if (!language || text.length > HIGHLIGHT_MAX) return undefined;
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}

export interface CodeEnhancer {
  /** Colour (lazily) and add copy buttons to the new code blocks under `root`. */
  enhance(root: ParentNode): void;
  /** Stop watching the blocks under a removed node (a pruned feed row), so it can be collected. */
  forget(root: ParentNode): void;
}

/** Wire the enhancer once, for every feed row, thread pane and card.
 *  `label(key, vars)` reads the console catalogue (code.copy / copied / copyFailed / expand / collapse). */
export function createCodeEnhancer(label: (key: string, vars?: Record<string, number>) => string): CodeEnhancer {
  const colour = (pre: HTMLElement) => {
    const code = pre.querySelector("code");
    if (!code) return;
    const html = highlightHtml(code.textContent ?? "", pre.dataset.lang ?? "");
    if (html !== undefined) {
      code.innerHTML = html;
      code.classList.add("hljs");
    }
  };
  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              io!.unobserve(e.target);
              colour(e.target as HTMLElement);
            }
          },
          { rootMargin: "200px 0px" },
        )
      : null;

  const resets = new WeakMap<HTMLButtonElement, number>();
  // One delegated listener for every copy button, present or future.
  document.addEventListener("click", (ev) => {
    const btn = (ev.target as Element | null)?.closest?.<HTMLButtonElement>("button.copy");
    if (!btn) return;
    const text = btn.parentElement?.querySelector("code")?.textContent ?? "";
    const done = (key: string) => {
      btn.textContent = label(key);
      btn.classList.toggle("ok", key === "code.copied");
      clearTimeout(resets.get(btn)); // a second tap restarts the feedback, it does not stack
      resets.set(btn, window.setTimeout(() => {
        btn.textContent = label("code.copy");
        btn.classList.remove("ok");
      }, 1600));
    };
    if (!navigator.clipboard) return done("code.copyFailed");
    navigator.clipboard.writeText(text).then(
      () => done("code.copied"),
      () => done("code.copyFailed"),
    );
  });

  // One delegated listener for every fold toggle: unfold shows the whole block, fold restores the preview.
  const foldLabel = (btn: HTMLButtonElement, open: boolean) => {
    btn.textContent = open ? label("code.collapse") : label("code.expand", { count: Number(btn.dataset.lines) });
    btn.setAttribute("aria-expanded", String(open));
  };
  document.addEventListener("click", (ev) => {
    const btn = (ev.target as Element | null)?.closest?.<HTMLButtonElement>("button.more");
    const wrap = btn?.previousElementSibling;
    if (!btn || !wrap?.classList.contains("cbw")) return;
    const open = wrap.classList.toggle("clp") === false;
    foldLabel(btn, open);
    // Folding a block taller than the screen would leave the reader far below it: bring it back.
    if (!open) wrap.scrollIntoView({ block: "nearest" });
  });

  const forget = (root: ParentNode) => {
    if (io) root.querySelectorAll<HTMLElement>("pre.code").forEach((pre) => io.unobserve(pre));
  };
  const enhance = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>("pre.code").forEach((pre) => {
      if (pre.dataset.hl) return;
      pre.dataset.hl = "1";
      // The button sits on a wrapper, not inside the <pre>: a block that scrolls sideways on a phone
      // must not scroll its copy button out of reach.
      const wrap = document.createElement("div");
      wrap.className = "cbw";
      pre.before(wrap);
      wrap.append(pre);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "copy";
      b.textContent = label("code.copy");
      wrap.append(b);
      const text = pre.querySelector("code")?.textContent ?? "";
      if (shouldCollapse(text)) {
        wrap.classList.add("clp");
        wrap.style.setProperty("--fold-lines", String(COLLAPSE_LINES)); // the folded height, one source
        const m = document.createElement("button");
        m.type = "button";
        m.className = "more";
        m.dataset.lines = String(lineCount(text));
        foldLabel(m, false);
        // After the wrapper, not in it: the toggle follows the message body's direction, not the code's.
        wrap.after(m);
      }
      if (io) io.observe(pre);
      else colour(pre);
    });
  };
  return { enhance, forget };
}
