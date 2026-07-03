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
  cfg = { token: "t" };
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
