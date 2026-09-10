import { readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";
import { describe, expect, test } from "vitest";

/**
 * 方案.md §五.20 静态闸门.
 *
 * The multi-tab model is: one real store + `SessionIdContext` + session-scoped
 * selectors + an explicit `sessionId` in every action/thunk payload. Reading
 * the *visible tab* (`state.sessions.activeSessionId`) from inside a
 * SessionView is the exact regression this refactor removed, so it is now
 * guarded by a test instead of by review.
 *
 * The allowlist below is the shell / visible-UI boundary only:
 *   - TabBar, AppShell (Layout, pages/gui/index), SessionViews (picks the tab)
 *   - global listeners and global shortcuts
 *   - history sidebar rows (highlight + switching)
 *   - config pages (no session tree)
 *   - the selectors that *define* the active projections
 *   - thunks whose whole job is to resolve the visible session once
 *     (`stopActiveSessionStream`, `approveActiveToolCall`,
 *     activation/lifecycle)
 *   - the SessionScope/editor-registry plumbing that needs to know visibility
 *   - persistV2 (stores the last active id) and the test harness
 */

const SRC = join(__dirname, "..");

/** Path prefixes (posix, relative to `gui/src`) allowed to touch the visible tab. */
const SHELL_ALLOWLIST = [
  "components/AppShell.tsx",
  "components/Layout.tsx",
  "components/TabBar/",
  "components/History/HistoryTableRow.tsx",
  "components/mainInput/TipTapEditor/MainEditorProvider.tsx",
  "components/mainInput/TipTapEditor/SessionScope.tsx",
  "hooks/ParallelListeners.tsx",
  "pages/config/",
  "pages/gui/SessionViews.tsx",
  "pages/gui/index.tsx",
  "pages/gui/useAutoScroll.ts",
  "redux/persistV2.ts",
  "redux/selectors/",
  "redux/thunks/edit.ts",
  "redux/thunks/sessionActivation.ts",
  "redux/thunks/sessionChanges.ts",
  "redux/thunks/sessionLifecycle.ts",
  "redux/thunks/sessionPersistence.ts",
  "redux/thunks/sessionStreams.ts",
  "redux/thunks/sessionTools.ts",
  "util/test/",
];

/**
 * The SessionView subtree: every file that renders inside a mounted tab. It
 * must never resolve the visible session, not even for "read-only" values.
 */
const SESSION_VIEW_DIRS = [
  "components/SessionLayout.tsx",
  "components/mainInput/",
  "components/StyledMarkdownPreview/",
  "components/UnifiedTerminal/",
  "components/StepContainer/",
  "components/AcceptRejectDiffButtons.tsx",
];

/**
 * 方案.md §九.0: the shell must not depend on a tab's editor provider or on any
 * session-scoped hook. The tab bar, the history sidebar and the GUI route entry
 * live here; they may only decide *which* tab is visible.
 */
const APP_SHELL_FILES = [
  "components/AppShell.tsx",
  "components/TabBar/",
  "components/History/",
  "pages/gui/index.tsx",
];

/** Session-scoped hooks/providers the shell must not use. */
const SHELL_FORBIDDEN_SESSION_API = [
  "MainEditorProvider",
  "useMainEditor",
  "useMainEditorForSession",
  "useSessionId",
  "useOptionalSessionId",
  "useIsVisibleSession",
  "useSessionHistory",
  "useSessionRuntime",
  "useSessionIsStreaming",
  "useSessionMode",
];

/**
 * Every per-tab global keyboard listener must be gated by visibility: a hidden
 * tab's tree stays mounted, so an ungated listener fires once per open tab and
 * dispatches active-session actions from a background tree.
 */
const KEYDOWN_LISTENER = /addEventListener\(\s*["']keydown/;

/** Files inside the subtree that legitimately know about visibility. */
const SESSION_VIEW_ALLOWLIST = [
  "components/mainInput/TipTapEditor/MainEditorProvider.tsx",
  "components/mainInput/TipTapEditor/SessionScope.tsx",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__snapshots__") {
        continue;
      }
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(SRC, file).split(sep).join("/");
const isAllowed = (file: string, allowlist: string[]) =>
  allowlist.some((prefix) => rel(file).startsWith(prefix));

/** Comments are allowed to name the old API (they document the refactor). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** `selectActiveXxx` used without an explicit sessionId argument. */
function activeSelectorUses(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(/\bselectActive[A-Za-z]*/g)) {
    const name = match[0];
    // `...Of(state, sessionId)` and `...ForSession` are session-scoped by
    // construction and are the approved replacement.
    if (name.endsWith("Of") || name.endsWith("ForSession")) continue;
    hits.push(name);
  }
  return hits;
}

const files = sourceFiles(SRC);

describe("方案.md §五.20 session-scope static gate", () => {
  test("only the shell reads the visible session id", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (isAllowed(file, SHELL_ALLOWLIST)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (/\.sessions\.activeSessionId\b/.test(source)) {
        violations.push(`${rel(file)}: reads sessions.activeSessionId`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("only the shell uses active-session selectors", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (isAllowed(file, SHELL_ALLOWLIST)) continue;
      const hits = activeSelectorUses(
        stripComments(readFileSync(file, "utf8")),
      );
      if (hits.length > 0) {
        violations.push(`${rel(file)}: ${[...new Set(hits)].join(", ")}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the SessionView subtree never resolves the visible session", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (!isAllowed(file, SESSION_VIEW_DIRS)) continue;
      if (isAllowed(file, SESSION_VIEW_ALLOWLIST)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (/\.sessions\.activeSessionId\b/.test(source)) {
        violations.push(`${rel(file)}: reads sessions.activeSessionId`);
      }
      const hits = activeSelectorUses(source);
      if (hits.length > 0) {
        violations.push(`${rel(file)}: ${[...new Set(hits)].join(", ")}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the shell never depends on a tab provider or a session hook", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (!isAllowed(file, APP_SHELL_FILES)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      for (const api of SHELL_FORBIDDEN_SESSION_API) {
        if (new RegExp(`\\b${api}\\b`).test(source)) {
          violations.push(`${rel(file)}: uses ${api}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("per-tab global keyboard listeners are visibility-gated", () => {
    // Any component that is not shell-only may be mounted once per open tab.
    // An ungated listener fires once per tab and acts on the visible session
    // from a background tree (方案.md §九.2).
    const violations: string[] = [];
    for (const file of files) {
      if (isAllowed(file, SHELL_ALLOWLIST)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (!KEYDOWN_LISTENER.test(source)) continue;
      if (!/useIsVisibleSession/.test(source)) {
        violations.push(
          `${rel(file)}: keydown listener without a visibility gate`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  test("session-scoped thunks take an explicit sessionId", () => {
    // Regression guard for §五.20: these thunks are dispatched from inside a
    // SessionView, so the session must arrive in the payload instead of being
    // resolved from the visible tab at dispatch time.
    const thunkFiles = [
      "redux/thunks/edit.ts",
      "redux/thunks/moveTerminalProcessToBackground.ts",
      "redux/thunks/sessionApplyState.ts",
      "redux/thunks/sessionPaging.ts",
      "redux/thunks/sessionSubmit.ts",
      "redux/thunks/sessionTitle.ts",
    ];
    const violations: string[] = [];
    for (const file of thunkFiles) {
      const source = stripComments(readFileSync(join(SRC, file), "utf8"));
      if (!/sessionId: string/.test(source)) {
        violations.push(`${file}: no explicit sessionId in any payload type`);
      }
      if (/\.sessions\.activeSessionId\b/.test(source)) {
        violations.push(`${file}: reads sessions.activeSessionId`);
      }
    }
    expect(violations).toEqual([]);
  });
});
