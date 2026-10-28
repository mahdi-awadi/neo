// The build label under the console logo (ADR-0056): the running build, as the boot recorded it.
// Pure, so it is unit-tested; app.ts puts it in the header. The shape mirrors `RunningBuild`.

export interface BuildInfo {
  version?: string;
  sha: string;
  branch: string;
}

type Tx = (key: string, vars?: Record<string, string | number>) => string;

/** `text` is the visible line (`v0.1.0 · d85b638`, or the commit alone), `title` the hover text. */
export function buildLabel(tx: Tx, b: BuildInfo): { text: string; title: string } {
  const vars = { version: b.version ?? "", sha: b.sha, branch: b.branch };
  // The hover text is plain text, so no <bdi>: each value is wrapped in an LTR isolate (LRI … PDI)
  // and never reorders inside an Arabic sentence. The visible line is LTR as a whole (dir="ltr").
  const iso = (v: string): string => `\u2066${v}\u2069`;
  const isoVars = { version: iso(vars.version), sha: iso(vars.sha), branch: iso(vars.branch) };
  return {
    text: b.version ? tx("brand.version", vars) : b.sha,
    title: tx(b.version ? "brand.versionTitle" : "brand.versionTitleNoVersion", isoVars),
  };
}
