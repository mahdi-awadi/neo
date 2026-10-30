// ADR-0071 end to end, in a real browser at a phone's size: a pin's Open lands on the item, where it can be
// answered by typing; a plan pin shows the plan, rendered, with a Download link, before Approve or Drop.
// Runs the real console (tools/console-demo) on 127.0.0.1 with Chromium from the local Playwright cache;
// skipped when that browser is not installed. NEO_SHOTS_DIR=<dir> also saves the screenshots.
import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { startConsoleDemo, type ConsoleDemo } from "../tools/console-demo/demo";

const exe = chromium.executablePath();
const run = existsSync(exe);
const SHOTS = process.env.NEO_SHOTS_DIR;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let demo: ConsoleDemo;
let browser: Browser;

beforeAll(async () => {
  if (run) browser = await chromium.launch({ executablePath: exe });
});
afterAll(async () => {
  await browser?.close();
});
// Each test gets its own console and ledger: an answered or dropped item never leaks into the next one.
beforeEach(() => {
  if (run) demo = startConsoleDemo(0);
});
afterEach(() => demo?.stop());

async function phone(lang: "en" | "ar" = "en"): Promise<Page> {
  const page = await browser.newPage({ ...PHONE, locale: lang });
  await page.goto(demo.loginUrl);
  if (lang === "ar") await page.evaluate(() => (document.cookie = "neo_lang=ar; path=/"));
  if (lang === "ar") await page.reload();
  await page.locator("#pins .pinr").first().waitFor();
  return page;
}
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
const row = (page: Page, text: string) => page.locator("#pins .pinr", { hasText: text });

test.skipIf(!run)(
  "Open on the stale reminder lands on the question; the operator types an answer and the pin goes",
  async () => {
    const page = await phone();
    await shot(page, "pins-strip-390");
    await row(page, "Should I write a plan").locator(".pinact").click();
    const sheet = page.locator("#tdsheet");
    await expect(sheet.isVisible()).resolves.toBe(true);
    // The full question, never cut, and the decision it is about.
    await expect(sheet.locator("h2", { hasText: "Should I write a plan to cut the memory each Neo worker uses for browser tools?" }).count()).resolves.toBe(1);
    const box = sheet.locator("textarea#itans");
    await box.tap();
    await box.fill("Yes — write the plan, keep the shared browser under 1 GB.");
    await expect(box.evaluate((el) => el === document.activeElement)).resolves.toBe(true);
    // Nothing covers the box: it is inside the viewport and it is the element at its own centre.
    const b = (await box.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(844);
    await expect(page.evaluate(([x, y]) => (document.elementFromPoint(x!, y!) as HTMLElement | null)?.id, [b.x + b.width / 2, b.y + b.height / 2])).resolves.toBe("itans");
    await shot(page, "pins-answer-typed-390");
    await sheet.locator("form.ireply button[type=submit]").tap();
    await page.waitForFunction(() => !(document.getElementById("tdsheet") as HTMLDialogElement).open);
    expect(demo.ledger.decisionById(demo.ids.hidden)).toMatchObject({ status: "answered", answer: "Yes — write the plan, keep the shared browser under 1 GB." });
    await page.waitForFunction(() => ![...document.querySelectorAll("#pins .pinr")].some((r) => r.textContent?.includes("Should I write a plan")));
    await page.close();
  },
  60_000,
);

test.skipIf(!run)(
  "a decision with options is answered with one tap",
  async () => {
    const page = await phone();
    await row(page, "Which payment provider").locator(".pinact").click();
    const sheet = page.locator("#tdsheet");
    await sheet.locator("button", { hasText: "ZainCash" }).tap();
    await page.waitForFunction(() => !(document.getElementById("tdsheet") as HTMLDialogElement).open);
    expect(demo.ledger.decisionById(demo.ids.options)).toMatchObject({ status: "answered", answer: "ZainCash" });
    await page.close();
  },
  60_000,
);

test.skipIf(!run)(
  "Review on a plan pin shows the plan rendered and readable, a Download link, and Approve & build / Drop",
  async () => {
    const page = await phone();
    const review = row(page, "Plan waiting for your approval").locator(".pinact");
    await expect(review.textContent()).resolves.toBe("Review");
    await review.click();
    const sheet = page.locator("#tdsheet");
    await sheet.locator(".plandoc h3.mh").first().waitFor();
    await expect(sheet.locator(".plandoc").textContent()).resolves.toContain("one shared browser per host");
    // Raw HTML in the file is text, never markup.
    await expect(sheet.locator(".plandoc script").count()).resolves.toBe(0);
    // Readable on a phone: no sideways scroll of the sheet (a table or code block scrolls on its own).
    await expect(sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).resolves.toBe(true);
    const dl = sheet.locator("a.mdl[download]");
    await expect(dl.getAttribute("href")).resolves.toContain("/md-file?path=");
    await shot(page, "plan-review-390");
    // Download is the same file, through the same endpoint and checks.
    const got = await dl.evaluate((a) => fetch((a as HTMLAnchorElement).href).then(async (r) => ({ status: r.status, disposition: r.headers.get("content-disposition"), text: await r.text() })));
    expect(got.status).toBe(200);
    expect(got.disposition).toContain("attachment");
    expect(got.text).toContain("# Plan: cut the memory");
    await expect(sheet.locator(".acts.stick button", { hasText: "Approve & build" }).count()).resolves.toBe(1);
    await sheet.locator(".plandoc").evaluate((el) => el.scrollIntoView({ block: "end" }));
    await shot(page, "plan-review-actions-390");
    page.once("dialog", (d) => void d.accept());
    await sheet.locator(".acts.stick button", { hasText: "Drop" }).tap();
    await page.waitForFunction(() => !(document.getElementById("tdsheet") as HTMLDialogElement).open);
    expect(demo.ledger.planById(demo.ids.planId)!.status).toBe("abandoned");
    await page.close();
  },
  60_000,
);

test.skipIf(!run)(
  "Arabic (RTL): the opened item reads right-to-left, its labels are Arabic, and numbers stay left-to-right",
  async () => {
    const page = await phone("ar");
    await expect(page.evaluate(() => document.documentElement.dir)).resolves.toBe("rtl");
    const review = row(page, "Plan waiting for your approval").locator(".pinact");
    await expect(review.textContent()).resolves.toBe("مراجعة");
    await review.click();
    const sheet = page.locator("#tdsheet");
    await sheet.locator(".plandoc h3.mh").first().waitFor();
    await expect(sheet.locator("a.mdl[download]").textContent()).resolves.toBe("تنزيل ملف .md");
    // The version is an LTR run inside the Arabic line.
    await expect(sheet.locator("bdi[dir=ltr], [dir=ltr]", { hasText: "v1" }).count()).resolves.toBeGreaterThan(0);
    await shot(page, "plan-review-ar-390");
    await page.close();
  },
  60_000,
);
