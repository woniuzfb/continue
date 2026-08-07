import "@testing-library/jest-dom";

// Node 25+ ships its own experimental `localStorage` global whose getter
// returns undefined when web storage is not configured. Because the key
// already exists on globalThis, vitest's jsdom environment does not re-copy
// jsdom's storage onto it (populateGlobal only redefines existing keys that
// are in its curated list), leaving `localStorage` undefined in tests.
// Bridge the real jsdom storage — or a minimal in-memory fallback for
// non-jsdom environments — onto globalThis.
function createInMemoryStorage(): Storage {
  let store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store = new Map();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } as Storage;
}

const jsdomWindow = (globalThis as any).jsdom?.window;
for (const key of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, key, {
    value: jsdomWindow?.[key] ?? createInMemoryStorage(),
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.resetAllMocks();
});

// Suppress uncaught ProseMirror errors in test environment
window.addEventListener("error", (event) => {
  if (
    event.error?.message?.includes("getClientRects") ||
    event.error?.message?.includes("prosemirror")
  ) {
    event.preventDefault();
    return false;
  }
});

window.addEventListener("unhandledrejection", (event) => {
  if (
    event.reason?.message?.includes("getClientRects") ||
    event.reason?.message?.includes("prosemirror")
  ) {
    event.preventDefault();
    return false;
  }
});

// https://github.com/vitest-dev/vitest/issues/821
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock getBoundingClientRect and getClientRects for ProseMirror
Object.defineProperty(Element.prototype, "getClientRects", {
  value: vi.fn(() => ({
    length: 1,
    0: { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 },
    item: () => ({
      top: 0,
      bottom: 20,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
    }),
  })),
});

Object.defineProperty(Element.prototype, "getBoundingClientRect", {
  value: vi.fn(() => ({
    top: 0,
    bottom: 20,
    left: 0,
    right: 100,
    width: 100,
    height: 20,
  })),
});
