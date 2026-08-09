import { describe, expect, test } from "bun:test";
import { chunkText, deliverChunked, TELEGRAM_MAX, type ChunkSendResult } from "../src/engine/format";

describe("chunkText", () => {
  test("short text is returned as a single chunk", () => {
    expect(chunkText("hello", TELEGRAM_MAX)).toEqual(["hello"]);
  });

  test("every chunk stays within the limit", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const chunks = chunkText(big, TELEGRAM_MAX);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX);
  });

  test("breaks on line boundaries — no line is cut when it fits", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `row-${i}`);
    const chunks = chunkText(lines.join("\n"), 100);
    for (const c of chunks) for (const l of c.split("\n")) expect(l).toMatch(/^row-\d+$/);
    expect(chunks.join("\n").split("\n")).toEqual(lines); // reconstructs in order
  });

  test("a single over-long line is hard-split", () => {
    const chunks = chunkText("A".repeat(10000), TELEGRAM_MAX);
    expect(chunks.length).toBe(3); // 4096 + 4096 + 1808
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(chunks.join("")).toBe("A".repeat(10000));
  });
});

describe("deliverChunked", () => {
  // Fake sender that simulates Telegram's real 4096 hard limit: a body over the cap is rejected.
  const makeSender = () => {
    const sent: { body: string; html: boolean }[] = [];
    let nextId = 100;
    const send = async (body: string, html: boolean): Promise<ChunkSendResult> => {
      if (body.length > TELEGRAM_MAX) return { ok: false }; // Telegram 400 "message is too long"
      sent.push({ body, html });
      return { ok: true, id: nextId++ };
    };
    return { send, sent };
  };

  test("a long table-heavy report is delivered in multiple ordered messages — nothing dropped", async () => {
    // ~10k chars incl. a markdown table — the exact shape that used to be silently dropped.
    const table = ["| ref | amount |", "| --- | --- |", ...Array.from({ length: 200 }, (_, i) => `| 10N${i} | ${i * 1000} IQD |`)].join("\n");
    const report = `**Bookings report**\n\n${table}\n\n${"detail ".repeat(300)}`;
    expect(report.length).toBeGreaterThan(TELEGRAM_MAX);

    const { send, sent } = makeSender();
    const firstId = await deliverChunked(send, report, "#eticket_v3 ");

    expect(sent.length).toBeGreaterThan(1); // split, not dropped
    for (const m of sent) expect(m.body.length).toBeLessThanOrEqual(TELEGRAM_MAX); // every send fits
    expect(sent[0].body.startsWith("#eticket_v3 ")).toBe(true); // tag on the first chunk only
    expect(firstId).toBe(100);
  });

  test("falls back to plain text when the markup is rejected", async () => {
    const attempts: boolean[] = [];
    const send = async (body: string, html: boolean): Promise<ChunkSendResult> => {
      attempts.push(html);
      if (html) return { ok: false }; // simulate Telegram rejecting the HTML entities
      return { ok: true, id: 1 };
    };
    const id = await deliverChunked(send, "some **rich** text", "");
    expect(attempts).toEqual([true, false]); // tried HTML, then plain
    expect(id).toBe(1);
  });

  test("short message sends once as HTML", async () => {
    const { send, sent } = makeSender();
    await deliverChunked(send, "hi there", "#p ");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ body: "#p hi there", html: true });
  });
});
