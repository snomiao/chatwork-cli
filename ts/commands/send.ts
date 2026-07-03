// `chatwork send <room> "<msg>" [--code XXXX]`
// Two-step confirm: first call prints --code=XXXX, re-run with same args + --code to commit.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  sendMessage,
  listMessages,
  listMembers,
  ChatworkError,
  type Message,
  type Member,
} from "../api.ts";
import { readConfig, type Config } from "../config.ts";
import { resolveRoom } from "../room-resolver.ts";
import { formatTime, resolveMentions } from "../format.ts";

// Similarity threshold above which the outgoing text is flagged as a probable
// re-post of a recent message. High on purpose: only near-identical text trips it.
const DUP_THRESHOLD = 0.82;

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

// One-line preview of a room message for the confirm gate:
// "[2026-07-03 14:22] Alice: head…". Mentions/quote tags are resolved to @name
// and the body is collapsed to its first line and clipped.
function previewLine(m: Message, members: Member[], headLen = 100): string {
  const body = resolveMentions(m.body, members);
  const head = body.length > headLen ? `${body.slice(0, headLen)}…` : body;
  return `[${formatTime(m.send_time)}] ${m.account.name}: ${head || "(empty)"}`;
}

// Normalize text for duplicate comparison: lowercase, strip Chatwork markup
// ([To:..], [rp ..], [qt]…), drop punctuation, collapse whitespace — so cosmetic
// differences (an added mention, a trailing period) don't hide a re-post.
function normalizeForDup(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function sumCounts(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

// Character-bigram Dice coefficient (0..1) over normalized text — robust to
// minor edits, good at catching near-identical re-posts. Identical strings → 1.
function textSimilarity(a: string, b: string): number {
  const na = normalizeForDup(a);
  const nb = normalizeForDup(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.size === 0 || bb.size === 0) return 0;
  let overlap = 0;
  for (const [g, count] of ba) {
    const other = bb.get(g);
    if (other) overlap += Math.min(count, other);
  }
  const total = sumCounts(ba) + sumCounts(bb);
  return total === 0 ? 0 : (2 * overlap) / total;
}

interface RoomContext {
  rid: number | null;
  messages: Message[];
  members: Member[];
}

// Best-effort read-before-write context for the confirm gate. Fail-soft: any
// error (unresolvable/ambiguous room, missing scope, network) yields an empty
// context so the confirm code is still minted — the preview degrades, the send
// flow does not break. Room resolution errors surface later at confirm time.
async function gatherRoomContext(token: string, roomArg: string): Promise<RoomContext> {
  try {
    const rid = await resolveRoom(token, roomArg);
    const [messages, members] = await Promise.all([
      listMessages(token, rid),
      listMembers(token, rid).catch(() => [] as Member[]),
    ]);
    return { rid, messages, members };
  } catch {
    return { rid: null, messages: [], members: [] };
  }
}

// Print the read-before-write confirm block: the room's recent messages, a
// duplicate warning if the outgoing text closely matches a recent message, and
// the "Sending" summary. Mirrors slack-cli's confirm gate.
function printConfirmContext(
  ctx: RoomContext,
  roomArg: string,
  message: string,
): void {
  // Duplicate guard: warn (never block) when the outgoing text is near-identical
  // to a recent message — catches re-posting something already said.
  if (ctx.messages.length) {
    let best = { sim: 0, msg: null as Message | null };
    for (const m of ctx.messages) {
      const t = resolveMentions(m.body, ctx.members);
      if (!t) continue;
      const sim = textSimilarity(message, t);
      if (sim > best.sim) best = { sim, msg: m };
    }
    if (best.msg && best.sim >= DUP_THRESHOLD) {
      const pct = Math.round(best.sim * 100);
      console.error(
        `⚠ possible duplicate: ${pct}% similar to a recent message — ${previewLine(best.msg, ctx.members)}`,
      );
    }
  }

  const recent = ctx.messages.slice(-3);
  const recentLines = recent.length
    ? recent.map((m) => `  ${previewLine(m, ctx.members)}`)
    : ["  (room context unavailable)"];
  const ridSuffix = ctx.rid != null ? ` (rid=${ctx.rid})` : "";
  const dest = ctx.rid != null ? `${roomArg} (rid=${ctx.rid})` : roomArg;

  console.log(`--- Last messages in room${ridSuffix} ---------------`);
  for (const line of recentLines) console.log(line);
  console.log(`--- Sending ------------------------------------`);
  console.log(`  → room: ${dest}`);
  console.log(`  Message: ${message}`);
  console.log(`------------------------------------------------`);
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
    // Read-before-write: show the room's recent messages (and a duplicate
    // warning) so the sender sees the context before confirming the send.
    const ctx = await gatherRoomContext(cfg.token, args.room);
    printConfirmContext(ctx, args.room, args.message);

    const pending: Pending = {
      room_arg: args.room,
      message: args.message,
      created_at: Date.now(),
    };
    writeFileSync(path, JSON.stringify(pending), { mode: 0o600 });
    console.log(
      `Re-run within ${PENDING_TTL_MS / 1000}s with --code=${hash} to send.`,
    );
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
