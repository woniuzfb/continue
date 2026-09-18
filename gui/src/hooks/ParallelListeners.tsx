import { useCallback, useContext, useEffect, useRef } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";

import { FromCoreProtocol } from "core/protocol";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import { setConfigLoading, setConfigResult } from "../redux/slices/configSlice";
import { updateIndexingStatus } from "../redux/slices/indexingSlice";
import {
  initializeProfilePreferences,
  setProfiles,
  setSelectedProfile,
} from "../redux/slices/profilesSlice";
import { setSessionCatalogLoading } from "../redux/slices/sessionCatalogSlice";
import {
  addContextItemsByMessageId,
  setSessionLastNonEditSessionWasEmpty,
  setSessionReasoningEnabled,
} from "../redux/slices/sessionsSlice";
import { setTTSActive } from "../redux/slices/uiSlice";

import { modelSupportsReasoning } from "core/llm/autodetect";
import { routeApplyStateUpdate } from "../redux/thunks/sessionApplyState";
import { stopActiveSessionStream } from "../redux/thunks/sessionStreams";

import {
  selectActiveHistory,
  selectActiveIsInEdit,
  selectActiveSessionId,
} from "../redux/selectors/sessionView";
import {
  ensureActiveSessionLoaded,
  refreshSessionCatalog,
} from "../redux/thunks/sessionLifecycle";
import { probeHostCapabilities } from "../redux/thunks/sessionMessageIdMigration";
import { updateSessionFileSymbolsFromHistory } from "../redux/thunks/updateFileSymbols";
import {
  setDocumentStylesFromLocalStorage,
  setDocumentStylesFromTheme,
} from "../styles/theme";
import { isJetBrains } from "../util";
import { setLocalStorage } from "../util/localStorage";
import { migrateLocalStorage } from "../util/migrateLocalStorage";
import { useWebviewListener } from "./useWebviewListener";

