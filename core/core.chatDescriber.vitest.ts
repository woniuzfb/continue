import { afterEach, describe, expect, it, vi } from "vitest";
import { Core } from "./core.js";
import type { ILLM } from "./index.js";
import { ChatDescriber } from "./util/chatDescriber.js";

type Handler = (msg: any) => any;

/**
 * Registers the production handler body through `registerMessageHandlers`
 * while avoiding the side effects of constructing a full Core instance.
 * The stand-in supplies only the dependencies accessed during registration
 * and by the chatDescriber/describe handler under test.
 */
function harness(config: unknown) {
  const handlers = new Map<string, Handler>();
  const messenger: any = {
    on(type: string, handler: Handler) {
      handlers.set(type, handler);
    },
    onError() {},
    send() {
      return "";
    },
    async request() {
      return {};
    },
  };

  const core: any = Object.assign(Object.create(Core.prototype), {
    messenger,
    ide: {},
    // Instance arrow field, so it is not on the prototype.
    getContextItems: async () => [],
    configHandler: {
      async loadConfig() {
        return { config };
      },
    },
  });

  (Core.prototype as any).registerMessageHandlers.call(
    core,
    Promise.resolve({}),
  );

  async function invoke(data: unknown) {
    const handler = handlers.get("chatDescriber/describe");
    if (!handler) {
      throw new Error("chatDescriber/describe was not registered");
    }
    return await handler({ messageType: "chatDescriber/describe", data });
  }

  return { invoke };
}

function llm(title: string | undefined, model: string): ILLM {
  return { title, model } as ILLM;
}

function config(models: ILLM[], selected: ILLM | null) {
  return {
    modelsByRole: { chat: models },
    selectedModelByRole: { chat: selected },
  };
}

const modelA = llm("model-a", "a");
const modelB = llm("model-b", "b");

describe("chatDescriber/describe model resolution (方案.md §七.10)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the model named in the request, not the global selection", async () => {
    // The profile-level selection is B; the request belongs to A.
    const { invoke } = harness(config([modelA, modelB], modelB));
    const describe = vi
      .spyOn(ChatDescriber, "describe")
      .mockResolvedValue("TITLE");
    const messages = [{ role: "user" as const, content: "q" }];

    await invoke({
      sessionId: "A",
      modelTitle: "model-a",
      text: "hi",
      messages,
    });

    expect(describe).toHaveBeenCalledTimes(1);
    expect(describe.mock.calls[0][0]).toBe(modelA);
    expect(describe.mock.calls.map((call) => call[0])).not.toContain(modelB);
    // text / messages are still forwarded untouched.
    expect(describe.mock.calls[0][2]).toBe("hi");
    expect(describe.mock.calls[0][3]).toBe(messages);
  });

  it("fails instead of falling back to the global model when the title is unknown", async () => {
    const { invoke } = harness(config([modelA, modelB], modelB));
    const describe = vi
      .spyOn(ChatDescriber, "describe")
      .mockResolvedValue("TITLE");

    await expect(
      invoke({ sessionId: "A", modelTitle: "missing-model", text: "hi" }),
    ).rejects.toThrow(/missing-model/);

    // The whole point of the contract: no silent cross-session fallback.
    expect(describe).not.toHaveBeenCalled();
  });

  it("matches a title-less model by its model name", async () => {
    // `llmToSerializedModelDescription` writes `title: llm.title ?? llm.model`,
    // so the GUI can legitimately send a "title" that is really the model name.
    const titleless = llm(undefined, "llama3");
    const { invoke } = harness(config([titleless, modelB], modelB));
    const describe = vi
      .spyOn(ChatDescriber, "describe")
      .mockResolvedValue("TITLE");

    await invoke({ sessionId: "A", modelTitle: "llama3", text: "hi" });

    expect(describe).toHaveBeenCalledTimes(1);
    expect(describe.mock.calls[0][0]).toBe(titleless);
  });
});
