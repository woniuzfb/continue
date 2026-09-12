import type { SessionChatModelRef } from "../index.js";

/**
 * 方案.md §7.5.4 — **one** place decides what a session's model choice means, for both sides.
 *
 * The GUI decides *which* model a session owns (the user's click, the shortcut, the profile
 * default, a legacy file's title); Core is the side that turns that decision into a concrete model
 * instance. Both must apply the **same** rule, otherwise the identity the toolbar displays, the
 * identity a turn captures and the model a request ends up calling can be three different things —
 * which is exactly the reported bug ("显示 A，实际发 B"). So the rule lives here as a pure function
 * and both callers delegate to it instead of each writing its own `find()`.
 *
 * The rule, in priority order:
 *
 * 1. **A ref resolves by all three fields, uniquely.** A title alone is not an identity: two
 *    entries can share one, and `provider`/`model` can change under a title between config loads.
 *    0 or ≥2 matches is a failure, never a guess.
 * 2. **A legacy title resolves only while it names exactly one entry.** That single match is what
 *    the GUI upgrades into a ref (and then persists); an ambiguous or missing title stays
 *    *unresolved* — the session keeps its own (unusable) choice and the send is refused rather than
 *    silently drifting to another model.
 * 3. **With neither**, the profile default (`selectedModelByRole.chat`) is the model — that is the
 *    documented meaning of "this session has no choice yet", and the only case where a default may
 *    be used.
 *
 * Fail-closed is the point of (1) and (2): a session that *has* a choice never falls back. The
 * result therefore carries the reason, so a caller can report **why** instead of only that nothing
 * was found — an ambiguous title and a deleted entry are different facts about the user's config.
 */
export type SessionChatModelResolution<TModel> =
  | {
      status: "resolved";
      model: TModel;
      source: "ref" | "legacy-title" | "default";
    }
  | { status: "unresolved"; code: SessionChatModelResolutionError };

export type SessionChatModelResolutionError =
  /** The request carried no ref and no title: nothing to resolve by. */
  | "NO_MODEL_REF"
  /** No entry matches the ref exactly — deleted, renamed, or a different provider build. */
  | "REF_NOT_FOUND"
  /** More than one entry matches the ref: the "identity" is not unique, so it is not an identity. */
  | "REF_AMBIGUOUS"
  /** A legacy title with no match. */
  | "TITLE_NOT_FOUND"
  /** A legacy title shared by several entries (see 方案.md §7.5.1). */
  | "TITLE_AMBIGUOUS"
  /** Neither a ref nor a title: the profile default itself is absent. */
  | "NO_DEFAULT_MODEL";

/** The minimal shape resolution needs — deliberately not the full `ModelDescription`. */
export interface ResolvableChatModel {
  title: string;
  /**
   * The same field `ModelDescription.provider` carries: `llmToSerializedModelDescription`
   * (`core/config/load.ts`) projects `provider` from `ILLM.providerName`, so this is the one name
   * under which a ref's provider is comparable on both sides of the protocol.
   */
  provider: string;
  model: string;
}

/**
 * 方案.md §7.5.4 for the **new** protocol: a request states its identity, and it must match exactly
 * one model. There is deliberately no `title`/default fallback here — that is the whole point.
 *
 * `NO_MODEL_REF` (the message carried no ref at all) is a separate code from `REF_NOT_FOUND` so the
 * two can be handled differently while the title-only protocol is still accepted: an old client
 * omits the field, a new client's ref failing to resolve is a real error.
 */
export function resolveSessionChatModelByRef<
  TModel extends ResolvableChatModel,
>(
  models: readonly TModel[],
  ref: SessionChatModelRef | undefined,
): SessionChatModelResolution<TModel> {
  if (!ref) {
    return { status: "unresolved", code: "NO_MODEL_REF" };
  }
  const matches = models.filter(
    (model) =>
      model.title === ref.title &&
      model.provider === ref.provider &&
      model.model === ref.model,
  );
  if (matches.length === 1) {
    return { status: "resolved", model: matches[0], source: "ref" };
  }
  return {
    status: "unresolved",
    code: matches.length === 0 ? "REF_NOT_FOUND" : "REF_AMBIGUOUS",
  };
}

/**
 * 方案.md §7.5.4, the full priority order. Used by the GUI (where a session's choice may only be a
 * legacy title, and where "no choice" legitimately means the profile default) and by Core for
 * requests that still speak the title-only protocol.
 */
