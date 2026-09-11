import { ContextItem, ContextItemWithId, ToolCallState } from "..";

/**
 * 方案.md §7.1.3（共享纯构造核心）：tool call 的 context items 投影是**纯函数**，
 * 因此放在 Core 侧，供 GUI 渲染与共享构造核心（`core/util/constructMessages`）共用。
 *
 * 之前它住在 `gui/src/pages/gui/ToolCallDiv/utils.tsx`：同一文件同时导出 React 图标
 * 组件，于是 Core 无法复用，构造核心只能反向依赖 GUI。这里只做搬迁，行为逐字不变。
 */

export function toolCallCtxItemToCtxItemWithId(
  ctxItem: ContextItem,
  toolCallId: string,
): ContextItemWithId {
  return {
    ...ctxItem,
    id: {
      providerTitle: "toolCall",
      itemId: toolCallId,
    },
  };
}

export function toolCallStateToContextItems(
  toolCallState: ToolCallState | undefined,
): ContextItemWithId[] {
  if (!toolCallState) {
    return [];
  }
  return (
    toolCallState.output?.map((ctxItem) =>
      toolCallCtxItemToCtxItemWithId(ctxItem, toolCallState.toolCallId),
    ) ?? []
  );
}
