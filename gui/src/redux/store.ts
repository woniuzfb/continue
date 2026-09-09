import {
  combineReducers,
  configureStore,
  ThunkDispatch,
  UnknownAction,
} from "@reduxjs/toolkit";
import { createLogger } from "redux-logger";
import {
  createMigrate,
  MigrationManifest,
  persistReducer,
  persistStore,
} from "redux-persist";
import { createFilter } from "redux-persist-transform-filter";
import autoMergeLevel2 from "redux-persist/lib/stateReconciler/autoMergeLevel2";
import storage from "redux-persist/lib/storage";
import {
  migratePersistedStateToV2,
  normalizePersistedSessionsState,
} from "./persistV2";
import { IdeMessenger, IIdeMessenger } from "../context/IdeMessenger";
import configReducer from "./slices/configSlice";
import editModeStateReducer from "./slices/editState";
import indexingReducer from "./slices/indexingSlice";
import { profilesReducer } from "./slices/profilesSlice";
import sessionCatalogReducer from "./slices/sessionCatalogSlice";
import sessionsReducer from "./slices/sessionsSlice";
import uiReducer from "./slices/uiSlice";

const rootReducer = combineReducers({
  // 方案.md §五.1/§五.3: sessions/sessionCatalog are the session state; the
  // legacy session/tabs slices are gone. editModeState remains until the edit
  // flow moves its runtime into the session.
  sessions: sessionsReducer,
  sessionCatalog: sessionCatalogReducer,
  ui: uiReducer,
  editModeState: editModeStateReducer,
  config: configReducer,
  indexing: indexingReducer,
  profiles: profilesReducer,
});

const saveSubsetFilters = [
  createFilter("editModeState", [
    "returnToMode",
    "lastNonEditSessionWasEmpty",
    "codeToEdit",
  ]),
  createFilter("config", []),
  createFilter("ui", [
    "toolSettings",
    "toolGroupSettings",
    "ruleSettings",
    "reasoningSettings",
  ]),
  createFilter("indexing", []),
  createFilter("profiles", ["preferencesByProfileId", "selectedProfileId"]),
  // Phase 1 target shape: only the tab projection and the catalog pointer.
  // sessionsById / history / streams / aborters are never persisted.
  createFilter("sessions", ["activeSessionId", "tabOrder", "tabDescriptors"]),
  createFilter("sessionCatalog", ["lastSessionId"]),
];

const migrations: MigrationManifest = {
  "0": (state) => {
    const oldState = state as any;
    return {
      config: {
        defaultModelTitle: oldState?.state?.defaultModelTitle ?? undefined,
      },
      session: {
        id: oldState?.state?.sessionId ?? "",
      },
      tabs: {
        tabs: [
          {
            id:
              Date.now().toString(36) + Math.random().toString(36).substring(2),
            title: "Chat 1",
            isActive: true,
          },
        ],
      },
      _persist: oldState?._persist,
    };
  },
  // v1 -> v2 (方案.md §五.23): the persisted shape becomes the tab projection
  // plus the catalog pointer. Runtime state is never persisted.
  "1": (state) => migratePersistedStateToV2(state) as any,
};

const persistConfig = {
  version: 2,
  key: "root",
  storage,
  transforms: [...saveSubsetFilters],
  stateReconciler: autoMergeLevel2,
  migrate: createMigrate(migrations, { debug: false }),
};

/**
 * Rehydrate guard (方案.md §五.23): never trust the persisted tab projection.
 * A rehydrated descriptor only says which session should be opened; history is
 * always loaded from disk afterwards.
 */
const normalizedReducer = (
  state: ReturnType<typeof rootReducer> | undefined,
  action: Parameters<typeof rootReducer>[1],
) => {
  const next = rootReducer(state, action);
  if (action.type === "persist/REHYDRATE") {
    const rehydrated = normalizePersistedSessionsState({
      sessions: (next as any).sessions,
      sessionCatalog: (next as any).sessionCatalog,
    });
    return {
      ...next,
      sessions: { ...(next as any).sessions, ...rehydrated.sessions },
      sessionCatalog: {
        ...(next as any).sessionCatalog,
        ...rehydrated.sessionCatalog,
      },
    } as ReturnType<typeof rootReducer>;
  }
  return next;
};

const persistedReducer = persistReducer<ReturnType<typeof rootReducer>>(
  persistConfig,
  normalizedReducer as typeof rootReducer,
);

export function setupStore(options: { ideMessenger?: IIdeMessenger }) {
  const ideMessenger = options.ideMessenger ?? new IdeMessenger();

  const logger = createLogger({
    // Customize logger options if needed
    collapsed: true, // Collapse console groups by default
    timestamp: false, // Remove timestamps from log
    diff: true, // Show diff between states
  });

  return configureStore({
    // persistedReducer causes type errors with async thunks
    reducer: persistedReducer as unknown as typeof rootReducer,
    // reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: false,
        // AbortControllers live in session runtime state by design
        // (方案.md §五.11): Stop aborts the target session's controller, which
        // is a deliberate out-of-reducer mutation of a non-serializable
        // object. The immutable check cannot model that.
        immutableCheck: false,
        thunk: {
          extraArgument: {
            ideMessenger,
          },
        },
      }),
    // This can be uncommented to get detailed Redux logs
    // .concat(logger),
  });
}

export type ThunkExtrasType = { ideMessenger: IIdeMessenger };

export type ThunkApiType = {
  state: RootState;
  extra: ThunkExtrasType;
  /** Explicit so nested thunk dispatches keep their payload types. */
  dispatch: AppThunkDispatch;
};

export type AppThunkDispatch = ThunkDispatch<
  RootState,
  ThunkExtrasType,
  UnknownAction
>;

export const store = setupStore({});

export type RootState = ReturnType<typeof rootReducer>;

export type AppDispatch = typeof store.dispatch;

export const persistor = persistStore(store);
