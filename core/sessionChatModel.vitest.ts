import { describe, expect, it } from "vitest";
import type { SessionChatModelRef } from "./index.js";
import {
  describeSessionChatModelRef,
  resolveCoreRequestChatModel,
  resolveSessionChatModel,
  resolveSessionChatModelByRef,
  sessionChatModelRefOfLlm,
} from "./util/sessionChatModel.js";

/**
 * 方案.md §7.5.4 — the **one** model-resolution rule, tested once, on both sides of the protocol.
 *
 * Two properties make this file worth its length:
 *
 * 1. uniqueness is an identity requirement, not a preference. A ref that matches 0 or ≥2 entries is
 *    *unresolved*, and the GUI must refuse the send instead of picking the first candidate — a
 *    resolved-by-guess identity is exactly the defect this contract exists to remove ("显示 A、
 *    实际发 B");
 * 2. the priority order is total. A session that has a choice of its own **never** falls back to the
 *    profile default, and the only case where the default applies is "no choice at all".
 */

const A_OPENAI = { title: "model-a", provider: "openai", model: "a" };
const A_ANTHROPIC = { title: "model-a", provider: "anthropic", model: "a" };
const B_OPENAI = { title: "model-b", provider: "openai", model: "b" };

const ref = (model: {
  title: string;
  provider: string;
  model: string;
}): SessionChatModelRef => ({ ...model });

describe("resolveSessionChatModelByRef", () => {
  it("matches all three fields and returns the entry", () => {
    const result = resolveSessionChatModelByRef(
      [A_OPENAI, B_OPENAI],
      ref(B_OPENAI),
    );
    expect(result).toEqual({
      status: "resolved",
      model: B_OPENAI,
      source: "ref",
    });
  });

  it("uses the chosen entry when two entries share a title", () => {
    // The whole point of the ref: `model-a` names two different models, and only the provider
    // distinguishes the one the user clicked.
    const result = resolveSessionChatModelByRef(
      [A_OPENAI, A_ANTHROPIC],
      ref(A_ANTHROPIC),
    );
    expect(result).toEqual({
      status: "resolved",
      model: A_ANTHROPIC,
      source: "ref",
    });
  });

  it("fails when nothing matches — even though the title does", () => {
    // The provider changed under the title (renamed/reconfigured entry): refusing is the only safe
    // answer, because the entry the user chose no longer exists.
    const result = resolveSessionChatModelByRef([A_OPENAI], ref(A_ANTHROPIC));
    expect(result).toEqual({ status: "unresolved", code: "REF_NOT_FOUND" });
  });

  it("fails when the same identity appears twice", () => {
    const duplicate = { ...A_OPENAI };
    const result = resolveSessionChatModelByRef(
      [A_OPENAI, duplicate],
      ref(A_OPENAI),
    );
    expect(result).toEqual({ status: "unresolved", code: "REF_AMBIGUOUS" });
  });

  it("reports a missing ref as its own code, not as a failed lookup", () => {
    // A new client always sends one; an old client omits the field. Those are different facts and
    // the codes keep them apart (the compat path is handled, not merged, by the caller).
    expect(resolveSessionChatModelByRef([A_OPENAI], undefined)).toEqual({
      status: "unresolved",
      code: "NO_MODEL_REF",
    });
  });

  it("does not resolve on an empty model list", () => {
    expect(resolveSessionChatModelByRef([], ref(A_OPENAI))).toEqual({
      status: "unresolved",
      code: "REF_NOT_FOUND",
    });
  });
});

