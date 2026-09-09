import { createAsyncThunk } from "@reduxjs/toolkit";

import StreamErrorDialog from "../../pages/gui/StreamError";
import StreamErrorRetryDialog from "../../pages/gui/StreamErrorRetryDialog";
import { analyzeError, isTransientStreamError } from "../../util/errorAnalysis";
import { waitForStreamRetryChoice } from "../../util/streamRetry";
import {
  selectSessionById,
  selectSessionChatModel,
} from "../selectors/sessions";
import { setDialogMessage, setShowDialog } from "../slices/uiSlice";
import { AppThunkDispatch, RootState, ThunkApiType } from "../store";
import { stopSessionStream } from "./sessionStreams";

/**
 * Phase 1 session-scoped stream error handling (方案.md §六 `sessionStreams.ts`).
 *
 * Same retry policy as the legacy `streamThunkWrapper`, but it never reads the
 * active session: the model comes from the session itself and every stop goes
 * through `stopSessionStream({sessionId, requestId})`, so a failure in tab A
 * cannot stop or save tab B.
 */

const OVERLOADED_RETRIES = 3;
const OVERLOADED_DELAY_MS = 2000;
const TRANSIENT_RETRIES = 3;
const TRANSIENT_RETRY_DELAY_MS = 1500;

function isOverloadedErrorMessage(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes("overloaded") || lower.includes("529");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stops whatever request the named session currently has live. Uses the
 * requestId read at call time so a retry loop never stops a newer request.
 */
async function stopLiveRequest(
  api: { dispatch: AppThunkDispatch; getState: () => RootState },
  sessionId: string,
): Promise<void> {
  const requestId = selectSessionById(api.getState(), sessionId)?.stream
    .requestId;
  if (!requestId) {
    return;
  }
  await api.dispatch(stopSessionStream({ sessionId, requestId }));
}

export const sessionStreamWrapper = createAsyncThunk<
  boolean,
  { sessionId: string; runStream: () => Promise<void> },
  ThunkApiType
>(
  "sessions/streamWrapper",
  async ({ sessionId, runStream }, { dispatch, getState }) => {
    const api = { dispatch, getState };

    for (let attempt = 0; attempt <= OVERLOADED_RETRIES; attempt++) {
      try {
        await runStream();
        return true;
      } catch (e) {
        const selectedModel = selectSessionChatModel(getState(), sessionId);
        const { message, statusCode } = analyzeError(e, selectedModel);

        // 1. Overloaded / 529: silent exponential backoff.
        if (isOverloadedErrorMessage(message) && attempt < OVERLOADED_RETRIES) {
          await stopLiveRequest(api, sessionId);
          await delay(OVERLOADED_DELAY_MS * 2 ** attempt);
          await stopLiveRequest(api, sessionId);
          continue;
        }

        // 2. Transient transport failures: ask the user, then retry the turn.
        if (
          isTransientStreamError(e, statusCode) &&
          attempt < TRANSIENT_RETRIES
        ) {
          await stopLiveRequest(api, sessionId);
          dispatch(setDialogMessage(<StreamErrorRetryDialog error={e} />));
          dispatch(setShowDialog(true));
          const choice = await waitForStreamRetryChoice();
          if (choice === "retry") {
            await delay(TRANSIENT_RETRY_DELAY_MS);
            await stopLiveRequest(api, sessionId);
            continue;
          }
          return false;
        }

        // 3. Permanent errors (or retries exhausted).
        await stopLiveRequest(api, sessionId);
        dispatch(setDialogMessage(<StreamErrorDialog error={e} />));
        dispatch(setShowDialog(true));
        return false;
      }
    }
    return false;
  },
);
