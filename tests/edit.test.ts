import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Config } from "../ts/config.ts";
import type { Message, Member } from "../ts/api.ts";
import { confirmCode } from "../ts/confirm.ts";
// spread the real api so unrelated exports survive bun's global mock.module
import * as realApi from "../ts/api.ts";

const RID = 555;
const ROOM_ARG = "client-room";
const MSG_ID = "1234567890";

let cfg: Config;
let editCalls: Array<{ rid: number; messageId: string; body: string }>;
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
  getMessage: async (_t: string, _rid: number, mid: string): Promise<Message> => ({
    message_id: mid,
    account: { account_id: 1, name: "Me", avatar_image_url: "" },
    body: "original body",
    send_time: 1_700_000_000,
    update_time: 1_700_000_000,
  }),
  listMembers: async (): Promise<Member[]> => [],
  editMessage: async (_t: string, rid: number, messageId: string, body: string) => {
    editCalls.push({ rid, messageId, body });
    return { message_id: messageId };
  },
}));

const { cmdEdit } = await import("../ts/commands/edit.ts");

const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  cfg = { token: "t", account_id: 1 };
  editCalls = [];
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

describe("cmdEdit two-step confirm", () => {
  test("first call previews current + new body and mints a code", async () => {
    await cmdEdit({ room: ROOM_ARG, messageId: MSG_ID, message: "new body", code: undefined });
    const text = out.join("\n");
    expect(text).toContain(`message_id: ${MSG_ID}`);
    expect(text).toContain("original body"); // the current message preview
    expect(text).toContain("Message: new body");
    expect(text).toContain("--code=");
    expect(editCalls).toHaveLength(0);
  });

  test("second call with the right code commits the edit", async () => {
    await cmdEdit({ room: ROOM_ARG, messageId: MSG_ID, message: "new body", code: undefined });
    const code = confirmCode("edit", ROOM_ARG, MSG_ID, "new body");
    await cmdEdit({ room: ROOM_ARG, messageId: MSG_ID, message: "new body", code });
    expect(editCalls).toEqual([{ rid: RID, messageId: MSG_ID, body: "new body" }]);
  });

  test("wrong code is rejected (no edit, exitCode 1)", async () => {
    await cmdEdit({ room: ROOM_ARG, messageId: MSG_ID, message: "new body", code: undefined });
    await cmdEdit({ room: ROOM_ARG, messageId: MSG_ID, message: "new body", code: "deadbeef" });
    expect(editCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  test("a send code cannot confirm an edit (kind salt differs)", async () => {
    await cmdEdit({ room: ROOM_ARG, messageId: MSG_ID, message: "new body", code: undefined });
    const sendCode = confirmCode("send", ROOM_ARG, MSG_ID, "new body");
    await cmdEdit({ room: ROOM_ARG, messageId: MSG_ID, message: "new body", code: sendCode });
    expect(editCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });
});
