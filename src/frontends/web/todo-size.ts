// The console's order-size marks (ADR-0072, spec §8): the size chip of a todo row and of the threads view's
// todo line, and the todo sheet's Size row with the reason of the latest move up. Pure render functions over
// the page's helpers (`Fmt`, as the History tab), so they are unit-tested. Every word comes from the
// catalogues; numbers, paths, commands and a project's own rule names are LTR isolates.
import { DEFAULT_SIZES_CFG, isOrderSize, type OrderSize, type SizeBy, type SizeUp } from "../../engine/order-size";
import type { Fmt } from "./history";

/** The reason templates (`todoDetail.sizeUp.<kind>`): the limits, a rule by path or by command, a plan, a handoff. */
export const SIZE_UP_KINDS = ["files", "lines", "services", "rule", "command", "plan", "handoff"] as const;
type SizeUpKind = (typeof SIZE_UP_KINDS)[number];

/** The rule names with an area text (`todoDetail.area.<name>`): the engine's default rules. */
const AREAS = new Set(DEFAULT_SIZES_CFG.guard.rules.map((r) => r.name));

const SETTERS: readonly SizeBy[] = ["operator", "company", "engine"];

interface Sized {
  size?: OrderSize;
  sizeBy?: SizeBy;
  sizeUp?: SizeUp;
}

/** The size chip, with ` ↑` and a title naming the first size after a move up. No size: no chip. */
export function sizeChipHtml(x: Sized, f: Fmt): string {
  if (!isOrderSize(x.size)) return "";
  const up = x.sizeUp && isOrderSize(x.sizeUp.from) ? x.sizeUp : undefined;
  const title = up ? ` title="${f.esc(f.tx("queue.sizeMoved", { from: f.tx(`queue.size.${up.from}`) }))}"` : "";
  return `<span class="tchip sz sz-${x.size}"${title}>${f.esc(f.tx(`queue.size.${x.size}`))}${up ? " ↑" : ""}</span>`;
}

function kindOf(up: SizeUp): SizeUpKind {
  if ((SIZE_UP_KINDS as readonly string[]).includes(up.rule) && up.rule !== "rule" && up.rule !== "command") return up.rule as SizeUpKind;
  return up.command ? "command" : "rule";
}

/** Why the order moved up, from the catalogue's template for its kind (markup). */
export function sizeUpHtml(up: SizeUp, f: Fmt): string {
  const kind = kindOf(up);
  const area = AREAS.has(up.rule) ? f.esc(f.tx(`todoDetail.area.${up.rule}`)) : f.ltr(up.rule);
  const line = f.tx(`todoDetail.sizeUp.${kind}`, {
    from: f.esc(f.tx(`queue.size.${isOrderSize(up.from) ? up.from : "big"}`)),
    value: f.ltr(up.value ?? ""),
    max: f.ltr(up.max ?? ""),
    area,
    path: f.ltr(up.path ?? ""),
    command: f.ltr(up.command ?? ""),
  });
  return up.late ? `${line} ${f.esc(f.tx("todoDetail.sizeUp.late"))}` : line;
}

/** The sheet's Size row: the chip · who set it, then the reason line when the order moved up. */
export function sizeRowHtml(d: Sized, f: Fmt): string {
  const by = d.sizeBy && SETTERS.includes(d.sizeBy) ? ` · ${f.esc(f.tx(`todoDetail.sizeBy.${d.sizeBy}`))}` : "";
  const up = d.sizeUp ? `<div class="szup" dir="auto">${sizeUpHtml(d.sizeUp, f)}</div>` : "";
  return `${sizeChipHtml(d, f)}${by}${up}`;
}