export function resolveSessionChatModel<TModel extends ResolvableChatModel>(
  models: readonly TModel[],
  request: {
    ref?: SessionChatModelRef;
    /** Legacy identity (and the fallback lookup key for old clients). */
    title?: string | null;
    /** The profile default — consulted **only** when the request states no choice at all. */
    defaultModel?: TModel;
  },
): SessionChatModelResolution<TModel> {
  const { ref, title, defaultModel } = request;

  if (ref) {
    return resolveSessionChatModelByRef(models, ref);
  }

  const legacyTitle = title ?? undefined;
  if (legacyTitle !== undefined && legacyTitle !== "") {
    const matches = models.filter(
      (model) => (model.title ?? model.model) === legacyTitle,
    );
    if (matches.length === 1) {
      return { status: "resolved", model: matches[0], source: "legacy-title" };
    }
    return {
      status: "unresolved",
      code: matches.length === 0 ? "TITLE_NOT_FOUND" : "TITLE_AMBIGUOUS",
    };
  }

  if (defaultModel) {
    return { status: "resolved", model: defaultModel, source: "default" };
  }
  return { status: "unresolved", code: "NO_DEFAULT_MODEL" };
}

/** The identity of a resolved model — the value a session and a turn store. */
export function sessionChatModelRefOf(
  model: ResolvableChatModel | undefined,
): SessionChatModelRef | undefined {
  return model
    ? { title: model.title, provider: model.provider, model: model.model }
    : undefined;
}

/**
 * The identity of a **runtime model instance** (`ILLM`), which is what Core resolves against:
 * `title` falls back to `model` and `provider` comes from `providerName`, exactly as
 * `llmToSerializedModelDescription` projects them into the `ModelDescription` the GUI sees. Without
 * this projection the two sides would compare different fields and a ref that the GUI considers
 * correct would fail to resolve in Core.
 *
 * `ChatModel` is the structural minimum, so this works for any `ILLM` without importing one.
 */
export function sessionChatModelRefOfLlm(llm: {
  title?: string;
  model: string;
  providerName: string;
}): SessionChatModelRef {
  return {
    title: llm.title ?? llm.model,
    provider: llm.providerName,
    model: llm.model,
  };
}

/** `LLM` instances, projected into the shape the shared resolution rule compares. */
function asResolvableChatModels(
  llms: readonly { title?: string; model: string; providerName: string }[],
): ResolvableChatModel[] {
  return llms.map((llm) => sessionChatModelRefOfLlm(llm));
}

/**
 * 方案.md §7.5.4 for the **sending path** in Core: resolve a request's chat model.
 *
 * This is the one function `llm/compileChat` and `llm/streamChat` both call, so the model that
 * compiles a request and the model that answers it cannot differ. It is deliberately *not* a second
 * resolution rule: it delegates to `resolveSessionChatModel` / `resolveSessionChatModelByRef` — the
 * same functions the GUI uses — over `ILLM`s projected into the comparable shape.
 *
 * Fail-closed:
 * - the request carries a `modelRef` ⇒ **only** that ref is judged, and it must match exactly one
 *   entry. 0 or ≥2 matches throws; there is no fallback to `selectedModelByRole.chat` and no second
 *   attempt by `title`. A ref that does not resolve uniquely proves nothing about the user's choice,
 *   so sending anyway is how "显示 A、实际发 B" happens;
 * - the request carries no `modelRef` ⇒ a legacy client speaking the title-only protocol, resolved
 *   by a unique title (0/≥2 matches throws). This compatibility branch is explicit and separate, not
 *   mixed into the new semantics.
 *
 * The thrown message names only the ref's three fields (the ones the toolbar shows) or the title:
 * never a key, an endpoint or a prompt.
 */
export function resolveCoreRequestChatModel<
  TModel extends { title?: string; model: string; providerName: string },
>(
  llms: readonly TModel[],
  request: {
    modelRef?: SessionChatModelRef;
    title?: string;
  },
): TModel | undefined {
  const models = asResolvableChatModels(llms);
  const resolution = request.modelRef
    ? resolveSessionChatModelByRef(models, request.modelRef)
    : resolveSessionChatModel(models, { title: request.title });
  if (resolution.status !== "resolved") {
    throw new Error(
      `Chat model not resolved (${resolution.code}): ` +
        `${describeSessionChatModelRef(request.modelRef)}` +
        `${request.modelRef ? "" : ` / title "${request.title ?? ""}"`}`,
    );
  }
  // The resolution carries the projected shape; the caller wants the instance it passed in. The
  // match is recovered by identity rather than by re-comparing fields, so the instance returned is
  // *the same object* Core's config holds (and never a half-matching second entry).
  const index = models.findIndex((model) => model === resolution.model);
  return index >= 0 ? llms[index] : undefined;
}

/**
 * Log line for a refused resolution. The ref is an identity, not a secret: it is the same three
 * fields the toolbar shows. No key, endpoint or prompt is ever included (方案.md §7.5.5).
 */
export function describeSessionChatModelRef(
  ref: SessionChatModelRef | undefined,
): string {
  return ref ? `${ref.title} (${ref.provider}/${ref.model})` : "no ref";
}
