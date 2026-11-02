// The composer's staged attachments (ADR-0026). Attaching uploads at once and shows a chip; the files
// travel with the next Send as ONE message (the /msg body carries their tokens). This model holds the
// chips' state and the Send rule; app.ts draws the chips and runs the uploads. Pure, so it is unit-tested.

export type AttachmentState = "uploading" | "ready" | "failed";

export interface Attachment {
  id: number;
  name: string;
  size: number;
  state: AttachmentState;
  /** Upload progress, a whole percent. */
  progress: number;
  /** The server's one-shot token, once the upload is staged. */
  token?: string;
}

/** The /msg request body. */
export interface SendBody {
  text: string;
  threadId?: number;
  attachments?: string[];
}

export interface Attachments {
  add(name: string, size: number): number;
  get(id: number): Attachment | undefined;
  list(): Attachment[];
  progress(id: number, loaded: number, total: number): void;
  ready(id: number, token: string): void;
  fail(id: number): void;
  /** Upload a failed file again: back to uploading, from zero. */
  retry(id: number): void;
  /** Take a chip out. Returns it (its token is discarded on the server), or undefined if unknown. */
  remove(id: number): Attachment | undefined;
  /** Send is allowed when no upload is running or failed and there is text or a ready file. */
  canSend(text: string): boolean;
  body(text: string, threadId?: number): SendBody;
  clear(): void;
}

export function createAttachments(): Attachments {
  const items = new Map<number, Attachment>();
  let seq = 0;
  const set = (id: number, patch: Partial<Attachment>) => {
    const a = items.get(id);
    if (a) items.set(id, { ...a, ...patch });
  };
  const list = () => [...items.values()];
  return {
    add(name, size) {
      const id = ++seq;
      items.set(id, { id, name, size, state: "uploading", progress: 0 });
      return id;
    },
    get: (id) => items.get(id),
    list,
    progress: (id, loaded, total) => set(id, { progress: total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0 }),
    ready: (id, token) => set(id, { state: "ready", progress: 100, token }),
    fail: (id) => set(id, { state: "failed" }),
    retry: (id) => set(id, { state: "uploading", progress: 0, token: undefined }),
    remove(id) {
      const a = items.get(id);
      items.delete(id);
      return a;
    },
    canSend(text) {
      const all = list();
      if (all.some((a) => a.state !== "ready")) return false;
      return text.trim() !== "" || all.length > 0;
    },
    body(text, threadId) {
      const tokens = list().flatMap((a) => (a.state === "ready" && a.token ? [a.token] : []));
      return { text: text.trim(), ...(threadId === undefined ? {} : { threadId }), ...(tokens.length ? { attachments: tokens } : {}) };
    },
    clear: () => items.clear(),
  };
}

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

/** A file size in the console's locale (`locale` is app.ts LOCALE): 512 bytes, 1.5 kB, 5 MB. */
export function formatSize(bytes: number, locale: string): string {
  let v = Math.max(0, bytes);
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  // Bytes take the long name: the short one reads "512 byte".
  return new Intl.NumberFormat(locale, { style: "unit", unit: UNITS[u], unitDisplay: u === 0 ? "long" : "short", maximumFractionDigits: 1 }).format(v);
}
