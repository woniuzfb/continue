import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { ChatHistoryItem, RuleWithSource } from "..";
import { SystemMessageToolCodeblocksFramework } from "../tools/systemMessageTools/toolCodeblocks";
import type { SystemMessageToolsFramework } from "../tools/systemMessageTools/types";
import { constructMessages } from "./constructMessages";

/**
 * Stage 2B 的首要验收（方案.md §7.1.3 / 已知限制 #63）：共享纯构造核心对搬迁前 GUI 实现的
 * 行为必须**完整返回结构深相等** —— 消息数组顺序、角色、字符串内容与所有业务字段
 * （`appliedRules`、`appliedRulesSourceMessageId`）严格相同。
 *
 * 断言用的是 `toEqual`（结构深相等），不是序列化后的字节相等：对象键序不属于业务语义。
 *
 * `__fixtures__/constructMessages.golden.json` 是在**搬迁之前**用当时的
 * `gui/src/redux/util/constructMessages.ts` 录出来的（记录脚本为一次性、未入库），
 * 每例同时保存输入与期望输出。因此这个文件是"legacy 实现"的冻结证据：
 * 一旦共享核心的任何行为漂移，用例立刻变红。
 *
 * 覆盖（对应用户给的清单）：普通 user/assistant history、summary carrier、
 * Local Provider `conversationSummaryOverride`、rules（alwaysApply / globs / regex /
 * policy off / alwaysApply:false）、native tools、system-tools framework、
 * tool call/result（含 canceled / errored / generating 状态渲染）、thinking、
 * merged bubble、images 与 context items、空 assistant placeholder、
 * `appliedRules` 与 `appliedRulesSourceMessageId`。
 */

type GoldenInput = {
  history: ChatHistoryItem[];
  baseSystemMessage?: string;
  availableRules: RuleWithSource[];
  rulePolicies: Record<string, unknown>;
  useSystemToolsFramework: boolean;
  conversationSummaryOverride?: string;
};

type GoldenCase = {
  name: string;
  input: GoldenInput;
  expected: {
    messages: any[];
    appliedRules: any[];
    appliedRulesSourceMessageId?: string;
  };
};

const golden: { recordedFrom: string; cases: GoldenCase[] } = JSON.parse(
  readFileSync(
    join(__dirname, "__fixtures__/constructMessages.golden.json"),
    "utf8",
  ),
);

/** The fixture list itself is part of the contract: cases may not be dropped. */
const EXPECTED_CASES = [
  "plain-history",
  "empty-assistant-placeholder",
  "summary-carrier",
  "summary-override-local-provider",
  "rules-matrix",
  "tool-call-and-result",
  "tool-call-statuses",
  "system-tools-framework",
  "thinking-and-merged-bubble",
  "images-and-file-content",
];

function run(input: GoldenInput) {
  const framework: SystemMessageToolsFramework | undefined =
    input.useSystemToolsFramework
      ? new SystemMessageToolCodeblocksFramework()
      : undefined;
  return constructMessages(
    input.history,
    input.baseSystemMessage,
    input.availableRules,
    input.rulePolicies as any,
    framework,
    input.conversationSummaryOverride !== undefined
      ? { conversationSummaryOverride: input.conversationSummaryOverride }
      : undefined,
  );
}

describe("shared constructMessages core reproduces the pre-Stage-2B GUI output", () => {
  it("covers the agreed fixture matrix", () => {
    expect(golden.cases.map((testCase) => testCase.name)).toEqual(
      EXPECTED_CASES,
    );
    expect(golden.recordedFrom).toContain("pre-Stage-2B");
  });

  for (const testCase of golden.cases) {
    it(`deep-equals the recorded legacy result for ${testCase.name}`, () => {
      // `toEqual` on the whole result: messages (including order, roles, content
      // frames and stripped runtime ids), appliedRules and the source message id.
      expect(run(testCase.input)).toEqual(testCase.expected);
    });
  }

  it("keeps the fixture inputs JSON-only (identity-free)", () => {
    // The goldens must stay serializable: a non-JSON input (Date, function,
    // class instance) would make the comparison meaningless.
    const reserialized = JSON.parse(JSON.stringify(golden.cases));
    expect(reserialized).toEqual(golden.cases);
  });
});
