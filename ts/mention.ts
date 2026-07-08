// Resolve `--to <account_id|name>` targets against a room's member list and
// build the Chatwork `[To:…]` mention prefix that `cw send` prepends to a body.
import type { Member } from "./api.ts";

export interface ResolvedMention {
  account_id: number;
  name?: string; // display name, when known from the member list
}

// Resolve a single `--to` argument. A numeric argument is taken as an
// account_id verbatim (its display name is filled in when it happens to be a
// room member). A name is matched exact-first, then substring — the same order
// as room-name resolution. Ambiguous or unknown names throw.
export function resolveMention(members: Member[], arg: string): ResolvedMention {
  if (/^\d+$/.test(arg)) {
    const id = Number(arg);
    const m = members.find((x) => x.account_id === id);
    return m ? { account_id: id, name: m.name } : { account_id: id };
  }
  const exact = members.filter((m) => m.name === arg);
  if (exact.length === 1) return { account_id: exact[0]!.account_id, name: exact[0]!.name };
  if (exact.length > 1) {
    throw new Error(
      `--to "${arg}" matches ${exact.length} members: ${exact
        .map((m) => `${m.account_id}=${m.name}`)
        .join(", ")}. Use an account_id.`,
    );
  }
  const sub = members.filter((m) => m.name.includes(arg));
  if (sub.length === 1) return { account_id: sub[0]!.account_id, name: sub[0]!.name };
  if (sub.length === 0) {
    throw new Error(`--to "${arg}" matched no member in this room. Use an account_id or an exact name.`);
  }
  throw new Error(
    `--to "${arg}" is ambiguous — matches ${sub.length} members: ${sub
      .map((m) => `${m.account_id}=${m.name}`)
      .join(", ")}. Use an account_id.`,
  );
}

// One `[To:…]` tag. The trailing "さん" label is cosmetic (Chatwork renders the
// mention from the id); it's omitted when the display name is unknown.
export function mentionTag(m: ResolvedMention): string {
  return m.name ? `[To:${m.account_id}]${m.name}さん` : `[To:${m.account_id}]`;
}

// Build the full mention prefix for a body: space-joined tags plus a newline.
// Returns "" when there are no targets (so the body is left untouched).
export function buildMentionPrefix(members: Member[], tos: string[]): string {
  if (tos.length === 0) return "";
  const tags = tos.map((t) => mentionTag(resolveMention(members, t)));
  return `${tags.join(" ")}\n`;
}
