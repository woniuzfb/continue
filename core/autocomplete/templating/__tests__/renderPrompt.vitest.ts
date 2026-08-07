import { afterEach, describe, expect, it, vi } from "vitest";

// ---------- Module mocks ----------

// Simple Handlebars mock that does naive placeholder substitution
vi.mock("handlebars", () => {
  return {
    default: {
      compile: (template: string) => (ctx: Record<string, string>) => {
        return template
          .replace(/{{prefix}}/g, ctx.prefix)
          .replace(/{{suffix}}/g, ctx.suffix)
          .replace(/{{filename}}/g, ctx.filename ?? "")
          .replace(/{{reponame}}/g, ctx.reponame ?? "")
          .replace(/{{language}}/g, ctx.language ?? "");
      },
    },
  };
});

// Token utilities – we map 1 char = 1 token for simplicity
vi.mock("../../../llm/countTokens", () => {
  const countTokens = (str: string) => str.length;
  const pruneLinesFromTop = (str: string, allowed: number) =>
    str.slice(Math.max(0, str.length - allowed));
  const pruneLinesFromBottom = (str: string, allowed: number) =>
    str.slice(0, allowed);
  const getTokenCountingBufferSafety = () => 0;

  return {
    countTokens,
    pruneLinesFromTop,
    pruneLinesFromBottom,
    getTokenCountingBufferSafety,
  };
});

// Snippet selection – configurable via constant return value
let snippetsOverride: any[] = [];
vi.mock("../filtering", () => ({
  getSnippets: () => snippetsOverride,
}));

// Snippet formatting – configurable via constant return value
let formattedSnippetsOverride = "[FORMATTED_SNIPPETS]";
vi.mock("../formatting", () => ({
  formatSnippets: () => formattedSnippetsOverride,
}));

// Stop tokens helper – we expose a variable so each test can override it
let stopTokenReturn: string[] = ["<STOP>"];
vi.mock("../getStopTokens", () => ({
  getStopTokens: () => stopTokenReturn,
}));

// AutocompleteTemplate – provide overridable template + compiler + completionOptions
let templateOverride: any = "{{prefix}}|{{suffix}}";
let compileFnOverride: ((...args: any[]) => [string, string]) | undefined;
let completionOptionsOverride: Record<string, any> | undefined;
vi.mock("../AutocompleteTemplate", () => ({
  getTemplateForModel: () => ({
    template: templateOverride,
    compilePrefixSuffix: compileFnOverride,
    completionOptions: completionOptionsOverride ?? {},
  }),
}));

// ---------- Imports after mocks ----------
import { renderPrompt, renderPromptWithTokenLimit } from "..";
import { AutocompleteLanguageInfo } from "../../constants/AutocompleteLanguageInfo";
import { SnippetPayload } from "../../snippets";
import { HelperVars } from "../../util/HelperVars";

// ---------- Helper builders ----------

const tsLang: AutocompleteLanguageInfo = {
  name: "TypeScript",
  topLevelKeywords: [],
  singleLineComment: "//",
  endOfLine: [";"],
};

const emptySnippetPayload: SnippetPayload = {
  rootPathSnippets: [],
  importDefinitionSnippets: [],
  ideSnippets: [],
  recentlyEditedRangeSnippets: [],
  recentlyVisitedRangesSnippets: [],
  diffSnippets: [],
  clipboardSnippets: [],
  recentlyOpenedFileSnippets: [],
  staticSnippet: [],
};

function makeHelper(overrides: any = {}) {
  return {
    input: {
      filepath: "file:///test.ts",
      pos: { line: 0, character: 0 },
      recentlyEditedRanges: [],
      recentlyVisitedRanges: [],
      ...overrides.input,
    },
    prunedPrefix: "PRUNED_PREFIX",
    prunedSuffix: "PRUNED_SUFFIX",
    lang: tsLang,
    modelName: "test-model",
    filepath: "file:///test.ts",
    workspaceUris: [],
    options: {
      // Default template can be overridden per test
      template: "{{prefix}}|{{suffix}}",
      maxPromptTokens: 2048,
      prefixPercentage: 0.5,
      maxSuffixPercentage: 0.5,
      experimental_includeClipboard: false,
      useRecentlyOpened: false,
      experimental_includeRecentlyVisitedRanges: false,
      experimental_includeRecentlyEditedRanges: false,
      experimental_includeDiff: false,
      onlyMyCode: false,
      ...overrides.options,
    },
    ...overrides,
  } as unknown as HelperVars;
}

afterEach(() => {
  // reset overridable mocks
  templateOverride = "{{prefix}}|{{suffix}}";
  compileFnOverride = undefined;
  completionOptionsOverride = undefined;
  stopTokenReturn = ["<STOP>"];
  snippetsOverride = [];
  formattedSnippetsOverride = "[FORMATTED_SNIPPETS]";
  vi.restoreAllMocks();
});

// ---------- Test suite ----------

