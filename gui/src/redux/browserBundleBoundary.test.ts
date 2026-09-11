import { readdirSync, readFileSync } from "fs";
import ts from "typescript";
import { dirname, join, relative, resolve, sep } from "path";
import { describe, expect, it } from "vitest";

/**
 * 方案.md §7.1.1: the GUI is bundled for the **webview** (browser), while parts of
 * `core/` are Node-only.
 *
 * This is a build-boundary regression guard, not a style rule. It exists because a
 * single runtime import broke the shipped extension:
 *
 * ```text
 * gui/src/redux/util/sessionRequestOptions.ts
 *   → core/llm/countTokens.ts
 *   → core/llm/asyncEncoder.ts
 *   → workerpool
 *   → worker_threads / os / child_process / path      ← Vite externalizes them
 * ```
 *
 * Vite does not fail the build for that: it replaces each Node module with a browser
 * stub, and the webview then dies at load time. The same shape of mistake is easy to
 * make again (the helper we needed next to a Node-only implementation), so the graph
 * is checked here instead of being rediscovered in production.
 *
 * Rules:
 * 1. `gui/src/**` must not runtime-import a Node-only core module (denylist below).
 * 2. Transitively: every core file reachable through GUI **runtime** imports must not
 *    reach a Node-only module either — that is what would smuggle `workerpool` back in
 *    through a helper file.
 * 3. `import type` is invisible to the bundler and is therefore ignored.
 */

const GUI_SRC = resolve(__dirname, "..");
const REPO_ROOT = resolve(GUI_SRC, "..", "..");
const CORE_ROOT = join(REPO_ROOT, "core");

/** Core modules that may not be reachable from the browser bundle. */
const NODE_ONLY_CORE_MODULES = [
  "core/llm/countTokens",
  "core/llm/asyncEncoder",
  "core/llm/llamaTokenizer",
  "core/llm/openaiTypeConvertersWorkerPool",
  "core/util/paths",
  "core/util/history",
];

