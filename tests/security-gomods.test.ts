import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGoModules, parseGoMod, placeholderLinks, prepare } from "../tools/security/gomods";

// The Go side of osv's call analysis (ADR-0066): each module is analysed standalone, as its own build
// sees it; a local `replace` target that is only a mount placeholder gets the repo's own module.

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "neo-sec-gomods-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const ETICKET_LIKE = {
  "go.work": "go 1.26\nuse ./services/common\n",
  "services/common/go.mod": "module example.com/app/services/common\n\ngo 1.26\n",
  "services/proto/go.mod": "module example.com/app/services/proto\n",
  "services/seo/go.mod": [
    "module example.com/app/services/seo",
    "require example.com/app/services/common v0.0.0",
    "replace example.com/app/services/common => ./common // mounted by docker-compose",
    "replace (",
    '\t"example.com/app/services/proto" v0.0.0 => ./proto',
    "\tgolang.org/x/net v0.1.0 => golang.org/x/net v0.2.0",
    "\texample.com/gone => ../gone",
    ")",
  ].join("\n"),
  "services/seo/common/.dockermount": "placeholder\n",
  "services/seo/proto/.dockermount": "placeholder\n",
  "node_modules/x/go.mod": "module ignored\n",
  "services/seo/vendor/y/go.mod": "module ignored\n",
  "services/seo/testdata/z/go.mod": "module ignored\n",
  ".hidden/go.mod": "module ignored\n",
};

describe("go.mod parsing", () => {
  test("module path and every replace form: single, block, versioned, quoted, commented", () => {
    const m = parseGoMod(ETICKET_LIKE["services/seo/go.mod"]);
    expect(m.module).toBe("example.com/app/services/seo");
    expect(m.replaces).toEqual([
      { path: "example.com/app/services/common", to: "./common" },
      { path: "example.com/app/services/proto", version: "v0.0.0", to: "./proto" },
      { path: "golang.org/x/net", version: "v0.1.0", to: "golang.org/x/net", toVersion: "v0.2.0" },
      { path: "example.com/gone", to: "../gone" },
    ]);
    expect(parseGoMod('module "example.com/q" // c\n').module).toBe("example.com/q");
    expect(parseGoMod("// no module\n")).toEqual({ module: undefined, replaces: [] });
  });
});

describe("Go modules in a repo", () => {
  test("found like `./...` finds packages: no node_modules, vendor, testdata, dot or underscore folders, no symlinks", () => {
    const root = repo(ETICKET_LIKE);
    symlinkSync(join(root, "services", "common"), join(root, "services", "link"));
    expect(findGoModules(root).map((d) => d.slice(root.length + 1)).sort()).toEqual(["services/common", "services/proto", "services/seo"]);
  });

  test("a local replace target without a go.mod is linked to the repo's module of that path", () => {
    const root = repo(ETICKET_LIKE);
    const links = placeholderLinks(root, findGoModules(root));
    expect(links).toEqual([
      { at: join(root, "services/seo/common"), to: join(root, "services/common") },
      { at: join(root, "services/seo/proto"), to: join(root, "services/proto") },
    ]); // ../gone has no module in the repo; a module replace is not a folder
  });

  test("a real replace target, or one outside the repo, is never touched", () => {
    const root = repo({
      "a/go.mod": "module example.com/a\nreplace example.com/b => ./b\nreplace example.com/c => ../../outside\n",
      "a/b/go.mod": "module example.com/b-fork\n",
      "b/go.mod": "module example.com/b\n",
      "c/go.mod": "module example.com/c\n",
    });
    expect(placeholderLinks(root, findGoModules(root))).toEqual([]);
  });

  test("prepare: links go into the overlay's upper folder only; the module list skips unsafe names", () => {
    const root = repo({ ...ETICKET_LIKE, "bad\nname/go.mod": "module example.com/bad\n" });
    const upper = mkdtempSync(join(tmpdir(), "neo-sec-upper-"));
    const list = join(mkdtempSync(join(tmpdir(), "neo-sec-meta-")), "modules.txt");
    prepare(root, upper, list);
    const link = join(upper, "services/seo/common");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(root, "services/common"));
    expect(existsSync(join(root, "services/seo/common/.dockermount"))).toBe(true); // the repo is unchanged
    expect(lstatSync(join(root, "services/seo/common")).isDirectory()).toBe(true);
    expect(readFileSync(list, "utf8").split("\n").filter(Boolean).map((d) => d.slice(root.length + 1)).sort()).toEqual([
      "services/common",
      "services/proto",
      "services/seo",
    ]);
  });
});
