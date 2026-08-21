/**
 * This is the entry point for the extension.
 */

import { setupCa } from "core/util/ca";
import * as vscode from "vscode";

export { default as buildTimestamp } from "./.buildTimestamp";

async function dynamicImportAndActivate(context: vscode.ExtensionContext) {
  // Isolate per-host index storage BEFORE any core module is imported:
  // core resolves index paths (e.g. ~/.continue/index) at module load time.
  // Different IDE hosts (VS Code, Cursor, Antigravity...) each bundle their
  // own native sqlite3 build; sharing one WAL database across processes with
  // different sqlite builds corrupts the shared -shm WAL-index (SQLITE_IOERR).
  process.env.CONTINUE_INDEX_HOST ??= vscode.env.appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  await setupCa();
  const { activateExtension } = await import("./activation/activate");
  return activateExtension(context);
}

export function activate(context: vscode.ExtensionContext) {
  return dynamicImportAndActivate(context).catch((e) => {
    console.log("Error activating extension: ", e);
    vscode.window
      .showWarningMessage(
        "Error activating the Continue extension.",
        "View Logs",
        "Retry",
      )
      .then((selection) => {
        if (selection === "View Logs") {
          vscode.commands.executeCommand("continue.viewLogs");
        } else if (selection === "Retry") {
          // Reload VS Code window
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
  });
}

export function deactivate() {
  // Best-effort: close index sqlite connections on shutdown so the WAL is
  // checkpointed cleanly (avoids stale -wal/-shm remnants after force-kill)
  import("core/indexing/refreshIndex")
    .then((m) => m.SqliteDb.close())
    .catch(() => {});
}
