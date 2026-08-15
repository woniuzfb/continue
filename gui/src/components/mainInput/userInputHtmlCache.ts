import type { JSONContent } from "@tiptap/react";

/**
 * 历史 user 消息的静态 HTML 缓存(模块级,不随组件销毁)。
 *
 * 背景:每条已发送的 user 消息渲染一个完整的 TipTap/ProseMirror 编辑器
 * 实例(useEditor → Editor + view DOM,~20-40ms/条)。与 markdown 不同,
 * 编辑器是有状态的实例,无法通过缓存元素树避免重建 —— 切 tab 卸载后再
 * 切回,每个 user 消息都要原价重建。
 *
 * 方案:TipTapEditor 卸载时把 editor.getHTML() 存入本缓存;重挂载时
 * ContinueInputBox 先渲染静态 HTML(纯 DOM,无实例成本),用户点击时
 * 才挂载真正的编辑器( autoFocus 并聚焦)。
 *
 * 命中条件:inputId 相同且 editorState 引用相等。LRU 会话缓存保留原
 * 对象引用,切 tab 后引用不变 → 命中;消息被编辑/重发 → 新引用 → 未命
 * 中 → 走真编辑器,天然防过期。
 *
 * 防脏数据:仅当编辑器未被用户修改过(onUpdate 未触发)时才在卸载时
 * 写入,避免把"改了没发"的草稿内容当作已发送内容缓存。
 */

const MAX_ENTRIES = 200;

interface CachedUserInput {
  editorState: JSONContent | string;
  html: string;
}

const userInputCache = new Map<string, CachedUserInput>();

/** 读取静态 HTML;editorState 引用不相等视为未命中。 */
export function getUserInputStaticHtml(
  inputId: string,
  editorState: JSONContent | string | undefined,
): string | undefined {
  const cached = userInputCache.get(inputId);
  if (!cached || editorState === undefined) {
    return undefined;
  }
  // 字符串按值比较，对象按引用比较；严格相等同时覆盖两种情况。
  const match = cached.editorState === editorState;
  if (!match) {
    userInputCache.delete(inputId);
    return undefined;
  }
  // LRU 触碰
  userInputCache.delete(inputId);
  userInputCache.set(inputId, cached);
  return cached.html;
}

/** 卸载时写入编辑器 HTML。 */
export function setUserInputStaticHtml(
  inputId: string,
  editorState: JSONContent | string | undefined,
  html: string,
): void {
  if (editorState === undefined) {
    return;
  }
  if (userInputCache.has(inputId)) {
    userInputCache.delete(inputId);
  } else if (userInputCache.size >= MAX_ENTRIES) {
    const oldest = userInputCache.keys().next().value;
    if (oldest !== undefined) {
      userInputCache.delete(oldest);
    }
  }
  userInputCache.set(inputId, { editorState, html });
}

/** 仅测试/调试用。 */
export function clearUserInputStaticHtmls(): void {
  userInputCache.clear();
}
