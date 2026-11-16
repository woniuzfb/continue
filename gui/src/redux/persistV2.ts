import { BaseSessionMetadata, MessageModes, SetCodeToEditPayload } from "core";
import { normalizeSessionMode } from "./util/sessionMode";

/**
 * Redux-persist v1 -> v2 (方案.md §五.23).
 *
 * v1 persisted: session.id / session.lastSessionId / session.title /
 * session.mode / tabs.tabs / the editModeState subset.
 *
 * v2 persists only the tab projection plus the catalog pointer. Runtime state
 * (`sessionsById`) is never persisted — a rehydrated descriptor only says
 * which session should be opened, never that its history is loaded.
 */

export type PersistedTabDescriptorV2 = {
  sessionId: string;
  title: string;
  loadState: "unloaded" | "loading" | "loaded" | "failed";
  mode?: MessageModes;
  persistedEditState?: {
    returnToMode?: MessageModes;
    lastNonEditSessionWasEmpty?: boolean;
    codeToEdit?: SetCodeToEditPayload[];
  };
};

export type PersistedV2 = {
  sessions: {
    activeSessionId?: string;
    tabOrder: string[];
    tabDescriptors: Record<string, PersistedTabDescriptorV2>;
  };
  sessionCatalog: {
    lastSessionId?: string;
  };
};

const LOAD_STATE_UNLOADED = "unloaded" as const;

/**
 * Pure v1 -> v2 mapping. Accepts the v0 shape as well (after the existing
 * `"0"` migration): a single tab without `sessionId` plus `session.id`.
 */
export function migratePersistedStateToV2(oldState: any): PersistedV2 {
  const oldSession = oldState?.session ?? {};
  const oldTabs: any[] = Array.isArray(oldState?.tabs?.tabs)
    ? oldState.tabs.tabs
    : [];
  const oldEditState = oldState?.editModeState ?? {};

  const persistedEditState = {
    returnToMode: oldEditState.returnToMode
      ? normalizeSessionMode(oldEditState.returnToMode)
      : undefined,
    lastNonEditSessionWasEmpty: oldEditState.lastNonEditSessionWasEmpty,
    codeToEdit: oldEditState.codeToEdit,
  };

  const tabOrder: string[] = [];
  const tabDescriptors: Record<string, PersistedTabDescriptorV2> = {};
  let activeSessionId: string | undefined;

  const addDescriptor = (
    sessionId: string,
    title: string,
    isActive: boolean,
  ) => {
    if (!sessionId || tabDescriptors[sessionId]) {
      return;
    }
    tabOrder.push(sessionId);
    tabDescriptors[sessionId] = {
      sessionId,
      title,
      loadState: LOAD_STATE_UNLOADED,
      mode: normalizeSessionMode(oldSession.mode),
      persistedEditState,
    };
    if (isActive) {
      activeSessionId = sessionId;
    }
  };

  for (const tab of oldTabs) {
    // A v0/v1 tab may have no sessionId yet (the "Chat 1" placeholder); the
    // active session id is the only source of truth in that case.
    const sessionId =
      typeof tab?.sessionId === "string" && tab.sessionId.length > 0
        ? tab.sessionId
        : tab?.isActive
          ? oldSession.id
          : undefined;
    if (!sessionId) {
      continue;
    }
    addDescriptor(
      sessionId,
      typeof tab?.title === "string" && tab.title ? tab.title : sessionId,
      tab?.isActive === true,
    );
  }

  if (typeof oldSession.id === "string" && oldSession.id.length > 0) {
    addDescriptor(
      oldSession.id,
      typeof oldSession.title === "string" && oldSession.title
        ? oldSession.title
        : oldSession.id,
      activeSessionId === undefined,
    );
  }

  if (!activeSessionId && tabOrder.length > 0) {
    activeSessionId = tabOrder[tabOrder.length - 1];
  }

  return {
    sessions: {
      activeSessionId,
      tabOrder,
      tabDescriptors,
    },
    sessionCatalog: {
      lastSessionId: oldSession.lastSessionId ?? oldSession.id,
    },
  };
}

/**
 * Rehydrate guard. Never trusts persisted runtime state, dedupes tab order and
 * makes sure the active id points at a real descriptor.
 */
export function normalizePersistedSessionsState(
  state: PersistedV2,
): PersistedV2 {
  const seen = new Set<string>();
  const tabOrder: string[] = [];
  for (const sessionId of state.sessions?.tabOrder ?? []) {
    if (typeof sessionId !== "string" || !sessionId || seen.has(sessionId)) {
      continue;
    }
    if (!state.sessions.tabDescriptors?.[sessionId]) {
      continue;
    }
    seen.add(sessionId);
    tabOrder.push(sessionId);
  }

  const tabDescriptors: Record<string, PersistedTabDescriptorV2> = {};
  for (const sessionId of tabOrder) {
    const descriptor = state.sessions.tabDescriptors[sessionId];
    tabDescriptors[sessionId] = {
      ...descriptor,
      sessionId,
      mode: normalizeSessionMode(descriptor.mode),
      persistedEditState: descriptor.persistedEditState
        ? {
            ...descriptor.persistedEditState,
            returnToMode: descriptor.persistedEditState.returnToMode
              ? normalizeSessionMode(descriptor.persistedEditState.returnToMode)
              : undefined,
          }
        : undefined,
      // Never rehydrate a loaded session: history is not persisted.
      loadState: LOAD_STATE_UNLOADED,
    };
  }

  const activeSessionId = seen.has(state.sessions?.activeSessionId ?? "")
    ? state.sessions.activeSessionId
    : tabOrder[tabOrder.length - 1];

  return {
    sessions: { activeSessionId, tabOrder, tabDescriptors },
    sessionCatalog: {
      lastSessionId: state.sessionCatalog?.lastSessionId,
    },
  };
}

/** Catalog list is not persisted in v2; keep the type handy for tests. */
export type PersistedCatalogMetadata = BaseSessionMetadata;
