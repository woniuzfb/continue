import { createAsyncThunk } from "@reduxjs/toolkit";

import StreamErrorDialog from "../../pages/gui/StreamError";
import StreamErrorRetryDialog from "../../pages/gui/StreamErrorRetryDialog";
import { analyzeError, isTransientStreamError } from "../../util/errorAnalysis";
import { waitForStreamRetryChoice } from "../../util/streamRetry";
import { selectSelectedChatModel } from "../slices/configSlice";
import { setDialogMessage, setShowDialog } from "../slices/uiSlice";
import { ThunkApiType } from "../store";
import { cancelStream } from "./cancelStream";
import { saveCurrentSession, saveSessionFromCache } from "./session";

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
  // 快照流所属会话：若流期间用户切走了会话，结束时保存的是该会话
  // 缓存副本里的完整内容（saveSessionFromCache），而不是当前活动会话。
  const streamSessionId = getState().session.id;
  for (let attempt = 0; attempt <= OVERLOADED_RETRIES; attempt++) {
    try {
      await runStream();
      const state = getState();
      if (!state.session.isInEdit) {
        if (state.session.id === streamSessionId) {
          await dispatch(
            saveCurrentSession({
              openNewSession: false,
            }),
          );
        } else {
          await dispatch(saveSessionFromCache(streamSessionId));
        }
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
});
