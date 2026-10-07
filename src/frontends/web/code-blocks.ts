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
 *  `label(key)` reads the console catalogue (code.copy / code.copied / code.copyFailed). */
export function createCodeEnhancer(label: (key: string) => string): CodeEnhancer {
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
      if (io) io.observe(pre);
      else colour(pre);
    });
  };
  return { enhance, forget };
}
