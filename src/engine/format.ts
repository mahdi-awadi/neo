// Render worker Markdown into SAFE HTML for both surfaces (ADR-0025): the web console and Telegram
// (parse_mode "HTML"). One renderer: `marked`'s GFM lexer parses, and the token walk below emits the
// HTML itself — every text node is escaped and raw HTML in the input is shown as text, so the only
// tags in the output are ones written here. Two targets:
//   - "web": full HTML (headings, lists, tables with alignment, code blocks with a language) for the
//     console, which highlights code blocks lazily in the browser.
//   - the default compact target: the b/i/s/code/pre/a/blockquote subset Telegram accepts, newlines
//     kept as text. Telegram has no <table>, so `tables: "pre"` renders tables as an aligned <pre>.
import { Lexer, Tokenizer, type Token, type Tokens } from "marked";
import { RTL_SCRIPT, numbersLtr } from "./bidi";

/** Deterministic Telegram hashtag for a project name, e.g. "eticket-v3" -> "#eticket_v3".
 *  Telegram only auto-links [A-Za-z0-9_] after "#", needs length >= 2, and treats a leading
 *  digit poorly — so: lowercase, map every other char to "_", collapse/trim underscores, and
 *  prefix "p_" when the result would start with a digit or be a single char. */
export function projectHashtag(name: string): string {
  let tag = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (/^[0-9]/.test(tag) || tag.length < 2) tag = `p_${tag}`;
  return `#${tag}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape for an attribute value (adds the double quote). */
function attr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

/** The FTS5 snippet match markers (control characters: they never occur in a message). */
export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";

/** A search snippet as safe HTML: the text escaped, the marked match in <mark>. */
export function snippetHtml(s: string): string {
  return esc(s).replaceAll(SNIPPET_OPEN, "<mark>").replaceAll(SNIPPET_CLOSE, "</mark>");
}

// A table separator row, e.g. |---|:--:|---|
function isSeparator(line: string): boolean {
  return line.includes("|") && /-/.test(line) && /^[\s:|-]+$/.test(line.trim());
}

function tableToPre(grid: string[][]): string {
  const cols = Math.max(...grid.map((r) => r.length));
  const width: number[] = [];
  for (let c = 0; c < cols; c++) width[c] = Math.max(...grid.map((r) => (r[c] ?? "").length));
  const fmt = (r: string[]) => r.map((cell, c) => (cell ?? "").padEnd(width[c])).join("  ").trimEnd();
  const lines = [fmt(grid[0]), "-".repeat(width.reduce((a, b) => a + b + 2, 0)), ...grid.slice(1).map(fmt)];
  return `<pre>${esc(lines.join("\n"))}</pre>`;
}

export interface MdOptions {
  /** "web" = the console's full HTML; default = the compact Telegram subset. */
  target?: "web";
  /** Compact target only: "pre" renders tables as an aligned <pre> (Telegram has no <table>). */
  tables?: "html" | "pre";
}

/** GFM emphasis without underscores: worker output is full of `__init__`, `__tests__/` and snake_case,
 *  and `_x_` emphasis turning them bold (losing the underscores) costs more than it adds. `*` still works. */
class NoUnderscoreEmphasis extends Tokenizer {
  override emStrong(src: string, maskedSrc: string, prevChar = ""): Tokens.Em | Tokens.Strong | undefined {
    return src.startsWith("_") ? undefined : super.emStrong(src, maskedSrc, prevChar);
  }
}

/** A safe link target: http(s) and mailto only, else undefined (the label renders as text). */
function safeHref(href: string): string | undefined {
  const h = href.trim();
  return /^(https?:|mailto:)/i.test(h) ? h : undefined;
}

/** A code fence's language: the first word of the info string, cut to a safe name. */
function fenceLang(info: string | undefined): string {
  return (info ?? "").trim().split(/[\s"'`<>{}=]/)[0]!.toLowerCase().replace(/[^a-z0-9_+#.-]/g, "").slice(0, 20);
}

/** A cell that is a number (counts, money, percentages, sizes): its column right-aligns. */
const NUMERIC = /^[-+−]?[$€£]?\d[\d,.\s]*(%|[kKmMgGtT]i?[bB]?|ms|s)?$/;

interface Ctx {
  web: boolean;
  tablesPre: boolean;
  /** The source has Arabic/Hebrew script: numbers in prose get an isolated LTR run. */
  rtl: boolean;
  /** Inside a table: already a left-to-right block, so numbers need no LTR run of their own. */
  inTable?: boolean;
}

function inline(tokens: Token[] | undefined, c: Ctx): string {
  return (tokens ?? []).map((t) => inlineToken(t, c)).join("");
}

function inlineToken(t: Token, c: Ctx): string {
  switch (t.type) {
    case "strong":
      return c.web ? `<strong>${inline(t.tokens, c)}</strong>` : `<b>${inline(t.tokens, c)}</b>`;
    case "em":
      return c.web ? `<em>${inline(t.tokens, c)}</em>` : `<i>${inline(t.tokens, c)}</i>`;
    case "del":
      return c.web ? `<del>${inline(t.tokens, c)}</del>` : `<s>${inline(t.tokens, c)}</s>`;
    case "codespan":
      return `<code>${esc((t as Tokens.Codespan).text)}</code>`;
    case "br":
      return c.web ? "<br>" : "\n";
    case "link":
    case "image": {
      const l = t as Tokens.Link | Tokens.Image;
      const label = t.type === "image" ? esc(l.text || l.href) : inline((l as Tokens.Link).tokens, c);
      const href = safeHref(l.href);
      if (!href) return label;
      return c.web ? `<a href="${attr(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<a href="${attr(href)}">${label}</a>`;
    }
    case "text": {
      const x = t as Tokens.Text;
      if (x.tokens?.length) return inline(x.tokens, c);
      return textOut(x.text, c);
    }
    case "escape":
    case "html":
    default:
      return textOut((t as { text?: string }).text ?? t.raw, c);
  }
}

/** Plain text: escaped; on the web a soft line break is a <br> and numbers are an LTR run. */
function textOut(s: string, c: Ctx): string {
  if (!c.web) return esc(s);
  return (c.rtl && !c.inTable ? numbersLtr(esc(s)) : esc(s)).replace(/\n/g, "<br>");
}

function cellText(cell: Tokens.TableCell): string {
  return cell.tokens.map((t) => t.raw).join("").trim();
}

function tableWeb(t: Tokens.Table, outer: Ctx): string {
  const c: Ctx = { ...outer, inTable: true };
  const numeric = t.header.map((_h, i) => t.rows.length > 0 && t.rows.every((r) => NUMERIC.test(cellText(r[i]!))));
  const cls = (i: number) => {
    const a = t.align[i];
    const name = a === "right" ? "al-r" : a === "center" ? "al-c" : a === "left" ? "al-l" : numeric[i] ? "num" : "";
    return name ? ` class="${name}"` : "";
  };
  const th = t.header.map((h, i) => `<th${cls(i)}>${inline(h.tokens, c)}</th>`).join("");
  const body = t.rows.map((r) => `<tr>${r.map((cell, i) => `<td${cls(i)}>${inline(cell.tokens, c)}</td>`).join("")}</tr>`).join("");
  return `<div class="tbl"><table class="md"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function tableCompact(t: Tokens.Table, c: Ctx): string {
  if (c.tablesPre) return tableToPre([t.header.map(cellText), ...t.rows.map((r) => r.map(cellText))]);
  const th = t.header.map((h) => `<th>${inline(h.tokens, c)}</th>`).join("");
  const body = t.rows.map((r) => `<tr>${r.map((cell) => `<td>${inline(cell.tokens, c)}</td>`).join("")}</tr>`).join("");
  return `<table class="md"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function listItems(l: Tokens.List, c: Ctx, depth: number): string {
  if (c.web) {
    const items = l.items
      .map((it) => {
        const body = blocks(it.tokens.filter((x) => x.type !== "checkbox"), c, depth + 1, true);
        if (!it.task) return `<li dir="auto">${body}</li>`;
        return `<li class="task" dir="auto"><input type="checkbox" disabled${it.checked ? " checked" : ""}> ${body}</li>`;
      })
      .join("");
    const start = l.ordered && l.start !== "" && l.start !== 1 ? ` start="${Number(l.start) || 1}"` : "";
    // No dir on the list itself: dir=auto skips children that have their own dir, so it would always
    // resolve LTR. Each item carries its direction, and the CSS indents each item on its own start side.
    return l.ordered ? `<ol${start}>${items}</ol>` : `<ul>${items}</ul>`;
  }
  const pad = "  ".repeat(depth);
  return l.items
    .map((it, i) => {
      const mark = it.task ? (it.checked ? "☑ " : "☐ ") : "";
      const bullet = l.ordered ? `${(Number(l.start) || 1) + i}. ` : "• ";
      return `${pad}${bullet}${mark}${blocks(it.tokens.filter((x) => x.type !== "checkbox"), c, depth + 1, true)}`;
    })
    .join("\n");
}

/** Render block tokens. `tight` = inside a list item (paragraphs without <p>). */
function blocks(tokens: Token[], c: Ctx, depth = 0, tight = false): string {
  let out = "";
  for (const t of tokens) {
    out += block(t, c, depth, tight);
    // The compact target keeps the source's line breaks between blocks; the web uses block elements.
    if (!c.web && t.type !== "space") out += (/\n*$/.exec(t.raw)?.[0] ?? "");
  }
  return out;
}

function block(t: Token, c: Ctx, depth: number, tight: boolean): string {
  switch (t.type) {
    case "space":
      return c.web ? "" : t.raw.replace(/[^\n]/g, "");
    case "code": {
      const code = (t as Tokens.Code).text;
      if (!c.web) return `<pre>${esc(code)}</pre>`;
      return codeBlock(code, fenceLang((t as Tokens.Code).lang));
    }
    case "heading": {
      const h = t as Tokens.Heading;
      // A line over "---"/"===" (setext) is how workers draw a separator, not a heading: a line + a rule.
      if (!/^ {0,3}#/.test(h.raw)) return c.web ? `<p dir="auto">${inline(h.tokens, c)}</p><hr>` : `${inline(h.tokens, c)}\n———`;
      if (!c.web) return `<b>${inline(h.tokens, c)}</b>`;
      const level = Math.min(h.depth + 2, 6);
      return `<h${level} class="mh" dir="auto">${inline(h.tokens, c)}</h${level}>`;
    }
    case "table":
      return c.web ? tableWeb(t as Tokens.Table, c) : tableCompact(t as Tokens.Table, c);
    case "hr":
      return c.web ? "<hr>" : "———";
    case "blockquote": {
      const inner = blocks((t as Tokens.Blockquote).tokens, c, depth).replace(/\n+$/, "");
      return c.web ? `<blockquote dir="auto">${inner}</blockquote>` : `<blockquote>${inner}</blockquote>`;
    }
    case "list":
      return listItems(t as Tokens.List, c, depth);
    case "paragraph": {
      const body = inline((t as Tokens.Paragraph).tokens, c);
      return c.web ? paragraphWeb(body, tight) : body;
    }
    case "text": {
      const x = t as Tokens.Text;
      return x.tokens?.length ? inline(x.tokens, c) : textOut(x.text, c);
    }
    case "def":
      return "";
    case "html":
    default: {
      const raw = t.raw.replace(/\n+$/, "");
      return c.web ? `<p dir="auto">${textOut(raw, c)}</p>` : esc(raw);
    }
  }
}

const VOID_TAG = new Set(["br", "hr", "input", "img", "wbr"]);

/** Split rendered inline HTML at its top-level <br>s. A <br> inside a tag (bold over two lines) stays,
 *  so no element is ever cut in half. The HTML is ours (well-formed), so a tag scan is exact. */
function topLevelLines(html: string): string[] {
  const lines: string[] = [];
  let depth = 0;
  let from = 0;
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>/g)) {
    const name = m[2]!;
    if (name === "br" && depth === 0) {
      lines.push(html.slice(from, m.index));
      from = m.index! + m[0].length;
    } else if (!VOID_TAG.has(name)) depth += m[1] ? -1 : 1;
  }
  lines.push(html.slice(from));
  return lines;
}

/** A web paragraph takes its own direction (dir=auto), and so does each of its lines: an Arabic line
 *  runs right-to-left and the English line under it left-to-right (ADR-0033). */
function paragraphWeb(body: string, tight: boolean): string {
  const lines = topLevelLines(body);
  if (lines.length > 1) return `<div class="lines">${lines.map((l) => `<div dir="auto">${l || "<br>"}</div>`).join("")}</div>`;
  return tight ? body : `<p dir="auto">${body}</p>`;
}

/** A code block for the web console: whitespace kept, the language for the browser's highlighter. */
export function codeBlock(code: string, lang = "", extraClass = ""): string {
  return `<pre class="code${extraClass ? ` ${extraClass}` : ""}" data-lang="${attr(lang)}"><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
}

export function mdToHtml(md: string, opts: MdOptions = {}): string {
  const c: Ctx = { web: opts.target === "web", tablesPre: opts.tables === "pre", rtl: RTL_SCRIPT.test(md) };
  const tokens = new Lexer({ gfm: true, breaks: c.web, tokenizer: new NoUnderscoreEmphasis() }).lex(md);
  const out = blocks(tokens, c);
  if (!c.web) return out.replace(/\n+$/, "");
  // A one-paragraph line (most feed lines) needs no block wrapper.
  const one = /^<p dir="auto">((?:(?!<p[ >]|<\/p>)[\s\S])*)<\/p>$/.exec(out);
  return one ? one[1]! : out;
}

/** Telegram's Bot API `sendMessage` hard-caps text at 4096 chars (verified empirically — 4097
 *  returns 400 "message is too long"; rich formatting does NOT raise it, entities count toward it).
 *  A message over this is REJECTED, not truncated — so long reports must be split, or Telegram
 *  drops them silently. This is the real ceiling for how Neo sends (not the 32k client long-post). */
export const TELEGRAM_MAX = 4096;

/** Source-text budget per chunk BEFORE HTML rendering. Kept well under TELEGRAM_MAX so that after
 *  mdToHtml expansion (bold/entities/table<pre>) + the project tag, the rendered chunk still fits;
 *  deliverChunked re-checks the rendered length and hard-splits to plain text if a chunk still
 *  overflows, so delivery is guaranteed regardless. */
const SRC_BUDGET = 3500;

/** Split text into pieces each no longer than `max` chars, breaking on newline boundaries where
 *  possible and hard-splitting any single line that is itself longer than `max`. Order-preserving.
 *  Pure — the core guarantee the Telegram sender relies on so long output is chunked, never dropped. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length) out.push(buf);
    buf = "";
  };
  for (const line of text.split("\n")) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
      continue;
    }
    const candidate = buf ? `${buf}\n${line}` : line;
    if (candidate.length > max) {
      flush();
      buf = line;
    } else {
      buf = candidate;
    }
  }
  flush();
  return out.length ? out : [""];
}

/** Table-aware source splitter for the Telegram path. Like chunkText it splits `text` into pieces
 *  each no longer than `max` chars, EXCEPT it never orphans a Markdown table's body rows from the
 *  header+separator rows that mdToHtml needs to detect a table. A table small enough stays whole
 *  (with its surrounding prose in the same chunk); a table too big to fit is split on ROW boundaries
 *  with the header+separator re-emitted at the top of each piece — so every chunk renders as an
 *  aligned <pre> table instead of leaking raw pipes when a long report is chunked. Order-preserving,
 *  lossless; plain (non-table) text splits on newline boundaries exactly like chunkText. */
export function chunkMarkdown(text: string, max: number): string[] {
  const src = text.split("\n");
  const out: string[] = [];
  let buf: string[] = [];
  const joined = (lines: string[]) => lines.join("\n");
  const flush = () => {
    if (buf.length) out.push(joined(buf));
    buf = [];
  };
  const fitsWith = (extra: string[]) => joined([...buf, ...extra]).length <= max;

  for (let i = 0; i < src.length; ) {
    const line = src[i];
    // A table block: header row + an adjacent separator row (the same detection mdToHtml uses).
    if (line.includes("|") && i + 1 < src.length && isSeparator(src[i + 1])) {
      const header = line;
      const sep = src[i + 1];
      const rows: string[] = [];
      i += 2; // consume header + separator
      while (i < src.length && src[i].includes("|") && src[i].trim() !== "") rows.push(src[i++]);

      const whole = [header, sep, ...rows];
      if (!fitsWith(whole)) flush(); // this table can't share the current chunk → start it fresh
      if (joined(whole).length <= max) {
        buf.push(...whole); // the whole table fits in this chunk — keep it together
      } else {
        // Too big even alone → split on row boundaries, repeating header+separator on every piece
        // so each piece is independently detectable as a table (buf is empty here after the flush).
        let r = 0;
        while (r < rows.length) {
          const piece = [header, sep];
          while (r < rows.length && joined([...piece, rows[r]]).length <= max) piece.push(rows[r++]);
          if (piece.length === 2) piece.push(rows[r++]); // one row wider than max — emit it anyway
          out.push(joined(piece));
        }
      }
      continue;
    }

    // A plain line: hard-split if it alone exceeds max, else pack it on newline boundaries.
    if (line.length > max) {
      flush();
      for (let j = 0; j < line.length; j += max) out.push(line.slice(j, j + max));
      i++;
      continue;
    }
    if (!fitsWith([line])) flush();
    buf.push(line);
    i++;
  }
  flush();
  return out.length ? out : [""];
}

export interface ChunkSendResult {
  ok: boolean;
  id?: number;
}
/** Sends one message body; `html` says whether to request parse_mode HTML. Returns whether Telegram
 *  accepted it (+ the message id when known). Implemented by each surface over its own transport. */
export type ChunkSender = (body: string, html: boolean) => Promise<ChunkSendResult>;

/** Deliver possibly-long text as one or MORE Telegram messages, never dropping it. Each chunk is
 *  sent as rich HTML; if Telegram rejects the markup or the rendered chunk still exceeds TELEGRAM_MAX,
 *  it falls back to plain text hard-split to the limit. `tag` (e.g. "#project ") is prepended to the
 *  FIRST chunk only. Returns the first delivered message id (for reply routing). This replaces the
 *  old single-shot send that silently dropped any report over 4096 chars (long/table-heavy ones).
 *  Chunking is table-aware (chunkMarkdown): a Markdown table is kept whole where it fits, or split
 *  on row boundaries with its header+separator repeated, so a long table renders as an aligned
 *  <pre> in EVERY chunk instead of leaking raw pipes when the header row lands in a prior chunk. */
export async function deliverChunked(send: ChunkSender, text: string, tag = ""): Promise<number | undefined> {
  const chunks = chunkMarkdown(text, SRC_BUDGET);
  let firstId: number | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const prefix = i === 0 ? tag : "";
    const html = prefix + mdToHtml(chunks[i], { tables: "pre" });
    let result: ChunkSendResult = { ok: false };
    if (html.length <= TELEGRAM_MAX) result = await send(html, true);
    if (result.ok) {
      if (firstId === undefined) firstId = result.id;
      continue;
    }
    // markup rejected, or rendered chunk still too long → plain text, hard-split to the hard limit
    for (const piece of chunkText(prefix + chunks[i], TELEGRAM_MAX)) {
      const r = await send(piece, false);
      if (r.ok && firstId === undefined) firstId = r.id;
    }
  }
  return firstId;
}
