import * as fs from "fs";

import { BaseSessionMetadata, Session } from "../index.js";
import type { PersistedContextMetrics, SessionChatModelRef } from "../index.js";
import {
  isJsonSafeMetricsSnapshot,
  type FullConversationMetricsResult,
} from "./fullConversationMetrics";
import { ListHistoryOptions } from "../protocol/core.js";

import { NEW_SESSION_TITLE } from "./constants.js";
import {
  collapseFileContentBlocks,
  stripInlineImageBase64,
} from "./messageContent.js";
import {
  getSessionFilePath,
  getSessionsFolderPath,
  getSessionsListPath,
} from "./paths.js";
import {
  decodePromptLogDeltas,
  encodePromptLogDeltas,
} from "./promptLogDelta.js";
import { extractFirstTurnItems } from "./firstTurn.js";
import {
  invalidateMessageIdAllocations,
  readMessageId,
  stabilizeWholeHistory,
} from "./messageIdStabilization.js";
import { SessionPersistenceError } from "./sessionPersistenceError.js";
import type { SaveHistoryResponse } from "../protocol/core";
import type { MigrateMessageIdsResponse } from "../protocol/core";
import type { ChatHistoryItem } from "../index";
function safeParseArray<T>(
  value: string,
  errorMessage: string = "Error parsing array",
): T[] | undefined {
  try {
    return JSON.parse(value) as T[];
  } catch (e: any) {
    console.warn(`${errorMessage}: ${e}`);
    return undefined;
  }
}

// 跨进程会话写锁。fs.mkdirSync 在同一文件系统上是原子操作（目录已存在会抛
// EEXIST），因此把它当互斥量：谁先建成锁目录谁持有锁。用来串行化 save() 里的
// “读→合并→写”，避免两个 IDE 窗口编辑【同一】session 时互相覆盖（lost update）。
// 说明：这是每 session 一把锁；跨【不同】session 对共享 sessions.json 的竞争不在
// 此锁范围内（那是低风险的元数据，且需要另一把全局锁），此处只解决用户关心的
// “同一会话被两个窗口打开”的场景。
// 不变量：STALE < TIMEOUT（必须成立）。否则当锁持有进程崩溃、而某个等待方
// 恰在锁刚创建时到达（gap≈0），该等待方会在 TIMEOUT 放弃时，锁的年龄才刚到
// TIMEOUT（< STALE），于是【无法回收】崩溃残留的锁——它只能无锁降级，陈旧锁
// 一直悬着，直到下一个更晚到的等待方才清理。令 STALE < TIMEOUT 可保证：即便
// gap=0 的等待方也能在放弃前把陈旧锁回收并拿到锁。
// 用调小 STALE（而非调大 TIMEOUT）来满足此不变量，是为了不增大最坏阻塞时长
// （syncSleep 在事件循环上阻塞，见下）。STALE=8s 仍远大于一次 JSON 写入的真实
// 耗时（毫秒级），不会误回收活跃持有者的锁。
const SESSION_LOCK_STALE_MS = 8_000; // 超过此年龄的锁视为陈旧（持有者崩溃）并回收
const SESSION_LOCK_TIMEOUT_MS = 10_000; // 超过此时间仍拿不到锁则放弃等待
const SESSION_LOCK_RETRY_MS = 25;

