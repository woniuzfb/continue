import type { ChatHistoryItem, PromptLogDelta } from "../index.js";

// 会话文件 promptLog 增量编码（纯磁盘格式）。
//
// 背景：promptLog 记录 LLM 边界的完整渲染 prompt，而连续两轮 prompt 共享
// 很长的滚动前缀（对话上下文逐轮追加）。全量快照落盘使会话文件按平方级
// 膨胀（实测 620 条消息的会话中 27 条 promptLog 共 17MB，其中绝大部分是
// 同一前缀的重复拷贝）。
//
// 方案：在持久化边界把第 2 条起的 prompt 替换为对前一条 prompt 的
// 前后缀差分（promptDelta）；加载时重建完整 prompt。运行时（内存/IPC/
// GUI）永远是完整形态，FeedbackButtons 的 devdata 上报等下游无需感知。
//
// 完整性：差分带 O(1) 基准哨兵（长度 + 头尾采样）。由于每次 save 都从
// 内存中的完整 prompt 重新编码整条链，正常流程下基准必然匹配；哨兵只
// 防御手工编辑/外部损坏等异常，不匹配时该条降级为无 prompt（遥测产物，
// 绝不让加载路径抛错）。

/** 差分至少要省下的字符数，否则保留全文（小 prompt 不值得引入间接层） */
const MIN_SAVINGS = 256;
/** promptDelta 对象序列化后的固定开销估算（字段名 + 引号 + 数字） */
const DELTA_OVERHEAD = 160;
/** 基准哨兵的头/尾采样长度 */
const GUARD_LEN = 16;
/** 分块比较的块大小：利用引擎对 slice 相等比较的 memcmp 优化 */
const CHUNK = 512;

function baseMatches(base: string | undefined, delta: PromptLogDelta): boolean {
  return (
    typeof base === "string" &&
    base.length === delta.baseLength &&
    base.startsWith(delta.baseHead) &&
    base.endsWith(delta.baseTail)
  );
}

function diffPrompt(prev: string, next: string): PromptLogDelta {
  const minLen = Math.min(prev.length, next.length);

  // 公共前缀：先按块推进，再逐字符收敛
  let prefixLen = 0;
  while (
    prefixLen + CHUNK <= minLen &&
    prev.slice(prefixLen, prefixLen + CHUNK) ===
      next.slice(prefixLen, prefixLen + CHUNK)
  ) {
    prefixLen += CHUNK;
  }
  while (
    prefixLen < minLen &&
    prev.charCodeAt(prefixLen) === next.charCodeAt(prefixLen)
  ) {
    prefixLen++;
  }

  // 公共后缀：上限 minLen - prefixLen，保证不与前缀重叠
  const maxSuffix = minLen - prefixLen;
  let suffixLen = 0;
  while (
    suffixLen + CHUNK <= maxSuffix &&
    prev.slice(prev.length - suffixLen - CHUNK, prev.length - suffixLen) ===
      next.slice(next.length - suffixLen - CHUNK, next.length - suffixLen)
  ) {
    suffixLen += CHUNK;
  }
  while (
    suffixLen < maxSuffix &&
    prev.charCodeAt(prev.length - 1 - suffixLen) ===
      next.charCodeAt(next.length - 1 - suffixLen)
  ) {
    suffixLen++;
  }

  return {
    prefixLen,
    suffixLen,
    middle: next.slice(prefixLen, next.length - suffixLen),
    baseLength: prev.length,
    baseHead: prev.slice(0, GUARD_LEN),
    baseTail:
      prev.length > GUARD_LEN ? prev.slice(prev.length - GUARD_LEN) : prev,
  };
}

function applyPromptDelta(base: string, delta: PromptLogDelta): string {
  return (
    base.slice(0, delta.prefixLen) +
    delta.middle +
    base.slice(base.length - delta.suffixLen)
  );
}

/**
 * 把 history 中所有 promptDelta 形态的 promptLog 就地重建为完整 prompt。
 * 用于加载路径（load/loadPage）与编码前的归一化。基准缺失/不匹配时该条
 * prompt 置为 undefined（链断裂，后续差分同样无法恢复），不抛错。
 */
export function decodePromptLogDeltas(history: ChatHistoryItem[]): void {
  let prev: string | undefined;
  for (const item of history) {
    if (!item.promptLogs?.length) continue;
    for (const log of item.promptLogs) {
      if (log.promptDelta) {
        const delta = log.promptDelta;
        delete log.promptDelta;
        if (typeof log.prompt !== "string") {
          log.prompt = baseMatches(prev, delta)
            ? applyPromptDelta(prev!, delta)
            : undefined;
        }
      }
      prev = typeof log.prompt === "string" ? log.prompt : undefined;
    }
  }
}

/**
 * 把 history 中的 promptLog 链就地编码为差分形态（用于落盘）。
 * 先调用 decode 归一化——懒加载合并保存会把磁盘上的差分头部与内存中的
 * 全文尾部拼在同一条 history 里，必须先统一回全文再重新编码，保证链条
 * 一致。第一条（无基准）与差分不划算的条目保留全文。
 */
export function encodePromptLogDeltas(history: ChatHistoryItem[]): void {
  decodePromptLogDeltas(history);

  let prev: string | undefined;
  for (const item of history) {
    if (!item.promptLogs?.length) continue;
    for (const log of item.promptLogs) {
      if (typeof log.prompt !== "string") {
        prev = undefined;
        continue;
      }
      const full = log.prompt;
      if (
        typeof prev === "string" &&
        full.length > MIN_SAVINGS + DELTA_OVERHEAD
      ) {
        const delta = diffPrompt(prev, full);
        if (
          full.length - (delta.middle.length + DELTA_OVERHEAD) >=
          MIN_SAVINGS
        ) {
          log.promptDelta = delta;
          log.prompt = undefined;
        }
      }
      prev = full;
    }
  }
}
