import type { RenderOptions, RenderResult } from "@testing-library/react";
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PropsWithChildren } from "react";
import { Provider } from "react-redux";
import { MemoryRouter, RouterProps } from "react-router-dom";
import { MainEditorProvider } from "../../components/mainInput/TipTapEditor";
import { SessionScope } from "../../components/mainInput/TipTapEditor/SessionScope";
import { AuthProvider } from "../../context/Auth";
import { IdeMessengerProvider } from "../../context/IdeMessenger";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import ParallelListeners from "../../hooks/ParallelListeners";
import { setupStore } from "../../redux/store";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { v4 as uuidv4 } from "uuid";
import {
  createSessionRuntime,
  initialSessionRuntime,
  setActiveSessionId,
} from "../../redux/slices/sessionsSlice";
// As a basic setup, import your same slice reducers

// This type interface extends the default options for render from RTL, as well
// as allows the user to specify other things such as initialState, store.
type ExtendedRenderOptions = Omit<RenderOptions, "queries"> & {
  store?: ReturnType<typeof setupStore>;
  routerProps?: RouterProps;
  mockIdeMessenger?: MockIdeMessenger;
};

function setupMocks() {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
}

export async function renderWithProviders(
  ui: React.ReactElement,
  extendedRenderOptions: ExtendedRenderOptions = {},
) {
  setupMocks();
  const ideMessenger =
    extendedRenderOptions?.mockIdeMessenger ?? new MockIdeMessenger();

  const {
    // Automatically create a store instance if no store was passed in
    store = setupStore({
      ideMessenger,
    }),
    routerProps = {},
    ...renderOptions
  } = extendedRenderOptions;

  // Phase 4 harness (方案.md §九): the rendered app reads the active session
  // through sessionsById, so seed a runtime for a fresh session unless the
  // caller provided one.
  const bootState = store.getState() as any;
  let seedSessionId = bootState.sessions.activeSessionId ?? "";
  if (Object.keys(bootState.sessions.sessionsById).length === 0) {
    const sessionId = uuidv4();
    seedSessionId = sessionId;
    await store.dispatch(
      createSessionRuntime({
        session: initialSessionRuntime(sessionId, NEW_SESSION_TITLE, {
          mode: "agent",
        }),
      }) as any,
    );
    await store.dispatch(setActiveSessionId({ sessionId }) as any);
  }

  const user = userEvent.setup();

  // A caller may deliberately render a store without any session (for example
  // to exercise the empty `SessionViews` bootstrap placeholder). In that case
  // there is no session to scope, and wrapping in `SessionScope("")` would make
  // every `useSessionId()` throw — the component under test must provide its
  // own scope instead.
  const scoped = (children: React.ReactNode) =>
    seedSessionId ? (
      <SessionScope sessionId={seedSessionId}>
        <MainEditorProvider sessionId={seedSessionId}>
          {children}
        </MainEditorProvider>
      </SessionScope>
    ) : (
      <>{children}</>
    );

  const Wrapper = ({ children }: PropsWithChildren) => (
    <MemoryRouter {...routerProps}>
      <IdeMessengerProvider messenger={ideMessenger}>
        <Provider store={store}>
          <AuthProvider>
            {scoped(children)}
            <ParallelListeners />
          </AuthProvider>
        </Provider>
      </IdeMessengerProvider>
    </MemoryRouter>
  );

  let rendered: RenderResult;
  await act(async () => {
    rendered = render(ui, { wrapper: Wrapper, ...renderOptions });
  });

  // Return an object with the store and all of RTL's query functions
  return {
    user,
    store,
    ideMessenger,
    ...rendered!,
  };
}
