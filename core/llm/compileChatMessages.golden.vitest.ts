import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, Tool } from "..";
import { compileChatMessages } from "./countTokens";

/**
 * Stage 2C 的前置保证：把 token 预算/计数/消息分区抽成共享 helper（供
 * `measureChatMessagesNoPrune` 复用）**不得改变 `compileChatMessages` 的行为**。
 *
 * `__fixtures__/compileChatMessages.golden.json` 是**重构之前**用当时的实现录出来的
 * （`git stash` 掉重构改动后重新录制，记录脚本一次性、未入库），每例保存输入与
 * 结果或抛出的错误文本。覆盖：无需裁剪 / 需要裁剪 / protected 抛错 /
 * 非可裁剪项超预算抛错 / 排除与包含 tool 输出 / 支持与不支持图片 / native tools /
 * 空 history 抛错 / tool 序列 / 超大窗口 / 未知窗口 / 极小 maxTokens。
 */

type GoldenCase = {
  name: string;
  input: {
    modelName: string;
    msgs: ChatMessage[];
    knownContextLength: number | undefined;
    maxTokens: number;
    supportsImages: boolean;
    tools?: Tool[];
    excludeToolOutputsFromTokenCount?: boolean;
    excludeToolOutputsFromToolCallCountMinTokens?: number;
    protectedMessageIndexes?: number[];
  };
  result?: unknown;
  error?: string;
};

const golden: { recordedFrom: string; cases: GoldenCase[] } = JSON.parse(
  readFileSync(
    join(__dirname, "__fixtures__/compileChatMessages.golden.json"),
    "utf8",
  ),
);

const EXPECTED_CASES = [
  "no-prune-fit",
  "prune-middle",
  "protected-throws",
  "not-enough-non-negotiables",
  "exclude-tool-outputs",
  "include-tool-outputs",
  "images-unsupported",
  "images-supported",
  "native-tools",
  "empty-history",
  "tool-sequence-and-history",
  "huge-context-no-prune",
  "unknown-context-length",
  "tiny-max-tokens",
];

function run(input: GoldenCase["input"]) {
  return compileChatMessages({
    ...input,
    excludeToolOutputsFromTokenCountMinTokens:
      input.excludeToolOutputsFromToolCallCountMinTokens,
  } as any);
}

describe("compileChatMessages keeps its pre-Stage-2C behaviour", () => {
  it("covers the recorded matrix", () => {
    expect(golden.cases.map((testCase) => testCase.name)).toEqual(
      EXPECTED_CASES,
    );
    expect(golden.recordedFrom).toContain("pre-Stage-2C");
  });

  for (const testCase of golden.cases) {
    if (testCase.error !== undefined) {
      it(`throws the same error for ${testCase.name}`, () => {
        expect(() => run(testCase.input)).toThrowError(testCase.error);
      });
    } else {
      it(`returns the same result for ${testCase.name}`, () => {
        expect(run(testCase.input)).toEqual(testCase.result);
      });
    }
  }
});
