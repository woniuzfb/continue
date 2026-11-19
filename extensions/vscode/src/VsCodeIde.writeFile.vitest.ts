import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const disk = new Map<string, string>();
  const openDocs: Array<{
    uri: { toString(): string; path: string };
    text: string;
    isDirty: boolean;
    getText(): string;
    positionAt(offset: number): { offset: number };
    save: ReturnType<typeof vi.fn>;
  }> = [];
  let applyEditShouldSucceed = true;

  const fsWriteFile = vi.fn(
    async (uri: { toString(): string }, content: Buffer | Uint8Array) => {
      disk.set(uri.toString(), Buffer.from(content).toString("utf8"));
    },
  );

  const applyEdit = vi.fn(
    async (edit: {
      replacements: Array<{ uri: { toString(): string }; newText: string }>;
    }) => {
      if (!applyEditShouldSucceed) {
        return false;
      }
      for (const r of edit.replacements) {
        const doc = openDocs.find((d) => d.uri.toString() === r.uri.toString());
        if (doc) {
          doc.text = r.newText;
          doc.isDirty = true;
        }
      }
      return true;
    },
  );

  return {
    disk,
    openDocs,
    fsWriteFile,
    applyEdit,
    setApplyEditShouldSucceed(v: boolean) {
      applyEditShouldSucceed = v;
    },
  };
});

vi.mock("vscode", () => {
  class FakeRange {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  }
  class FakeWorkspaceEdit {
    replacements: Array<{
      uri: { toString(): string };
      range: unknown;
      newText: string;
    }> = [];
    replace(uri: { toString(): string }, range: unknown, newText: string) {
      this.replacements.push({ uri, range, newText });
    }
  }
  return {
    Uri: {
      parse: (s: string) => ({
        toString: () => s,
        path: s.replace(/^file:\/\//, ""),
      }),
    },
    Range: FakeRange,
    WorkspaceEdit: FakeWorkspaceEdit,
    workspace: {
      get textDocuments() {
        return state.openDocs;
      },
      notebookDocuments: [],
      fs: {
        writeFile: state.fsWriteFile,
      },
      applyEdit: state.applyEdit,
    },
    window: {},
    commands: {},
  };
});

vi.mock("./util/ideUtils", () => ({
  VsCodeIdeUtils: class {
    async stat() {
      return { size: 100 };
    }
    async readFile(uri: { toString(): string }) {
      const val = state.disk.get(uri.toString());
      return val !== undefined ? Buffer.from(val, "utf8") : null;
    }
  },
}));

vi.mock("./util/workspaceConfig", () => ({
  getContinueWorkspaceConfig: () => ({ get: () => undefined }),
}));

vi.mock("./util/vscode", () => ({
  getExtensionUri: () => ({ toString: () => "file:///ext" }),
}));

vi.mock("./util/fileSearch", () => ({
  OpenFilesTracker: class {},
}));

vi.mock("./autocomplete/lsp", () => ({
  executeGotoProvider: vi.fn(),
  executeSignatureHelpProvider: vi.fn(),
  executeSymbolProvider: vi.fn(),
}));

vi.mock("./stubs/SecretStorage", () => ({
  SecretStorage: class {},
}));

import { VsCodeIde } from "./VsCodeIde";

describe("VsCodeIde.writeFile", () => {
  beforeEach(() => {
    state.disk.clear();
    state.openDocs.length = 0;
    state.fsWriteFile.mockClear();
    state.applyEdit.mockClear();
    state.setApplyEditShouldSucceed(true);
  });

  it("updates and saves an open TextDocument so an immediate readFile never returns stale text", async () => {
    const fileUri = "file:///workspace/sample.ts";
    state.disk.set(fileUri, "const v = 1;\n");
    const doc = {
      uri: { toString: () => fileUri, path: "/workspace/sample.ts" },
      text: "const v = 1;\n",
      isDirty: false,
      getText() {
        return this.text;
      },
      positionAt(offset: number) {
        return { offset };
      },
      save: vi.fn(async () => {
        state.disk.set(fileUri, doc.text);
        doc.isDirty = false;
        return true;
      }),
    };
    state.openDocs.push(doc);

    const ide = new VsCodeIde(Promise.resolve({} as any), {} as any);
    await ide.writeFile(fileUri, "const v = 2;\n");

    expect(state.applyEdit).toHaveBeenCalledTimes(1);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(state.fsWriteFile).not.toHaveBeenCalled();
    expect(await ide.readFile(fileUri)).toBe("const v = 2;\n");
    expect(state.disk.get(fileUri)).toBe("const v = 2;\n");
  });

  it("falls back to workspace.fs.writeFile when document is not open", async () => {
    const fileUri = "file:///workspace/closed.ts";
    const ide = new VsCodeIde(Promise.resolve({} as any), {} as any);

    await ide.writeFile(fileUri, "export const x = 42;\n");

    expect(state.applyEdit).not.toHaveBeenCalled();
    expect(state.fsWriteFile).toHaveBeenCalledTimes(1);
    expect(await ide.readFile(fileUri)).toBe("export const x = 42;\n");
  });

  it("falls back to workspace.fs.writeFile when applyEdit fails", async () => {
    const fileUri = "file:///workspace/readonly.ts";
    state.setApplyEditShouldSucceed(false);
    const doc = {
      uri: { toString: () => fileUri, path: "/workspace/readonly.ts" },
      text: "old",
      isDirty: false,
      getText() {
        return this.text;
      },
      positionAt(offset: number) {
        return { offset };
      },
      save: vi.fn(async () => true),
    };
    state.openDocs.push(doc);

    const ide = new VsCodeIde(Promise.resolve({} as any), {} as any);
    await ide.writeFile(fileUri, "new");

    expect(state.applyEdit).toHaveBeenCalledTimes(1);
    expect(doc.save).not.toHaveBeenCalled();
    expect(state.fsWriteFile).toHaveBeenCalledTimes(1);
    expect(state.disk.get(fileUri)).toBe("new");
  });
});
