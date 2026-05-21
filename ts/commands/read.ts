import { listMessages, listMembers } from "../api.ts";
import { readConfig } from "../config.ts";
import { resolveRoom } from "../room-resolver.ts";
import { formatMessages } from "../format.ts";

export async function cmdRead(args: {
  room: string;
  limit: number;
  format: string;
}): Promise<void> {
  const cfg = readConfig();
  const rid = await resolveRoom(cfg.token, args.room);
  const [messages, members] = await Promise.all([
    listMessages(cfg.token, rid),
    listMembers(cfg.token, rid).catch(() => []),
  ]);
  const tail = messages.slice(-args.limit);

  if (args.format === "json") {
    console.log(JSON.stringify(tail, null, 2));
    return;
  }
  console.log(formatMessages(tail, members));
}
