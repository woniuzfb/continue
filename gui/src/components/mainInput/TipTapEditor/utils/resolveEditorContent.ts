import { Dispatch } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/react";
import {
  ContextItemWithId,
  DefaultContextProvider,
  InputModifiers,
  MessageContent,
  MessagePart,
  RangeInFile,
  SlashCommandDescWithSource,
} from "core";
import { stripImages } from "core/util/messageContent";
import { IIdeMessenger } from "../../../../context/IdeMessenger";
import { setSessionGatheringContext } from "../../../../redux/slices/sessionsSlice";
import {
  measureSubmitLatency,
  measureSubmitLatencySync,
  recordSubmitLatency,
} from "../../../../util/submitLatency";
import { RootState } from "../../../../redux/store";
import { processEditorContent } from "./processEditorContent";
import { renderSlashCommandPrompt } from "./renderSlashCommand";
import { GetContextRequest } from "./types";

interface ResolveEditorContentInput {
  /** 方案.md §九.0: the owning session is explicit, never the active one. */
  sessionId: string;
  editorState: JSONContent;
  modifiers: InputModifiers;
  ideMessenger: IIdeMessenger;
  defaultContextProviders: DefaultContextProvider[];
  availableSlashCommands: SlashCommandDescWithSource[];
  dispatch: Dispatch;
  getState: () => RootState;
}

interface ResolveEditorContentOutput {
  selectedContextItems: ContextItemWithId[];
  selectedCode: RangeInFile[];
  content: MessageContent;
  legacyCommandWithInput:
    | {
        command: SlashCommandDescWithSource;
        input: string;
      }
    | undefined;
}

/**
 * This function converts the input from the editor to a string, resolving any context items
 * Context items are appended to the top of the prompt and then referenced within the input
 */
export async function resolveEditorContent({
  sessionId,
  editorState,
  modifiers,
  ideMessenger,
  defaultContextProviders,
  availableSlashCommands,
  dispatch,
  getState,
}: ResolveEditorContentInput): Promise<ResolveEditorContentOutput> {
  // Latency instrumentation: the submitted turn is committed only after this function
  // resolves, so whatever happens here is time the user spends without a bubble.
  const {
    parts,
    contextRequests: editorContextRequests,
    selectedCode,
    slashCommandName,
  } = measureSubmitLatencySync({ phase: "editor-processing", sessionId }, () =>
    processEditorContent(editorState),
  );

  const {
    slashedParts,
    contextRequests: slashContextRequests,
    legacyCommandWithInput,
  } = await measureSubmitLatency({ phase: "slash-rendering", sessionId }, () =>
    renderSlashCommandPrompt(
      ideMessenger,
      slashCommandName,
      parts,
      availableSlashCommands,
      selectedCode,
    ),
  );

  const contextRequests = [...editorContextRequests, ...slashContextRequests];

  const shouldGatherContext =
    defaultContextProviders.length > 0 ||
    modifiers.useCodebase ||
    !modifiers.noContext ||
    contextRequests.length > 0;

  if (shouldGatherContext) {
    dispatch(setSessionGatheringContext({ sessionId, gathering: true }));
  }

  try {
    // One event for the whole phase: the duration and the classification are only both known
    // after the call, and two `context-resolution` lines per send made the phase count
    // ambiguous (a test asserts one).
    const contextStartedAt = performance.now();
    let gathered;
    try {
      gathered = await gatherContextItems({
        sessionId,
        contextRequests,
        modifiers,
        ideMessenger,
        defaultContextProviders,
        parts: slashedParts,
        selectedCode,
        getState,
      });
    } catch (error) {
      recordSubmitLatency({
        phase: "context-resolution",
        sessionId,
        durationMs: performance.now() - contextStartedAt,
        ok: false,
      });
      throw error;
    }

    const { contextItems: selectedContextItems, issued } = gathered;
    recordSubmitLatency({
      phase: "context-resolution",
      sessionId,
      durationMs: performance.now() - contextStartedAt,
      requests:
        issued.mentions +
        issued.defaultProviders +
        issued.currentFile +
        issued.codebase,
      contextRequests: issued,
      ok: true,
    });

    return {
      selectedContextItems,
      selectedCode,
      content: slashedParts,
      legacyCommandWithInput,
    };
  } finally {
    // `finally`, not the happy path: a provider that throws used to leave the session
    // stuck in "gathering context" forever (there is no other writer of this flag).
    if (shouldGatherContext) {
      dispatch(setSessionGatheringContext({ sessionId, gathering: false }));
    }
  }
}

/**
 * Gathers context items from various sources
 */
