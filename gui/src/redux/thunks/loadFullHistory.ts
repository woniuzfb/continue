import { createAsyncThunk } from "@reduxjs/toolkit";
import { v4 as uuidv4 } from "uuid";

import { setFullHistory } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

/**
 * 在懒加载状态下，发送新消息前调用：合并磁盘头部未加载部分与当前 state.history，
 * 清除 truncated 标记，确保 LLM 收到完整历史上下文。
 *
 * 合并策略（与 save 一致）：磁盘 history[0..headCount) + 当前 state.history。
 * 这样保留了前端的 truncate/delete/edit 操作（这些只改了已加载的尾部），
 * 同时补全未加载的头部。若直接用磁盘全量覆盖会丢失这些操作。
 *
 * 如果当前 history 已完整（historyTruncated !== true），直接返回。
 * 失败时 throw，让调用方（streamResponse）能感知并中止发送。
 */
export const loadFullHistory = createAsyncThunk<void, void, ThunkApiType>(
  "session/loadFullHistory",
  async (_, { getState, dispatch, extra }) => {
    const state = getState().session;

    if (!state.historyTruncated) {
      return;
    }

    // 从磁盘加载完整 session（用于取未加载的头部）
    const result = await extra.ideMessenger.request("history/load", {
      id: state.id,
    });

    if (result.status === "error") {
      // 抛错而非静默吞错：调用方通过 .unwrap() 感知失败，
      // 避免在部分 history 上发送消息导致 LLM 上下文缺失
      throw new Error(`loadFullHistory failed: ${result.error}`);
    }

    const diskHistory = result.content.history;
    const headCount = state.historyLoadedOffset ?? 0;

    // 守卫：historyTruncated=true 蕴含磁盘上应存在 headCount 条头部消息。
    // 若磁盘 history 短于尾部（文件缺失时 load() 返回空、JSON 损坏被静默
    // 吞掉、或多窗口并发改写），继续合并会静默丢弃头部、以部分上下文发送，
    // 且发送结束的自动 save 会用尾部-only 覆盖磁盘，永久破坏原文件。
    // 这里显式失败：streamResponse 会 setInactive 并中止发送（复用既有
    // 错误对话框路径），保留磁盘原状以便修复。
    if (diskHistory.length < headCount) {
      throw new Error(
        `loadFullHistory: on-disk history (${diskHistory.length}) is shorter ` +
          `than the expected frozen head (${headCount}). Refusing to merge ` +
          `a partial context and overwrite the session file; aborting send.`,
      );
    }

    // 合并：磁盘头部未加载部分 + 当前已加载（可能被 truncate/delete/edit 过）的尾部。
    const safeHeadCount = Math.min(headCount, diskHistory.length);
    const mergedHistory = [
      ...diskHistory.slice(0, safeHeadCount),
      ...state.history,
    ];

    // 保留 message id：头部来自磁盘（已有 id），尾部来自 state（已有 id），
    // 仅对缺失 id 的旧消息补一个新 uuid
    const historyWithIds = mergedHistory.map((item) => ({
      ...item,
      message: {
        ...item.message,
        id: (item.message as { id?: string }).id ?? uuidv4(),
      },
    }));

    // setFullHistory reducer 已清除所有分页标记（historyTruncated 等）
    dispatch(setFullHistory(historyWithIds));
  },
);
