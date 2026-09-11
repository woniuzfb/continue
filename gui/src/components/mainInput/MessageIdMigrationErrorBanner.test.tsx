import { render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";
import { createMockStore } from "../../util/test/mockStore";
import {
  setLegacyMessageIdEventSink,
  type LegacyMessageIdEvent,
} from "../../redux/util/legacyMessageIdObservability";
import type { MessageIdMigrationState } from "../../redux/slices/sessionsSlice";
import {
  initialSessionRuntime,
  type SessionRuntimeState,
} from "../../redux/slices/sessionsSlice";
import MessageIdMigrationErrorBanner from "./MessageIdMigrationErrorBanner";
import SessionSaveErrorBanner from "./SessionSaveErrorBanner";
import { SessionScope } from "./TipTapEditor/SessionScope";

/**
 * P4b-1. The banner must be session-scoped, code-specific, and silent for every
 * state that is not a failure (`unsupported` above all: an old host that never
 * declares the capability is the normal compatibility path, not a broken file).
 */

const METRICS_SNAPSHOT = {
  inputTokens: 1_234,
  contextLength: 100_000,
  availableTokens: 98_766,
  contextPercentage: 0.42,
  exceedsContext: false,
};
const METRICS_META = {
  constructionIdentity: "",
  conversationRevision: 0,
  schemaVersion: 1,
};

function failed(
  code: Extract<MessageIdMigrationState, { state: "failed" }>["code"],
  message = "raw core error",
): MessageIdMigrationState {
  return { state: "failed", code, message };
}

function makeStore(
  overrides: Record<string, Partial<SessionRuntimeState>> = {},
  activeSessionId = "s1",
) {
  const sessionsById: Record<string, SessionRuntimeState> = {};
  for (const [id, override] of Object.entries(overrides)) {
    sessionsById[id] = initialSessionRuntime(id, id, {
      fullConversationMetrics: METRICS_SNAPSHOT,
      fullConversationMetricsMeta: METRICS_META,
      ...override,
    });
  }
  const ids = Object.keys(sessionsById);
  return createMockStore({
    sessions: {
      activeSessionId,
      tabOrder: ids,
      tabDescriptors: Object.fromEntries(
        ids.map((id) => [
          id,
          { sessionId: id, title: id, loadState: "loaded" as const },
        ]),
      ),
      sessionsById,
    },
  });
}

function renderFor(store: ReturnType<typeof makeStore>, sessionId: string) {
  return render(
    <Provider store={store}>
      <SessionScope sessionId={sessionId}>
        <MessageIdMigrationErrorBanner />
      </SessionScope>
    </Provider>,
  );
}

describe("MessageIdMigrationErrorBanner", () => {
  it("explains SESSION_FILE_INVALID without claiming the file was damaged", () => {
    const store = makeStore({
      s1: { messageIdMigration: failed("SESSION_FILE_INVALID") },
    });
    renderFor(store, "s1");

    expect(screen.getByText(/Message ID migration failed/)).toBeTruthy();
    expect(screen.getByText(/SESSION_FILE_INVALID/)).toBeTruthy();
    expect(screen.getByText(/could not be read safely/)).toBeTruthy();
    expect(screen.getByText(/left unchanged/)).toBeTruthy();
  });

  it("gives MESSAGE_ID_MIGRATION_FAILED its own copy", () => {
    const store = makeStore({
      s1: { messageIdMigration: failed("MESSAGE_ID_MIGRATION_FAILED") },
    });
    renderFor(store, "s1");

    expect(screen.getByText(/MESSAGE_ID_MIGRATION_FAILED/)).toBeTruthy();
    expect(
      screen.getByText(/could not be upgraded\. The original/),
    ).toBeTruthy();
    // Not the "file could not be read" wording — the two codes differ.
    expect(screen.queryByText(/could not be read safely/)).toBeNull();
  });

  it("describes REQUEST_TIMEOUT as an unfinished host action, not a bad file", () => {
    const store = makeStore({
      s1: { messageIdMigration: failed("REQUEST_TIMEOUT") },
    });
    renderFor(store, "s1");

    expect(screen.getByText(/REQUEST_TIMEOUT/)).toBeTruthy();
    expect(screen.getByText(/did not finish/)).toBeTruthy();
    expect(screen.getByText(/remains available/)).toBeTruthy();
    expect(screen.queryByText(/left unchanged/)).toBeNull();
  });

  it("never renders the raw Core error (it can carry a path)", () => {
    const store = makeStore({
      s1: {
        messageIdMigration: failed(
          "SESSION_FILE_INVALID",
          "/Users/someone/.continue/sessions/abc.json is not valid JSON",
        ),
      },
    });
    const { container } = renderFor(store, "s1");

    expect(container.textContent).not.toContain("/Users/someone");
    expect(container.textContent).not.toContain("is not valid JSON");
    // The stable code is still surfaced so a report can name the case.
    expect(container.textContent).toContain("SESSION_FILE_INVALID");
  });

  it("stays silent for every non-failure state", () => {
    const states: MessageIdMigrationState[] = [
      { state: "not-requested" },
      { state: "pending" },
      { state: "succeeded", migrated: true, addedCount: 3 },
      { state: "succeeded", migrated: false, addedCount: 0 },
      // The ordinary legacy-host path: no capability, nothing was ever sent.
      { state: "unsupported" },
    ];

    for (const migration of states) {
      const store = makeStore({ s1: { messageIdMigration: migration } });
      const { container, unmount } = renderFor(store, "s1");
      expect(container.textContent, migration.state).toBe("");
      unmount();
    }
  });

  it("shows only the owning session's failure, even when another tab is active", () => {
    const store = makeStore(
      {
        s1: { messageIdMigration: failed("SESSION_FILE_INVALID") },
        s2: { messageIdMigration: { state: "not-requested" } },
      },
      "s2",
    );

    // B is visible and clean: A's failure must not surface here.
    const b = renderFor(store, "s2");
    expect(b.container.textContent).toBe("");
    b.unmount();

    // A's own tree still renders A's failure although s2 is the visible tab.
    const a = renderFor(store, "s1");
    expect(a.container.textContent).toContain("SESSION_FILE_INVALID");
    a.unmount();
  });

  it("coexists with the save-failure banner instead of replacing it", () => {
    const store = makeStore({
      s1: {
        dirty: true,
        persistence: {
          state: "failed",
          revision: 2,
          persistedRevision: 1,
          hasPersistedBaseline: true,
          error: { code: "SESSION_SAVE_FAILED", message: "disk full" },
        },
        messageIdMigration: failed("MESSAGE_ID_MIGRATION_FAILED"),
      },
    });
    const { container } = render(
      <Provider store={store}>
        <SessionScope sessionId="s1">
          <SessionSaveErrorBanner />
          <MessageIdMigrationErrorBanner />
        </SessionScope>
      </Provider>,
    );

    expect(container.textContent).toContain("Couldn't save this session");
    expect(container.textContent).toContain("Retry save");
    expect(container.textContent).toContain("Message ID migration failed");
  });

  it("emits no telemetry event on mount or re-render (P5a: never from a component)", () => {
    const events: LegacyMessageIdEvent[] = [];
    setLegacyMessageIdEventSink((event) => {
      events.push(event);
    });
    const store = makeStore(
      {
        s1: { messageIdMigration: failed("SESSION_FILE_INVALID") },
        s2: { messageIdMigration: { state: "not-requested" } },
      },
      "s2",
    );

    const view = renderFor(store, "s1");
    // Force several re-renders; emission points must all live outside React.
    view.rerender(
      <Provider store={store}>
        <SessionScope sessionId="s1">
          <MessageIdMigrationErrorBanner />
        </SessionScope>
      </Provider>,
    );
    view.rerender(
      <Provider store={store}>
        <SessionScope sessionId="s1">
          <MessageIdMigrationErrorBanner />
        </SessionScope>
      </Provider>,
    );

    expect(events).toEqual([]);
  });

  it("changes nothing: no metrics invalidation, no dirty flag, no request", () => {
    const store = makeStore({
      s1: { messageIdMigration: failed("MESSAGE_ID_MIGRATION_FAILED") },
    });
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const before = (store.getState() as any).sessions.sessionsById.s1;
    const metrics = before.fullConversationMetrics;
    const meta = before.fullConversationMetricsMeta;

    const { unmount } = renderFor(store, "s1");
    unmount();

    const after = (store.getState() as any).sessions.sessionsById.s1;
    expect(after.fullConversationMetrics).toBe(metrics);
    expect(after.fullConversationMetricsMeta).toBe(meta);
    expect(after.dirty).toBe(false);
    expect(after.contextPercentage).toBeUndefined();
    const types = request.mock.calls.map((call) => call[0]);
    expect(types).not.toContain("llm/compileChat");
    expect(types).not.toContain("history/save");
    expect(types).not.toContain("history/migrateIds");
  });
});
