import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import { resolveStreamRetry } from "../../util/streamRetry";
import { INITIAL_CONFIG_SLICE } from "../slices/configSlice";
import { initialSessionRuntime } from "../slices/sessionsSlice";
import { sessionStreamWrapper } from "./sessionStreamWrapper";

function makeStore() {
  const s1 = initialSessionRuntime("s1", "Chat 1", {
    history: [
      {
        message: { id: "u1", role: "user", content: "hi" } as any,
        contextItems: [],
      },
    ],
    chatModelTitle: "gpt-4o",
    stream: { status: "streaming", requestId: "req-1" },
  });
  const s2 = initialSessionRuntime("s2", "Chat 2", {
    stream: { status: "streaming", requestId: "req-2" },
  });
  return createMockStore({
    sessions: {
      activeSessionId: "s2",
      tabOrder: ["s1", "s2"],
      tabDescriptors: {
        s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
        s2: { sessionId: "s2", title: "Chat 2", loadState: "loaded" },
      },
      sessionsById: { s1, s2 },
    },
    config: {
      ...INITIAL_CONFIG_SLICE,
      config: {
        ...INITIAL_CONFIG_SLICE.config,
        modelsByRole: {
          ...INITIAL_CONFIG_SLICE.config.modelsByRole,
          chat: [
            {
              title: "gpt-4o",
              provider: "openai",
              model: "gpt-4o",
            } as any,
          ],
        },
      },
    },
  });
}

function run(store: ReturnType<typeof makeStore>, thunk: any) {
  return (store.dispatch(thunk) as any).unwrap() as Promise<boolean>;
}

function dialogShown(store: ReturnType<typeof makeStore>) {
  return (store.getState() as any).ui.showDialog;
}

describe("sessionStreamWrapper", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns true without a dialog when the stream succeeds", async () => {
    const store = makeStore();
    const runStream = vi.fn(async () => {});

    expect(
      await run(store, sessionStreamWrapper({ sessionId: "s1", runStream })),
    ).toBe(true);
    expect(runStream).toHaveBeenCalledTimes(1);
    expect(dialogShown(store)).toBe(false);
  });

  it("shows the error dialog and returns false on a permanent error", async () => {
    const store = makeStore();
    const runStream = vi.fn(async () => {
      throw new Error("invalid api key");
    });

    expect(
      await run(store, sessionStreamWrapper({ sessionId: "s1", runStream })),
    ).toBe(false);
    expect(dialogShown(store)).toBe(true);
    expect(runStream).toHaveBeenCalledTimes(1);
  });

  it("stops only the failing session's live request", async () => {
    const store = makeStore();
    const aborter = new AbortController();
    store.dispatch({
      type: "sessions/beginSessionStream",
      payload: { sessionId: "s1", requestId: "req-1", aborter },
    });
    const otherAborter = new AbortController();
    store.dispatch({
      type: "sessions/beginSessionStream",
      payload: { sessionId: "s2", requestId: "req-2", aborter: otherAborter },
    });

    await run(
      store,
      sessionStreamWrapper({
        sessionId: "s1",
        runStream: async () => {
          throw new Error("invalid api key");
        },
      }),
    );

    expect(aborter.signal.aborted).toBe(true);
    expect(otherAborter.signal.aborted).toBe(false);
  });

  it("retries a transient failure when the user chooses retry", async () => {
    const store = makeStore();
    const error = Object.assign(new Error("socket hang up"), {
      response: { status: 503 },
    });
    let attempts = 0;
    const runStream = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw error;
      }
    });

    const promise = run(
      store,
      sessionStreamWrapper({ sessionId: "s1", runStream }),
    );
    // The retry dialog resolves the wrapper's pending choice.
    await vi.waitFor(() => expect(dialogShown(store)).toBe(true));
    resolveStreamRetry("retry");

    expect(await promise).toBe(true);
    expect(runStream).toHaveBeenCalledTimes(2);
  }, 15000);

  it("returns false when the user disconnects", async () => {
    const store = makeStore();
    const error = Object.assign(new Error("socket hang up"), {
      response: { status: 503 },
    });
    const runStream = vi.fn(async () => {
      throw error;
    });

    const promise = run(
      store,
      sessionStreamWrapper({ sessionId: "s1", runStream }),
    );
    await vi.waitFor(() => expect(dialogShown(store)).toBe(true));
    resolveStreamRetry("disconnect");

    expect(await promise).toBe(false);
    expect(runStream).toHaveBeenCalledTimes(1);
  }, 15000);
});
