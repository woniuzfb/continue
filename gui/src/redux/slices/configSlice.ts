import { ConfigResult, ConfigValidationError } from "@continuedev/config-yaml";
import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { BrowserSerializedContinueConfig, ModelDescription } from "core";
import { DEFAULT_CONTEXT_LENGTH } from "core/llm/constants";

export type ConfigState = {
  configError: ConfigValidationError[] | undefined;
  config: BrowserSerializedContinueConfig;
  loading: boolean;
  /**
   * Runtime-only model projection for the active tab (方案.md §五.17). Tab
   * activation must not rewrite the persisted user selection, so it sets this
   * instead of updateSelectedModelByRole(). Never persisted (the config persist
   * filter is an empty whitelist) and cleared/overwritten on explicit choice.
   */
  activeSessionModelProjection?: ModelDescription | null;
};

export const EMPTY_CONFIG: BrowserSerializedContinueConfig = {
  slashCommands: [],
  contextProviders: [],
  tools: [],
  mcpServerStatuses: [],
  modelsByRole: {
    chat: [],
    apply: [],
    edit: [],
    summarize: [],
    autocomplete: [],
    rerank: [],
    embed: [],
    subagent: [],
  },
  selectedModelByRole: {
    chat: null,
    apply: null,
    edit: null,
    summarize: null,
    autocomplete: null,
    rerank: null,
    embed: null,
    subagent: null,
  },
  rules: [],
};

export const INITIAL_CONFIG_SLICE: ConfigState = {
  configError: undefined,
  config: EMPTY_CONFIG,
  loading: false,
};

export const configSlice = createSlice({
  name: "config",
  initialState: INITIAL_CONFIG_SLICE,
  reducers: {
    setConfigResult: (
      state,
      {
        payload: result,
      }: PayloadAction<ConfigResult<BrowserSerializedContinueConfig>>,
    ) => {
      const { config, errors } = result;
      if (!errors || errors.length === 0) {
        state.configError = undefined;
      } else {
        state.configError = errors;
      }

      // If an error is found in config on save,
      // We must invalidate the GUI config too,
      // Since core won't be able to load config
      // Don't invalidate the loaded config
      if (!config) {
        state.config = EMPTY_CONFIG;
      } else {
        state.config = config;
      }
      state.loading = false;
    },
    updateConfig: (
      state,
      { payload: config }: PayloadAction<BrowserSerializedContinueConfig>,
    ) => {
      state.config = config;
    },
    setConfigLoading: (state, { payload: loading }: PayloadAction<boolean>) => {
      state.loading = loading;
    },
    /**
     * Tab activation projection (方案.md §五.17). Must not persist the choice,
     * mark a session dirty, or notify the IDE — those belong to an explicit
     * user model change.
     */
    setActiveSessionModelProjection: (
      state,
      { payload }: PayloadAction<{ model?: ModelDescription | null }>,
    ) => {
      state.activeSessionModelProjection = payload.model;
    },
  },
  selectors: {
    selectSelectedChatModelContextLength: (state): number => {
      return (
        (
          state.activeSessionModelProjection ??
          state.config.selectedModelByRole.chat
        )?.contextLength || DEFAULT_CONTEXT_LENGTH
      );
    },
    selectSelectedChatModel: (state) => {
      // The active tab's projection wins; it is set by tab activation and by
      // an explicit model choice, and never persisted on its own.
      return (
        state.activeSessionModelProjection ??
        state.config.selectedModelByRole.chat
      );
    },
    selectUserSelectedChatModel: (state) => {
      return state.config.selectedModelByRole.chat;
    },
    selectUIConfig: (state) => {
      return state.config?.ui ?? null;
    },
  },
});

export const {
  updateConfig,
  setConfigResult,
  setConfigLoading,
  setActiveSessionModelProjection,
} = configSlice.actions;

export const {
  selectSelectedChatModelContextLength,
  selectUIConfig,
  selectSelectedChatModel,
  selectUserSelectedChatModel,
} = configSlice.selectors;

export default configSlice.reducer;