async function gatherContextItems({
  sessionId,
  contextRequests,
  modifiers,
  ideMessenger,
  defaultContextProviders,
  parts,
  selectedCode,
  getState,
}: {
  sessionId: string;
  contextRequests: GetContextRequest[];
  modifiers: InputModifiers;
  ideMessenger: IIdeMessenger;
  defaultContextProviders: DefaultContextProvider[];
  parts: MessagePart[];
  selectedCode: RangeInFile[];
  getState: () => RootState;
}): Promise<{
  contextItems: ContextItemWithId[];
  /** Which context requests this call actually issued (for the latency log). */
  issued: {
    mentions: number;
    defaultProviders: number;
    currentFile: number;
    codebase: number;
  };
}> {
  const defaultRequests: GetContextRequest[] = defaultContextProviders.map(
    (def) => ({
      provider: def.name,
      query: def.query,
    }),
  );
  const withDefaults = [...contextRequests, ...defaultRequests];
  const deduplicatedInputs = withDefaults.reduce<GetContextRequest[]>(
    (acc, item) => {
      if (
        !acc.some((i) => i.provider === item.provider && i.query === item.query)
      ) {
        acc.push(item);
      }
      return acc;
    },
    [],
  );
  const contextItems: ContextItemWithId[] = [];

  // What this call actually issues, counted where the decision is made. `requests` alone was
  // misleading: the editor's mention list is often 0 while `currentFile` (or a default
  // provider, or codebase) is still being fetched.
  const issued = {
    mentions: 0,
    defaultProviders: 0,
    currentFile: 0,
    codebase: 0,
  };

  const isInAgentMode =
    (getState().sessions.sessionsById[sessionId]?.mode ?? "chat") === "agent";

  // Build all context requests in parallel to minimize first-token latency
  // (previously each provider was fetched sequentially, 3+ IPC round-trips).
  // IMPORTANT: results are collected into per-source buckets and only assembled
  // AFTER every request settles, so the final ordering is deterministic and no
  // longer depends on which IPC response happens to arrive first. This
  // preserves the original sequential ordering: currentFile first (matching the
  // previous `unshift`), then @-mentions in input order, then codebase.
  const parallelRequests: Promise<void>[] = [];

  // 1. @-mentioned context providers — run in parallel, but keep input order by
  //    writing each provider's results into its own fixed slot.
  const mentionResults: ContextItemWithId[][] = new Array(
    deduplicatedInputs.length,
  );
  issued.mentions = deduplicatedInputs.length;
  issued.defaultProviders = defaultRequests.length;
  deduplicatedInputs.forEach((item, mentionIdx) => {
    parallelRequests.push(
      (async () => {
        // Per-provider timing: the total only ever reports the slowest one.
        const result = await measureSubmitLatency(
          { phase: "context-resolution", sessionId, provider: item.provider },
          () =>
            ideMessenger.request("context/getContextItems", {
              name: item.provider,
              query: item.query ?? "",
              fullInput: stripImages(parts),
              selectedCode,
              isInAgentMode,
            }),
        );
        mentionResults[mentionIdx] =
          result.status === "success" ? result.content : [];
      })(),
    );
  });

  // 2. Codebase context (cmd+enter) — in parallel with other requests
  let codebaseResults: ContextItemWithId[] = [];
  if (
    modifiers.useCodebase &&
    !deduplicatedInputs.some((item) => item.provider === "codebase")
  ) {
    issued.codebase = 1;
    parallelRequests.push(
      (async () => {
        const result = await measureSubmitLatency(
          { phase: "context-resolution", sessionId, provider: "codebase" },
          () =>
            ideMessenger.request("context/getContextItems", {
              name: "codebase",
              query: "",
              fullInput: stripImages(parts),
              selectedCode,
              isInAgentMode,
            }),
        );
        if (result.status === "success") {
          codebaseResults = result.content;
        }
      })(),
    );
  }

  // 3. Current file (unless suppressed) — in parallel with other requests
  let currentFileItem: ContextItemWithId | undefined;
  if (
    !modifiers.noContext &&
    !deduplicatedInputs.some((item) => item.provider === "currentFile")
  ) {
    issued.currentFile = 1;
    parallelRequests.push(
      (async () => {
        const currentFileResponse = await measureSubmitLatency(
          { phase: "context-resolution", sessionId, provider: "currentFile" },
          () =>
            ideMessenger.request("context/getContextItems", {
              name: "currentFile",
              query: "non-mention-usage",
              fullInput: "",
              selectedCode: [],
              isInAgentMode,
            }),
        );
        if (currentFileResponse.status === "success") {
          const currentFile = currentFileResponse.content[0];
          if (currentFile?.uri?.value) {
            currentFile.id = {
              providerTitle: "file",
              itemId: currentFile.uri.value,
            };
            currentFileItem = currentFile;
          }
        }
      })(),
    );
  }

  // Wait for ALL context requests to complete in parallel
  await Promise.all(parallelRequests);

  // Assemble deterministically regardless of settle order:
  // currentFile first, then @-mentions (input order), then codebase.
  if (currentFileItem) {
    contextItems.push(currentFileItem);
  }
  for (const bucket of mentionResults) {
    if (bucket) {
      contextItems.push(...bucket);
    }
  }
  contextItems.push(...codebaseResults);

  // Deduplicates based on either providerTitle + itemId or uri type + value
  const deduplicatedOutputs = contextItems.reduce<ContextItemWithId[]>(
    (acc, item) => {
      if (
        !acc.some(
          (i) =>
            (i.id.providerTitle === item.id.providerTitle &&
              i.id.itemId === item.id.itemId) ||
            (i.uri &&
              item.uri &&
              i.uri.type === item.uri.type &&
              i.uri.value === item.uri.value),
        )
      ) {
        acc.push(item);
      }
      return acc;
    },
    [],
  );
  return { contextItems: deduplicatedOutputs, issued };
}
