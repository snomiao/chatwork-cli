// `chatwork tail <room> [-n N] [--interval SEC]`
// Print last N messages, then poll every interval seconds and print new ones (dedup by message_id).
import { listMessages, listMembers, type Message, type Member } from "../api.ts";
import { readConfig } from "../config.ts";
import { resolveRoom } from "../room-resolver.ts";
import { formatTime, resolveMentions } from "../format.ts";

export async function cmdTail(args: {
  room: string;
  limit: number;
  interval: number;
  format: string;
}): Promise<void> {
  const cfg = readConfig();
  const rid = await resolveRoom(cfg.token, args.room);
  await tailRoom({
    token: cfg.token,
    rid,
    initialLimit: args.limit,
    intervalSec: args.interval,
    format: args.format,
    prefix: undefined,
  });
}

export async function tailRoom(opts: {
  token: string;
  rid: number;
  initialLimit: number;
  intervalSec: number;
  format: string;
  prefix: string | undefined;
}): Promise<void> {
  const { token, rid, initialLimit, intervalSec, format, prefix } = opts;
  const members = await listMembers(token, rid).catch(() => [] as Member[]);
  const initial = await listMessages(token, rid);
  const head = initial.slice(-initialLimit);
  printBatch(head, members, format, prefix);
  let lastSeen = initial.length > 0 ? initial[initial.length - 1]!.message_id : "0";

  while (true) {
    await sleep(intervalSec * 1000);
    try {
      const fresh = await listMessages(token, rid);
      const newOnes = fresh.filter((m) => cmpId(m.message_id, lastSeen) > 0);
      if (newOnes.length > 0) {
        printBatch(newOnes, members, format, prefix);
        lastSeen = newOnes[newOnes.length - 1]!.message_id;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[tail rid=${rid}] poll error: ${msg}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Chatwork message_id is a numeric string; use BigInt for safe ordering.
function cmpId(a: string, b: string): number {
  const aa = BigInt(a);
  const bb = BigInt(b);
  if (aa > bb) return 1;
  if (aa < bb) return -1;
  return 0;
}

function printBatch(
  messages: Message[],
  members: Member[],
  format: string,
  prefix: string | undefined,
): void {
  if (format === "json") {
    for (const m of messages) {
      const obj = prefix ? { room: prefix, ...m } : m;
      console.log(JSON.stringify(obj));
    }
    return;
  }
  for (const m of messages) {
    const t = formatTime(m.send_time);
    const body = resolveMentions(m.body, members);
    const head = prefix ? `[${prefix}] ` : "";
    console.log(`${head}[${t}] ${m.account.name} (${m.account.account_id}): ${body}`);
  }
}