// 会话持久化瘦身：只剥离用户消息中由附件元数据明确标识的块，避免
// 改写普通正文、代码示例或其他 history 字段中的字面量标签。
function stripAttachedFileContent(history: Session["history"] | undefined) {
  if (!history) return;
  for (const item of history) {
    if (item.message.role !== "user") continue;
    const attachments = item.message.metadata?.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) continue;
    const paths = new Set(
      attachments
        .map((attachment) =>
          typeof attachment === "object" && attachment !== null
            ? (attachment as { path?: unknown }).path
            : undefined,
        )
        .filter((path): path is string => typeof path === "string"),
    );
    if (paths.size === 0) continue;
    const stripText = (text: string) => {
      // Attachments are generated as line-delimited blocks. Requiring both
      // markers to occupy their own line avoids treating a tag mentioned in
      // ordinary prose or source code as an attachment boundary.
      const blockRe =
        /^[ \t]*<file_content path="([^"]*)">[ \t]*\r?\n([\s\S]*?)^[ \t]*<\/file_content>[ \t]*(?:\r?\n|$)/gim;
      return text.replace(
        blockRe,
        (
          block,
          path: string,
          body: string,
          offset: number,
          fullText: string,
        ) => {
          if (!paths.has(path)) return block;

          // A nested opening marker means this is source text, not the flat
          // attachment format emitted by buildAttachedFilesText. Leave it
          // untouched because a regex cannot reliably match nested blocks.
          if (/^[ \t]*<file_content\b/gim.test(body)) return block;

          // A standalone closing tag in the body is ambiguous: the lazy regex
          // stops at the first one. If another closing tag appears before the
          // next attachment opening, retaining the original text is safer than
          // silently dropping a suffix of the user's attached file.
          const remaining = fullText.slice(offset + block.length);
          const nextOpening = remaining.search(/^[ \t]*<file_content path="/im);
          const untilNextOpening =
            nextOpening === -1 ? remaining : remaining.slice(0, nextOpening);
          if (
            /^[ \t]*<\/file_content>[ \t]*(?:\r?\n|$)/im.test(untilNextOpening)
          ) {
            return block;
          }
          return `<file_content path="${path}"/>`;
        },
      );
    };
    if (typeof item.message.content === "string") {
      item.message.content = stripText(item.message.content);
    } else if (Array.isArray(item.message.content)) {
      item.message.content = item.message.content.map((part) =>
        part.type === "text" ? { ...part, text: stripText(part.text) } : part,
      );
    }
  }

  // promptLogs 瘦身：promptLog 记录的是 LLM 边界的最终渲染 prompt，当前
  // 消息的附件以完整 <file_content> 块形式进入（工具循环每轮各留一份全量
  // 拷贝），旧会话文件因此膨胀到 100MB+。这里把完整块折叠为自闭合标记
  // （与消息本体的瘦身格式一致），并按现有方法剥离内联 base64 图片。
  // 不做 attachment 路径匹配：promptLog 挂在 assistant 消息上，无从对照
  // user 消息的 metadata；且它是遥测产物，保留 path 即可。幂等。
  for (const item of history) {
    if (!item.promptLogs?.length) continue;
    for (const log of item.promptLogs) {
      if (typeof log.prompt === "string") {
        log.prompt = collapseFileContentBlocks(
          stripInlineImageBase64(log.prompt),
        );
      }
    }
  }

  // toolCallStates.processedArgs 瘦身：single_find_and_replace / multi_edit 在
  // 预处理阶段会把编辑前后的全量文件文本写入 processedArgs，对大文件每次编辑会
  // 膨胀数 MB。UI 在缺失这两个字段时会自动回退到 edits 渲染 diff，落盘与加载
  // 时剥离即可消除会话 JSON 膨胀。幂等。
  for (const item of history) {
    if (!item.toolCallStates?.length) continue;
    for (const tcs of item.toolCallStates) {
      if (!tcs.processedArgs) continue;
      if (
        "editingFileContents" in tcs.processedArgs ||
        "newFileContents" in tcs.processedArgs
      ) {
        const {
          editingFileContents: _old,
          newFileContents: _new,
          ...rest
        } = tcs.processedArgs;
        tcs.processedArgs = rest;
      }
    }
  }
}

// 会话持久化瘦身（结构化图片 part）：user 消息 content 里的 imageUrl base64
// 与 editorState 里的 image src 是同一张图的两份拷贝（content 的 imageUrl
// part 本就发送时从 editorState 派生）。落盘后 content 那份无人消费——
// 渲染/编辑重发/Resubmit 全部走 editorState（Chat.tsx 的
// `editorState ?? content` 兜底、StreamError.tsx 的 resubmit），而构造
// LLM 历史上下文时 data: imageUrl part 会被整体过滤
// （gui constructMessages.ts）。因此只在 editorState 存在（图片在编辑器
// 状态里仍是完整副本）时剥离 base64 载荷；剥离后保留 "data:<mime>;base64,"
// 前缀，确保上述过滤条件（startsWith("data:")）继续命中。幂等。
function stripContentImageUrlParts(history: Session["history"] | undefined) {
  if (!history) return;
  for (const item of history) {
    if (item.message.role !== "user") continue;
    if (item.editorState == null) continue; // content 是图片唯一副本，不可剥
    if (!Array.isArray(item.message.content)) continue;
    item.message.content = item.message.content.map((part) => {
      if (part.type !== "imageUrl") return part;
      const url = part.imageUrl?.url;
      if (typeof url !== "string" || !url.startsWith("data:")) return part;
      const payloadStart = url.indexOf(";base64,");
      if (payloadStart === -1) return part;
      const after = payloadStart + ";base64,".length;
      if (url.length <= after) return part; // 已剥离过
      return {
        ...part,
        imageUrl: { ...part.imageUrl, url: url.slice(0, after) },
      };
    });
  }
}

// 运行时守护不变量，防止未来有人调参数时不慎打破 STALE < TIMEOUT。
if (SESSION_LOCK_STALE_MS >= SESSION_LOCK_TIMEOUT_MS) {
  throw new Error(
    "[history] Invariant violated: SESSION_LOCK_STALE_MS must be < " +
      "SESSION_LOCK_TIMEOUT_MS, otherwise a crashed holder's lock cannot be " +
      "reclaimed by a waiter that arrives when the lock is created.",
  );
}

function sessionLockDir(sessionFilePath: string): string {
  return `${sessionFilePath}.lock`;
}