function ParallelListeners() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const history = useAppSelector(selectActiveHistory);
  const isInEdit = useAppSelector(selectActiveIsInEdit);
  const selectedProfileId = useAppSelector(
    (store) => store.profiles.selectedProfileId,
  );
  const reasoningSettings = useAppSelector(
    (store) => store.ui.reasoningSettings,
  );
  const hasDoneInitialConfigLoad = useRef(false);

  // Load symbols for chat on any session change
  const sessionId = useAppSelector((state) => selectActiveSessionId(state));

  const handleConfigUpdate = useCallback(
    async (isInitial: boolean, result: FromCoreProtocol["configUpdate"][0]) => {
      const { result: configResult, profileId, profiles } = result;
      if (isInitial && hasDoneInitialConfigLoad.current) {
        return;
      }
      if (configResult.configLoadInterrupted || !configResult.config) {
        return;
      }
      hasDoneInitialConfigLoad.current = true;
      dispatch(setProfiles(profiles));
      dispatch(setSelectedProfile(profileId));
      dispatch(setConfigResult(configResult));

      const isNewProfileId = profileId && profileId !== selectedProfileId;

      if (isNewProfileId) {
        dispatch(
          initializeProfilePreferences({
            defaultSlashCommands: [],
            profileId,
          }),
        );
      }

      // Perform any actions needed with the config
      if (configResult.config?.ui?.fontSize) {
        setLocalStorage("fontSize", configResult.config.ui.fontSize);
        document.body.style.fontSize = `${configResult.config.ui.fontSize}px`;
      }

      const chatModel = configResult.config?.selectedModelByRole.chat;
      const supportsReasoning = modelSupportsReasoning(chatModel);
      const isReasoningDisabled =
        chatModel?.completionOptions?.reasoning === false;
      // LLM: prefix models default to reasoning disabled unless the user
      // has explicitly toggled it on for this model.
      const isLLMPrefix =
        chatModel?.model?.startsWith("LLM:") ||
        chatModel?.model?.startsWith("openrouter:") ||
        chatModel?.model?.startsWith("opencode:");
      const userReasoningPref = chatModel?.title
        ? reasoningSettings[chatModel.title]
        : undefined;
      const wasReasoningPreviouslyEnabled =
        userReasoningPref !== undefined ? userReasoningPref : !isLLMPrefix;
      if (sessionId) {
        dispatch(
          setSessionReasoningEnabled({
            sessionId,
            enabled:
              supportsReasoning &&
              !isReasoningDisabled &&
              wasReasoningPreviouslyEnabled,
            source: "derived",
          }),
        );
      }
    },
    [dispatch, hasDoneInitialConfigLoad, selectedProfileId, reasoningSettings],
  );

  // Load config from the IDE
  useEffect(() => {
    async function initialLoadConfig() {
      dispatch(setSessionCatalogLoading({ isLoading: true }));
      dispatch(setConfigLoading(true));
      const result = await ideMessenger.request(
        "config/getSerializedProfileInfo",
        undefined,
      );
      if (result.status === "success") {
        await handleConfigUpdate(true, result.content);
      }
      dispatch(setConfigLoading(false));
      // 方案.md §五.16: redux-persist rehydrates asynchronously, so the tab to
      // load is resolved here (after the config round-trip) rather than being
      // captured at first render — at first render `activeSessionId` is still
      // empty and the restored tabs would never be loaded from disk.
      await dispatch(ensureActiveSessionLoaded());
    }
    void initialLoadConfig();
    const interval = setInterval(() => {
      if (hasDoneInitialConfigLoad.current) {
        // Init to run on initial config load
        ideMessenger.post("docs/initStatuses", undefined);
        void dispatch(updateSessionFileSymbolsFromHistory({ sessionId }));
        void dispatch(refreshSessionCatalog({}));

        // This triggers sending pending status to the GUI for relevant docs indexes
        clearInterval(interval);
      } else {
        void initialLoadConfig();
      }
    }, 2_000);

    return () => clearInterval(interval);
  }, [hasDoneInitialConfigLoad, ideMessenger]);

  useWebviewListener(
    "configUpdate",
    async (update) => {
      if (!update) {
        return;
      }
      await handleConfigUpdate(false, update);
    },
    [handleConfigUpdate],
  );

  useEffect(() => {
    if (sessionId) {
      void dispatch(updateSessionFileSymbolsFromHistory({ sessionId }));
    }
  }, [sessionId]);

  // ON LOAD
  useEffect(() => {
    // Override persisted state
    void dispatch(stopActiveSessionStream());

    // P4a: ask the host once — through `getIdeInfo`, an existing type that every
    // host already answers — whether it forwards `history/migrateIds`. The
    // capability has to come from the host: Core implementing the handler says
    // nothing about whether the host routes the request (IntelliJ uses an
    // explicit allow-list), and an unrecognised type is dropped *without any
    // response*, which would leave the request pending forever and leak its
    // window listener. A host that does not declare it is never asked.
    void dispatch(probeHostCapabilities());

    const jetbrains = isJetBrains();
    setDocumentStylesFromLocalStorage(jetbrains);

    if (jetbrains) {
      // Save theme colors to local storage for immediate loading in JetBrains
      void ideMessenger
        .request("jetbrains/getColors", undefined)
        .then((result) => {
          if (result.status === "success") {
            setDocumentStylesFromTheme(result.content);
          }
        });

      // Tell JetBrains the webview is ready
      void ideMessenger
        .request("jetbrains/onLoad", undefined)
        .then((result) => {
          if (result.status === "error") {
            return;
          }

          const msg = result.content;
          (window as any).windowId = msg.windowId;
          (window as any).serverUrl = msg.serverUrl;
          (window as any).workspacePaths = msg.workspacePaths;
          (window as any).vscMachineId = msg.vscMachineId;
          (window as any).vscMediaUrl = msg.vscMediaUrl;
        });
    }
  }, []);

  useWebviewListener(
    "jetbrains/setColors",
    async (data) => {
      setDocumentStylesFromTheme(data);
    },
    [],
  );

  // IDE event listeners
  useWebviewListener(
    "getWebviewHistoryLength",
    async () => {
      return history.length;
    },
    [history],
  );

  useWebviewListener(
    "getCurrentSessionId",
    async () => {
      return sessionId;
    },
    [sessionId],
  );

  useWebviewListener("setInactive", async () => {
    void dispatch(stopActiveSessionStream());
  });

  useWebviewListener("setTTSActive", async (status) => {
    dispatch(setTTSActive(status));
  });

  useWebviewListener("addContextItem", async (data) => {
    const messageId = history[data.historyIndex]?.message.id;
    if (messageId) {
      dispatch(
        addContextItemsByMessageId({
          sessionId,
          messageId,
          contextItems: [data.item],
        }),
      );
    }
  });

  useWebviewListener("indexing/statusUpdate", async (data) => {
    dispatch(updateIndexingStatus(data));
  });

  useWebviewListener(
    "updateApplyState",
    async (state) => {
      // 方案.md §五.21: the event carries no sessionId, so its session is
      // resolved from the apply-origin registry, never from the visible tab.
      // Routing (and the drop-with-warning for an unknown stream) lives in
      // `routeApplyStateUpdate` so that no active-session fallback can creep
      // back in here.
      void dispatch(routeApplyStateUpdate({ applyState: state }));
    },
    [],
  );

  useEffect(() => {
    if (!isInEdit) {
      if (sessionId) {
        dispatch(
          setSessionLastNonEditSessionWasEmpty({
            sessionId,
            isEmpty: history.length === 0,
          }),
        );
      }
    }
  }, [isInEdit, history]);

  useEffect(() => {
    migrateLocalStorage(dispatch);
  }, []);

  return <></>;
}

export default ParallelListeners;
