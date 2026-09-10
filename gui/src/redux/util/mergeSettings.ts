import type { RootState } from "../store";

/**
 * C3 (方案.md §五.17「merge 设置投影」): `config.ui` is the single authority for
 * the bubble-merge settings; `SessionRuntimeState.dontMerge*` is only the
 * reducer-readable mirror.
 *
 * Every runtime-construction path seeds that mirror through this one helper, so
 * there is exactly one default (`?? true`) and no duplicated fallback logic.
 * Runtime-only: never persisted, never part of the Core `Session` protocol.
 */
export function mergeSettings(state: RootState): {
  dontMergeReplyBubbles: boolean;
  dontMergeHistoricalReplyBubbles: boolean;
} {
  const ui = state.config.config?.ui;
  return {
    dontMergeReplyBubbles: ui?.dontMergeReplyBubbles ?? true,
    dontMergeHistoricalReplyBubbles:
      ui?.dontMergeHistoricalReplyBubbles ?? true,
  };
}
