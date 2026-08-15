import type { ReactNode } from "react";

/**
 * Markdown 渲染产物缓存(模块级,不随组件实例销毁)。
 *
 * 背景:StyledMarkdownPreview 每次挂载都会通过 useRemark 重新执行完整
 * remark → rehype → highlight.js 管线(长消息 ~10-20ms/条)。切 tab 会
 * 卸载整棵消息组件树,切回时全部重算 —— 实测 168 条消息 ≈ 2.7s,而数据
 * 恢复(LRU 会话缓存)仅 0.6ms,瓶颈全在这条管线。
 *
 * 缓存内容:useRemark 输出的 React 元素树(不可变描述)。命中时跳过管线,
 * 只保留 React mount / DOM 构建成本(约 2-5ms/条)。
 *
 * 键设计(调用方拼装):sessionId + itemIndex + 渲染模式位 + source 全文。
 * react-remark 在组件首次渲染时固定插件 options,管线闭包捕获的是挂载
 * 实例的 props/refs,因此所有影响产物的输入都必须进键。refs(pastFileInfo、
 * itemIndex 等)在跨实例复用时是"冻结旧值",对同一 (session, index,
 * source) 通常等值;SymbolLink/FilenameLink 等基于 context items 的增强
 * 链接可接受此误差。
 *
 * 写入时机:仅在会话非流式(isStreaming=false)时写入,避免流式 chunk
 * 与 reactContent 异步更新之间的竞态把过期产物写进缓存。
 *
 * 逐出:上限 300 条,LRU(命中即触碰)。
 */

const MAX_ENTRIES = 300;

const artifactCache = new Map<string, ReactNode>();

/** 读取渲染产物(命中会将该条目标记为最近使用)。 */
export function getMarkdownArtifact(key: string): ReactNode | undefined {
  const hit = artifactCache.get(key);
  if (hit !== undefined) {
    artifactCache.delete(key);
    artifactCache.set(key, hit);
  }
  return hit;
}

/** 写入渲染产物,超限时淘汰最久未使用的条目。 */
export function setMarkdownArtifact(key: string, content: ReactNode): void {
  if (artifactCache.has(key)) {
    artifactCache.delete(key);
  } else if (artifactCache.size >= MAX_ENTRIES) {
    const oldest = artifactCache.keys().next().value;
    if (oldest !== undefined) {
      artifactCache.delete(oldest);
    }
  }
  artifactCache.set(key, content);
}

/** 清空缓存(仅测试/调试用)。 */
export function clearMarkdownArtifacts(): void {
  artifactCache.clear();
}
