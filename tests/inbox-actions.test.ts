import { test, expect } from "bun:test";
import { openInbox } from "../src/engine/inbox";
import { renderInboxList, renderInboxItem, shortId, buildDraftBrief, draftInboxReply, replySubject, sendInboxReply } from "../src/engine/inbox-actions";
import { createRegistry } from "../src/engine/registry";
import { openLedger } from "../src/engine/ledger";
import { createMeter } from "../src/engine/budget";
import { openTrustStore } from "../src/engine/trust";
import { registerDefaultProject } from "../src/engine/default-project";
import type { Order } from "../src/types";
import type { RunHandlers, RunResult } from "../src/engine/session-runner";

/** A brief-deps bundle whose fake run captures the order.task (= the brief) and returns a draft. */
function briefHarness(draft: string) {
  const registry = createRegistry();
  const ledger = openLedger(":memory:");
  registerDefaultProject(registry, ledger, () => 1);
  let seenBrief = "";
  const fakeRun = async (o: Order, _h: RunHandlers): Promise<RunResult> => {
    seenBrief = o.task;
    return { ok: true, sessionId: "co-1", summary: draft, costUsd: 0.01 };
  };
  return {
    seen: () => seenBrief,
    deps: {
      cfg: {} as never, ledger, registry,
      meter: createMeter({ windowBudgetUsd: 100, reservePct: 0.2 }),
      trust: openTrustStore(":memory:"),
      reply: () => {},
      askApproval: async () => "deny" as const,
      run: fakeRun as never,
      now: () => 2,
    },
  };
}

test("renderInboxList lists items newest-first with status + from/subject + short id (no AI)", () => {
  const ib = openInbox(":memory:");
  const a = ib.record({ from: "a@x.com", fromName: "Ann", subject: "Quote?", text: "How much?" }, 1000);
  const b = ib.record({ from: "b@x.com", subject: "Refund", text: "Please refund" }, 2000);

  const out = renderInboxList(ib);
  // newest first
  const lines = out.text.split("\n");
  const idxB = lines.findIndex((l) => l.includes("Refund"));
  const idxA = lines.findIndex((l) => l.includes("Quote?"));
  expect(idxB).toBeGreaterThan(-1);
  expect(idxA).toBeGreaterThan(idxB); // a (older) listed after b (newer)
  expect(out.text).toContain("new"); // status shown
  expect(out.text).toContain("Ann"); // fromName shown
  expect(out.text).toContain(shortId(a.id)); // short id shown

  // tappable entries, newest-first, carrying the real id
  expect(out.items.map((i) => i.id)).toEqual([b.id, a.id]);
  expect(out.items[0].label).toContain("Refund");
});

test("renderInboxList reports an empty inbox", () => {
  const ib = openInbox(":memory:");
  expect(renderInboxList(ib).items).toEqual([]);
  expect(renderInboxList(ib).text.toLowerCase()).toContain("empty");
});

test("renderInboxItem shows full body + sender; unknown id returns undefined", () => {
  const ib = openInbox(":memory:");
  const x = ib.record({ from: "c@x.com", fromName: "Cal", subject: "Hi", text: "the full message body here" });

  const view = renderInboxItem(ib, x.id)!;
  expect(view.text).toContain("Cal");
  expect(view.text).toContain("c@x.com");
  expect(view.text).toContain("Hi");
  expect(view.text).toContain("the full message body here");
  expect(view.item.id).toBe(x.id);

  expect(renderInboxItem(ib, "nope")).toBeUndefined();
});

test("renderInboxItem includes the stored draft once drafted", () => {
  const ib = openInbox(":memory:");
  const x = ib.record({ from: "d@x.com", subject: "S", text: "body" });
  ib.setDraft(x.id, "Hi — thanks for reaching out.");
  expect(renderInboxItem(ib, x.id)!.text).toContain("Hi — thanks for reaching out.");
});

