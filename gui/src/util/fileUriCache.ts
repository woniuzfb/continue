import type { IDE } from "core";
import { inferResolvedUriFromRelativePath } from "core/util/ideUtils";

/**
 * 代码块「相对路径 → URI 解析 / 文件是否存在」结果的模块级缓存。
 *
 * 背景：StepContainerPreToolbar 在每个代码块挂载时都会
 * 1) inferResolvedUriFromRelativePath —— 内部按 目录×路径后缀 组合
 *    串行/并发发出多个 fileExists IPC；
 * 2) 解析完成后再发一次 fileExists IPC。
 * 长会话（~400+ 带路径代码块）切 tab 重挂载时，这会形成上千个 IPC
 * 洪峰；响应错落返回、各自 setState，在主线程上形成持续数秒的
 * 长任务瀑布（实测切回后 t0+1.1s ~ t0+3.7s 的 jank 主要来源）。
 *
 * 路径解析结果在同一 workspace 下稳定（5min TTL 兜底，key 包含
 * workspace，因此切换 workspace 不会复用旧解析结果）；
 * fileExists 用 30s 短 TTL 兼顾文件增删，Apply 后调用方应
 * invalidateFileExists 失效旧值。
 * 两级缓存都按 key 做 in-flight 去重：同 key 并发共享同一次 IPC。
 */

const RESOLVED_URI_TTL_MS = 5 * 60 * 1000;
const FILE_EXISTS_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 1000;

type CacheEntry<T> = { value: T; expires: number };

const resolvedUriCache = new Map<string, CacheEntry<string | null>>();
const fileExistsCache = new Map<string, CacheEntry<boolean>>();
const inFlight = new Map<string, Promise<unknown>>();

function getWorkspaceCacheKey(): string {
  return (window.workspacePaths ?? []).join("\u0000");
}

function getFresh<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
): T | undefined {
  const entry = map.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expires <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  // LRU 触碰
  map.delete(key);
  map.set(key, entry);
  return entry.value;
}

function setEntry<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, { value, expires: Date.now() + ttlMs });
}

async function dedup<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const promise = run();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * 解析相对路径为工作区 URI（带缓存）。解析失败返回 null 并缓存
 * （原实现抛错会产生 unhandled rejection；此处按「不可解析」处理，
 * UI 表现为文件不存在 → CreateFile 按钮，与原语义一致）。
 */
export async function resolveRelativePathToUriCached(
  ide: IDE,
  relativePath: string,
): Promise<string | null> {
  const normalizedPath = relativePath.trim().replaceAll("\\", "/");
  if (!normalizedPath) {
    return null;
  }
  const key = `${getWorkspaceCacheKey()}\u0000${normalizedPath}`;
  const cached = getFresh(resolvedUriCache, key);
  if (cached !== undefined) {
    return cached;
  }
  return dedup(`resolve:${key}`, async () => {
    let uri: string | null = null;
    try {
      uri = await inferResolvedUriFromRelativePath(normalizedPath, ide);
    } catch {
      uri = null;
    }
    setEntry(resolvedUriCache, key, uri, RESOLVED_URI_TTL_MS);
    return uri;
  });
}

/**
 * 文件是否存在（带缓存）。forceRefresh 时跳过读缓存并写回最新结果；
 * 写操作也可以通过 invalidateFileExists 精确失效已有结果。
 */
export async function fileExistsCached(
  ide: IDE,
  uri: string,
  forceRefresh = false,
): Promise<boolean> {
  if (!forceRefresh) {
    const cached = getFresh(fileExistsCache, uri);
    if (cached !== undefined) {
      return cached;
    }
  }
  // 强制刷新不能复用普通查询的在途 Promise，否则 Apply/CreateFile 后
  // 可能拿到创建前发起的旧结果，并把 false 重新写入 30s 缓存。
  const requestKey = forceRefresh ? `exists:refresh:${uri}` : `exists:${uri}`;
  return dedup(requestKey, async () => {
    let exists = false;
    try {
      exists = await ide.fileExists(uri);
    } catch {
      exists = false;
    }
    setEntry(fileExistsCache, uri, exists, FILE_EXISTS_TTL_MS);
    return exists;
  });
}

/** 精确失效单个文件存在性结果。 */
export function invalidateFileExists(uri: string): void {
  fileExistsCache.delete(uri);
  inFlight.delete(`exists:${uri}`);
}
