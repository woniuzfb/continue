import { createAsyncThunk } from "@reduxjs/toolkit";
import { LLMFullCompletionOptions } from "core";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";
import { selectActiveTools } from "../selectors/selectActiveTools";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  ChatHistoryItemWithMessageId,
  setContextInputTokens,
  setContextLength,
  setContextMetrics,
  setContextPercentage,
  setIsPruned,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";

/**
 * 触发一次 context 指标计算，把 contextPercentage / isPruned /
 * contextInputTokens / contextLength dispatch 到 redux，同时保存完整快照。
 *
 * 用途：
 *  - 加载历史会话后若无 contextMetrics 快照（旧会话/model 不匹配）时填充指标
 *
 * 设计要点：
 *  - 懒加载场景（historyTruncated=true）：通过 history/load 从磁盘读取完整
 *    history 仅用于 compile，不更新前端 state（不 dispatch loadFullHistory），
 *    保持懒加载状态不被破坏
 *  - 复用 streamNormalInput 的 precompile 构建片段（systemMessage / tools /
 *    constructMessages），保证与发送消息时的 token 计数一致
 *  - 失败时静默（console.warn），不阻塞调用方流程
 */
export const compileChatForContextMetrics = createAsyncThunk<
  void,
  void,
  ThunkApiType
>(
  "session/compileChatForContextMetrics",
  async (_, { getState, dispatch, extra }) => {
    const state = getState();
    const selectedChatModel = selectSelectedChatModel(state);

    if (!selectedChatModel) {
      return;
    }

    // 空 history 无需 compile
    if (!state.session.history?.length) {
      return;
    }

    // 懒加载场景：前端只有部分 history，直接 compile 会系统性偏低 token 数。
    // 从磁盘读取完整 history 仅用于 compile，不更新前端 state，
    // 保持 historyTruncated 标记和懒加载分页状态不被破坏。
    let historyForCompile: ChatHistoryItemWithMessageId[] =
      state.session.history;
    if (state.session.historyTruncated) {
      try {
        const result = await extra.ideMessenger.request("history/load", {
          id: state.session.id,
        });
        if (result.status === "error") {
          console.warn(
            "compileChatForContextMetrics: history/load failed",
            result.error,
          );
          return;
        }
        // 磁盘 session 文件中 message 已带 id（save 时序列化），
        // 但 Session.history 类型声明为 ChatHistoryItem[]，这里断言为 WithMessageId
        historyForCompile = result.content
          .history as ChatHistoryItemWithMessageId[];
      } catch (e) {
        console.warn("compileChatForContextMetrics: history/load failed", e);
        return;
      }
    }

    // 复用 streamNormalInput 的 precompile 构建逻辑
    let activeTools = selectActiveTools(state);
    if (selectedChatModel.toolOverrides?.length) {
      const { tools: overriddenTools, errors } = applyToolOverrides(
        activeTools,
        selectedChatModel.toolOverrides,
      );
      activeTools = overriddenTools;
      for (const error of errors) {
        if (!error.fatal) {
          console.warn(`Tool override warning: ${error.message}`);
        }
      }
    }

    const useNativeTools = state.config.config.experimental
      ?.onlyUseSystemMessageTools
      ? false
      : modelSupportsNativeTools(selectedChatModel);
    const systemToolsFramework = !useNativeTools
      ? new SystemMessageToolCodeblocksFramework()
      : undefined;

    let completionOptions: LLMFullCompletionOptions = {};
    if (useNativeTools && activeTools.length > 0) {
      completionOptions = { tools: activeTools };
    }

    const baseSystemMessage = state.config.config.ui?.skipBaseSystemMessage
      ? ""
      : getBaseSystemMessage(
          state.session.mode,
          selectedChatModel,
          activeTools,
        );

    const systemMessage = systemToolsFramework
      ? addSystemMessageToolsToSystemMessage(
          systemToolsFramework,
          baseSystemMessage,
          activeTools,
        )
      : baseSystemMessage;

    const withoutMessageIds = historyForCompile.map((item) => {
      const { id, ...messageWithoutId } = item.message;
      return { ...item, message: messageWithoutId };
    });

    const { messages } = constructMessages(
      withoutMessageIds,
      systemMessage,
      state.config.config.rules,
      state.ui.ruleSettings,
      systemToolsFramework,
    );

    const precompiledRes = await extra.ideMessenger.request("llm/compileChat", {
      messages,
      options: completionOptions,
    });

    if (precompiledRes.status === "error") {
      console.warn(
        "compileChatForContextMetrics failed:",
        precompiledRes.error,
      );
      return;
    }

    const { didPrune, contextPercentage, inputTokens, contextLength } =
      precompiledRes.content;

    dispatch(setIsPruned(didPrune));
    dispatch(setContextPercentage(contextPercentage));
    if (inputTokens !== undefined) {
      dispatch(setContextInputTokens(inputTokens));
    }
    if (contextLength !== undefined) {
      dispatch(setContextLength(contextLength));
    }
    // 保存指标快照（不含 compiledChatMessages，避免 session 文件膨胀），
    // 下次加载该会话时直接还原
    dispatch(
      setContextMetrics({
        didPrune,
        contextPercentage,
        inputTokens,
        contextLength,
      }),
    );
  },
);
