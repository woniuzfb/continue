import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { JSONContent } from "@tiptap/react";
import { ContextItemWithId } from "core";
import { expect, test, vi } from "vitest";
import { parseClipboardText } from "./editorConfig";
import { processEditorContent } from "./processEditorContent";

describe("processEditorContent", () => {
  // Create some reusable test data
  const createContextItem = (
    content: string,
    description: string,
    fileUri?: string,
    editing?: boolean,
  ): ContextItemWithId => ({
    id: { providerTitle: "test", itemId: "test-id" },
    content,
    description,
    name: "Test Item",
    editing,
    uri: fileUri ? { type: "file", value: fileUri } : undefined,
  });

  test("processEditorContent should return empty arrays when content is empty", () => {
    // Empty editor state
    const emptyEditorState: JSONContent = {
      type: "doc",
      content: [],
    };

    const result = processEditorContent(emptyEditorState);

    expect(result.parts).toEqual([]);
    expect(result.contextRequests).toEqual([]);
    expect(result.selectedCode).toEqual([]);
    expect(result.slashCommandName).toBeUndefined();
  });

  test("processEditorContent should process text paragraphs", () => {
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Hello world",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "This is another paragraph",
            },
          ],
        },
      ],
    };

    const result = processEditorContent(editorState);

    expect(result.parts).toEqual([
      {
        type: "text",
        text: "Hello world\nThis is another paragraph",
      },
    ]);
    expect(result.contextRequests).toEqual([]);
    expect(result.selectedCode).toEqual([]);
  });

  test("processEditorContent should detect slash commands", () => {
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "prompt-block",
          attrs: {
            item: {
              name: "test-command",
            },
          },
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Some text after the prompt",
            },
          ],
        },
      ],
    };

    const result = processEditorContent(editorState);

    expect(result.slashCommandName).toBe("test-command");
    expect(result.parts).toEqual([
      {
        type: "text",
        text: "Some text after the prompt",
      },
    ]);
  });

  test("processEditorContent should handle mentions and collect context requests", () => {
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Hello ",
            },
            {
              type: "mention",
              attrs: {
                id: "fileSearch",
                label: "@fileSearch",
                itemType: "contextProvider",
              },
            },
            {
              type: "text",
              text: " and also ",
            },
            {
              type: "mention",
              attrs: {
                id: "github",
                label: "@github",
                itemType: "contextProvider",
              },
            },
          ],
        },
      ],
    };

    const result = processEditorContent(editorState);

    expect(result.parts).toEqual([
      {
        type: "text",
        text: "Hello @fileSearch and also @github",
      },
    ]);
    expect(result.contextRequests).toEqual([
      { provider: "fileSearch" },
      { provider: "github" },
    ]);
  });

  test("processEditorContent should handle code blocks", () => {
    const codeItem = createContextItem(
      "function test() {\n  return 'hello';\n}",
      "a description",
      "file:///example.js",
    );

    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Check this code:",
            },
          ],
        },
        {
          type: "code-block",
          attrs: {
            item: codeItem,
          },
        },
      ],
    };

    const result = processEditorContent(editorState);

    expect(result.parts).toEqual([
      {
        type: "text",
        text: "Check this code:\n\n```js example.js (1-1)\nfunction test() {\n  return 'hello';\n}\n```\n",
      },
    ]);
    expect(result.selectedCode).toHaveLength(1);
    expect(result.selectedCode[0].filepath).toBe("file:///example.js");
  });

  test("processEditorContent should not include editing code blocks in the text", () => {
    const editingCodeItem = createContextItem(
      "function test() {\n  return 'hello';\n}",
      "a description",
      "file:///editing.js",
      true, // Set editing to true
    );

    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Edit this code:",
            },
          ],
        },
        {
          type: "code-block",
          attrs: {
            item: editingCodeItem,
          },
        },
      ],
    };

    const result = processEditorContent(editorState);

    // The code block should not be included in parts because it's marked as editing
    expect(result.parts).toEqual([
      {
        type: "text",
        text: "Edit this code:",
      },
    ]);

    // But it should still be in selectedCode
    expect(result.selectedCode).toHaveLength(1);
    expect(result.selectedCode[0].filepath).toBe("file:///editing.js");
  });

  test("processEditorContent should handle images", () => {
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Here's an image:",
            },
          ],
        },
        {
          type: "image",
          attrs: {
            src: "https://example.com/image.png",
          },
        },
      ],
    };

    const result = processEditorContent(editorState);

    expect(result.parts).toEqual([
      {
        type: "text",
        text: "Here's an image:",
      },
      {
        type: "imageUrl",
        imageUrl: { url: "https://example.com/image.png" },
      },
    ]);
  });

  test("processEditorContent should handle complex content with multiple elements", () => {
    const codeItem = createContextItem(
      "const x = 42;",
      "a description",
      "file:///script.ts",
    );

    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "prompt-block",
          attrs: {
            item: {
              name: "explain",
            },
          },
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Please explain this code and also check ",
            },
            {
              type: "mention",
              attrs: {
                id: "related",
                label: "@related",
                itemType: "similarFiles",
              },
            },
          ],
        },
        {
          type: "code-block",
          attrs: {
            item: codeItem,
          },
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "What does this constant do?",
            },
          ],
        },
        {
          type: "image",
          attrs: {
            src: "https://example.com/diagram.png",
          },
        },
      ],
    };

    const result = processEditorContent(editorState);

    expect(result.slashCommandName).toBe("explain");
    expect(result.contextRequests).toEqual([{ provider: "similarFiles" }]);
    expect(result.selectedCode).toHaveLength(1);
    expect(result.selectedCode[0].filepath).toBe("file:///script.ts");

    // `\n\n\`\`\`${extension} ${relativePathOrBasename}\n${contextItem.content}\n\`\`\`\n`;

    expect(result.parts).toEqual([
      {
        type: "text",
        text: "Please explain this code and also check @related\n\n```ts script.ts (1-1)\nconst x = 42;\n```\n\nWhat does this constant do?",
      },
      {
        type: "imageUrl",
        imageUrl: { url: "https://example.com/diagram.png" },
      },
    ]);
  });

  test("processEditorContent should merge consecutive text parts", () => {
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "First paragraph",
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Second paragraph",
            },
          ],
        },
        {
          type: "image",
          attrs: {
            src: "https://example.com/image.png",
          },
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Third paragraph",
            },
          ],
        },
      ],
    };

    const result = processEditorContent(editorState);

    // First two paragraphs should be merged, but the third should be separate
    // because there's an image in between
    expect(result.parts).toEqual([
      {
        type: "text",
        text: "First paragraph\nSecond paragraph",
      },
      {
        type: "imageUrl",
        imageUrl: { url: "https://example.com/image.png" },
      },
      {
        type: "text",
        text: "Third paragraph",
      },
    ]);
  });

  test("processEditorContent should handle unexpected content types gracefully", () => {
    // Testing with an unknown node type
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Normal text",
            },
          ],
        },
        {
          type: "unknown-type", // This type doesn't exist
          content: [
            {
              type: "text",
              text: "This should be ignored",
            },
          ],
        },
      ],
    };

    // Spy on console.warn to verify it's called
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = processEditorContent(editorState);

    // Only the normal paragraph should be processed
    expect(result.parts).toEqual([
      {
        type: "text",
        text: "Normal text",
      },
    ]);

    // Console.warn should be called for the unknown type
    expect(warnSpy).toHaveBeenCalledWith(
      "Unexpected content type",
      "unknown-type",
    );

    warnSpy.mockRestore();
  });

  test("processEditorContent should handle missing attrs in code blocks", () => {
    // Testing with a code block that has no item attribute
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "code-block",
          // Missing attrs property
        },
      ],
    };

    // Spy on console.warn to verify it's called
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = processEditorContent(editorState);

    // No parts should be created
    expect(result.parts).toEqual([]);
    expect(result.selectedCode).toEqual([]);

    // Console.warn should be called for the missing item attribute
    expect(warnSpy).toHaveBeenCalledWith("codeBlock has no item attribute");

    warnSpy.mockRestore();
  });

  test("processEditorContent should handle paragraphs with unexpected child types", () => {
    // Testing with a paragraph that has an unknown child type
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Normal text ",
            },
            {
              type: "unknown-child", // This type doesn't exist
              text: "This should be ignored",
            },
          ],
        },
      ],
    };

    // Spy on console.warn to verify it's called
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = processEditorContent(editorState);

    // Only the normal text should be processed
    expect(result.parts).toEqual([
      {
        type: "text",
        text: "Normal text ",
      },
    ]);

    // Console.warn should be called for the unknown child type
    expect(warnSpy).toHaveBeenCalledWith(
      "Unexpected child type",
      "unknown-child",
    );

    warnSpy.mockRestore();
  });
});

