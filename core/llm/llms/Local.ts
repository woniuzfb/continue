import { ChatMessage, CompletionOptions, LLMOptions } from "../../index.js";

import { ChatCompletionCreateParams } from "openai/resources/index";
import OpenAI from "./OpenAI.js";

class Local extends OpenAI {
  static providerName = "Local";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "http://localhost:5000/v1/",
  };

  // Allow reasoning fields to be attached to historical assistant messages
  // so multi-turn conversations preserve the thinking chain.
  protected supportsReasoningField = true;

  protected modifyChatBody(
    body: ChatCompletionCreateParams,
    completionOptions?: CompletionOptions,
  ): ChatCompletionCreateParams {
    body = super.modifyChatBody(body, completionOptions);

    // Toggle thinking via top-level enable_thinking field.
    // Server reads body.get("enable_thinking") and returns
    // reasoning_content in the response when enabled.
    // - reasoning === false  -> explicitly disable thinking
    // - reasoning === true   -> explicitly enable thinking
    // - reasoning === undefined -> leave server default untouched
    const reasoning = completionOptions?.reasoning;
    if (reasoning !== undefined) {
      (body as any).enable_thinking = !!reasoning;
    }

    return body;
  }

  // _convertArgs is used by _streamChat (the fallback path when openaiAdapter
  // is unavailable). The openaiAdapter path calls
  // modifyChatBody, but _convertArgs did not — so enable_thinking was never
  // added to the request body. Override to route through modifyChatBody.
  protected _convertArgs(
    options: CompletionOptions,
    messages: ChatMessage[],
  ): ChatCompletionCreateParams {
    const body = super._convertArgs(options, messages);
    return this.modifyChatBody(body, options);
  }
}

export default Local;