// 非阻塞睡眠：save()/delete() 已异步化（见下），锁重试用真正的 setTimeout 让出
// 事件循环，因此等待锁期间【不再阻塞】core 进程的 IPC/定时器。这是 P2-3b 用
// Atomics.wait 同步阻塞版本的替代——彻底消除事件循环停顿。
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 获取锁；成功返回锁目录路径，超时放弃则返回 ""（表示未持有）。
// 异步版：用 fs.promises.mkdir 原子建目录，重试期间 await sleep 让出事件循环。
async function acquireSessionLock(sessionFilePath: string): Promise<string> {
  const lockDir = sessionLockDir(sessionFilePath);
  const deadline = Date.now() + SESSION_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.promises.mkdir(lockDir);
      return lockDir; // 建目录成功 = 获得锁
    } catch (e: any) {
      if (e?.code !== "EEXIST") {
        throw e; // 非“已存在”的意外文件系统错误，向上抛
      }
      // 锁被他人持有：若看起来已陈旧（持有进程崩溃），回收后重试。
      try {
        const st = await fs.promises.stat(lockDir);
        const age = Date.now() - st.mtimeMs;
        if (age > SESSION_LOCK_STALE_MS) {
          await fs.promises.rm(lockDir, { recursive: true, force: true });
          continue; // 回收后立即重试
        }
      } catch {
        // stat/rm 与其它进程竞争：忽略，走等待重试。
      }
      if (Date.now() >= deadline) {
        // 不能让 save() 永久阻塞。放弃锁而不是丢用户数据：原子写 + 完整性守卫
        // 仍能防止“损坏/截断”，只剩极小概率的跨进程 lost-update 窗口。
        console.warn(
          `[history] Could not acquire session lock ${lockDir} within ` +
            `${SESSION_LOCK_TIMEOUT_MS}ms; proceeding without it.`,
        );
        return ""; // 空 = 未持有
      }
      await sleep(SESSION_LOCK_RETRY_MS);
    }
  }
}

