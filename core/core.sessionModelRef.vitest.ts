import { describe, expect, it, vi } from "vitest";
import { Core } from "./core.js";
import type { ILLM, SessionChatModelRef } from "./index.js";

/**
 * 方案.md §7.5.4, the **Core** half: a request states which model it is for, and Core must execute
 * exactly that decision or refuse.
 *
 * Both handlers are exercised through the real registration path (`registerMessageHandlers`), so the
 * wiring is covered too — the defect this contract fixes was precisely that `llm/compileChat` and
 * `llm/streamChat` resolved their model independently (one from the profile default, one from the
 * request), which made a request compile against one model and be answered by another.
 */

type Handler = (msg: any) => any;

function fakeModel(
  title: string,
  model: string,
  providerName: string,
  behaviour: "ok" | "explode" = "ok",
) {
  const instance = {
    title,
    model,
    providerName,
    underlyingProviderName: providerName,
    streamChat: vi.fn(async function* () {
      yield { role: "assistant", content: `answered by ${providerName}` };
    }),
    compileChatMessages: vi.fn(() => ({
      compiledChatMessages: [],
      didPrune: false,
      contextPercentage: 0,
      inputTokens: 0,
      contextLength: 0,
    })),
  };
  if (behaviour === "explode") {
    instance.streamChat = vi.fn(() => {
      throw new Error("this model must never be called");
    }) as any;
  }
  return instance;
}

/**
 * Registers the production handler bodies while supplying only the dependencies they touch. The
 * config carries the model list and — deliberately — a *different* `selectedModelByRole.chat`, so a
 * fallback to the profile default would be observable rather than invisible.
 */
function harness(models: ReturnType<typeof fakeModel>[], defaultModel?: any) {
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
  const config = {
    modelsByRole: { chat: models },
    selectedModelByRole: { chat: defaultModel ?? null },
  };
  const core: any = Object.assign(Object.create(Core.prototype), {
    messenger,
    // Instance arrow field (not on the prototype): the stream handler registers its abort controller
    // before the model is ever resolved.
    messageAbortControllers: new Map(),
    ide: {},
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

  /** Drive the stream handler far enough that the model's own `streamChat` has been entered. */
  async function stream(data: unknown) {
    const handler = handlers.get("llm/streamChat");
    if (!handler) {
      throw new Error("llm/streamChat was not registered");
    }
    const generator = await handler({
      messageType: "llm/streamChat",
      messageId: "m1",
      data,
    });
    const first = await generator.next();
    return { generator, first };
  }

  async function compile(data: unknown) {
    const handler = handlers.get("llm/compileChat");
    if (!handler) {
      throw new Error("llm/compileChat was not registered");
    }
    return await handler({ messageType: "llm/compileChat", data });
  }

  return { stream, compile };
}

const REF_OPENAI: SessionChatModelRef = {
  title: "model-a",
  provider: "openai",
  model: "a",
};
const REF_ANTHROPIC: SessionChatModelRef = {
  title: "model-a",
  provider: "anthropic",
  model: "a",
};

const baseStreamData = (overrides: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: "hi" }],
  completionOptions: {},
  title: "model-a",
  messageOptions: { precompiled: true },
  ...overrides,
});