test("buildDraftBrief matches the web path: opening line, sender/subject/body, instructions, prior draft", () => {
  const ib = openInbox(":memory:");
  const item = ib.record({ from: "a@x.com", fromName: "Ann", subject: "Quote?", text: "How much for 10 units?" });
  // base brief
  const base = buildDraftBrief(ib.get(item.id)!);
  expect(base).toContain("A customer emailed the business.");
  expect(base).toContain("Output ONLY the reply body");
  expect(base).toContain("From: Ann <a@x.com>");
  expect(base).toContain("Subject: Quote?");
  expect(base).toContain("How much for 10 units?");
  expect(base).not.toContain("Neo's instructions");
  // a one-shot EMAIL, not a chat: never ask the customer questions back; answer + brief us + a CTA
  expect(base).toContain("do NOT ask the customer follow-up questions");
  expect(base).toContain("what we do");
  expect(base).toContain("book a short meeting");
  // no booking link configured → graceful fallback (no dead link, still a clear next step)
  expect(base).toContain("propose two or three times");
  // with a booking link → the email points them at it to pick a time
  const linked = buildDraftBrief(ib.get(item.id)!, "", "https://cal.com/mahdi");
  expect(linked).toContain("https://cal.com/mahdi");
  expect(linked).not.toContain("propose two or three times");
  // with instructions + a prior draft to revise
  ib.setDraft(item.id, "Old draft text");
  const revised = buildDraftBrief(ib.get(item.id)!, "be warmer, offer a discount");
  expect(revised).toContain("Neo's instructions for this reply: be warmer, offer a discount");
  expect(revised).toContain("Old draft text");
});

test("draftInboxReply runs the company, stores the draft, and lands the item in 'drafted'", async () => {
  const ib = openInbox(":memory:");
  const item = ib.record({ from: "a@x.com", fromName: "Ann", subject: "Quote?", text: "How much?" });
  const h = briefHarness("Hi Ann — happy to help, it's $20/unit.");

  const draft = await draftInboxReply(ib, item.id, "", h.deps);

  expect(draft).toBe("Hi Ann — happy to help, it's $20/unit.");
  expect(h.seen()).toContain("How much?"); // the company received the real brief
  const after = ib.get(item.id)!;
  expect(after.draft).toBe("Hi Ann — happy to help, it's $20/unit.");
  expect(after.status).toBe("drafted");
});

test("draftInboxReply returns undefined for an unknown id", async () => {
  const ib = openInbox(":memory:");
  expect(await draftInboxReply(ib, "nope", "", briefHarness("x").deps)).toBeUndefined();
});

test("replySubject prefixes Re: once and falls back when absent", () => {
  const ib = openInbox(":memory:");
  expect(replySubject(ib.record({ from: "a@x", subject: "Quote?" }))).toBe("Re: Quote?");
  expect(replySubject(ib.record({ from: "a@x", subject: "Re: Quote?" }))).toBe("Re: Quote?"); // not doubled
  expect(replySubject(ib.record({ from: "a@x", subject: "" }))).toBe("Re:");
});

test("sendInboxReply posts the reply to the gateway and marks the item 'replied'", async () => {
  const ib = openInbox(":memory:");
  const item = ib.record({ from: "a@x.com", subject: "Quote?", text: "?", messageId: "<orig>" });
  let seen: any = null;
  const fakeFetch = async (url: any, init: any) => {
    seen = { url, init, body: JSON.parse(init.body), auth: init.headers.authorization };
    return { ok: true } as Response;
  };
  const ok = await sendInboxReply(ib, item.id, "  Here is your quote: $20  ", { url: "https://gw/send", secret: "sek" }, fakeFetch as any);

  expect(ok).toBe(true);
  expect(seen.url).toBe("https://gw/send");
  expect(seen.auth).toBe("Bearer sek");
  expect(seen.body).toEqual({ to: "a@x.com", subject: "Re: Quote?", text: "Here is your quote: $20", inReplyTo: "<orig>" });
  expect(ib.get(item.id)!.status).toBe("replied");
});

test("sendInboxReply leaves status untouched on a gateway failure or empty/unknown input", async () => {
  const ib = openInbox(":memory:");
  const item = ib.record({ from: "a@x.com", subject: "S", text: "?" });
  ib.setDraft(item.id, "d"); // status 'drafted'
  const failFetch = async () => ({ ok: false }) as Response;

  expect(await sendInboxReply(ib, item.id, "hi", { url: "u", secret: "s" }, failFetch as any)).toBe(false);
  expect(ib.get(item.id)!.status).toBe("drafted"); // unchanged on failure
  expect(await sendInboxReply(ib, item.id, "   ", { url: "u", secret: "s" }, failFetch as any)).toBe(false); // empty reply
  expect(await sendInboxReply(ib, "nope", "hi", { url: "u", secret: "s" }, failFetch as any)).toBe(false); // unknown id
});
