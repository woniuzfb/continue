import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import {
  clearMarkdownArtifacts,
  getMarkdownArtifact,
  setMarkdownArtifact,
} from "./markdownArtifactCache";

// ReactNode 只作值使用,无需真实 JSX
const node = (n: number) => ({ n }) as unknown as ReactNode;

describe("markdownArtifactCache", () => {
  afterEach(() => {
    clearMarkdownArtifacts();
  });

  it("round-trips a value by key", () => {
    setMarkdownArtifact("k1", node(1));
    expect(getMarkdownArtifact("k1")).toEqual({ n: 1 });
    expect(getMarkdownArtifact("missing")).toBeUndefined();
  });

  it("overwrites the same key without growing", () => {
    setMarkdownArtifact("k1", node(1));
    setMarkdownArtifact("k1", node(2));
    expect(getMarkdownArtifact("k1")).toEqual({ n: 2 });
  });

  it("evicts the least-recently-used entry beyond capacity", () => {
    // 填满 + 1 触发逐出:第一个 key 应被淘汰
    for (let i = 0; i < 301; i++) {
      setMarkdownArtifact(`k${i}`, node(i));
    }
    expect(getMarkdownArtifact("k0")).toBeUndefined(); // 最旧,被逐出
    expect(getMarkdownArtifact("k300")).toEqual({ n: 300 });
  });

  it("a read refreshes recency and protects the entry from eviction", () => {
    for (let i = 0; i < 300; i++) {
      setMarkdownArtifact(`k${i}`, node(i));
    }
    // 触碰 k0 → k1 变成最旧
    expect(getMarkdownArtifact("k0")).toEqual({ n: 0 });
    setMarkdownArtifact("k300", node(300)); // 逐出 k1
    expect(getMarkdownArtifact("k1")).toBeUndefined();
    expect(getMarkdownArtifact("k0")).toEqual({ n: 0 });
  });
});
