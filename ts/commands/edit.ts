// `chatwork edit <room> <message_id> "<new_body>" [--code XXXX]`
// Two-step confirm mirroring `send`: first call previews the current message and
// the replacement, then prints --code; re-run with the code to commit the edit.
import { getMessage, editMessage, listMembers, ChatworkError, type Member, type Message } from "../api.ts";
import { readConfig } from "../config.ts";
import { resolveRoom } from "../room-resolver.ts";
import { previewLine } from "../format.ts";
import {
  confirmCode,
  stagePending,
  checkPending,
  clearPending,
  pendingError,
  PENDING_TTL_MS,
} from "../confirm.ts";

export async function cmdEdit(args: {
  room: string;
  messageId: string;
  message: string;
  code: string | undefined;
}): Promise<void> {
  const cfg = readConfig();
  const code = confirmCode("edit", args.room, args.messageId, args.message);

  if (!args.code) {
    // Best-effort read-before-write: show the message being replaced. Fail-soft —
    // a fetch failure degrades the preview but still mints the code.
    let rid: number | null = null;
    let current: Message | null = null;
    let members: Member[] = [];
    try {
      rid = await resolveRoom(cfg.token, args.room);
      [current, members] = await Promise.all([
        getMessage(cfg.token, rid, args.messageId).catch(() => null),
        listMembers(cfg.token, rid).catch(() => [] as Member[]),
      ]);
    } catch {
      // room resolution / fetch failed — surfaces again at confirm time
    }
    const ridSuffix = rid != null ? ` (rid=${rid})` : "";
    const dest = rid != null ? `${args.room} (rid=${rid})` : args.room;
    console.log(`--- Editing message in room${ridSuffix} -------`);
    console.log(`  message_id: ${args.messageId}`);
    console.log(`  current: ${current ? previewLine(current, members) : "(message unavailable)"}`);
    console.log(`--- New body -----------------------------------`);
    console.log(`  → room: ${dest}`);
    console.log(`  Message: ${args.message}`);
    console.log(`------------------------------------------------`);
    stagePending("edit", code);
    console.log(`Re-run within ${PENDING_TTL_MS / 1000}s with --code=${code} to edit.`);
    return;
  }

  const reason = checkPending("edit", args.code, code);
  if (reason) {
    console.error(pendingError(reason, code));
    process.exitCode = 1;
    return;
  }

  const rid = await resolveRoom(cfg.token, args.room);
  try {
    const result = await editMessage(cfg.token, rid, args.messageId, args.message);
    clearPending("edit", code);
    console.log(`✓ edited msg_id=${result.message_id} in rid=${rid}`);
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