/** Node builtins (or bundler-hostile packages) that must never appear in the graph. */
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "tls",
  "url",
  "util",
  "v8",
  "worker_threads",
  "zlib",
  "workerpool",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "__snapshots__"
      ) {
        continue;
      }
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    // Declaration files emit nothing and cannot be transpiled; they also have no
    // runtime graph of their own.
    if (/\.d\.ts$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(REPO_ROOT, file).split(sep).join("/");

/**
 * Specifiers the **bundler actually keeps**.
 *
 * The source text cannot answer this: a statement like
 * `import { ChatMessage } from ".."` mentions only types and is erased, while
 * `import { countTokens } from "./countTokens"` is retained. So each file is transpiled
 * the same way the bundler transpiles TS (type-only bindings elided, unused imports
 * dropped) and the *emitted JavaScript* is inspected — that is precisely the edge set
 * Vite walks and externalizes against.
 */
function runtimeSpecifiers(source: string, fileName: string): string[] {
  const emitted = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      isolatedModules: true,
    },
  }).outputText;

  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^;]*?from\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of emitted.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * Resolves a core-relative specifier (`core/...`) to a file path.
 *
 * Bare `"core"` is deliberately **not** resolved: the barrel is `core/index.d.ts` only
 * (declarations, no runtime module), and the GUI's many `import { SomeType } from
 * "core"` statements are erased by the bundler because no binding survives type
 * erasure. There is nothing to walk — and a runtime *value* import from the barrel is
 * a resolution error the build reports immediately, not a silent Node leak.
 */
function corePathFor(specifier: string): string | undefined {
  if (specifier === "core") {
    return undefined;
  }
  if (!specifier.startsWith("core/")) {
    return undefined;
  }
  const base = join(REPO_ROOT, specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Relative specifier resolution for files inside core (`./x`, `../y`). */
function relativeCorePath(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = resolve(dirname(file), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

const NODE_BUILTIN_USING_CORE_PREFIXES = ["core/node_modules/"];

type Violation = { from: string; to: string; chain: string[] };

/**
 * Walks the runtime import graph from the given GUI files, reporting the first
 * Node-only module (or Node builtin/package) it can reach.
 */
function findBoundaryViolations(entries: string[]): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const queue: { file: string; chain: string[] }[] = entries.map((file) => ({
    file,
    chain: [rel(file)],
  }));

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, "utf8");
    for (const specifier of runtimeSpecifiers(source, file)) {
      const bare = specifier.replace(/\.js$/, "");
      if (NODE_BUILTINS.has(bare) || bare.startsWith("node:")) {
        violations.push({ from: rel(file), to: specifier, chain });
        continue;
      }
      if (NODE_BUILTIN_USING_CORE_PREFIXES.some((p) => specifier.includes(p))) {
        violations.push({ from: rel(file), to: specifier, chain });
        continue;
      }
      const target =
        corePathFor(specifier) ??
        relativeCorePath(file, specifier) ??
        undefined;
      if (!target) {
        continue;
      }
      if (NODE_ONLY_CORE_MODULES.includes(rel(target).replace(/\.tsx?$/, ""))) {
        violations.push({ from: rel(file), to: rel(target), chain });
        continue;
      }
      if (target.startsWith(CORE_ROOT) && !target.endsWith(".d.ts")) {
        queue.push({ file: target, chain: [...chain, rel(target)] });
      }
    }
  }
  return violations;
}

describe("browser bundle boundary (方案.md §7.1.1)", () => {
  it("never reaches a Node-only core module from GUI runtime imports", () => {
    const guiFiles = sourceFiles(GUI_SRC);
    const violations = findBoundaryViolations(guiFiles);
    expect(
      violations.map((v) => `${v.from} → ${v.to}  (${v.chain.join(" → ")})`),
    ).toEqual([]);
  });

  it("keeps the relocated token helpers browser-safe", () => {
    // The module GUI imports for its budget/identity projection must stay free of
    // tokenizers, workers and Node builtins.
    const violations = findBoundaryViolations([
      join(CORE_ROOT, "llm", "tokenMeasurementInputs.ts"),
    ]);
    expect(
      violations.map((v) => `${v.from} → ${v.to}  (${v.chain.join(" → ")})`),
    ).toEqual([]);
    // …and it really is what the GUI uses.
    const guiUsage = readFileSync(
      join(GUI_SRC, "redux", "util", "sessionRequestOptions.ts"),
      "utf8",
    );
    expect(guiUsage).toContain("core/llm/tokenMeasurementInputs");
  });

  it("still detects the regression it was written for", () => {
    // The guard must fail for the exact shape that broke the webview: a GUI file that
    // runtime-imports the Node-only token module (which imports asyncEncoder → workerpool).
    const violationSource = {
      from: "gui/src/redux/util/regression-probe.ts",
      to: "core/llm/countTokens.ts",
      chain: [
        "gui/src/redux/util/regression-probe.ts",
        "core/llm/countTokens.ts",
      ],
    };
    const countTokens = readFileSync(
      join(CORE_ROOT, "llm", "countTokens.ts"),
      "utf8",
    );
    const specifiers = runtimeSpecifiers(countTokens, "countTokens.ts");
    // countTokens itself reaches asyncEncoder at runtime…
    expect(specifiers.some((s) => s.includes("asyncEncoder"))).toBe(true);
    expect(NODE_ONLY_CORE_MODULES).toContain(
      violationSource.to.replace(/\.ts$/, ""),
    );
    // …and a `import type` from the same module would NOT be a violation.
    expect(
      runtimeSpecifiers(
        'import type { X } from "core/llm/countTokens";',
        "probe.ts",
      ),
    ).toEqual([]);
    // A *used* value import from the same module survives transpilation — that is the
    // shape that broke the webview.
    expect(
      runtimeSpecifiers(
        'import { measurementInputsAffectingTokens } from "core/llm/countTokens";\nconsole.log(measurementInputsAffectingTokens);',
        "probe.ts",
      ),
    ).toEqual(["core/llm/countTokens"]);
  });
});