describe("llm/streamChat resolves the model from the request's ref (方案.md §7.5.4)", () => {
  it("calls the model the ref names, not the profile default", async () => {
    const openai = fakeModel("model-a", "a", "openai");
    const anthropic = fakeModel("model-a", "a", "anthropic");
    const fallback = fakeModel("fallback", "f", "fallback", "explode");
    const { stream } = harness([openai, anthropic], fallback);

    await stream(baseStreamData({ modelRef: REF_ANTHROPIC }));

    expect(anthropic.streamChat).toHaveBeenCalled();
    expect(openai.streamChat).not.toHaveBeenCalled();
    // The profile default is never a second chance.
    expect(fallback.streamChat).not.toHaveBeenCalled();
  });

  it("refuses when the ref matches no entry instead of using the profile default", async () => {
    const openai = fakeModel("model-a", "a", "openai");
    const fallback = fakeModel("fallback", "f", "fallback", "explode");
    const { stream } = harness([openai], fallback);

    await expect(
      stream(baseStreamData({ modelRef: REF_ANTHROPIC })),
    ).rejects.toThrow(/REF_NOT_FOUND/);
    expect(openai.streamChat).not.toHaveBeenCalled();
    expect(fallback.streamChat).not.toHaveBeenCalled();
  });

  it("refuses when the ref is ambiguous", async () => {
    // Two identical entries: the "identity" is not an identity, so nothing may be called.
    const first = fakeModel("model-b", "b", "openai");
    const second = fakeModel("model-b", "b", "openai");
    const { stream } = harness([first, second], first);

    await expect(
      stream(
        baseStreamData({
          title: "model-b",
          modelRef: { title: "model-b", provider: "openai", model: "b" },
        }),
      ),
    ).rejects.toThrow(/REF_AMBIGUOUS/);
    expect(first.streamChat).not.toHaveBeenCalled();
    expect(second.streamChat).not.toHaveBeenCalled();
  });

  it("does not fall back to the title when a ref is present but fails", async () => {
    // The request also carries `title: "model-a"`, which *would* resolve. A ref that fails is an
    // error, not an invitation to guess again by title — that is how a turn drifts to another model.
    const openai = fakeModel("model-a", "a", "openai");
    const { stream } = harness([openai], openai);

    await expect(
      stream(
        baseStreamData({
          title: "model-a",
          modelRef: { title: "model-a", provider: "anthropic", model: "a" },
        }),
      ),
    ).rejects.toThrow(/REF_NOT_FOUND/);
    expect(openai.streamChat).not.toHaveBeenCalled();
  });

  it("accepts an old client's title-only request by a unique title (compat, tested apart)", async () => {
    // 旧请求没有 ref 时的兼容行为：显式分叉、单独测试，不与新协议语义混写。
    const openai = fakeModel("model-a", "a", "openai");
    const other = fakeModel("model-b", "b", "openai");
    const { stream } = harness([openai, other], other);

    await stream(baseStreamData({ modelRef: undefined, title: "model-a" }));

    expect(openai.streamChat).toHaveBeenCalled();
    expect(other.streamChat).not.toHaveBeenCalled();
  });

  it("refuses an old client's ambiguous title, without using the default", async () => {
    const openai = fakeModel("model-a", "a", "openai");
    const anthropic = fakeModel("model-a", "a", "anthropic");
    const fallback = fakeModel("fallback", "f", "fallback", "explode");
    const { stream } = harness([openai, anthropic], fallback);

    await expect(
      stream(baseStreamData({ modelRef: undefined, title: "model-a" })),
    ).rejects.toThrow(/TITLE_AMBIGUOUS/);
    expect(openai.streamChat).not.toHaveBeenCalled();
    expect(anthropic.streamChat).not.toHaveBeenCalled();
    expect(fallback.streamChat).not.toHaveBeenCalled();
  });

  it("names only the identity in the error — no key, endpoint or prompt", async () => {
    const models = [fakeModel("model-a", "a", "openai")];
    const { stream } = harness(models, models[0]);

    let message = "";
    try {
      await stream(
        baseStreamData({
          messages: [{ role: "user", content: "SUPER SECRET PROMPT" }],
          modelRef: { title: "gone", provider: "openai", model: "g" },
        }),
      );
      throw new Error("expected the request to be refused");
    } catch (e) {
      message = (e as Error).message;
    }
    // The ref's three fields are the ones the toolbar shows, so they are safe to log verbatim.
    expect(message).toContain("gone (openai/g)");
    // Nothing else about the request may leak into it.
    expect(message).not.toContain("SUPER SECRET PROMPT");
    expect(message).not.toMatch(/apiKey|apiBase|https?:\/\//);
  });
});

describe("llm/compileChat uses the same identity as the stream (方案.md §7.5.4)", () => {
  it("compiles with the model the ref names", async () => {
    const openai = fakeModel("model-a", "a", "openai");
    const anthropic = fakeModel("model-a", "a", "anthropic");
    const fallback = fakeModel("fallback", "f", "fallback", "explode");
    const { compile } = harness([openai, anthropic], fallback);

    await compile({
      messages: [],
      options: {},
      modelRef: REF_ANTHROPIC,
    });

    expect(anthropic.compileChatMessages).toHaveBeenCalled();
    expect(openai.compileChatMessages).not.toHaveBeenCalled();
    // Before this contract, compile used `selectedModelByRole.chat` — the fallback — so the token
    // budget and prune decision described a different model than the one that answered.
    expect(fallback.compileChatMessages).not.toHaveBeenCalled();
  });

  it("refuses instead of compiling with the profile default", async () => {
    const openai = fakeModel("model-a", "a", "openai");
    const fallback = fakeModel("fallback", "f", "fallback");
    const { compile } = harness([openai], fallback);

    await expect(
      compile({
        messages: [],
        options: {},
        modelRef: { title: "gone", provider: "openai", model: "g" },
      }),
    ).rejects.toThrow(/REF_NOT_FOUND/);
    expect(fallback.compileChatMessages).not.toHaveBeenCalled();
    expect(openai.compileChatMessages).not.toHaveBeenCalled();
  });

  it("refuses a request that identifies no model at all", async () => {
    const openai = fakeModel("model-a", "a", "openai");
    const { compile } = harness([openai], openai);

    await expect(compile({ messages: [], options: {} })).rejects.toThrow(
      /NO_DEFAULT_MODEL/,
    );
    expect(openai.compileChatMessages).not.toHaveBeenCalled();
  });

  it("resolves an old client's title-only compile request the same way the stream does", async () => {
    const openai = fakeModel("model-a", "a", "openai");
    const other = fakeModel("model-b", "b", "openai");
    const { compile } = harness([openai, other], other);

    await compile({ messages: [], options: {}, title: "model-a" });

    expect(openai.compileChatMessages).toHaveBeenCalled();
    expect(other.compileChatMessages).not.toHaveBeenCalled();
  });
});
