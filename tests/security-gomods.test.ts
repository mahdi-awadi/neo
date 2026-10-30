import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("only a placeholder is linked: a folder with real files, or one module path in two folders, never", () => {
    const root = repo({
      "x/go.mod": "module example.com/x\n",
      "x/internal/code.go": "package internal\n",
      "y/go.mod": "module example.com/y\nreplace example.com/common => ../x/internal\nreplace example.com/dup => ./dup\n",
      "common/go.mod": "module example.com/common\n",
      "d1/go.mod": "module example.com/dup\n",
      "d2/go.mod": "module example.com/dup\n",
    });
    expect(placeholderLinks(root, findGoModules(root))).toEqual([]);
  });

  test("a placeholder may hold dotfiles, non-Go files and links that loop back to itself, never Go code or a link to it", () => {
    const root = repo({
      "common/go.mod": "module example.com/common\n",
      "gw/go.mod": "module example.com/gw\nreplace example.com/common => ./common\n",
      "gw/common/.dockermount": "x\n",
      "gw/common/README.txt": "mounted at build time\n",
      "api/go.mod": "module example.com/api\nreplace example.com/common => ./common\n",
      "api/common/.dockermount": "x\n",
    });
    symlinkSync("../common", join(root, "gw", "common", "common")); // loops to gw/common itself (eticket's connect-gateway)
    symlinkSync(join(root, "common"), join(root, "api", "common", "real")); // a link to real Go code
    expect(placeholderLinks(root, findGoModules(root)).map((l) => l.at)).toEqual([join(root, "gw/common")]);
  });

  test("no link through a symlink or under another link: nested targets and committed symlinks are refused", () => {
    const outside = mkdtempSync(join(tmpdir(), "neo-sec-outside-"));
    const root = repo({
      "a/go.mod": "module example.com/a\n",
      "b/go.mod": "module example.com/b\n",
      "svc/go.mod": "module example.com/svc\nreplace example.com/a => ./p\nreplace example.com/b => ./p/q\nreplace example.com/a => ./esc/z\n",
    });
    symlinkSync(outside, join(root, "svc", "esc"));
    const links = placeholderLinks(root, findGoModules(root));
    expect(links).toEqual([{ at: join(root, "svc/p"), to: join(root, "a") }]); // ./p/q is under ./p; ./esc goes through a symlink
    const upper = mkdtempSync(join(tmpdir(), "neo-sec-upper-"));
    prepare(root, upper, join(upper, "..", `list-${Date.now()}`));
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(root, "svc", "p"))).toBe(false);
  });

  test("prepare never writes through a symlink that is already in the upper folder", () => {
    const root = repo(ETICKET_LIKE);
    const upper = mkdtempSync(join(tmpdir(), "neo-sec-upper-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "neo-sec-else-"));
    symlinkSync(elsewhere, join(upper, "services"));
    prepare(root, upper, join(mkdtempSync(join(tmpdir(), "neo-sec-meta-")), "m.txt"));
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("the module list leaves out a folder whose name has whitespace", () => {
    const root = repo({ ...ETICKET_LIKE, "has space/go.mod": "module example.com/s\n" });
    const list = join(mkdtempSync(join(tmpdir(), "neo-sec-meta-")), "m.txt");
    prepare(root, mkdtempSync(join(tmpdir(), "neo-sec-upper-")), list);
    expect(readFileSync(list, "utf8")).not.toContain("has space");
  });
});