describe("paste with empty lines", () => {
  // 构建一个 minimal TipTap editor 用于测试 parseClipboardText
  function createTestEditor() {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text],
      content: "",
    });
    return editor;
  }

  test("ProseMirror default split would lose empty lines", () => {
    // 验证 ProseMirror 默认的 split 逻辑合并连续换行, 空行丢失
    const text = "第一行\n\n第三行";
    const defaultSplit = text.split(/(?:\r\n?|\n)+/);
    expect(defaultSplit).toEqual(["第一行", "第三行"]);
  });

  test("parseClipboardText preserves empty lines as empty paragraphs", () => {
    const editor = createTestEditor();
    const view = editor.view;
    const $context = view.state.doc.resolve(0);

    const text = "第一行\n\n第三行";
    const slice = parseClipboardText(text, $context, view);
    const json = slice.content.toJSON();

    // 应该产生 3 个段落: [第一行, 空段落, 第三行]
    expect(json).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "第一行" }] },
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "第三行" }] },
    ]);

    editor.destroy();
  });

  test("parseClipboardText + processEditorContent preserves empty lines end-to-end", () => {
    const editor = createTestEditor();
    const view = editor.view;
    const $context = view.state.doc.resolve(0);

    // 模拟从 browser.md 复制的含空行文本
    const clipboardText =
      "我想重构脚本来统一处理\n最好能区分3种不同的客户端状态\n\n目标是:\n\n1. 根据 BROWSER_MODEL_METADATA";

    // 1. 粘贴: parseClipboardText 产生 Slice
    const slice = parseClipboardText(clipboardText, $context, view);

    // 2. 将 Slice 插入 editor
    view.dispatch(view.state.tr.replaceSelection(slice));

    // 3. 获取 editor JSON
    const editorState = editor.getJSON();

    // 4. 调用 processEditorContent
    const result = processEditorContent(editorState);

    // 5. 验证输出包含空行 (\n\n)
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toEqual({
      type: "text",
      text:
        "我想重构脚本来统一处理\n" +
        "最好能区分3种不同的客户端状态\n" +
        "\n" +
        "目标是:\n" +
        "\n" +
        "1. 根据 BROWSER_MODEL_METADATA",
    });

    editor.destroy();
  });

  test("multiple consecutive empty lines are preserved", () => {
    const editor = createTestEditor();
    const view = editor.view;
    const $context = view.state.doc.resolve(0);

    // 3 个连续空行
    const text = "A\n\n\n\nD";
    const slice = parseClipboardText(text, $context, view);
    const json = slice.content.toJSON();

    // 应该产生 5 个段落: [A, 空, 空, 空, D]
    expect(json).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "A" }] },
      { type: "paragraph" },
      { type: "paragraph" },
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "D" }] },
    ]);

    // 插入并处理
    view.dispatch(view.state.tr.replaceSelection(slice));
    const result = processEditorContent(editor.getJSON());

    // A\n\n\n\nD (4 个 \n 分隔 5 行, 其中 3 行为空)
    expect(result.parts[0]).toEqual({
      type: "text",
      text: "A\n\n\n\nD",
    });

    editor.destroy();
  });

  test("clipboardTextSerializer with \\n separator preserves empty lines", () => {
    // 验证覆盖后的 clipboardTextSerializer (用 \n 作段落分隔符):
    // <p>A</p><p></p><p>B</p> (1 个空行) 序列化为 "A\n\nB" (仍是 1 个空行)
    // 对比 ProseMirror 默认的 \n\n 分隔符会产生 "A\n\n\n\nB" (3 个空行, 翻倍)
    const editor = createTestEditor();
    const view = editor.view;

    // 插入 "A\n\nB" (1 个空行 = 3 个段落)
    const slice = parseClipboardText("A\n\nB", view.state.doc.resolve(0), view);
    view.dispatch(view.state.tr.replaceSelection(slice));

    // 选中整个文档
    const { state } = view;
    const TextSelection = require("@tiptap/pm/state").TextSelection;
    view.dispatch(
      state.tr.setSelection(
        new TextSelection(
          state.doc.resolve(0),
          state.doc.resolve(state.doc.content.size),
        ),
      ),
    );

    // 模拟 clipboardTextSerializer: textBetween(0, size, "\n")
    const content = view.state.selection.content().content;
    const text = content.textBetween(0, content.size, "\n");

    // \n 分隔符: <p>A</p><p></p><p>B</p> → "A\n\nB" (1 个空行, 与外部源一致)
    expect(text).toBe("A\n\nB");

    editor.destroy();
  });

  test("internal copy-paste round trip preserves empty lines (no tripling)", () => {
    // 端到端验证: 从 TipTap 复制 "A\n\nB" (1 空行) 再粘贴回来, 空行不应翻倍。
    // 修复方案: clipboardTextSerializer 用 \n 分隔, handlePaste 用 parseClipboardText
    // 按 \n 分割, 两者约定一致, 无需检测来源。
    const editor = createTestEditor();
    const view = editor.view;

    // 1. 插入初始内容 "A\n\nB" (1 个空行)
    const slice = parseClipboardText("A\n\nB", view.state.doc.resolve(0), view);
    view.dispatch(view.state.tr.replaceSelection(slice));

    // 2. 全选并用 clipboardTextSerializer (\n 分隔) 生成 text/plain
    const { state } = view;
    const TextSelection = require("@tiptap/pm/state").TextSelection;
    view.dispatch(
      state.tr.setSelection(
        new TextSelection(
          state.doc.resolve(0),
          state.doc.resolve(state.doc.content.size),
        ),
      ),
    );
    const content = view.state.selection.content().content;
    const copiedText = content.textBetween(0, content.size, "\n");

    // 3. 验证: text/plain 是 "A\n\nB" (1 个空行), 不是 "A\n\n\n\nB" (3 个空行)
    expect(copiedText).toBe("A\n\nB");

    // 4. 模拟粘贴: handlePaste 读取 text/plain, 用 parseClipboardText 解析
    view.dispatch(view.state.tr.deleteSelection());
    const pastedSlice = parseClipboardText(
      copiedText,
      view.state.selection.$from,
      view,
    );
    view.dispatch(view.state.tr.replaceSelection(pastedSlice));

    // 5. 验证结果: 仍然只有 1 个空行, 没有翻倍
    const result = processEditorContent(editor.getJSON());
    expect(result.parts[0]).toEqual({
      type: "text",
      text: "A\n\nB",
    });

    editor.destroy();
  });

  test("multiple round trips do not amplify empty lines", () => {
    // 验证多次复制粘贴不会累积空行 (之前的 bug: 1→3→7→15)
    const editor = createTestEditor();
    const view = editor.view;
    const TextSelection = require("@tiptap/pm/state").TextSelection;

    // 初始: 1 个空行
    let slice = parseClipboardText("A\n\nB", view.state.doc.resolve(0), view);
    view.dispatch(view.state.tr.replaceSelection(slice));

    // 模拟 3 次复制粘贴循环
    for (let i = 0; i < 3; i++) {
      // 全选
      view.dispatch(
        view.state.tr.setSelection(
          new TextSelection(
            view.state.doc.resolve(0),
            view.state.doc.resolve(view.state.doc.content.size),
          ),
        ),
      );
      // 复制 (clipboardTextSerializer 用 \n)
      const content = view.state.selection.content().content;
      const copiedText = content.textBetween(0, content.size, "\n");
      // 粘贴 (parseClipboardText 按 \n 分割)
      view.dispatch(view.state.tr.deleteSelection());
      const pastedSlice = parseClipboardText(
        copiedText,
        view.state.selection.$from,
        view,
      );
      view.dispatch(view.state.tr.replaceSelection(pastedSlice));
    }

    // 3 次循环后仍然是 1 个空行
    const result = processEditorContent(editor.getJSON());
    expect(result.parts[0]).toEqual({
      type: "text",
      text: "A\n\nB",
    });

    editor.destroy();
  });
});
