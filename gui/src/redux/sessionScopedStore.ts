import type { RootState } from "./store";

/**
 * 方案.md §九.1/§九.2: every mounted tab needs its own "active session" view.
 *
 * A session-scoped store is a thin facade over the real store: `getState`
 * returns the same state with `sessions.activeSessionId` replaced by the tab's
 * id, while `dispatch`/`subscribe` go straight to the real store. Components
 * keep using the existing selectors, but a tree mounted under
 * `<Provider store={scoped}>` only ever sees its own session.
 *
 * The scoped state is memoized per real-state reference, so
 * `useSyncExternalStore` sees a stable snapshot (a new object per call would
 * re-render forever).
 */

export type SessionScopedStore = {
  getState: () => RootState;
  dispatch: (...args: any[]) => any;
  subscribe: (listener: () => void) => () => void;
  /** The real store, for code that must read the true active session. */
  realStore: SessionScopedStore | any;
};

const scopedStores = new WeakMap<object, Map<string, SessionScopedStore>>();

export function getSessionScopedStore(
  store: { getState: () => RootState; dispatch: any; subscribe: any },
  sessionId: string,
): SessionScopedStore {
  let bySession = scopedStores.get(store);
  if (!bySession) {
    bySession = new Map();
    scopedStores.set(store, bySession);
  }
  const existing = bySession.get(sessionId);
  if (existing) {
    return existing;
  }

  let lastRealState: RootState | undefined;
  let lastScopedState: RootState | undefined;

  const scoped: SessionScopedStore = {
    getState: () => {
      const real = store.getState();
      if (real !== lastRealState) {
        lastRealState = real;
        lastScopedState = {
          ...real,
          sessions: { ...real.sessions, activeSessionId: sessionId },
        };
      }
      return lastScopedState!;
    },
    dispatch: (...args: any[]) => store.dispatch(...args),
    subscribe: (listener: () => void) => store.subscribe(listener),
    realStore: store,
  };

  bySession.set(sessionId, scoped);
  return scoped;
}

/** The real store behind a scoped one (used by the tab bar, dialogs, ...). */
export function realStoreOf(store: any): any {
  return store?.realStore ?? store;
}
