// `chatwork send <room> "<msg>" [--code XXXX]`
// Two-step confirm: first call prints --code=XXXX, re-run with same args + --code to commit.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendMessage, ChatworkError } from "../api.ts";
import { readConfig } from "../config.ts";
import { resolveRoom } from "../room-resolver.ts";

const PENDING_TTL_MS = 60_000;

interface Pending {
  room_arg: string;
  message: string;
  created_at: number;
}

function intentHash(roomArg: string, message: string): string {
  return createHash("sha256")
    .update(`${roomArg}\x00${message}`)
    .digest("hex")
    .slice(0, 8);
}

function pendingPath(hash: string): string {
  return join(tmpdir(), `chatwork-cli-pending-${hash}.json`);
}

export async function cmdSend(args: {
  room: string;
  message: string;
  code: string | undefined;
}): Promise<void> {
  const cfg = readConfig();
  const hash = intentHash(args.room, args.message);
  const path = pendingPath(hash);

  if (!args.code) {
    const pending: Pending = {
      room_arg: args.room,
      message: args.message,
      created_at: Date.now(),
    };
    writeFileSync(path, JSON.stringify(pending), { mode: 0o600 });
    console.log(
      `Re-run within ${PENDING_TTL_MS / 1000}s with --code=${hash} to send:`,
    );
    console.log(`  room: ${args.room}`);
    console.log(`  body: ${args.message.slice(0, 200)}${args.message.length > 200 ? "…" : ""}`);
    return;
  }

  if (args.code !== hash) {
    console.error(`code mismatch: expected ${hash}, got ${args.code}`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(path)) {
    console.error(`no pending intent for code=${hash}. Re-run without --code to start over.`);
    process.exitCode = 1;
    return;
  }
  const pending = JSON.parse(readFileSync(path, "utf8")) as Pending;
  if (Date.now() - pending.created_at > PENDING_TTL_MS) {
    unlinkSync(path);
    console.error(`pending intent expired (>${PENDING_TTL_MS / 1000}s). Re-run without --code.`);
    process.exitCode = 1;
    return;
  }

  const rid = await resolveRoom(cfg.token, args.room);
  try {
    const result = await sendMessage(cfg.token, rid, args.message);
    unlinkSync(path);
    console.log(`✓ sent to rid=${rid} (msg_id=${result.message_id})`);
  } catch (e) {
    if (e instanceof ChatworkError && e.status === 429 && e.rate) {
      const wait = e.rate.reset - Math.floor(Date.now() / 1000);
      console.error(`rate-limited (429). Retry after ${wait}s (reset=${e.rate.reset}).`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
}
