// Render the PWA PNG icons from the Core "o" mark (src/frontends/web/icons/favicon.svg, ADR-0056) with
// headless Chrome: the mark on the brand tile (BRAND.logoTile = the manifest background, so the native
// launch splash has no seam). Run: `bun tools/brand/render-icons.ts` (CHROME_BIN overrides the browser).
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BRAND, ICONS } from "../../src/frontends/web/brand";

/** The mark's share of the tile: "any" icons and the Apple icon, and the maskable one (inside the
 *  80% safe zone the launcher may crop to a circle). */
export const ICON_MARK_RATIO = { any: 0.62, maskable: 0.46 } as const;

const WEB = join(import.meta.dir, "../../src/frontends/web");

/** One icon as a page: the SVG mark, centred on the tile. The mark's own `<style>` sets its ink for a
 *  light page; the tile is dark, so the ink is set here to the light one. */
export function iconPage(size: number, ratio: number, svg: string): string {
  const mark = Math.round(size * ratio);
  return (
    `<!doctype html><html><head><style>html,body{margin:0;width:${size}px;height:${size}px;background:${BRAND.logoTile};overflow:hidden}` +
    `svg{position:absolute;left:50%;top:50%;width:${mark}px;height:${mark}px;transform:translate(-50%,-50%);color:#f1f1ef!important}` +
    `</style></head><body>${svg.replace(/<style>[\s\S]*?<\/style>/, `<style>svg{--accent:${BRAND.logoAccent}}</style>`)}</body></html>`
  );
}

if (import.meta.main) {
  const chrome = process.env.CHROME_BIN ?? ["/opt/google/chrome/chrome", "/usr/bin/google-chrome"].find(existsSync);
  if (!chrome) throw new Error("no Chrome found — set CHROME_BIN");
  const svg = readFileSync(join(WEB, "icons", "favicon.svg"), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "neo-icons-"));
  for (const icon of ICONS) {
    if (!icon.file.endsWith(".png")) continue;
    const ratio = "purpose" in icon && icon.purpose === "maskable" ? ICON_MARK_RATIO.maskable : ICON_MARK_RATIO.any;
    const page = join(dir, `${icon.file}.html`);
    writeFileSync(page, iconPage(icon.size, ratio, svg));
    const out = join(WEB, "icons", icon.file);
    const r = spawnSync(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--window-size=${icon.size},${icon.size}`, `--screenshot=${out}`, `file://${page}`], { timeout: 60_000 });
    console.log(`${icon.file}: ${r.status === 0 ? "ok" : `failed (${r.status})`}`);
  }
}