describe("renderPrompt prefix/suffix selection", () => {
  it("uses manuallyPassPrefix when provided", () => {
    const helper = makeHelper({
      input: { manuallyPassPrefix: "MANUAL" },
    });

    const { prefix, suffix } = renderPrompt({
      snippetPayload: emptySnippetPayload,
      workspaceDirs: ["file:///workspace"],
      helper,
    });

    expect(suffix).toBe("\n");
    expect(prefix.endsWith("MANUAL")).toBe(true);
  });

  it("falls back to prunedPrefix when no manual prefix", () => {
    const helper = makeHelper({});

    const { prefix } = renderPrompt({
      snippetPayload: emptySnippetPayload,
      workspaceDirs: ["file:///workspace"],
      helper,
    });

    expect(prefix.includes("PRUNED_PREFIX")).toBe(true);
  });
});

describe("template rendering paths", () => {
  it("handles function template", () => {
    templateOverride = (
      p: string,
      s: string,
      _filepath: string,
      _reponame: string,
    ) => `FUNC:${p}|${s}`;

    const helper = makeHelper({ options: { template: undefined } });

    const { prompt } = renderPrompt({
      snippetPayload: emptySnippetPayload,
      workspaceDirs: ["file:///workspace"],
      helper,
    });

    expect(prompt.startsWith("FUNC:")).toBe(true);
    expect(prompt.includes("PRUNED_PREFIX")).toBe(true);
  });
});

describe("compilePrefixSuffix vs snippet formatting", () => {
  it("applies compilePrefixSuffix when provided", () => {
    compileFnOverride = (p: string, s: string) => [`COMP_${p}`, `COMP_${s}`];
    templateOverride = "{{prefix}}|{{suffix}}";
    const helper = makeHelper({ options: { template: undefined } });

    const { prefix: compiledPrefix } = renderPrompt({
      snippetPayload: emptySnippetPayload,
      workspaceDirs: ["file:///workspace"],
      helper,
    });

    expect(compiledPrefix.startsWith("COMP_PRUNED_PREFIX")).toBe(true);
  });

  it("prepends formatted snippets when no compiler present", () => {
    const helper = makeHelper({});

    const { prefix: compiledPrefix } = renderPrompt({
      snippetPayload: emptySnippetPayload,
      workspaceDirs: ["file:///workspace"],
      helper,
    });

    expect(compiledPrefix.startsWith(`${formattedSnippetsOverride}\n`)).toBe(
      true,
    );
  });
});

describe("renderPromptWithTokenLimit parity & pruning", () => {
  it("matches renderPrompt when llm is undefined", () => {
    const helper = makeHelper({});

    const res1 = renderPrompt({
      snippetPayload: emptySnippetPayload,
      workspaceDirs: ["file:///workspace"],
      helper,
    });

    const res2 = renderPromptWithTokenLimit({
      snippetPayload: emptySnippetPayload,
      workspaceDirs: ["file:///workspace"],
      helper,
      llm: undefined,
    });

    expect(res2).toEqual(res1);
  });

  it("prunes prefix/suffix to respect small context length", () => {
    const longPrefix = "A".repeat(300);

    const helper = makeHelper({ prunedPrefix: longPrefix });

    const llmStub = {
      contextLength: 120,
      completionOptions: { maxTokens: 10 },
      model: "test-model",
    } as any;

    const { prefix: compiledPrefix } = renderPromptWithTokenLimit({
      snippetPayload: emptySnippetPayload,
      workspaceDirs: ["file:///workspace"],
      helper,
      llm: llmStub,
    });

    expect(compiledPrefix.length).toBeLessThan(120);
  });

  it("regression: large snippets cannot push the final prompt over the limit", () => {
    // 1 char = 1 token in this test setup. The upfront estimate only counts
    // raw prefix/suffix + a fixed 50-token overhead, so a 100-token formatted
    // snippet is invisible to it. Without the post-build fallback, the final
    // prompt would exceed the limit (contextLength 120 - maxTokens 10 = 110).
    const bigSnippetText = "S".repeat(100);
    formattedSnippetsOverride = bigSnippetText;
    snippetsOverride = [{ content: bigSnippetText }];

    const helper = makeHelper({}); // raw prefix/suffix: 13 + 13 tokens

    const llmStub = {
      contextLength: 120,
      completionOptions: { maxTokens: 10 },
      model: "test-model",
    } as any;

    const { prompt, prefix: compiledPrefix } = renderPromptWithTokenLimit({
      snippetPayload: emptySnippetPayload,
      workspaceDirs: ["file:///workspace"],
      helper,
      llm: llmStub,
    });

    // Final rendered prompt must never exceed the limit
    expect(prompt.length).toBeLessThanOrEqual(110);
    // Snippet content is preserved (only prefix/suffix get pruned)
    expect(compiledPrefix.includes(bigSnippetText)).toBe(true);
    // And the raw prefix was actually pruned to make room
    expect(compiledPrefix.includes("PRUNED_PREFIX")).toBe(false);
  });
});

describe("stop-token merging", () => {
  it("returns stop tokens from getStopTokens", () => {
    stopTokenReturn = ["LANG_STOP", "TEMPLATE_STOP"];
    completionOptionsOverride = { stop: ["TEMPLATE_STOP"] };
    templateOverride = "{{prefix}}|{{suffix}}";

    const helper = makeHelper({ options: { template: undefined } });

    const { completionOptions } = renderPrompt({
      snippetPayload: emptySnippetPayload,
      workspaceDirs: ["file:///workspace"],
      helper,
    });

    expect(completionOptions?.stop).toEqual(stopTokenReturn);
  });
});
