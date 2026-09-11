package com.github.continuedev.continueintellijextension.constants

class MessageTypes {
    companion object {
        val IDE_MESSAGE_TYPES = listOf(
            "readRangeInFile",
            "getUniqueId",
            "getDiff",
            "getTerminalContents",
            "getWorkspaceDirs",
            "showLines",
            "writeFile",
            "fileExists",
            "showVirtualFile",
            "openFile",
            "runCommand",
            "saveFile",
            "readFile",
            "readBinaryBase64",
            "showDiff",
            "getOpenFiles",
            "getCurrentFile",
            "getPinnedFiles",
            "getSearchResults",
            "getFileResults",
            "getProblems",
            "subprocess",
            "getBranch",
            "getTags",
            "getIdeInfo",
            "getIdeSettings",
            "getRepoName",
            "listDir",
            "getGitRootPath",
            "getFileStats",
            "insertAtCursor",
            "applyToFile",
            "showToast",
            "openUrl",
            "isWorkspaceRemote",

            // These only come from the GUI for now but should be here to prevent confusion
            "toggleDevTools",
            "showTutorial",

            // These are jetbrains only and only come from the GUI for now
            // But again including for consistency
            "copyText",
            "jetbrains/isOSREnabled",
            "jetbrains/getColors",
            "jetbrains/onLoad"
        )

        // Note: If updating these values, make a corresponding update in
        // core/protocol/passThrough.ts
        val PASS_THROUGH_TO_WEBVIEW = listOf(
            "configUpdate",
            "indexProgress", // Codebase
            "indexing/statusUpdate", // Docs, etc.
            "addContextItem",
            "refreshSubmenuItems",
            "isContinueInputFocused",
            "setTTSActive",
            "getWebviewHistoryLength",
            "getCurrentSessionId",
            "sessionUpdate",
            "didCloseFiles",
            "toolCallPartialOutput",
        )

        // Note: If updating these values, make a corresponding update in
        // core/protocol/passThrough.ts
        val PASS_THROUGH_TO_CORE = listOf(
            "abort",
            "history/list",
            "history/delete",
            "history/load",
            "history/save",
            // Legacy message ID migration (P4a). This host only advertises
            // `capabilities.historyMigrateIds` in `getIdeInfo` because this
            // allow-list contains the type: an unlisted type is silently
            // dropped here (no response at all), so a host that does not list
            // it must NOT advertise the capability.
            "history/migrateIds",
            "history/loadRemote",
            "history/clear",
            "devdata/log",
            "config/addModel",
            "config/newPromptFile",
            "config/newAssistantFile",
            "config/ideSettingsUpdate",
            "config/addLocalWorkspaceBlock",
            "config/addGlobalRule",
            "config/deleteRule",
            "config/getSerializedProfileInfo",
            "config/deleteModel",
            "config/refreshProfiles",
            "config/openProfile",
            "config/updateSharedConfig",
            "config/updateSelectedModel",
            "mcp/reloadServer",
            "mcp/startAuthentication",
            "mcp/removeAuthentication",
            "mcp/setServerEnabled",
            "mcp/getPrompt",
            "context/getContextItems",
            "context/getSymbolsForFiles",
            "context/loadSubmenuItems",
            "context/addDocs",
            "context/removeDocs",
            "context/indexDocs",
            "autocomplete/complete",
            "autocomplete/cancel",
            "autocomplete/accept",
            "nextEdit/predict",
            "nextEdit/reject",
            "nextEdit/accept",
            "nextEdit/startChain",
            "nextEdit/deleteChain",
            "nextEdit/isChainAlive",
            "nextEdit/queue/getProcessedCount",
            "nextEdit/queue/dequeueProcessed",
            "nextEdit/queue/processOne",
            "nextEdit/queue/clear",
            "nextEdit/queue/abort",
            "tts/kill",
            "llm/complete",
            "llm/streamChat",
            "llm/listModels",
            "llm/compileChat",
            "streamDiffLines",
            "getDiffLines",
            "chatDescriber/describe",
            "conversation/compact",
            "stats/getTokensPerDay",
            "stats/getTokensPerModel",
            // Codebase
            "index/setPaused",
            "index/forceReIndex",
            "index/forceReIndexFiles",
            "index/indexingProgressBarInitialized",
            // Docs, etc.
            "indexing/reindex",
            "indexing/abort",
            "indexing/setPaused",
            "docs/initStatuses",
            "docs/getDetails",
            "docs/getIndexedPages",
            //
            "onboarding/complete",
            "addAutocompleteModel",
            "didChangeSelectedProfile",
            "didChangeSelectedOrg",
            "tools/call",
            "tools/evaluatePolicy",
            "tools/preprocessArgs",
            "controlPlane/getEnvironment",
            "controlPlane/getCreditStatus",
            "controlPlane/openUrl",
            "isItemTooBig",
            "process/markAsBackgrounded",
            "process/isBackgrounded",
            "process/killTerminalProcess",
            "models/fetch"
        )
    }
}
