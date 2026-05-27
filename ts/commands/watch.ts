// `chatwork watch <room1> <room2> ...`
// Tail multiple rooms concurrently; each printed message is prefixed with [room_name].
import { readConfig } from "../config.ts";
import { resolveRoom, loadRoomsCached } from "../room-resolver.ts";
import { tailRoom } from "./tail.ts";

export async function cmdWatch(args: {
  rooms: string[];
  limit: number;
  interval: number;
  format: string;
}): Promise<void> {
  const cfg = readConfig();
  const cache = await loadRoomsCached(cfg.token);
  const nameByRid = new Map(cache.map((r) => [r.rid, r.name] as const));

  const resolved = await Promise.all(
    args.rooms.map(async (arg) => {
      const rid = await resolveRoom(cfg.token, arg);
      return { rid, name: nameByRid.get(rid) ?? String(rid) };
    }),
  );

  await Promise.all(
    resolved.map(({ rid, name }) =>
      tailRoom({
        token: cfg.token,
        rid,
        initialLimit: args.limit,
        intervalSec: args.interval,
        format: args.format,
        prefix: name,
      }),
    ),
  );
}
