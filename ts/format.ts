// Output helpers: table & JSON.
import type { Message, Member, Room } from "./api.ts";

export function formatTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

// Replace [To:{aid}], [rp aid={aid}], [qt][qtmeta aid=...] etc. with human-readable @name.
export function resolveMentions(body: string, members: Member[]): string {
  const byId = new Map(members.map((m) => [m.account_id, m.name] as const));
  return body
    .replace(/\[To:(\d+)\]/g, (_m, id: string) => `@${byId.get(Number(id)) ?? id} `)
    .replace(/\[rp aid=(\d+)[^\]]*\]/g, (_m, id: string) => `@${byId.get(Number(id)) ?? id} `)
    .replace(/\[qtmeta aid=(\d+) time=\d+\]/g, (_m, id: string) => `(quote @${byId.get(Number(id)) ?? id}: `)
    .replace(/\[\/qt\]/g, ")")
    .replace(/\[qt\]/g, "")
    .replace(/\[info\]/g, "")
    .replace(/\[\/info\]/g, "")
    .replace(/\[title\]/g, "")
    .replace(/\[\/title\]/g, ": ")
    .replace(/\[hr\]/g, "—")
    .replace(/\n+/g, " ")
    .trim();
}

export function formatRoomsTable(rooms: Room[]): string {
  const rows = rooms.map((r) => ({
    rid: String(r.room_id),
    unread: r.unread_num > 0 ? String(r.unread_num) : "",
    type: r.type,
    name: r.name,
  }));
  const widths = {
    rid: Math.max(3, ...rows.map((r) => r.rid.length)),
    unread: Math.max(6, ...rows.map((r) => r.unread.length)),
    type: Math.max(6, ...rows.map((r) => r.type.length)),
  };
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  const lines = [
    `${pad("rid", widths.rid)}  ${pad("unread", widths.unread)}  ${pad("type", widths.type)}  name`,
    `${"-".repeat(widths.rid)}  ${"-".repeat(widths.unread)}  ${"-".repeat(widths.type)}  ----`,
    ...rows.map(
      (r) =>
        `${pad(r.rid, widths.rid)}  ${pad(r.unread, widths.unread)}  ${pad(r.type, widths.type)}  ${r.name}`,
    ),
  ];
  return lines.join("\n");
}

export function formatMessages(messages: Message[], members: Member[]): string {
  return messages
    .map((m) => {
      const t = formatTime(m.send_time);
      const name = m.account.name;
      const body = resolveMentions(m.body, members);
      return `[${t}] ${name} (${m.account.account_id}): ${body}`;
    })
    .join("\n");
}
