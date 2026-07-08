// Two-step confirm gate shared by `send` and `edit`.
//
// First call stages a pending intent keyed by a short hash of the intent fields
// and echoes that hash as the `--code`. Re-running with `--code` re-derives the
// hash from the same args; a match (plus an unexpired pending file) commits.
// The hash binds every intent field, so changing the room / message / target
// invalidates a previously minted code.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PENDING_TTL_MS = 60_000;

// Stable 8-hex confirm code over `kind` + the intent fields. `kind` salts the
// hash so a code minted for a `send` can never confirm an `edit` (or vice versa).
export function confirmCode(kind: string, ...parts: string[]): string {
  return createHash("sha256")
    .update([kind, ...parts].join("\x00"))
    .digest("hex")
    .slice(0, 8);
}

function pendingPath(kind: string, code: string): string {
  return join(tmpdir(), `chatwork-cli-${kind}-${code}.json`);
}

// First call: persist the pending intent (TTL is checked on confirm).
export function stagePending(kind: string, code: string): void {
  writeFileSync(
    pendingPath(kind, code),
    JSON.stringify({ created_at: Date.now() }),
    { mode: 0o600 },
  );
}

export type PendingReason = "mismatch" | "missing" | "expired";

// Second call: validate the supplied code against the freshly-derived one and
// the staged pending file. Returns null on success, else why it failed.
// A stale (expired) pending file is removed as a side effect.
export function checkPending(
  kind: string,
  provided: string,
  expected: string,
): PendingReason | null {
  if (provided !== expected) return "mismatch";
  const path = pendingPath(kind, expected);
  if (!existsSync(path)) return "missing";
  const { created_at } = JSON.parse(readFileSync(path, "utf8")) as {
    created_at: number;
  };
  if (Date.now() - created_at > PENDING_TTL_MS) {
    unlinkSync(path);
    return "expired";
  }
  return null;
}

// Remove a staged pending file after a successful commit.
export function clearPending(kind: string, code: string): void {
  const path = pendingPath(kind, code);
  if (existsSync(path)) unlinkSync(path);
}

// Standard stderr message for a failed confirm check.
export function pendingError(reason: PendingReason, code: string): string {
  switch (reason) {
    case "mismatch":
      return `code mismatch for ${code}. Re-run without --code to start over.`;
    case "missing":
      return `no pending intent for code=${code}. Re-run without --code to start over.`;
    case "expired":
      return `pending intent expired (>${PENDING_TTL_MS / 1000}s). Re-run without --code.`;
  }
}
