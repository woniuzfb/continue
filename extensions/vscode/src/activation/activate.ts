import { getContinueRcPath, getTsConfigPath } from "core/util/paths";
import * as vscode from "vscode";

import { VsCodeExtension } from "../extension/VsCodeExtension";
import { isUnsupportedPlatform } from "../util/util";

import { GlobalContext } from "core/util/GlobalContext";
import { VsCodeContinueApi } from "./api";
import setupInlineTips from "./InlineTipManager";

export async function activateExtension(context: vscode.ExtensionContext) {
  const platformCheck = isUnsupportedPlatform();
  const globalContext = new GlobalContext();
  const hasShownUnsupportedPlatformWarning = globalContext.get(
    "hasShownUnsupportedPlatformWarning",
  );

  if (platformCheck.isUnsupported && !hasShownUnsupportedPlatformWarning) {
    const platformTarget = "windows-arm64";

    globalContext.update("hasShownUnsupportedPlatformWarning", true);
    void vscode.window.showInformationMessage(
      `Continue detected that you are using ${platformTarget}. Due to native dependencies, Continue may not be able to start`,
    );
  }

  // Add necessary files
  getTsConfigPath();
  getContinueRcPath();

  // Register commands and providers
  setupInlineTips(context);

  const vscodeExtension = new VsCodeExtension(context);

  // Load Continue configuration
  if (!context.globalState.get("hasBeenInstalled")) {
    void context.globalState.update("hasBeenInstalled", true);
  }

  // Register config.yaml schema by removing old entries and adding new one (uri.fsPath changes with each version)
  const yamlMatcher = ".continue/**/*.yaml";
  const yamlConfig = vscode.workspace.getConfiguration("yaml");

  // The `yaml` configuration namespace only exists when the Red Hat YAML
  // extension is installed. Skip the write entirely when it is missing —
  // otherwise every startup logs a scary (but handled) error to the
  // Extension Host output for a purely cosmetic downgrade (no YAML schema
  // validation).
  const yamlExtension = vscode.extensions.getExtension("redhat.vscode-yaml");
  if (yamlExtension) {
    const newPath = vscode.Uri.joinPath(
      context.extension.extensionUri,
      "config-yaml-schema.json",
    ).toString();

    // 剔除旧版本残留的 schema 条目（路径形如 .../continue.continue-X.Y.Z/config-yaml-schema.json）
    // 升级后旧版本目录会被卸载，但 yaml.schemas 中的映射不会自动清理，导致 YAML 扩展加载失败
    // 需要清理所有作用域：Global（用户设置）和 Workspace（.code-workspace / .vscode/settings.json）
    const cleanSchemas = (
      raw: unknown,
    ): { cleaned: Record<string, unknown>; changed: boolean } => {
      const cleaned: Record<string, unknown> = {};
      let changed = false;
      if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw as object)) {
          if (
            typeof key === "string" &&
            /[/\\]continue\.continue-[^/\\]*[/\\]config-yaml-schema\.json$/.test(
              key,
            )
          ) {
            changed = true;
            continue;
          }
          cleaned[key] = value;
        }
      }
      return { cleaned, changed };
    };

    const inspection = yamlConfig.inspect<object>("schemas");

    // 清理 Workspace 作用域的残留（不追加新路径，避免污染工作区设置）
    if (inspection?.workspaceValue) {
      const { cleaned, changed } = cleanSchemas(inspection.workspaceValue);
      if (changed) {
        try {
          await yamlConfig.update(
            "schemas",
            cleaned,
            vscode.ConfigurationTarget.Workspace,
          );
        } catch (error) {
          console.error(
            "Failed to clean yaml.schemas in workspace settings",
            error,
          );
        }
      }
    }

    // Global 作用域：清理残留并追加当前版本的 schema 映射
    const { cleaned: globalCleaned } = cleanSchemas(inspection?.globalValue);
    try {
      await yamlConfig.update(
        "schemas",
        {
          ...globalCleaned,
          [newPath]: [yamlMatcher],
        },
        vscode.ConfigurationTarget.Global,
      );
    } catch (error) {
      console.error("Failed to register Continue config.yaml schema", error);
    }
  }

  const api = new VsCodeContinueApi(vscodeExtension);
  const continuePublicApi = {
    registerCustomContextProvider: api.registerCustomContextProvider.bind(api),
  };

  // 'export' public api-surface
  // or entire extension for testing
  return process.env.NODE_ENV === "test"
    ? {
        ...continuePublicApi,
        extension: vscodeExtension,
      }
    : continuePublicApi;
}
