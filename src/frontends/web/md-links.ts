// Markdown file links (ADR-0046): an absolute path to a `.md` file in a feed line — plain text or
// inline code — becomes a download link to /md-file. The detector is pure (tested); the DOM pass runs
// with the code-block enhancer on every rendered row, thread and card. It links only what the server
// can serve (absolute, `.md`, no hidden or `..` segment); the server checks everything again. The link
// is dir="ltr", so a path stays left-to-right inside Arabic text.

/** One path segment: no leading dot (hidden, `.` and `..` are never linked). Letters of any script. */
const SEG = String.raw`[\p{L}\p{N}_@+~-][\p{L}\p{N}_.@+~-]*`;
/** Not after a path or URL character (so `https://x/a.md` and `docs/a.md` stay text); not followed by
 *  one, or by a dot and more name (`a.md.bak`) — a sentence's closing dot is fine. */
const MD_PATH = new RegExp(String.raw`(?<![\p{L}\p{N}_.~:/\\-])/(?:${SEG}/)*${SEG}\.md(?![\p{L}\p{N}_@+~/-])(?!\.[\p{L}\p{N}_])`, "giu");

export interface MdPathMatch {
  start: number;
  end: number;
  path: string;
}

/** Every Markdown path in `text`. A fresh regex per call: `matchAll` starts at the shared one's
 *  `lastIndex`, so any earlier use of it would make this miss paths. */
export function findMdPaths(text: string): MdPathMatch[] {
  return [...text.matchAll(new RegExp(MD_PATH))].map((m) => ({ start: m.index!, end: m.index! + m[0].length, path: m[0] }));
}

export function mdFileHref(path: string): string {
  return `/md-file?path=${encodeURIComponent(path)}`;
}

/** A small download arrow (inline SVG, so it never depends on a font). */
const DOWNLOAD_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Where a path is text, not something else: code blocks keep their text, links and controls stay. */
const SKIP = "pre, a, button, textarea, input, script, style";

/** Link every Markdown path in the text under `root`. `title` is the tooltip (plain text). Idempotent:
 *  text already inside a link is skipped. */
export function linkMdPaths(root: Node, title: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Array<{ text: Text; found: MdPathMatch[] }> = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    if (!text.data.includes(".") || text.parentElement?.closest(SKIP)) continue;
    const found = findMdPaths(text.data);
    if (found.length) hits.push({ text, found });
  }
  for (const { text, found } of hits) {
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const m of found) {
      if (m.start > at) frag.append(text.data.slice(at, m.start));
      const a = document.createElement("a");
      a.className = "mdl";
      a.href = mdFileHref(m.path);
      a.setAttribute("download", "");
      a.dir = "ltr";
      a.title = title;
      a.textContent = m.path;
      a.insertAdjacentHTML("beforeend", DOWNLOAD_ICON);
      frag.append(a);
      at = m.end;
    }
    if (at < text.data.length) frag.append(text.data.slice(at));
    text.replaceWith(frag);
  }
}
