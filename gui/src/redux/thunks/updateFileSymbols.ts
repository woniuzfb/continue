import { createAsyncThunk } from "@reduxjs/toolkit";
import { ChatHistoryItem, ContextItemWithId } from "core";
import { CodeBlock } from "../../components/mainInput/TipTapEditor/extensions";
import { setSessionSymbols } from "../slices/sessionsSlice";
import { ThunkApiType } from "../store";

export function getContextItemsFromHistory(
  historyItems: ChatHistoryItem[],
  priorToIndex?: number,
) {
  const pastHistoryItems = historyItems.filter(
    (_, i) => i <= (priorToIndex ?? historyItems.length - 1),
  );

  const pastNormalContextItems = pastHistoryItems.flatMap((item) => {
    return (
      item.contextItems?.filter(
        (item) => item.uri?.type === "file" && item.uri?.value,
      ) ?? []
    );
  });
  const pastToolbarContextItems: ContextItemWithId[] = pastHistoryItems
    .filter(
      (item) => item.editorState && Array.isArray(item.editorState.content),
    )
    .flatMap((item) => item.editorState.content)
    .filter(
      (content) =>
        content?.type === CodeBlock.name &&
        content?.attrs?.item?.uri?.value &&
        content.attrs.item.uri?.type === "file",
    )
    .map((content) => content.attrs!.item!);

  return [...pastNormalContextItems, ...pastToolbarContextItems];
}

/*
    Get file symbols for given context items
    Overwrite symbols for existing file matches
*/
/**
 * Phase 1 session-scoped variant of {@link updateFileSymbolsFromFiles}
 * (方案.md §五.20): merges the fetched symbols into the target session instead
 * of the active one.
 */
export const updateSessionFileSymbolsFromFiles = createAsyncThunk<
  void,
  { sessionId: string; filepaths: string[] },
  ThunkApiType
>(
  "sessions/updateFileSymbols",
  async ({ sessionId, filepaths }, { dispatch, extra, getState }) => {
    try {
      const uniqueUris = Array.from(new Set(filepaths));
      if (uniqueUris.length === 0) {
        return;
      }
      const result = await extra.ideMessenger.request(
        "context/getSymbolsForFiles",
        { uris: uniqueUris },
      );
      if (result.status === "error") {
        throw new Error(result.error);
      }
      const session = getState().sessions.sessionsById[sessionId];
      if (!session) {
        return;
      }
      dispatch(
        setSessionSymbols({
          sessionId,
          symbols: { ...session.symbols, ...result.content },
        }),
      );
    } catch (e) {
      console.error(
        "Error updating session file symbols from filepaths",
        e,
        filepaths,
      );
    }
  },
);

/*
    - Update file symbols for all context items in history
    - That don't already have symbols
*/
// in-flight 去重：启动时 ParallelListeners 的 interval 与
// [sessionId] effect 会对同一会话并发触发本 thunk，各自读到的
// sessionsById[id].symbols 都还是空 → 发两份完全相同的 IPC，host 端
// treesitter 批算压力翻倍（且第二份结果晚到还会再触发一轮渲染）。
// 按 sessionId 记录 in-flight promise，同会话并发调用共享同一次计算。
const symbolsInFlight = new Map<string, Promise<void>>();

/**
 * Session-scoped symbols refresh (方案.md §五.20): walks the target session's
 * history, fetches symbols for the file context items it does not have yet and
 * merges them into that session. In-flight calls per session are shared.
 */
export const updateSessionFileSymbolsFromHistory = createAsyncThunk<
  void,
  { sessionId: string },
  ThunkApiType
>(
  "sessions/updateFileSymbolsFromHistory",
  async ({ sessionId }, { dispatch, extra, getState }) => {
    try {
      const existing = symbolsInFlight.get(sessionId);
      if (existing) {
        await existing;
        await dispatch(
          updateSessionFileSymbolsFromHistory({ sessionId }),
        ).unwrap();
        return;
      }

      const run = (async () => {
        const state = getState();
        const session = state.sessions.sessionsById[sessionId];
        if (!session) {
          return;
        }
        const contextItems = getContextItemsFromHistory(session.history);
        const uniqueUris = new Set(
          contextItems
            .filter((item) => item?.uri?.type === "file" && item?.uri?.value)
            .map((item) => item.uri!.value),
        );
        Object.keys(session.symbols).forEach((key) => {
          uniqueUris.delete(key);
        });
        const uriArray = Array.from(uniqueUris);
        if (uriArray.length === 0) {
          return;
        }
        const result = await extra.ideMessenger.request(
          "context/getSymbolsForFiles",
          { uris: uriArray },
        );
        if (result.status === "error") {
          throw new Error(result.error);
        }
        const current = getState().sessions.sessionsById[sessionId];
        if (!current) {
          return;
        }
        dispatch(
          setSessionSymbols({
            sessionId,
            symbols: { ...current.symbols, ...result.content },
          }),
        );
      })();

      symbolsInFlight.set(sessionId, run);
      try {
        await run;
      } finally {
        symbolsInFlight.delete(sessionId);
      }
    } catch (e) {
      console.error("Error updating session file symbols from history", e);
    }
  },
);
