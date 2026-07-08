import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../ts/config.ts";
import { confirmCode } from "../ts/confirm.ts";
// bun's mock.module is global and leaks across files; spread the real module so
// exports other test files rely on (e.g. `call`) survive our partial override.
import * as realApi from "../ts/api.ts";

const ROOM_ARG = "client-room";
const RID = 555;

// Mutable config the mocked readConfig returns; each test sets it.
let cfg: Config;
// Spy state for the mocked sendMessage.
let sendCalls: Array<{ rid: number; body: string }>;

mock.module("../ts/config.ts", () => ({
  readConfig: () => cfg,
  writeConfig: () => {},
}));
mock.module("../ts/room-resolver.ts", () => ({
  resolveRoom: async (_token: string, _room: string) => RID,
}));
mock.module("../ts/api.ts", () => ({
  ...realApi,
  sendMessage: async (_token: string, rid: number, body: string) => {
    sendCalls.push({ rid, body });
    return { message_id: "mock-msg" };
  },
  listMessages: async () => [],
  listMembers: async () => [],
}));

// Import after mocks are registered.
const { cmdSend } = await import("../ts/commands/send.ts");

let tmp: string;
let hooks: { ok: string; fail: string };

function writeHook(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

beforeEach(() => {
  sendCalls = [];
  tmp = mkdtempSync(join(tmpdir(), "cw-hook-test-"));
  hooks = { ok: join(tmp, "ok.sh"), fail: join(tmp, "fail.sh") };
  writeHook(hooks.ok, "#!/bin/sh\nexit 0\n");
  writeHook(hooks.fail, "#!/bin/sh\nexit 1\n");
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  process.exitCode = undefined;
});

// Drive the two-step confirm: first call writes pending, second commits.
async function send(message: string, opts: { force?: boolean } = {}): Promise<void> {
  await cmdSend({ room: ROOM_ARG, message, code: undefined });
  const code = confirmCode("send", ROOM_ARG, message);
  await cmdSend({ room: ROOM_ARG, message, code, force: opts.force ?? false });
}

describe("cmdSend pre-send hook", () => {
  test("client room + hook exit 0 → sendMessage called", async () => {
    cfg = { token: "t", client_rooms: [RID], pre_send_hook: hooks.ok };
    await send("hello client");
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.body).toBe("hello client");
  });

  test("client room + hook non-zero → sendMessage NOT called, exitCode 3", async () => {
    cfg = { token: "t", client_rooms: [RID], pre_send_hook: hooks.fail };
    await send("bad claim");
    expect(sendCalls).toHaveLength(0);
    expect(process.exitCode).toBe(3);
  });

  test("room outside client_rooms → hook skipped, normal send", async () => {
    cfg = { token: "t", client_rooms: [999], pre_send_hook: hooks.fail };
    await send("other room");
    expect(sendCalls).toHaveLength(1);
  });

  test("pre_send_hook unset → hook skipped, normal send", async () => {
    cfg = { token: "t", client_rooms: [RID] };
    await send("no hook configured");
    expect(sendCalls).toHaveLength(1);
  });

  test("--force → hook skipped even for client room with failing hook", async () => {
    cfg = { token: "t", client_rooms: [RID], pre_send_hook: hooks.fail };
    await send("urgent", { force: true });
    expect(sendCalls).toHaveLength(1);
  });

  test("hook missing / non-executable → fail-closed (no send, exitCode 3)", async () => {
    cfg = { token: "t", client_rooms: [RID], pre_send_hook: join(tmp, "does-not-exist.sh") };
    await send("should be blocked");
    expect(sendCalls).toHaveLength(0);
    expect(process.exitCode).toBe(3);
  });
});
