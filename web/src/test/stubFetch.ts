import { vi } from "vitest";

export interface StubResponse {
  status?: number;
  body?: unknown;
}

/** Replaces `fetch` with [handler]; returns the mock to inspect calls. An async handler delays the response. */
export function stubFetch(handler: (url: string, init: RequestInit | undefined) => StubResponse | Promise<StubResponse>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body } = await handler(String(input), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return body;
      },
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
