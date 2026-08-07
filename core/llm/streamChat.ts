import { fetchwithRequestOptions } from "@continuedev/fetch";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ChatMessage, IDE, PromptLog } from "..";
import { ConfigHandler } from "../config/ConfigHandler";
import { FromCoreProtocol, ToCoreProtocol } from "../protocol";
import { IMessenger, Message } from "../protocol/messenger";

import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";
import { removeCodeBlocksAndTrim } from "../util";
import { TTS } from "../util/tts";

function sanitizeForMCPTTS(text: string): string {
  return (
    removeCodeBlocksAndTrim(text)
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/\|<im_end>\|/gi, "")
      .replace(/<assistant>/gi, "")
      .replace(/<\/assistant>/gi, "")
      .replace(/<user>/gi, "")
      .replace(/<\/user>/gi, "")
      .replace(/<system>/gi, "")
      .replace(/<\/system>/gi, "")
      // Remove markdown formatting
      .replace(/^#+\s/gm, "") // headings
      .replace(/`{1,3}[^`]+`{1,3}/g, "") // inline code
      .replace(/\*\*(.+?)\*\*/g, "$1") // bold
      .replace(/\*(.+?)\*/g, "$1") // italic
      .replace(/^[-*+]\s/gm, "") // bullet points
      .replace(/^\d+\.\s/gm, "") // numbered lists
      // Remove emoji and other non-text symbols
      .replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{2328}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{200D}\u{20E3}\u{FE0F}]/gu,
        "",
      )
      // Remove operational tool messages (precise prefix matching)
      .replace(/^Continue (tried to|attempted to|is|was) .*/gm, "")
      .replace(/^\[.*?\] (returned|output|result|called|executed):?.*/gm, "")
      .replace(/^(Running|Executing|Calling|Invoking) (tool|command):?.*/gm, "")
      // Collapse all newlines and whitespace into a single clean line
      .replace(/\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/\*/g, "") // strip all asterisks (unpaired bold/italic markers)
      .trim()
  );
}

// Per-connection serial queues to ensure TTS sentences are spoken in order.
// Each entry is a { text, toolName, resolve } object.
const ttsQueues = new Map<
  string,
  { text: string; toolName: string; resolve: () => void }[]
>();
const ttsQueueRunning = new Map<string, boolean>();

// System TTS never rejects the caller: playback errors are logged and
// swallowed, so a failing `say`/`espeak` can never wedge a queue or produce
// an unhandled rejection from the fire-and-forget call sites.
function safeSystemTTS(text: string): Promise<void> {
  return TTS.read(text).catch((e) => {
    console.warn(`TTS playback error: ${e}`);
  });
}

async function processTTSQueue(
  mcpId: string,
  manager: ReturnType<typeof MCPManagerSingleton.getInstance>,
): Promise<void> {
  if (ttsQueueRunning.get(mcpId)) return;
  ttsQueueRunning.set(mcpId, true);

  try {
    const queue = ttsQueues.get(mcpId);
    while (queue && queue.length > 0) {
      const item = queue[0];
      try {
        const connection = manager.getConnection(mcpId);
        if (!connection) {
          // Connection gone — dequeue everything
          while (queue.length > 0) {
            const skipped = queue.shift()!;
            skipped.resolve();
          }
          break;
        }

        const doCall = async () =>
          connection.client.callTool(
            { name: item.toolName, arguments: { text: item.text } },
            CallToolResultSchema,
            { timeout: connection.options.timeout },
          );

        let ok = false;
        // First attempt
        try {
          await doCall();
          ok = true;
        } catch {
          // Call failed — try reconnecting once and retry.
          // silent: avoid triggering reloadConfig, which would re-run
          // rectifySelectedModelsFromGlobalContext and potentially switch
          // the user's selected chat model.
          try {
            await manager.refreshConnection(mcpId, { silent: true });
          } catch {
            // Reconnect itself failed
          }
          try {
            await doCall();
            ok = true;
          } catch {
            // Retry also failed
          }
        }

        if (!ok) {
          console.warn(
            `MCP TTS server "${mcpId}" unavailable, falling back to system TTS`,
          );
          await safeSystemTTS(item.text);
        }
      } catch (e) {
        // A single failed item must never wedge the queue: fall back to
        // system TTS, resolve the item, and keep draining.
        console.warn(`MCP TTS item failed for "${mcpId}":`, e);
        try {
          await safeSystemTTS(item.text);
        } catch {
          // Even the system TTS fallback failed — drop the item so the
          // queue moves on instead of hanging forever.
        }
      } finally {
        item.resolve();
        queue.shift();
      }
    }
  } finally {
    ttsQueueRunning.set(mcpId, false);
    const queue = ttsQueues.get(mcpId);
    // If items arrived during the drain (between last shift() and clearing
    // the flag), restart draining so nothing is left unspoken.
    if (queue && queue.length > 0) {
      void processTTSQueue(mcpId, manager);
    }
  }
}

async function readWithMCPTTS(
  text: string,
  mcpId: string,
  toolName: string,
): Promise<void> {
  text = sanitizeForMCPTTS(text);
  if (!text) return;

  const manager = MCPManagerSingleton.getInstance();
  const connection = manager.getConnection(mcpId);
  if (!connection) {
    console.warn(
      `MCP TTS server "${mcpId}" not found, falling back to system TTS`,
    );
    await safeSystemTTS(text);
    return;
  }

  // Enqueue this sentence to be spoken in order
  return new Promise<void>((resolve) => {
    let queue = ttsQueues.get(mcpId);
    if (!queue) {
      queue = [];
      ttsQueues.set(mcpId, queue);
    }
    queue.push({ text, toolName, resolve });
    void processTTSQueue(mcpId, manager);
  });
}

export async function* llmStreamChat(
  configHandler: ConfigHandler,
  abortController: AbortController,
  msg: Message<ToCoreProtocol["llm/streamChat"][0]>,
  ide: IDE,
  messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>,
): AsyncGenerator<ChatMessage, PromptLog> {
  const { config } = await configHandler.loadConfig();
  if (!config) {
    throw new Error("Config not loaded");
  }

  // Stop TTS on new StreamChat
  if (config.experimental?.readResponseTTS) {
    void TTS.kill();
  }

  const {
    legacySlashCommandData,
    completionOptions,
    messages,
    messageOptions,
  } = msg.data;

  const model = config.selectedModelByRole.chat;

  if (!model) {
    throw new Error("No chat model selected");
  }

  // Log to return in case of error
  const errorPromptLog = {
    modelTitle: model?.title ?? model?.model,
    modelProvider: model?.underlyingProviderName ?? "unknown",
    completion: "",
    prompt: "",
    completionOptions: {
      ...msg.data.completionOptions,
      model: model?.model,
    },
  };

  try {
    if (legacySlashCommandData) {
      const { command, contextItems, historyIndex, input, selectedCode } =
        legacySlashCommandData;
      const slashCommand = config.slashCommands?.find(
        (sc) => sc.name === command.name,
      );
      if (!slashCommand) {
        throw new Error(`Unknown slash command ${command.name}`);
      }
      if (!slashCommand.run) {
        console.error(
          `Slash command ${command.name} (${command.source}) has no run function`,
        );
        throw new Error(`Slash command not found`);
      }

      const gen = slashCommand.run({
        input,
        history: messages,
        llm: model,
        contextItems,
        params: command.params,
        ide,
        addContextItem: (item) => {
          void messenger.request("addContextItem", {
            item,
            historyIndex,
          });
        },
        selectedCode,
        config,
        fetch: (url, init) =>
          fetchwithRequestOptions(
            url,
            {
              ...init,
              signal: abortController.signal,
            },
            model.requestOptions,
          ),
        completionOptions,
        abortController,
      });
      let next = await gen.next();
      while (!next.done) {
        if (abortController.signal.aborted) {
          next = await gen.return(errorPromptLog);
          break;
        }
        if (next.value) {
          yield {
            role: "assistant",
            content: next.value,
          };
        }
        next = await gen.next();
      }
      if (!next.done) {
        throw new Error("Will never happen");
      }

      return next.value;
    } else {
      const gen = model.streamChat(
        messages,
        abortController.signal,
        completionOptions,
        messageOptions,
      );
      let ttsBuffer = "";

      let next = await gen.next();
      while (!next.done) {
        if (abortController.signal.aborted) {
          next = await gen.return(errorPromptLog);
          break;
        }

        const chunk = next.value;

        // Stream TTS on each chunk if streaming mode is enabled
        if (
          config.experimental?.readResponseTTS &&
          config.experimental?.readResponseTTSStream &&
          chunk.content &&
          typeof chunk.content === "string" &&
          !(
            config.experimental?.readResponseTTSExcludeThinking &&
            chunk.role === "thinking"
          )
        ) {
          ttsBuffer += chunk.content;
          // Flush on sentence boundaries for more natural speech.
          // Supports Western (. ! ?) and CJK (。！？) sentence-final marks.
          // NOTE: sentenceEnd carries the /g flag, so its lastIndex is stateful
          // across exec() calls. Because we re-slice ttsBuffer to a shorter
          // string on every iteration, we MUST reset lastIndex to 0 before the
          // next exec(); otherwise the search resumes at a stale offset in the
          // new (shorter) buffer and silently skips or merges sentences.
          const sentenceEnd = /[.。!！?？]+/g;
          let match;
          while ((match = sentenceEnd.exec(ttsBuffer)) !== null) {
            const endIdx = match.index + match[0].length;
            const sentence = ttsBuffer.slice(0, endIdx).trim();
            ttsBuffer = ttsBuffer.slice(endIdx).trim();
            // Buffer was resliced from the boundary; restart matching at 0.
            sentenceEnd.lastIndex = 0;
            if (sentence) {
              // Strip thinking tags if configured
              let sentenceToRead = sentence;
              if (config.experimental?.readResponseTTSExcludeThinking) {
                sentenceToRead = sentenceToRead
                  .replace(/<think>[\s\S]*?<\/think>/gi, "")
                  .replace(/\|<im_end>\|/gi, "")
                  .trim();
              }
              if (!sentenceToRead) continue;
              const ttsServer = config.experimental?.readResponseTTSServer;
              if (ttsServer) {
                // Fire-and-forget: don't block the stream on TTS
                void readWithMCPTTS(
                  sentenceToRead,
                  ttsServer.mcpId,
                  ttsServer.toolName,
                );
              } else {
                void safeSystemTTS(sentenceToRead);
              }
            }
          }
        }

        yield chunk;
        next = await gen.next();
      }

      // Flush remaining buffer after stream ends
      if (
        config.experimental?.readResponseTTS &&
        config.experimental?.readResponseTTSStream &&
        ttsBuffer.trim()
      ) {
        let remainingText = ttsBuffer.trim();
        if (config.experimental?.readResponseTTSExcludeThinking) {
          remainingText = remainingText
            .replace(/<think>[\s\S]*?<\/think>/gi, "")
            .replace(/\|<im_end>\|/gi, "")
            .trim();
        }
        if (remainingText) {
          const ttsServer = config.experimental?.readResponseTTSServer;
          if (ttsServer) {
            void readWithMCPTTS(
              remainingText,
              ttsServer.mcpId,
              ttsServer.toolName,
            );
          } else {
            void safeSystemTTS(remainingText);
          }
        }
      }

      if (
        config.experimental?.readResponseTTS &&
        !config.experimental?.readResponseTTSStream &&
        "completion" in next.value
      ) {
        let completionText = next.value?.completion;
        // Strip thinking content if configured
        if (
          config.experimental?.readResponseTTSExcludeThinking &&
          completionText
        ) {
          completionText = completionText
            .replace(/<think>[\s\S]*?<\/think>/gi, "")
            .replace(/\|<im_end>\|/gi, "");
        }
        const ttsServer = config.experimental?.readResponseTTSServer;
        if (ttsServer) {
          void readWithMCPTTS(
            completionText,
            ttsServer.mcpId,
            ttsServer.toolName,
          );
        } else {
          void safeSystemTTS(completionText);
        }
      }

      if (!next.done) {
        throw new Error("Will never happen");
      }

      return next.value;
    }
  } catch (error) {
    // Moved error handling that was here to GUI, keeping try/catch for clean diff
    throw error;
  }
}
