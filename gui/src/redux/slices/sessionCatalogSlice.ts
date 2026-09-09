import { PayloadAction, createSlice } from "@reduxjs/toolkit";
import { BaseSessionMetadata } from "core";

/**
 * Global session metadata that does not belong to any tab (方案.md §五.6):
 * the History page list, the last-opened session id and the list loading flag.
 * Runtime state lives in sessionsSlice.sessionsById and never leaks in here.
 */
export type SessionCatalogState = {
  allSessionMetadata: BaseSessionMetadata[];
  lastSessionId?: string;
  isLoading: boolean;
};

export const initialSessionCatalogState: SessionCatalogState = {
  allSessionMetadata: [],
  lastSessionId: undefined,
  isLoading: false,
};

export const sessionCatalogSlice = createSlice({
  name: "sessionCatalog",
  initialState: initialSessionCatalogState,
  reducers: {
    refreshSessionMetadata: (
      state,
      action: PayloadAction<{
        metadata: BaseSessionMetadata[];
        isLoading?: boolean;
      }>,
    ) => {
      state.allSessionMetadata = action.payload.metadata;
      if (action.payload.isLoading !== undefined) {
        state.isLoading = action.payload.isLoading;
      }
    },
    setSessionCatalogLoading: (
      state,
      action: PayloadAction<{ isLoading: boolean }>,
    ) => {
      state.isLoading = action.payload.isLoading;
    },
    setLastSessionId: (
      state,
      action: PayloadAction<{ lastSessionId?: string }>,
    ) => {
      state.lastSessionId = action.payload.lastSessionId;
    },
    /**
     * Optimistic/authoritative title or metadata update for one session
     * (create/delete/title events only — a plain save must not refresh the
     * whole list, 方案.md §七.8.1).
     */
    upsertSessionMetadata: (
      state,
      action: PayloadAction<{ metadata: BaseSessionMetadata }>,
    ) => {
      const index = state.allSessionMetadata.findIndex(
        (m) => m.sessionId === action.payload.metadata.sessionId,
      );
      if (index >= 0) {
        state.allSessionMetadata[index] = action.payload.metadata;
      } else {
        state.allSessionMetadata.unshift(action.payload.metadata);
      }
    },
    removeSessionMetadata: (
      state,
      action: PayloadAction<{ sessionId: string }>,
    ) => {
      state.allSessionMetadata = state.allSessionMetadata.filter(
        (m) => m.sessionId !== action.payload.sessionId,
      );
      if (state.lastSessionId === action.payload.sessionId) {
        state.lastSessionId = undefined;
      }
    },
  },
});

export const {
  refreshSessionMetadata,
  setSessionCatalogLoading,
  setLastSessionId,
  upsertSessionMetadata,
  removeSessionMetadata,
} = sessionCatalogSlice.actions;

export default sessionCatalogSlice.reducer;
