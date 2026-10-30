// A fake text-embeddings-inference server for the task history tests (ADR-0066): `Bun.serve` on
// 127.0.0.1, port 0. `/info` answers the model id and revision; `/embed` answers one vector per input
// (from `vectorOf`), checks the bearer key, and can be told to answer a status, hang, or refuse a batch
// larger than `maxBatch` with 413. It records each request (path, auth header, inputs).

export interface FakeTeiOpts {
  key: string;
  model?: string;
  revision?: string;
  dims?: number;
  /** A vector for one input; default: a vector of `dims` from the text's char codes. */
  vectorOf?: (text: string) => number[];
}

export interface FakeTei {
  readonly url: string;
  readonly port: number;
  info: { model_id: string; model_sha: string };
  /** Each `/embed` answers the next queued status (`hang` never answers); empty → 200. */
  queue: Array<number | "hang">;
  /** A batch with more inputs than this answers 413. */
  maxBatch: number;
  /** Override the vector length of every answer. */
  vectorLength?: number;
  retryAfter?: string;
  requests: Array<{ path: string; auth: string | null; inputs?: string[] }>;
  /** Stop answering (connection refused) / start again on the same port. */
  stop(): void;
  restart(): void;
}

export function startFakeTei(opts: FakeTeiOpts): FakeTei {
  const dims = opts.dims ?? 4;
  const vectorOf = opts.vectorOf ?? ((t: string) => Array.from({ length: dims }, (_, i) => ((t.charCodeAt(i % Math.max(1, t.length)) || 1) % 97) / 97));
  const hangs: Array<() => void> = [];
  const fake: FakeTei = {
    url: "",
    port: 0,
    info: { model_id: opts.model ?? "BAAI/bge-m3", model_sha: opts.revision ?? "5617a9f61b028005a4858fdac845db406aefb181" },
    queue: [],
    maxBatch: 1_000,
    requests: [],
    stop() {
      for (const h of hangs.splice(0)) h();
      server.stop(true);
    },
    restart() {
      server = serve(fake.port);
    },
  };
  const handler = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const auth = req.headers.get("authorization");
    let inputs: string[] | undefined;
    if (req.method === "POST") inputs = ((await req.json()) as { inputs: string[] }).inputs;
    fake.requests.push({ path, auth, ...(inputs ? { inputs } : {}) });
    if (auth !== `Bearer ${opts.key}`) return new Response("unauthorized", { status: 401 });
    if (path === "/info") return Response.json({ ...fake.info, model_type: { embedding: { pooling: "cls" } }, max_input_length: 8192 });
    if (path !== "/embed" || !inputs) return new Response("not found", { status: 404 });
    const next = fake.queue.shift();
    if (next === "hang") return new Promise<Response>((done) => hangs.push(() => done(new Response("gone", { status: 503 }))));
    if (typeof next === "number" && next !== 200) {
      return new Response("busy", { status: next, headers: fake.retryAfter ? { "retry-after": fake.retryAfter } : {} });
    }
    if (inputs.length > fake.maxBatch) return new Response("payload too large", { status: 413 });
    return Response.json(inputs.map((t) => {
      const v = vectorOf(t);
      return fake.vectorLength !== undefined ? Array.from({ length: fake.vectorLength }, (_, i) => v[i % v.length] ?? 0) : v;
    }));
  };
  const serve = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
  let server = serve(0);
  Object.assign(fake, { port: server.port, url: `http://127.0.0.1:${server.port}` });
  return fake;
}