async function releaseSessionLock(lockDir: string): Promise<void> {
  if (!lockDir) {
    return; // 从未真正持有
  }
  try {
    await fs.promises.rm(lockDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[history] Failed to release session lock ${lockDir}: ${e}`);
  }
}

// 全局 sessions.json 锁：所有 session 共享同一份 sessions.json 元数据文件，
// 两个进程（两个 IDE 窗口）保存【不同】session 时也会各自“读→改→写”这一份
// 文件，从而丢失彼此的元数据更新（lost update）。复用上面的 mkdir 原子锁，锁在
// sessions.json 本身上，把这段读改写串行化。锁获取顺序始终为“每-session 锁 →
// 全局锁”（save 先持 per-session 再取 global；delete 只取 global），无环、不会死锁。
async function acquireSessionsListLock(): Promise<string> {
  return acquireSessionLock(getSessionsListPath());
}
async function releaseSessionsListLock(lockDir: string): Promise<void> {
  await releaseSessionLock(lockDir);
}

/**
 * 方案.md §五.16.7: `history/save` 的可选计量回调。
 *
 * 回调在**保存锁内**、拿到合并后的 `finalHistory` 之后被调用 —— 计量必须与写盘看到同一份
 * 内容。回调由 `history/save` handler 组装（解析模型 + 请求里的构造输入），history 层
 * 因此不依赖 LLM 类，也不读 active model。
 */
export type SaveHistoryOptions = {
  measureFullConversation?: (
    finalHistory: ChatHistoryItem[],
  ) => FullConversationMetricsResult;
  /**
   * 方案.md §7.2.2：把这一次保存的分段耗时打到控制台（**扩展宿主** DevTools），前缀
   * `[submit-latency] save …`：等锁 / 瘦身 / 差分编码 / 计量 / 写盘 / catalog / 响应。
   * 由 GUI 的 debug 开关（`config.ui.showSubmitLatencyLogs`）决定，默认关闭。
   *
   * 起因：真实会话的一次终态保存被测到 3.3s，而载荷只有 4.3MB —— 只看总时长无法判断是
   * 等锁（`acquireSessionLock` 以 25ms 重试、上限 10s）、读盘、变换、计量还是写盘。
   */
  logTimings?: boolean;
};

/**
 * 读回磁盘上已有的 metrics（legacy 形状或完整 Result），供「只保存、不计量」的路径原样写回。
 * 文件缺失/不可解析时返回 undefined：那种情况没有可信的 metrics 可保留，
 * 但**不能**因此中断保存（数据完整性优先）。
 */
function readContextMetricsFromDisk(
  sessionId: string,
): PersistedContextMetrics | undefined {
  return readPreservedFieldsFromDisk(sessionId).contextMetrics;
}

/**
 * 磁盘上**不是由当前请求载荷决定**、必须原样保留的字段，一次解析读回（§7.5.4）。
 *
 * `chatModelRef` 与 `contextMetrics` 是同一类东西：载荷里没有它时，磁盘上的值才是权威 ——
 * metrics 由 Core 的锁内计量掌管，会话模型身份由 GUI 的显式选择掌管，两者的保存路径都
 * 可能"只带一半"。文件缺失/不可解析一律返回空对象：没有可信的原值，且**不能**因此中断保存。
 */
function readPreservedFieldsFromDisk(sessionId: string): {
  contextMetrics?: PersistedContextMetrics;
  /** `null` is preserved as the fact "the file states no identity", like an absent field. */
  chatModelRef?: SessionChatModelRef | null;
} {
  try {
    const sessionFilePath = getSessionFilePath(sessionId);
    if (!fs.existsSync(sessionFilePath)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(sessionFilePath, "utf8")) as Session;
    return {
      contextMetrics: raw.contextMetrics,
      chatModelRef: raw.chatModelRef,
    };
  } catch {
    return {};
  }
}

export class HistoryManager {
  list(options: ListHistoryOptions): BaseSessionMetadata[] {
    const filepath = getSessionsListPath();
    if (!fs.existsSync(filepath)) {
      return [];
    }
    const content = fs.readFileSync(filepath, "utf8");

    let sessions = safeParseArray<BaseSessionMetadata>(content) ?? [];
    sessions = sessions
      .filter((session: any) => {
        // Filter out old format
        return typeof session.session_id !== "string";
        // Reverse to show newest first; sessions.json is chronological by creation
      })
      .reverse();

    // Filter by workspace directory if provided
    if (options.workspaceDirectory) {
      const target = options.workspaceDirectory.toLowerCase();
      sessions = sessions.filter(
        (session) =>
          typeof session.workspaceDirectory === "string" &&
          session.workspaceDirectory.toLowerCase() === target,
      );
    }

    // Apply limit and offset
    if (options.limit) {
      const offset = options.offset || 0;
      sessions = sessions.slice(offset, offset + options.limit);
    }

    return sessions;
  }

  async delete(sessionId: string): Promise<void> {
    // 与 save() 一样先拿 per-session 锁：否则一个进行中的 save（持有锁、
    // 正在原子 rename）可能与这里的 unlink 竞争，导致 save 的 rename 在
    // unlink 之后重建文件 —— 留下“sessions.json 已无条目但文件还在”的孤儿。
    // 锁顺序与 save() 一致（per-session → 全局），无死锁。
    const sessionFile = getSessionFilePath(sessionId);
    const lockDir = await acquireSessionLock(sessionFile);
    try {
      // Delete a session
      if (!fs.existsSync(sessionFile)) {
        throw new Error(`Session file ${sessionFile} does not exist`);
      }
      fs.unlinkSync(sessionFile);

      // Read and update the sessions list（用全局锁串行化，避免与其它进程的
      // save/delete 并发读改写 sessions.json 时互相覆盖元数据）。
      const sessionsListFile = getSessionsListPath();
      const listLock = await acquireSessionsListLock();
      try {
        const sessionsListRaw = fs.readFileSync(sessionsListFile, "utf-8");
        let sessionsList =
          safeParseArray<BaseSessionMetadata>(
            sessionsListRaw,
            "Error parsing sessions.json",
          ) ?? [];

        sessionsList = sessionsList.filter(
          (session) => session.sessionId !== sessionId,
        );

        fs.writeFileSync(
          sessionsListFile,
          JSON.stringify(sessionsList, undefined, 2),
        );
      } finally {
        await releaseSessionsListLock(listLock);
      }
    } finally {
      await releaseSessionLock(lockDir);
    }
  }

  clearAll() {
    fs.rmSync(getSessionsFolderPath(), { recursive: true, force: true });
  }

  load(sessionId: string): Session {
    const sessionFile = getSessionFilePath(sessionId);
    if (!fs.existsSync(sessionFile)) {
      // 文件不存在是预期场景：新建的 session tab 在发消息前从未保存到磁盘。
      // 静默返回空 session，不作为错误处理。
      return {
        history: [],
        title: NEW_SESSION_TITLE,
        workspaceDirectory: "",
        sessionId: sessionId,
      };
    }
    try {
      const session: Session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      session.sessionId = sessionId;
      // 加载瘦身（见 stripAttachedFileContent 注释）：旧文件迁移前仍是肥的，
      // 剥离后再返回，避免 100MB+ 块体灌进 IPC 与 webview 堆
      stripAttachedFileContent(session.history);
      // 同上：content.imageUrl 的 base64 与 editorState 里的副本重复，
      // 旧文件里的重复载荷在加载时剥除（见 stripContentImageUrlParts 注释）
      stripContentImageUrlParts(session.history);
      // 重建差分编码的 promptLog（见 promptLogDelta.ts）：磁盘上的
      // promptDelta 在此恢复为完整 prompt，运行时下游无需感知磁盘格式。
      decodePromptLogDeltas(session.history);
      // 老会话补 message.id（见 messageIdStabilization.ts）：在**完整数组**上
      // 按下标分配，loadPage 的切片发生在这之后，因此页内各项天然一致，
      // 且不需要任何 offset→绝对下标换算。只读：不写盘（写回是 P3 的
      // 具名协议动作 history/migrateIds）。
      stabilizeWholeHistory(sessionId, session.history);
      return session;
    } catch (e) {
      console.log(`Error loading session: ${e}`);
      return {
        history: [],
        title: NEW_SESSION_TITLE,
        workspaceDirectory: "",
        sessionId: sessionId,
      };
    }
  }

  /**
   * 分页加载会话历史：只读取最新的部分消息。
   * offset=0 表示从最新一条开始；切片方向从末尾向前。
   * 同时返回 session 元数据（title/mode/chatModelTitle/contextMetrics），
   * 避免调用方再调一次 load 读完整文件。
   */
  loadPage(
    sessionId: string,
    offset: number,
    limit: number,
  ): {
    items: Session["history"];
    firstTurnItems: ChatHistoryItem[];
    latestConversationSummary?: {
      sourceMessageId: string;
      sourceAbsoluteIndex: number;
      content: string;
    };
    hasMore: boolean;
    total: number;
    session: Pick<
      Session,
      | "title"
      | "mode"
      | "chatModelTitle"
      | "chatModelRef"
      | "workspaceDirectory"
      | "contextMetrics"
      | "hasReasoningEnabled"
      | "reasoningPreferenceSource"
    >;
  } {
    const session = this.load(sessionId);
    const total = session.history.length;
    // Clamp offset/limit: a negative `end` would make slice() count from the
    // end of the array and return the WRONG items (e.g. offset > total).
    // Defensive — the GUI guards with hasMore, but callers should not be
    // able to corrupt a page load.
    const safeOffset = Math.min(Math.max(0, offset), total);
    const safeLimit = Math.max(0, limit);
    // 从末尾算起：取 [total - offset - limit, total - offset)
    const end = total - safeOffset; // 不包含
    const start = Math.max(0, end - safeLimit); // 包含
    const items = session.history.slice(start, end);
    const hasMore = start > 0;
    // 首轮和权威摘要只在第一页返回（方案.md §十三.4/§十一）：后续页调用者
    // 只需要 items/hasMore/total，重复扫描完整 history 是纯浪费。
    const isFirstPage = safeOffset === 0;
    return {
      items,
      firstTurnItems: isFirstPage ? extractFirstTurnItems(session.history) : [],
      latestConversationSummary: isFirstPage
        ? this.latestSummaryOf(session.history)
        : undefined,
      hasMore,
      total,
      session: {
        title: session.title,
        mode: session.mode,
        chatModelTitle: session.chatModelTitle,
        // 方案.md §7.5.4: the paged load is a *complete* session's metadata, so it carries the
        // stable identity too — otherwise a restart on the lazy path would downgrade a session that
        // has a ref to "title only" and lose the one thing that removes the ambiguity.
        chatModelRef: session.chatModelRef,
        workspaceDirectory: session.workspaceDirectory,
        contextMetrics: session.contextMetrics,
        hasReasoningEnabled: session.hasReasoningEnabled,
        reasoningPreferenceSource: session.reasoningPreferenceSource,
      },
    };
  }

  async save(
    session: Session,
    options?: SaveHistoryOptions,
  ): Promise<SaveHistoryResponse> {
    // 用跨进程锁串行化整个“读→合并→写”，使两个 IDE 窗口编辑同一 session 时不会
    // 互相覆盖。finally 保证任何退出路径（数据完整性守卫的 return、抛异常）都释放锁。
    // 异步版：等待锁期间不再阻塞事件循环（见 sleep/acquireSessionLock）。
    //
    // 分段时间（方案.md §7.2.2）：只在调用方要求时收集。真实会话里一次终态保存被测到
    // 3.3s（载荷仅 4.3MB），单看总时长无法判断是等锁、读盘、变换、计量还是写盘 ——
    // 而 `acquireSessionLock` 会以 25ms 间隔重试直到 10s，所以“等锁”完全可能是那个量级。
    const timings: string[] = [];
    const mark = (label: string, startedAt: number) => {
      if (options?.logTimings) {
        timings.push(
          `${label}=${(performance.now() - startedAt).toFixed(0)}ms`,
        );
      }
    };
    const totalStartedAt = performance.now();
    const enteredAt = Date.now();
    const lockStartedAt = performance.now();
    const lockDir = await acquireSessionLock(
      getSessionFilePath(session.sessionId),
    );
    mark("lock", lockStartedAt);
    if (options?.logTimings && !lockDir) {
      timings.push("lockAcquired=false");
    }
    try {
      return await this._saveUnlocked(session, options, mark);
    } finally {
      await releaseSessionLock(lockDir);
      if (options?.logTimings) {
        timings.push(
          `total=${(performance.now() - totalStartedAt).toFixed(0)}ms`,
        );
        console.log(
          `[submit-latency] save ${session.sessionId} at=${enteredAt} doneAt=${Date.now()} ${timings.join(" ")}`,
        );
      }
    }
  }

  /**
   * Atomic session-file replacement: write a temp file in the same directory,
   * then rename over the target (atomic on mainstream filesystems). Shared by
   * `history/save` and `history/migrateIds`; the caller classifies the thrown
   * error (SESSION_SAVE_FAILED vs MESSAGE_ID_MIGRATION_FAILED) so both paths
   * keep their own structured error code.
   */
  private writeSessionFileAtomically(
    sessionFilePath: string,
    payload: unknown,
  ): void {
    const tmpSessionFilePath = `${sessionFilePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(
        tmpSessionFilePath,
        JSON.stringify(payload, undefined, 2),
      );
      fs.renameSync(tmpSessionFilePath, sessionFilePath);
    } catch (e) {
      // 清理可能残留的临时文件，别把半截垃圾留在会话目录里。
      try {
        if (fs.existsSync(tmpSessionFilePath)) {
          fs.unlinkSync(tmpSessionFilePath);
        }
      } catch {
        // 忽略清理错误
      }
      throw e;
    }
  }

  private async _saveUnlocked(
    session: Session,
    options?: SaveHistoryOptions,
    mark: (label: string, startedAt: number) => void = () => {},
  ): Promise<SaveHistoryResponse> {
    // Save the main session json file
    // Explicitely rewriting here to influence the written key order in the file!
    // e.g. id at the top, history next, etc.

    // 懒加载合并保存：如果 history 仅部分加载（historyTruncated=true），
    // 读取磁盘上完整 history，保留未加载的头部，把当前 history 替换到尾部。
    //
    // 数据完整性：任何"无法安全合并"的情形都绝不能退化为"只写内存里的尾部"，
    // 因为那会静默丢掉磁盘上冻结的头部。一旦发现不一致，宁可放弃本次写入、
    // 保留磁盘上的完整文件不动（内存副本仍在，可重试），也不覆盖成更短的历史。
    let finalHistory = session.history;
    if (session.historyTruncated) {
      // historyLoadedOffset = 头部未加载条数
      const headCount = session.historyLoadedOffset ?? 0;
      const sessionFile = getSessionFilePath(session.sessionId);
      let existing: Session | undefined;
      if (fs.existsSync(sessionFile)) {
        try {
          existing = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        } catch (e) {
          // 读取/解析磁盘历史失败：无法确认能安全合并，放弃写入而不是破坏性覆盖。
          throw new SessionPersistenceError(
            "SESSION_FILE_INVALID",
            `[history] Failed to merge truncated history for ` +
              `${session.sessionId}; leaving session file unchanged to avoid ` +
              `data loss: ${e}`,
            { cause: e },
          );
        }
      } else if (headCount > 0) {
        // 声称头部被冻结却找不到源文件 —— 直接写会只落尾部并丢头。放弃写入。
        throw new SessionPersistenceError(
          "TRUNCATED_BASELINE_MISSING",
          `[history] Failed to merge truncated history for ` +
            `${session.sessionId}: historyLoadedOffset=${headCount} but no ` +
            `session file on disk. Leaving state unchanged to avoid data loss.`,
        );
      }
      if (existing) {
        const existingHistory = existing.history || [];
        if (headCount > existingHistory.length) {
          // 磁盘上的历史比预期的头部还短 —— 数据模型已不一致。
          // 若继续，orderedSession.history 只会是内存尾部，覆盖后头部永久丢失。
          // 放弃写入，保留磁盘完整文件。
          throw new SessionPersistenceError(
            "TRUNCATED_OFFSET_INVALID",
            `[history] Failed to merge truncated history for ` +
              `${session.sessionId}: historyLoadedOffset=${headCount} exceeds ` +
              `on-disk history length ${existingHistory.length}. Leaving ` +
              `session file unchanged to avoid dropping the frozen head.`,
          );
        }
        finalHistory = [
          ...existingHistory.slice(0, headCount),
          ...session.history,
        ];
      }
      // headCount === 0 且无文件：全新会话，session.history 即完整历史，正常写入。
    }

    // 写盘瘦身（见 stripAttachedFileContent 注释）：覆盖合并后的完整 history
    // （含从磁盘读回的冻结头部），块体不落盘。幂等，重复剥离无副作用。
    const stripStartedAt = performance.now();
    stripAttachedFileContent(finalHistory);
    // 同上：content.imageUrl 与 editorState 重复存图，落盘只留 editorState
    // 那份（见 stripContentImageUrlParts 注释）。幂等。
    stripContentImageUrlParts(finalHistory);
    mark("strip", stripStartedAt);

    // promptLog 增量落盘（见 promptLogDelta.ts）：对前一条 prompt 做前后缀
    // 差分，消除滚动上下文的平方级重复存储。加载时由 load() 重建。
    const deltaStartedAt = performance.now();
    encodePromptLogDeltas(finalHistory);
    mark("delta", deltaStartedAt);

    // 方案.md §五.16.4/§五.16.7：携带计量请求时，在**同一把锁内**用这份 finalHistory
    // 构造完整逻辑会话并 no-prune 计量；metrics 与 history 一起原子写盘。
    //
    // 度量对象是**写盘后的语义内容**（上面的三个落盘瘦身助手已经跑过）：reload 之后
    // 运行时读到的就是这份，两边因此同源。内存里尚未落盘的窗口可能算出略大的数，
    // 下一次保存/计量会收敛。
    let fullConversationMetrics: FullConversationMetricsResult | undefined;
    if (options?.measureFullConversation) {
      const measureStartedAt = performance.now();
      const measured = options.measureFullConversation(finalHistory);
      mark("measure", measureStartedAt);
      // 方案.md §7.1.4 的写入边界兜底：JSON 没有非有限数（`Infinity` ⇒ `null`），
      // 把一个读方必然判为 `unavailable` 的值写进磁盘没有意义 —— 保留磁盘原值即可。
      if (isJsonSafeMetricsSnapshot(measured.metrics)) {
        fullConversationMetrics = measured;
      } else {
        console.warn(
          "history/save: skipping a non-JSON-safe full-conversation measurement",
          measured.metrics,
        );
      }
    }

    // 不携带计量的保存**不得**改动磁盘上已有的 metrics：GUI 载荷里的
    // `Session.contextMetrics` 因此不再被采信（它只是历史遗留字段），磁盘值才是权威。
    // 无计量时把原值读回来原样写回；文件不存在/不可解析时按"没有 metrics"处理。
    const preserved = readPreservedFieldsFromDisk(session.sessionId);
    const preservedContextMetrics =
      fullConversationMetrics ?? preserved.contextMetrics ?? undefined;

    const orderedSession: Session = {
      sessionId: session.sessionId,
      title: session.title,
      workspaceDirectory: session.workspaceDirectory,
      history: finalHistory,
    };
    if (session.mode) {
      orderedSession.mode = session.mode;
    }
    if (session.chatModelTitle !== undefined) {
      orderedSession.chatModelTitle = session.chatModelTitle;
    }
    // 方案.md §7.5.4: the stable identity round-trips **as written**. Core never re-derives it from
    // the title (that is where a wrong ref would come from), and a payload that states none keeps the
    // on-disk value rather than dropping an identity the session already had. A save that clears the
    // title clears the ref with it — the session then has no choice of its own again.
    const requestedRef =
      typeof session.chatModelRef === "object" && session.chatModelRef !== null
        ? session.chatModelRef
        : undefined;
    if (requestedRef) {
      orderedSession.chatModelRef = requestedRef;
    } else if (orderedSession.chatModelTitle != null) {
      // The title is still there, so the identity it stands for must not be dropped — but note the
      // `!= null`: a payload that explicitly clears the title (with no ref) also clears the identity.
      const existingRef = preserved.chatModelRef;
      if (existingRef) {
        orderedSession.chatModelRef = existingRef;
      }
    }
    if (session.usage !== undefined) {
      orderedSession.usage = session.usage;
    }
    if (preservedContextMetrics !== undefined) {
      orderedSession.contextMetrics = preservedContextMetrics;
    }
    // per-session reasoning preference (方案.md §七.8): without these the GUI
    // falls back to the derived default after a reload.
    if (session.hasReasoningEnabled !== undefined) {
      orderedSession.hasReasoningEnabled = session.hasReasoningEnabled;
    }
    if (session.reasoningPreferenceSource !== undefined) {
      orderedSession.reasoningPreferenceSource =
        session.reasoningPreferenceSource;
    }

    // 原子写：先写临时文件再 rename，避免进程在写到一半时崩溃，
    // 把已存在的完整会话文件截断成半个 JSON（不可解析 = 整个会话丢失）。
    // 同一目录内的 rename 在主流文件系统上是原子操作。
    const sessionFilePath = getSessionFilePath(session.sessionId);
    try {
      const writeStartedAt = performance.now();
      this.writeSessionFileAtomically(sessionFilePath, orderedSession);
      mark("write", writeStartedAt);
    } catch (e) {
      throw new SessionPersistenceError(
        "SESSION_SAVE_FAILED",
        `[history] Failed to save session ${session.sessionId}: ${e}`,
        { cause: e },
      );
    }

    // Read and update the sessions list（全局锁串行化，防止两个进程并发保存
    // 【不同】session 时对共享 sessions.json 的读改写互相覆盖元数据）。
    const catalogStartedAt = performance.now();
    const sessionsListFilePath = getSessionsListPath();
    const listLock = await acquireSessionsListLock();
    // The object that actually lands in sessions.json — and the one returned to
    // the GUI, so a brand-new session becomes visible in the catalog as soon as
    // this save succeeds, without waiting for a full `history/list`
    // (方案.md §五.6/§七.8.1). Both `dateCreated` and `messageCount` are disk
    // authority: the GUI must never recompute them from a lazy window.
    let savedMetadata: BaseSessionMetadata | undefined;
    try {
      const rawSessionsList = fs.readFileSync(sessionsListFilePath, "utf-8");

      let sessionsList: BaseSessionMetadata[];
      try {
        sessionsList = JSON.parse(rawSessionsList);
      } catch (e) {
        if (rawSessionsList.trim() === "") {
          fs.writeFileSync(sessionsListFilePath, JSON.stringify([]));
          sessionsList = [];
        } else {
          throw e;
        }
      }

      let found = false;
      // 用合并后的完整 history 计算，避免懒加载会话只统计已加载尾部导致计数偏低
      const messageCount = finalHistory.filter(
        (item) => item.message.role === "assistant",
      ).length;
      for (const entry of sessionsList) {
        if (entry.sessionId === session.sessionId) {
          // dateCreated is the creation time: an update never rewrites it.
          entry.title = session.title;
          entry.workspaceDirectory = session.workspaceDirectory;
          entry.messageCount = messageCount;
          savedMetadata = entry;
          found = true;
          break;
        }
      }

      if (!found) {
        savedMetadata = {
          sessionId: session.sessionId,
          title: session.title,
          dateCreated: String(Date.now()),
          workspaceDirectory: session.workspaceDirectory,
          messageCount,
        };
        sessionsList.push(savedMetadata);
      }

      fs.writeFileSync(
        sessionsListFilePath,
        JSON.stringify(sessionsList, undefined, 2),
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `It looks like there is a JSON formatting error in your sessions.json file (${sessionsListFilePath}). Please fix this before creating a new session.`,
        );
      }
      throw new Error(
        `It looks like there is a validation error in your sessions.json file (${sessionsListFilePath}). Please fix this before creating a new session. Error: ${error}`,
      );
    } finally {
      await releaseSessionsListLock(listLock);
    }

    mark("catalog", catalogStartedAt);

    // 方案.md §七.8.1: 返回权威首轮 / 最新摘要 / 完整条数 / 该 session 刚写进
    // sessions.json 的权威元数据（GUI 用它增量 upsert catalog，见 protocol 注释）。
    const responseStartedAt = performance.now();
    const response = {
      firstTurnItems: extractFirstTurnItems(finalHistory),
      latestConversationSummary: this.latestSummaryOf(finalHistory),
      totalHistoryCount: finalHistory.length,
      sessionMetadata: savedMetadata,
      // 方案.md §五.16.5: 回传**同一个** Result（不重新计量），GUI 校验完整身份后接受。
      // 未携带计量时保持 undefined —— GUI 据此保留 last-known 数值。
      ...(fullConversationMetrics ? { fullConversationMetrics } : {}),
    };
    mark("response", responseStartedAt);
    return response;
  }

  /**
   * Legacy message ID migration (P3 of `bugs/Legacy_messageID_stabilization_设计.md`).
   *
   * Writes the ids this process already assigned (P2) into the session file —
   * **only** into `message.id` slots that are still missing one. Deliberately
   * does NOT go through `load()` + `save()`: those apply read-side normalization
   * (attachment / image / promptLog-delta encoding) that would rewrite non-id
   * fields, violating the "migration only adds ids" guarantee.
   *
   * Reuses the same per-session write lock as `history/save` (so the two can
   * never interleave) and the same atomic tmp+rename replacement.
   *
   * Idempotent: when every item already has an id this is a **success no-op**
   * that does not touch the file, so mtime / write counts stay put.
   */
  async migrateMessageIds(
    sessionId: string,
  ): Promise<MigrateMessageIdsResponse> {
    const sessionFilePath = getSessionFilePath(sessionId);
    const lockDir = await acquireSessionLock(sessionFilePath);
    try {
      // 1) Strict raw read — never load()'s "return an empty session" fallback,
      //    which would silently turn a corrupt file into an empty migration.
      if (!fs.existsSync(sessionFilePath)) {
        throw new SessionPersistenceError(
          "SESSION_FILE_INVALID",
          `[history] Cannot migrate message IDs for ${sessionId}: session file does not exist.`,
        );
      }
      let raw: Session;
      try {
        raw = JSON.parse(fs.readFileSync(sessionFilePath, "utf8"));
      } catch (e) {
        throw new SessionPersistenceError(
          "SESSION_FILE_INVALID",
          `[history] Cannot migrate message IDs for ${sessionId}: session file ` +
            `is not valid JSON. Leaving it unchanged.`,
          { cause: e },
        );
      }
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.history)) {
        throw new SessionPersistenceError(
          "SESSION_FILE_INVALID",
          `[history] Cannot migrate message IDs for ${sessionId}: session file ` +
            `has no history array. Leaving it unchanged.`,
        );
      }

      // 2) Idempotency: nothing missing ⇒ success, and no write at all.
      const missing = raw.history.filter((item) => !readMessageId(item)).length;
      if (missing === 0) {
        return { migrated: false, addedCount: 0 };
      }

      // 3) Stabilize a clone that has been normalized exactly like load() would,
      //    so the fingerprint shape matches the table P2 built and we reuse the
      //    ids already handed to the GUI instead of minting new ones.
      const normalizedHistory: ChatHistoryItem[] = JSON.parse(
        JSON.stringify(raw.history),
      );
      stripAttachedFileContent(normalizedHistory);
      stripContentImageUrlParts(normalizedHistory);
      decodePromptLogDeltas(normalizedHistory);
      stabilizeWholeHistory(sessionId, normalizedHistory);

      if (normalizedHistory.length !== raw.history.length) {
        throw new SessionPersistenceError(
          "MESSAGE_ID_MIGRATION_FAILED",
          `[history] Refusing to migrate ${sessionId}: normalized history length ` +
            `${normalizedHistory.length} != on-disk ${raw.history.length}.`,
        );
      }

      // 4) Copy back ONLY the missing ids. Every other part of the raw object
      //    (attachments, image urls, promptLog deltas, key order) stays byte-for-byte.
      let addedCount = 0;
      for (let i = 0; i < raw.history.length; i++) {
        if (readMessageId(raw.history[i])) {
          continue; // already persisted — never rewrite an existing id
        }
        const assigned = readMessageId(normalizedHistory[i]);
        if (!assigned) {
          throw new SessionPersistenceError(
            "MESSAGE_ID_MIGRATION_FAILED",
            `[history] Refusing to migrate ${sessionId}: index ${i} received no id.`,
          );
        }
        (raw.history[i].message as { id?: string }).id = assigned;
        addedCount++;
      }

      // 5) Atomic write of the raw object.
      try {
        this.writeSessionFileAtomically(sessionFilePath, raw);
      } catch (e) {
        throw new SessionPersistenceError(
          "MESSAGE_ID_MIGRATION_FAILED",
          `[history] Failed to write migrated message IDs for ${sessionId}: ${e}`,
          { cause: e },
        );
      }

      // 6) The whole file now carries ids ⇒ the process table is obsolete.
      invalidateMessageIdAllocations(sessionId);

      return { migrated: true, addedCount };
    } finally {
      await releaseSessionLock(lockDir);
    }
  }

  /** 最近一次 compact 的摘要及其来源条目位置（方案.md §七.8.1）。 */
  private latestSummaryOf(history: ChatHistoryItem[]):
    | {
        sourceMessageId: string;
        sourceAbsoluteIndex: number;
        content: string;
      }
    | undefined {
    for (let i = history.length - 1; i >= 0; i--) {
      const summary = (history[i] as { conversationSummary?: string })
        .conversationSummary;
      const messageId = (history[i].message as { id?: string }).id;
      if (summary && messageId) {
        return {
          sourceMessageId: messageId,
          sourceAbsoluteIndex: i,
          content: summary,
        };
      }
    }
    return undefined;
  }
}

const historyManager = new HistoryManager();

export default historyManager;
