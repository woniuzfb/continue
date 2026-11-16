import { act, render } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";
import { SessionScope } from "../../../components/mainInput/TipTapEditor/SessionScope";
import { initialSessionRuntime } from "../../../redux/slices/sessionsSlice";
import { registerSessionStreamRunner } from "../../../redux/thunks/sessionTools";
import { createMockStore } from "../../../util/test/mockStore";
import { AskUserQuestion } from "./AskUserQuestion";

describe("AskUserQuestion component", () => {
  it("auto-settles with timedOut=true when timeout expires and continues at the session stream depth", async () => {
    vi.useFakeTimers();
    try {
      const s1 = initialSessionRuntime("s1", "Chat 1", {
        history: [
          {
            message: { id: "u1", role: "user", content: "ask me" } as any,
            contextItems: [],
          },
          {
            message: {
              id: "a1",
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "t-ask",
                  type: "function",
                  function: { name: "ask_user_question", arguments: "{}" },
                },
              ],
            } as any,
            contextItems: [],
            toolCallStates: [
              {
                toolCallId: "t-ask",
                toolCall: {
                  id: "t-ask",
                  type: "function",
                  function: { name: "ask_user_question", arguments: "{}" },
                },
                status: "calling",
                parsedArgs: {},
              },
            ],
          },
        ],
        stream: { status: "idle", requestId: "req-1", depth: 3 },
      });
      const store = createMockStore({
        sessions: {
          activeSessionId: "s1",
          tabOrder: ["s1"],
          tabDescriptors: {
            s1: { sessionId: "s1", title: "Chat 1", loadState: "loaded" },
          },
          sessionsById: { s1 },
        },
      });
      const runner = vi.fn(async () => {});
      registerSessionStreamRunner(runner);

      render(
        <Provider store={store as any}>
          <SessionScope sessionId="s1">
            <AskUserQuestion
              toolCallId="t-ask"
              status="calling"
              timeout={2}
              questions={[
                {
                  id: "q1",
                  question: "Choose option",
                  options: [{ label: "Yes" }, { label: "No" }],
                },
              ]}
            />
          </SessionScope>
        </Provider>,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });

      const state = (store.getState() as any).sessions.sessionsById.s1;
      const toolState = state.history[1].toolCallStates[0];
      expect(toolState.status).toBe("done");
      expect(JSON.parse(toolState.output[0].content)).toEqual({
        cancelled: true,
        timedOut: true,
        answers: [],
      });
      expect(runner).toHaveBeenCalledWith({
        sessionId: "s1",
        requestId: "req-1",
        depth: 4,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
