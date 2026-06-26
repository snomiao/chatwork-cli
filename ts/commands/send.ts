// `chatwork send <room> "<msg>" [--code XXXX]`
// Two-step confirm: first call prints --code=XXXX, re-run with same args + --code to commit.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sendMessage, ChatworkError } from "../api.ts";
import { readConfig, type Config } from "../config.ts";
import { resolveRoom } from "../room-resolver.ts";

const PENDING_TTL_MS = 60_000;
const HOOK_TIMEOUT_MS = 20_000;

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

// Run the configured pre-send hook. Returns the hook exit code (0 = pass).
// fail-closed: spawn failure / timeout resolve to a non-zero code so the caller aborts.
function runPreSendHook(
  hookPath: string,
  message: string,
  rid: number,
  roomArg: string,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(expandHome(hookPath), {
      stdio: ["pipe", "inherit", "inherit"],
      env: {
        ...process.env,
        CHATWORK_ROOM_ID: String(rid),
        CHATWORK_ROOM_ARG: roomArg,
      },
    });
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      console.error(`✗ pre-send hook timed out after ${HOOK_TIMEOUT_MS / 1000}s`);
      done(124);
    }, HOOK_TIMEOUT_MS);
    child.on("error", (err) => {
      console.error(`✗ pre-send hook failed to start: ${err.message}`);
      done(126);
    });
    child.on("close", (code) => done(code ?? 1));
    child.stdin.on("error", () => {}); // ignore EPIPE if hook never reads stdin
    child.stdin.end(message);
  });
}

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
  force?: boolean | undefined;
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

  const hookApplies =
    Array.isArray(cfg.client_rooms) &&
    cfg.client_rooms.includes(rid) &&
    typeof cfg.pre_send_hook === "string" &&
    cfg.pre_send_hook.length > 0;
  if (hookApplies) {
    if (args.force) {
      console.error(`⚠ pre-send hook bypassed via --force`);
    } else {
      const code = await runPreSendHook(
        (cfg as Config).pre_send_hook!,
        args.message,
        rid,
        args.room,
      );
      if (code !== 0) {
        console.error(`✗ send aborted by pre-send hook (exit ${code})`);
        process.exitCode = 3;
        return; // keep pending file so the user can fix & re-send
      }
    }
  }

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
