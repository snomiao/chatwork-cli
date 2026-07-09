import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Config } from "../ts/config.ts";
import type { Message, Member } from "../ts/api.ts";
// bun's mock.module is global and leaks across files; spread the real module so
// exports other test files rely on (e.g. `call`) survive our partial override.
import * as realApi from "../ts/api.ts";

const RID = 555;
const ROOM_ARG = "client-room";

let cfg: Config;
let messages: Message[];
let members: Member[];
let failFetch: boolean;

// Captured console output for the first-call (no --code) confirm gate.
let out: string[];
let err: string[];

mock.module("../ts/config.ts", () => ({
  readConfig: () => cfg,
  writeConfig: () => {},
}));
mock.module("../ts/room-resolver.ts", () => ({
  resolveRoom: async (_token: string, _room: string) => RID,
}));
mock.module("../ts/api.ts", () => ({
  ...realApi,
  sendMessage: async () => ({ message_id: "mock-msg" }),
  listMessages: async () => {
    if (failFetch) throw new Error("no scope");
    return messages;
  },
  listMembers: async () => members,
  // never hit the network for self-account resolution in tests
  getMe: async () => ({ account_id: cfg.account_id ?? 999, name: "me" }),
}));

const { cmdSend } = await import("../ts/commands/send.ts");

function msg(id: string, name: string, body: string, t = 1_700_000_000): Message {
  return {
    message_id: id,
    account: { account_id: 1, name, avatar_image_url: "" },
    body,
    send_time: t,
    update_time: t,
  } as Message;
}

const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  // self = 999 by default so the fixture messages (account_id 1) never look
  // like our own recent post; the self-send-warn tests override this.
  cfg = { token: "t", account_id: 999 };
  failFetch = false;
  members = [];
  messages = [
    msg("1", "Alice", "First message in the room", 1_700_000_000),
    msg("2", "Bob", "please confirm the schedule for next week", 1_700_000_100),
  ];
  out = [];
  err = [];
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  process.exitCode = undefined;
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.exitCode = undefined;
});

// First call (no --code) is the confirm gate.
async function gate(message: string): Promise<void> {
  await cmdSend({ room: ROOM_ARG, message, code: undefined });
}

describe("cmdSend read-before-write confirm context", () => {
  test("previews the room's recent messages before confirming", async () => {
    await gate("something new to say");
    const text = out.join("\n");
    expect(text).toContain("--- Last messages in room (rid=555)");
    expect(text).toContain("Alice: First message in the room");
    expect(text).toContain("Bob: please confirm the schedule for next week");
    expect(text).toContain("--- Sending");
    expect(text).toContain("Message: something new to say");
    expect(text).toContain("--code=");
  });

  test("warns when the outgoing text closely matches a recent message", async () => {
    await gate("please confirm the schedule for next week");
    expect(err.join("\n")).toContain("possible duplicate");
  });

  test("no duplicate warning for a distinct message", async () => {
    await gate("here is a completely unrelated new topic entirely");
    expect(err.join("\n")).not.toContain("possible duplicate");
  });

  test("context unavailable is fail-soft: still mints the code", async () => {
    failFetch = true; // exercise the fetch-error path
    await gate("hello");
    const text = out.join("\n");
    expect(text).toContain("(room context unavailable)");
    expect(text).toContain("--code=");
  });
});

describe("cmdSend --to mentions", () => {
  test("prepends a [To:] mention (resolved from members) to the previewed body", async () => {
    members = [{ account_id: 100, role: "member", name: "Alice" }];
    await cmdSend({ room: ROOM_ARG, message: "本文です", code: undefined, to: ["Alice"] });
    const text = out.join("\n");
    expect(text).toContain("[To:100]Aliceさん");
    expect(text).toContain("本文です");
  });

  test("an unresolvable --to aborts before minting a code", async () => {
    members = [{ account_id: 100, role: "member", name: "Alice" }];
    await expect(
      cmdSend({ room: ROOM_ARG, message: "x", code: undefined, to: ["誰それ"] }),
    ).rejects.toThrow(/no member/);
    expect(out.join("\n")).not.toContain("--code=");
  });
});

describe("cmdSend self-send warnings", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  // Set env vars for one test and restore them afterwards.
  async function withEnv(
    vars: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  describe("reply-state warning (default on)", () => {
    test("warns + hints edit when the last message is mine (any age)", async () => {
      cfg = { token: "t", account_id: 1 };
      messages = [msg("777", "Me", "my old unanswered message", nowSec() - 6000)];
      await gate("a follow-up message");
      const text = err.join("\n");
      expect(text).toContain("相手はまだ返信していません");
      expect(text).toContain("cw edit 555 777");
    });

    test("no warning when someone replied after me (last message is theirs)", async () => {
      cfg = { token: "t", account_id: 1 };
      const mine = msg("777", "Me", "my message", nowSec() - 30);
      const theirs = msg("888", "Them", "their reply", nowSec() - 5);
      theirs.account.account_id = 2;
      messages = [mine, theirs];
      await gate("another message");
      expect(err.join("\n")).not.toContain("相手はまだ返信していません");
      expect(err.join("\n")).not.toContain("直前");
    });

    test("CHATWORK_UNREPLIED_WARN=0 disables the reply-state warning", async () => {
      cfg = { token: "t", account_id: 1 };
      messages = [msg("777", "Me", "my old message", nowSec() - 6000)];
      await withEnv({ CHATWORK_UNREPLIED_WARN: "0" }, async () => {
        await gate("a follow-up message");
        // too old for the time-based window either → no warning at all
        expect(err.join("\n")).not.toContain("相手はまだ返信していません");
        expect(err.join("\n")).not.toContain("直前");
      });
    });
  });

  describe("time-based fallback (reply-state off)", () => {
    test("warns within the window when reply-state is disabled", async () => {
      cfg = { token: "t", account_id: 1 };
      messages = [msg("777", "Me", "my recent message", nowSec() - 12)];
      await withEnv({ CHATWORK_UNREPLIED_WARN: "0" }, async () => {
        await gate("a follow-up message");
        const text = err.join("\n");
        expect(text).toContain("直前");
        expect(text).toContain("message_id=777");
        expect(text).toContain("cw edit 555 777");
      });
    });

    test("no warning outside the window when reply-state is disabled", async () => {
      cfg = { token: "t", account_id: 1 };
      messages = [msg("777", "Me", "my old message", nowSec() - 600)];
      await withEnv({ CHATWORK_UNREPLIED_WARN: "0" }, async () => {
        await gate("a follow-up message");
        expect(err.join("\n")).not.toContain("直前");
      });
    });

    test("both disabled → no warning at all", async () => {
      cfg = { token: "t", account_id: 1 };
      messages = [msg("777", "Me", "my recent message", nowSec() - 2)];
      await withEnv(
        { CHATWORK_UNREPLIED_WARN: "0", CHATWORK_RESEND_WARN_SECONDS: "0" },
        async () => {
          await gate("a follow-up message");
          expect(err.join("\n")).not.toContain("直前");
          expect(err.join("\n")).not.toContain("相手はまだ返信していません");
        },
      );
    });
  });

  test("no warning when the last message is someone else's", async () => {
    cfg = { token: "t", account_id: 1 };
    const m = msg("888", "Someone", "their message", nowSec() - 5);
    m.account.account_id = 2;
    messages = [m];
    await gate("a reply");
    expect(err.join("\n")).not.toContain("相手はまだ返信していません");
    expect(err.join("\n")).not.toContain("直前");
  });
});