describe("resolveSessionChatModel priority order", () => {
  it("prefers a ref over a title that would resolve to something else", () => {
    const result = resolveSessionChatModel([A_OPENAI, B_OPENAI], {
      ref: ref(B_OPENAI),
      title: "model-a",
      defaultModel: A_OPENAI,
    });
    expect(result.status === "resolved" && result.model).toBe(B_OPENAI);
  });

  it("does not fall back to the title when the ref fails", () => {
    // "有 modelRef 但解析失败 ⇒ 绝不回退 profile 默认，也绝不只按 title 再猜一次".
    const result = resolveSessionChatModel([A_OPENAI, B_OPENAI], {
      ref: ref({ title: "gone", provider: "openai", model: "gone" }),
      title: "model-a",
      defaultModel: B_OPENAI,
    });
    expect(result).toEqual({ status: "unresolved", code: "REF_NOT_FOUND" });
  });

  it("upgrades a legacy title that names exactly one entry", () => {
    const result = resolveSessionChatModel([A_OPENAI, B_OPENAI], {
      title: "model-b",
      defaultModel: A_OPENAI,
    });
    expect(result).toEqual({
      status: "resolved",
      model: B_OPENAI,
      source: "legacy-title",
    });
  });

  it("refuses an ambiguous legacy title instead of taking the first entry", () => {
    const result = resolveSessionChatModel([A_OPENAI, A_ANTHROPIC], {
      title: "model-a",
      defaultModel: B_OPENAI,
    });
    expect(result).toEqual({ status: "unresolved", code: "TITLE_AMBIGUOUS" });
  });

  it("refuses a legacy title that no longer exists, without using the default", () => {
    const result = resolveSessionChatModel([B_OPENAI], {
      title: "model-a",
      defaultModel: B_OPENAI,
    });
    expect(result).toEqual({ status: "unresolved", code: "TITLE_NOT_FOUND" });
  });

  it("uses the profile default only when the request states no choice", () => {
    const result = resolveSessionChatModel([A_OPENAI, B_OPENAI], {
      defaultModel: B_OPENAI,
    });
    expect(result).toEqual({
      status: "resolved",
      model: B_OPENAI,
      source: "default",
    });
  });

  it("reports a missing default rather than resolving to nothing silently", () => {
    expect(resolveSessionChatModel([A_OPENAI], {})).toEqual({
      status: "unresolved",
      code: "NO_DEFAULT_MODEL",
    });
  });

  it("treats an empty legacy title as absent", () => {
    const result = resolveSessionChatModel([A_OPENAI, B_OPENAI], {
      title: "",
      defaultModel: B_OPENAI,
    });
    expect(result.status === "resolved" && result.source).toBe("default");
  });
});

describe("resolveCoreRequestChatModel — Core's fail-closed entry point", () => {
  /** Stand-in for the `ILLM` instances `config.modelsByRole.chat` holds. */
  const llm = (title: string, model: string, providerName: string) => ({
    title,
    model,
    providerName,
  });
  const coreModels = [
    llm("model-a", "a", "openai"),
    llm("model-a", "a", "anthropic"),
    llm("model-b", "b", "openai"),
  ];

  it("resolves the ref to the exact instance the caller passed in", () => {
    const resolved = resolveCoreRequestChatModel(coreModels, {
      modelRef: { title: "model-a", provider: "anthropic", model: "a" },
    });
    expect(resolved).toBe(coreModels[1]);
  });

  it("projects ILLM fields the same way the GUI's ModelDescription does", () => {
    // `llmToSerializedModelDescription` sets `provider = providerName` and `title = title ?? model`;
    // if Core compared different fields, a ref the GUI considers correct would fail to resolve.
    expect(sessionChatModelRefOfLlm(llm("t", "m", "p"))).toEqual({
      title: "t",
      provider: "p",
      model: "m",
    });
    expect(sessionChatModelRefOfLlm({ model: "m", providerName: "p" })).toEqual(
      {
        title: "m",
        provider: "p",
        model: "m",
      },
    );
  });

  it("throws instead of falling back to the profile default when the ref misses", () => {
    expect(() =>
      resolveCoreRequestChatModel(coreModels, {
        modelRef: { title: "gone", provider: "openai", model: "gone" },
      }),
    ).toThrow(/REF_NOT_FOUND/);
  });

  it("throws when the ref is ambiguous", () => {
    const duplicated = [...coreModels, llm("model-b", "b", "openai")];
    expect(() =>
      resolveCoreRequestChatModel(duplicated, {
        modelRef: { title: "model-b", provider: "openai", model: "b" },
      }),
    ).toThrow(/REF_AMBIGUOUS/);
  });

  it("resolves an old client's title-only request by a unique title", () => {
    // Explicit compatibility branch: no ref ⇒ the legacy protocol, still unique-only.
    expect(resolveCoreRequestChatModel(coreModels, { title: "model-b" })).toBe(
      coreModels[2],
    );
  });

  it("throws for an old client's ambiguous title", () => {
    expect(() =>
      resolveCoreRequestChatModel(coreModels, { title: "model-a" }),
    ).toThrow(/TITLE_AMBIGUOUS/);
  });

  it("throws when the request carries neither a ref nor a title", () => {
    // Nothing was stated, and Core has no profile default to consult on this path by design — a
    // request that identifies no model is refused rather than answered with "whatever is selected".
    expect(() => resolveCoreRequestChatModel(coreModels, {})).toThrow(
      /NO_DEFAULT_MODEL/,
    );
  });

  it("names only the identity in the error — no key, endpoint or prompt", () => {
    try {
      resolveCoreRequestChatModel(coreModels, {
        modelRef: { title: "secret-model", provider: "openai", model: "m" },
      });
      throw new Error("expected a resolution failure");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("secret-model (openai/m)");
      expect(message).not.toMatch(/apiKey|apiBase|https?:|prompt/i);
    }
  });

  it("describes a missing ref without inventing an identity", () => {
    expect(describeSessionChatModelRef(undefined)).toBe("no ref");
    expect(
      describeSessionChatModelRef({
        title: "t",
        provider: "p",
        model: "m",
      }),
    ).toBe("t (p/m)");
  });
});
