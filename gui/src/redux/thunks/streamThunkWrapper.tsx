import { createAsyncThunk } from "@reduxjs/toolkit";

import StreamErrorDialog from "../../pages/gui/StreamError";
import StreamErrorRetryDialog from "../../pages/gui/StreamErrorRetryDialog";
import { analyzeError, isTransientStreamError } from "../../util/errorAnalysis";
import { waitForStreamRetryChoice } from "../../util/streamRetry";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  clearPendingSessionAction,
  PendingSessionAction,
} from "../slices/tabsSlice";
import { newSession } from "../slices/sessionSlice";
import { setDialogMessage, setShowDialog } from "../slices/uiSlice";
import { ThunkApiType } from "../store";
import { cancelStream } from "./cancelStream";
import { loadSession, saveCurrentSession } from "./session";

const OVERLOADED_RETRIES = 3;
const OVERLOADED_DELAY_MS = 2000;
// User-driven retries for transient (recoverable) errors before giving up.
const TRANSIENT_RETRIES = 3;
const TRANSIENT_RETRY_DELAY_MS = 1500;

function isOverloadedErrorMessage(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes("overloaded") || lower.includes("529");
}

export const streamThunkWrapper = createAsyncThunk<
  void,
  () => Promise<void>,
  ThunkApiType
>("chat/streamWrapper", async (runStream, { dispatch, getState }) => {
  try {
    for (let attempt = 0; attempt <= OVERLOADED_RETRIES; attempt++) {
      try {
        await runStream();
        const state = getState();
        if (!state.session.isInEdit) {
          await dispatch(
            saveCurrentSession({
              openNewSession: false,
            }),
          );
        }
        return;
      } catch (e) {
        // Get the selected model from the state for error analysis
        const state = getState();
        const selectedModel = selectSelectedChatModel(state);
        const { message, statusCode } = analyzeError(e, selectedModel);

        // 1. Overloaded/529: silent exponential-backoff retries (existing).
        if (isOverloadedErrorMessage(message) && attempt < OVERLOADED_RETRIES) {
          await dispatch(cancelStream());
          const delayMs = OVERLOADED_DELAY_MS * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          await dispatch(cancelStream());
          continue;
        }

        // 2. Transient network/socket/SSE/server errors: ask the user whether
        // to keep waiting and retry, or disconnect. Retrying re-runs the whole
        // stream through this wrapper, so subsequent failures still get the
        // same retry/backoff/error-dialog handling.
        if (
          isTransientStreamError(e, statusCode) &&
          attempt < TRANSIENT_RETRIES
        ) {
          await dispatch(cancelStream());
          dispatch(setDialogMessage(<StreamErrorRetryDialog error={e} />));
          dispatch(setShowDialog(true));
          const choice = await waitForStreamRetryChoice();
          if (choice === "retry") {
            // Give the connection a moment to recover before re-running.
            await new Promise((resolve) =>
              setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS),
            );
            await dispatch(cancelStream());
            continue;
          }
          return; // user chose to disconnect
        }

        // 3. Permanent errors (or retries exhausted): show the regular error
        // dialog.
        await dispatch(cancelStream());
        dispatch(setDialogMessage(<StreamErrorDialog error={e} />));
        dispatch(setShowDialog(true));

        return;
      }
    }
  } finally {
    // Stream is definitively over (completed, cancelled, or failed after all
    // retries). If the user switched tabs mid-stream, apply the deferred
    // session switch now — but only if no NEW stream has started in the same
    // session (e.g. the user queued another message while streaming), so the
    // new stream's updates never land in the wrong session.
    //
    // TODO: 目前是“延迟切换”方案——流进行中切 tab，内容区要等流结束后才
    // 切换过去（tab 高亮即时生效）。若要支持“流在后台继续 + 立即浏览其他
    // 会话”，需要把流状态按 session 隔离（streamAborter / isStreaming /
    // streamUpdate 都按 sessionId 路由，完成后写回对应 session 文件），
    // 改动较大，留作后续优化。
    const state = getState();
    if (state.session.isStreaming) {
      return;
    }
    const pending: PendingSessionAction | undefined =
      state.tabs.pendingSessionAction;
    if (pending) {
      dispatch(clearPendingSessionAction());
      if (pending.type === "load") {
        void dispatch(
          loadSession({
            sessionId: pending.sessionId,
            saveCurrentSession: pending.saveCurrentSession,
          }),
        );
      } else {
        dispatch(newSession());
      }
    }
  }
});
