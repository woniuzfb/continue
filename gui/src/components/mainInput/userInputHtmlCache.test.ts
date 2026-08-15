import { afterEach, describe, expect, it } from "vitest";

import {
  clearUserInputStaticHtmls,
  getUserInputStaticHtml,
  setUserInputStaticHtml,
} from "./userInputHtmlCache";

describe("userInputHtmlCache", () => {
  afterEach(() => {
    clearUserInputStaticHtmls();
  });

  it("round-trips html for the same editorState reference", () => {
    const state = { type: "doc" };
    setUserInputStaticHtml("m1", state, "<p>hi</p>");
    expect(getUserInputStaticHtml("m1", state)).toBe("<p>hi</p>");
  });

  it("misses on a different editorState reference", () => {
    setUserInputStaticHtml("m1", { type: "doc" }, "<p>a</p>");
    expect(
      getUserInputStaticHtml("m1", { type: "doc" } as never),
    ).toBeUndefined();
  });

  it("misses when editorState is undefined", () => {
    const state = { type: "doc" };
    setUserInputStaticHtml("m1", state, "<p>hi</p>");
    expect(getUserInputStaticHtml("m1", undefined)).toBeUndefined();
  });

  it("does not write when editorState is undefined", () => {
    setUserInputStaticHtml("m1", undefined, "<p>hi</p>");
    expect(getUserInputStaticHtml("m1", { type: "doc" })).toBeUndefined();
  });

  it("evicts least-recently-used beyond capacity", () => {
    // 缓存按引用比较 editorState,必须复用同一批对象
    const states = Array.from({ length: 201 }, (_, i) => ({ i }));
    states.forEach((s, i) => setUserInputStaticHtml(`m${i}`, s, `<p>${i}</p>`));
    expect(getUserInputStaticHtml("m0", states[0])).toBeUndefined();
    expect(getUserInputStaticHtml("m200", states[200])).toBe("<p>200</p>");
  });
});
