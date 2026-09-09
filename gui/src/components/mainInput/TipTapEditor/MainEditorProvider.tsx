import { Editor } from "@tiptap/react";
import { InputModifiers } from "core";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { setSessionMainEditorContentTrigger } from "../../../redux/slices/sessionsSlice";
import { useMainEditorWebviewListeners } from "./useMainEditorWebviewListeners";

import { useStore } from "react-redux";
import { realStoreOf } from "../../../redux/sessionScopedStore";
import type { RootState } from "../../../redux/store";

/**
 * Context for accessing the main editor instance
 */
interface MainEditorContextType {
  /** The session this editor instance belongs to (方案.md §九). */
  sessionId: string;
  /** The current main editor instance */
  mainEditor: Editor | null;
  /** Set the current main editor instance */
  setMainEditor: (editor: Editor | null) => void;
  /** The current input ID */
  inputId: string | null;
  /** Set the current input ID */
  setInputId: (id: string) => void;
  /** Reference to the execute content function */
  onEnterRef: React.MutableRefObject<(modifiers: InputModifiers) => void>;
}

const initialState: MainEditorContextType = {
  sessionId: "",
  mainEditor: null,
  setMainEditor: () => {},
  inputId: null,
  setInputId: () => {},
  onEnterRef: { current: () => {} },
};

const MainEditorContext = createContext<MainEditorContextType | null>(null);

/**
 * 方案.md §九.0: the shell (Layout, dialogs) is outside every per-tab provider,
 * so it resolves the *active* tab's editor through this registry. The active
 * provider publishes itself here; `useMainEditor` falls back to it.
 */
const activeEditors = new Map<string, MainEditorContextType>();
let registryVersion = 0;
const registryListeners = new Set<() => void>();

function publishActiveEditor(
  sessionId: string,
  value: MainEditorContextType,
): void {
  activeEditors.set(sessionId, value);
  registryVersion++;
  registryListeners.forEach((listener) => listener());
}

function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

/**
 * Provider component that maintains a reference to the main editor
 */
export const MainEditorProvider: React.FC<{
  /** 方案.md §九: the provider owns exactly one session's editor instance. */
  sessionId: string;
  children: React.ReactNode;
}> = ({ sessionId, children }) => {
  const dispatch = useAppDispatch();
  const [mainEditor, setMainEditorInternal] = useState<Editor | null>(
    initialState.mainEditor,
  );
  const [inputId, setInputId] = useState<string | null>(initialState.inputId);
  const onEnterRef = useRef<(modifiers: InputModifiers) => void>(() => {});
  const editorFocusedRef = useRef<boolean>(false);
  const store = useStore<RootState>();
  const historyLength = useAppSelector(
    (state) => state.sessions.sessionsById[sessionId]?.history.length ?? 0,
  );

  // Listen for changes to this session's mainEditorContentTrigger.
  const mainEditorContentTrigger = useAppSelector(
    (state) => state.sessions.sessionsById[sessionId]?.mainEditorContentTrigger,
  );

  useEffect(() => {
    if (mainEditor && mainEditorContentTrigger) {
      queueMicrotask(() => {
        mainEditor.commands.setContent(mainEditorContentTrigger);
      });
      // Clear the trigger after using it
      dispatch(
        setSessionMainEditorContentTrigger({ sessionId, content: undefined }),
      );
    }
  }, [mainEditor, mainEditorContentTrigger, dispatch, sessionId]);

  // Update focused ref when editor focus state changes
  useEffect(() => {
    if (mainEditor) {
      const updateFocus = () => {
        editorFocusedRef.current = mainEditor.isFocused || false;
      };

      mainEditor.on("focus", updateFocus);
      mainEditor.on("blur", updateFocus);

      return () => {
        mainEditor.off("focus", updateFocus);
        mainEditor.off("blur", updateFocus);
      };
    }
  }, [mainEditor]);

  // Set up main editor webview listeners when we have a valid editor and input ID
  useMainEditorWebviewListeners({
    sessionId,
    editor: mainEditor,
    onEnterRef,
    dispatch,
    historyLength,
    inputId: inputId || "",
    editorFocusedRef,
  });

  const setMainEditor = (newEditor: Editor | null) => {
    setMainEditorInternal(newEditor);
  };

  const value: MainEditorContextType = {
    sessionId,
    mainEditor,
    setMainEditor,
    inputId,
    setInputId,
    onEnterRef,
  };

  // Publish only for the session the real store considers active, so the shell
  // resolves the visible tab's editor.
  const isRealActive = useAppSelector(
    (state) => state.sessions.activeSessionId === sessionId,
  );
  useEffect(() => {
    if (isRealActive) {
      publishActiveEditor(sessionId, value);
    }
  }, [isRealActive, sessionId, mainEditor, inputId]);

  return (
    <MainEditorContext.Provider value={value}>
      {children}
    </MainEditorContext.Provider>
  );
};

/**
 * Hook to access the main editor context. Inside a per-tab provider it returns
 * that tab's editor; in the shell it returns the active tab's editor.
 */
export const useMainEditor = (): MainEditorContextType => {
  const context = useContext(MainEditorContext);
  const realActiveSessionId = useAppSelector(
    (state) => realStoreOf(useStore())?.getState?.().sessions.activeSessionId,
  );
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useSyncExternalStore(
    subscribeRegistry,
    () => registryVersion,
    () => registryVersion,
  );
  if (context) {
    return context;
  }
  return (
    (realActiveSessionId && activeEditors.get(realActiveSessionId)) ||
    initialState
  );
};
