import { describe, expect, test } from "bun:test";
import type { Member } from "../ts/api.ts";
import { resolveMention, mentionTag, buildMentionPrefix } from "../ts/mention.ts";

const members: Member[] = [
  { account_id: 100, role: "admin", name: "Alice" },
  { account_id: 101, role: "member", name: "田中太郎" },
  { account_id: 102, role: "member", name: "田中花子" },
];

describe("resolveMention", () => {
  test("numeric arg is taken as account_id, name filled from members", () => {
    expect(resolveMention(members, "100")).toEqual({ account_id: 100, name: "Alice" });
  });

  test("numeric arg not in the room is still accepted (no name)", () => {
    expect(resolveMention(members, "999")).toEqual({ account_id: 999 });
  });

  test("exact name match wins", () => {
    expect(resolveMention(members, "Alice")).toEqual({ account_id: 100, name: "Alice" });
  });

  test("unique substring match resolves", () => {
    expect(resolveMention(members, "Alice")).toEqual({ account_id: 100, name: "Alice" });
  });

  test("ambiguous substring throws with candidates", () => {
    expect(() => resolveMention(members, "田中")).toThrow(/ambiguous/);
  });

  test("no match throws", () => {
    expect(() => resolveMention(members, "存在しない")).toThrow(/no member/);
  });
});

describe("mentionTag / buildMentionPrefix", () => {
  test("tag includes display name + さん when known", () => {
    expect(mentionTag({ account_id: 100, name: "Alice" })).toBe("[To:100]Aliceさん");
  });

  test("tag omits the label when the name is unknown", () => {
    expect(mentionTag({ account_id: 999 })).toBe("[To:999]");
  });

  test("prefix prepends a single [To:] and a newline", () => {
    expect(buildMentionPrefix(members, ["Alice"])).toBe("[To:100]Aliceさん\n");
  });

  test("multiple targets are space-joined before the newline", () => {
    expect(buildMentionPrefix(members, ["100", "田中太郎"])).toBe(
      "[To:100]Aliceさん [To:101]田中太郎さん\n",
    );
  });

  test("empty target list leaves the body untouched", () => {
    expect(buildMentionPrefix(members, [])).toBe("");
  });
});
