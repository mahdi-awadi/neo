// ADR-0072 end to end, in a real browser at a phone's size: the Queue tab shows each todo's size chip (a move
// up adds ↑ and a title), and a moved-up todo's sheet shows the Size row and why it moved — in English (LTR)
// and Arabic (RTL), with ids, paths and numbers left to right. Runs the real console (tools/console-demo) on
// 127.0.0.1 with Chromium from the local Playwright cache; skipped when that browser is not installed.
// NEO_SHOTS_DIR=<dir> also saves the screenshots.
import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { startConsoleDemo, type ConsoleDemo } from "../tools/console-demo/demo";

const exe = chromium.executablePath();
const run = existsSync(exe);
const SHOTS = process.env.NEO_SHOTS_DIR;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PATH = "ui/agency-ui/src/components/booking/PaymentMethodPicker.tsx";

let demo: ConsoleDemo;
let browser: Browser;

beforeAll(async () => {
  if (run) browser = await chromium.launch({ executablePath: exe });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(() => {
  if (run) demo = startConsoleDemo(0);
});
afterEach(() => demo?.stop());

async function queue(lang: "en" | "ar"): Promise<Page> {
  const page = await browser.newPage({ ...PHONE, locale: lang });
  await page.goto(demo.loginUrl);
  if (lang === "ar") await page.evaluate(() => (document.cookie = "neo_lang=ar; path=/"));
  if (lang === "ar") await page.reload();
  await page.locator(".tab[data-v=todos]").click();
  await page.locator("#vtodos .qrow").first().waitFor();
  return page;
}
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
const rowOf = (page: Page, id: number) => page.locator(`#vtodos .qrow[data-id="${id}"]`);
/** The computed direction of the LTR isolate holding `text` (a ref, a path, a number). */
const dirOf = (page: Page, scope: string, text: string) =>
  page.evaluate(([s, t]) => {
    const el = [...document.querySelectorAll(`${s} bdi[dir=ltr]`)].find((b) => b.textContent === t);
    return el ? getComputedStyle(el).direction : "missing";
  }, [scope, text] as const);

for (const lang of ["en", "ar"] as const) {
  const L = lang === "en"
    ? { quick: "quick", standard: "standard", big: "big ↑", title: "moved up from quick", by: "set by the chief of staff", why: "moved up from quick: it touches payments and money" }
    : { quick: "سريع", standard: "عادي", big: "كبير ↑", title: "رُفع من سريع", by: "حدّده مدير المكتب", why: "رُفع من سريع: يمسّ المدفوعات والمال" };

  test.skipIf(!run)(
    `${lang}: the Queue tab shows each size chip; the moved-up todo's sheet says why it moved, paths and ids LTR`,
    async () => {
      const page = await queue(lang);
      await expect(page.evaluate(() => document.documentElement.dir)).resolves.toBe(lang === "ar" ? "rtl" : "ltr");
      const { running, moved, quick } = demo.ids.todos;
      await expect(rowOf(page, quick).locator(".sz-quick").textContent()).resolves.toBe(L.quick);
      await expect(rowOf(page, running).locator(".sz-standard").textContent()).resolves.toBe(L.standard);
      const chip = rowOf(page, moved).locator(".sz-big");
      await expect(chip.textContent()).resolves.toBe(L.big);
      await expect(chip.getAttribute("title")).resolves.toBe(L.title);
      // The ids are LTR isolates in either direction.
      await expect(dirOf(page, "#vtodos", `#${moved}`)).resolves.toBe("ltr");
      // The project's queue card at the top of the screen, every row in view.
      await rowOf(page, running).evaluate((el) => el.closest(".card")!.scrollIntoView({ block: "start" }));
      await shot(page, `sizes-queue-${lang}-390`);

      await rowOf(page, moved).click();
      const sheet = page.locator("#tdsheet");
      await sheet.locator(".szup").waitFor();
      await expect(sheet.locator("dd", { has: page.locator(".sz-big") }).textContent()).resolves.toContain(L.by);
      await expect(sheet.locator(".szup").textContent()).resolves.toBe(`${L.why} (${PATH})`);
      await expect(dirOf(page, "#tdsheet", PATH)).resolves.toBe("ltr");
      await expect(dirOf(page, "#tdsheet", `#${moved}`)).resolves.toBe("ltr");
      // The position is a number: LTR too.
      await expect(dirOf(page, "#tdsheet", "1")).resolves.toBe("ltr");
      await shot(page, `sizes-sheet-${lang}-390`);
      await page.close();
    },
    60_000,
  );
}
