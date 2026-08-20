import { BaseContextProvider } from "..";
import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
  FetchFunction,
} from "../..";
const LOCAL_WEB_SEARCH_BASE_URL = "http://127.0.0.1:5002/";

export const fetchSearchResults = async (
  query: string,
  n: number,
  fetchFn: FetchFunction,
): Promise<ContextItem[]> => {
  const resp = await fetchFn(WebContextProvider.ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      n,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();

    throw new Error(`Failed to fetch web context: ${text}`);
  }

  const data = await resp.json();

  if (!Array.isArray(data)) {
    throw new Error("Local web search returned a non-array response");
  }

  return data;
};

export default class WebContextProvider extends BaseContextProvider {
  public static ENDPOINT = new URL("web", LOCAL_WEB_SEARCH_BASE_URL);
  private static DEFAULT_N = 6;

  static description: ContextProviderDescription = {
    title: "web",
    displayTitle: "Web",
    description: "Search the web",
    type: "normal",
    renderInlineAs: "",
  };

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    return await fetchSearchResults(
      extras.fullInput,
      this.options.n ?? WebContextProvider.DEFAULT_N,
      extras.fetch,
    );
  }
}
