import { describe, expect, test } from "bun:test";
import { call, ChatworkError, type Me } from "../ts/api.ts";
import { resolveMentions } from "../ts/format.ts";

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
}

describe("api.call", () => {
  test("sends x-chatworktoken header and parses JSON", async () => {
    let captured: { url: string; headers: Headers } | null = null;
    const fetchStub = stubFetch((url, init) => {
      captured = { url, headers: new Headers(init?.headers as Record<string, string>) };
      return new Response(JSON.stringify({ account_id: 42, name: "taku" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-limit": "300",
          "x-ratelimit-remaining": "299",
          "x-ratelimit-reset": "1716182400",
        },
      });
    });
    const res = await call<Me>("test-token", "/me", {}, fetchStub);
    expect(captured).not.toBeNull();
    expect(captured!.headers.get("x-chatworktoken")).toBe("test-token");
    expect(captured!.url).toBe("https://api.chatwork.com/v2/me");
    expect(res.data.account_id).toBe(42);
    expect(res.rate?.remaining).toBe(299);
  });

  test("throws ChatworkError on 429 with rate info", async () => {
    const fetchStub = stubFetch(
      () =>
        new Response("rate limited", {
          status: 429,
          headers: {
            "x-ratelimit-limit": "10",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1716182500",
          },
        }),
    );
    let thrown: unknown;
    try {
      await call("t", "/rooms/1/messages", { method: "POST", body: { body: "hi" } }, fetchStub);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ChatworkError);
    const err = thrown as ChatworkError;
    expect(err.status).toBe(429);
    expect(err.rate?.reset).toBe(1716182500);
  });

  test("POST body is form-encoded", async () => {
    let captured: { body: string; ct: string | null } | null = null;
    const fetchStub = stubFetch((_url, init) => {
      captured = {
        body: init?.body as string,
        ct: new Headers(init?.headers as Record<string, string>).get("content-type"),
      };
      return new Response(JSON.stringify({ message_id: "abc" }), { status: 200 });
    });
    await call("t", "/rooms/1/messages", { method: "POST", body: { body: "hello world" } }, fetchStub);
    expect(captured).not.toBeNull();
    expect(captured!.ct).toBe("application/x-www-form-urlencoded");
    expect(captured!.body).toBe("body=hello+world");
  });
});

describe("format.resolveMentions", () => {
  const members = [
    { account_id: 100, role: "admin", name: "Taku" },
    { account_id: 200, role: "member", name: "Yamamoto" },
  ];

  test("replaces [To:id] with @name", () => {
    const out = resolveMentions("[To:100]hello", members);
    expect(out).toBe("@Taku hello");
  });

  test("replaces [rp aid=id] with @name", () => {
    const out = resolveMentions("[rp aid=200 to=1234-567]thanks", members);
    expect(out).toBe("@Yamamoto thanks");
  });

  test("strips [info]/[title] tags", () => {
    const out = resolveMentions("[info][title]Heading[/title]body[/info]", members);
    expect(out).toBe("Heading: body");
  });

  test("leaves unknown ids as numeric fallback", () => {
    const out = resolveMentions("[To:999]hi", members);
    expect(out).toBe("@999 hi");
  });
});
