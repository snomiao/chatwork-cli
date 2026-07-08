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

describe("cmdSend recent self-send warning", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  test("warns + hints edit when I posted here within the window", async () => {
    cfg = { token: "t", account_id: 1 };
    messages = [msg("777", "Me", "my last message", nowSec() - 12)];
    await gate("a follow-up message");
    const text = err.join("\n");
    expect(text).toContain("直前");
    expect(text).toContain("message_id=777");
    expect(text).toContain("cw edit 555 777");
  });

  test("no warning when the last self-send is older than the window", async () => {
    cfg = { token: "t", account_id: 1 };
    messages = [msg("777", "Me", "my old message", nowSec() - 600)];
    await gate("a follow-up message");
    expect(err.join("\n")).not.toContain("直前");
  });

  test("no warning when the last message is someone else's", async () => {
    cfg = { token: "t", account_id: 1 };
    messages = [msg("888", "Someone", "their message", nowSec() - 5)];
    // fixture msg() stamps account_id 1; override to a different sender
    messages[0]!.account.account_id = 2;
    await gate("a reply");
    expect(err.join("\n")).not.toContain("直前");
  });

  test("CHATWORK_RESEND_WARN_SECONDS=0 disables the warning", async () => {
    cfg = { token: "t", account_id: 1 };
    messages = [msg("777", "Me", "my last message", nowSec() - 2)];
    const prev = process.env.CHATWORK_RESEND_WARN_SECONDS;
    process.env.CHATWORK_RESEND_WARN_SECONDS = "0";
    try {
      await gate("a follow-up message");
      expect(err.join("\n")).not.toContain("直前");
    } finally {
      if (prev === undefined) delete process.env.CHATWORK_RESEND_WARN_SECONDS;
      else process.env.CHATWORK_RESEND_WARN_SECONDS = prev;
    }
  });
});
