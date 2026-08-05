import * as fs from "fs";

import { BaseSessionMetadata, Session } from "../index.js";
import { ListHistoryOptions } from "../protocol/core.js";

import { NEW_SESSION_TITLE } from "./constants.js";
import {
  getSessionFilePath,
  getSessionsFolderPath,
  getSessionsListPath,
} from "./paths.js";
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
    // Delete a session
    const sessionFile = getSessionFilePath(sessionId);
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
  }

  clearAll() {
    fs.rmSync(getSessionsFolderPath(), { recursive: true, force: true });
  }

  load(sessionId: string): Session {
    try {
      const sessionFile = getSessionFilePath(sessionId);
      if (!fs.existsSync(sessionFile)) {
        throw new Error(`Session file ${sessionFile} does not exist`);
      }
      const session: Session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      session.sessionId = sessionId;
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
    hasMore: boolean;
    total: number;
    session: Pick<
      Session,
      | "title"
      | "mode"
      | "chatModelTitle"
      | "workspaceDirectory"
      | "contextMetrics"
    >;
  } {
    const session = this.load(sessionId);
    const total = session.history.length;
    // 从末尾算起：取 [total - offset - limit, total - offset)
    const end = total - offset; // 不包含
    const start = Math.max(0, end - limit); // 包含
    const items = session.history.slice(start, end);
    const hasMore = start > 0;
    return {
      items,
      hasMore,
      total,
      session: {
        title: session.title,
        mode: session.mode,
        chatModelTitle: session.chatModelTitle,
        workspaceDirectory: session.workspaceDirectory,
        contextMetrics: session.contextMetrics,
      },
    };
  }

  async save(session: Session): Promise<void> {
    // 用跨进程锁串行化整个“读→合并→写”，使两个 IDE 窗口编辑同一 session 时不会
    // 互相覆盖。finally 保证任何退出路径（数据完整性守卫的 return、抛异常）都释放锁。
    // 异步版：等待锁期间不再阻塞事件循环（见 sleep/acquireSessionLock）。
    const lockDir = await acquireSessionLock(
      getSessionFilePath(session.sessionId),
    );
    try {
      await this._saveUnlocked(session);
    } finally {
      await releaseSessionLock(lockDir);
    }
  }

  private async _saveUnlocked(session: Session): Promise<void> {
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
      try {
        const sessionFile = getSessionFilePath(session.sessionId);
        if (fs.existsSync(sessionFile)) {
          const existing: Session = JSON.parse(
            fs.readFileSync(sessionFile, "utf8"),
          );
          const existingHistory = existing.history || [];
          if (headCount <= existingHistory.length) {
            finalHistory = [
              ...existingHistory.slice(0, headCount),
              ...session.history,
            ];
          } else {
            // 磁盘上的历史比预期的头部还短 —— 数据模型已不一致。
            // 若继续，orderedSession.history 只会是内存尾部，覆盖后头部永久丢失。
            // 放弃写入，保留磁盘完整文件。
            console.error(
              `[history] Refusing truncated-history save for ` +
                `${session.sessionId}: historyLoadedOffset=${headCount} exceeds ` +
                `on-disk history length ${existingHistory.length}. Leaving ` +
                `session file unchanged to avoid dropping the frozen head.`,
            );
            return;
          }
        } else if (headCount > 0) {
          // 声称头部被冻结却找不到源文件 —— 直接写会只落尾部并丢头。放弃写入。
          console.error(
            `[history] Refusing truncated-history save for ` +
              `${session.sessionId}: historyLoadedOffset=${headCount} but no ` +
              `session file on disk. Leaving state unchanged to avoid data loss.`,
          );
          return;
        }
        // headCount === 0 且无文件：全新会话，session.history 即完整历史，正常写入。
      } catch (e) {
        // 读取/解析磁盘历史失败：无法确认能安全合并，放弃写入而不是破坏性覆盖。
        console.error(
          `[history] Failed to merge truncated history for ` +
            `${session.sessionId}; leaving session file unchanged to avoid ` +
            `data loss: ${e}`,
        );
        return;
      }
    }

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
    if (session.usage !== undefined) {
      orderedSession.usage = session.usage;
    }
    if (session.contextMetrics !== undefined) {
      orderedSession.contextMetrics = session.contextMetrics;
    }

    // 原子写：先写临时文件再 rename，避免进程在写到一半时崩溃，
    // 把已存在的完整会话文件截断成半个 JSON（不可解析 = 整个会话丢失）。
    // 同一目录内的 rename 在主流文件系统上是原子操作。
    const sessionFilePath = getSessionFilePath(session.sessionId);
    const tmpSessionFilePath = `${sessionFilePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(
        tmpSessionFilePath,
        JSON.stringify(orderedSession, undefined, 2),
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

    // Read and update the sessions list（全局锁串行化，防止两个进程并发保存
    // 【不同】session 时对共享 sessions.json 的读改写互相覆盖元数据）。
    const sessionsListFilePath = getSessionsListPath();
    const listLock = await acquireSessionsListLock();
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
      for (const sessionMetadata of sessionsList) {
        if (sessionMetadata.sessionId === session.sessionId) {
          sessionMetadata.title = session.title;
          sessionMetadata.workspaceDirectory = session.workspaceDirectory;
          sessionMetadata.messageCount = messageCount;
          found = true;
          break;
        }
      }

      if (!found) {
        const sessionMetadata: BaseSessionMetadata = {
          sessionId: session.sessionId,
          title: session.title,
          dateCreated: String(Date.now()),
          workspaceDirectory: session.workspaceDirectory,
          messageCount,
        };
        sessionsList.push(sessionMetadata);
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
  }
}

const historyManager = new HistoryManager();

export default historyManager;
