import { listRooms } from "../api.ts";
import { readConfig, writeRoomsCache, type RoomCacheEntry } from "../config.ts";
import { formatRoomsTable } from "../format.ts";

export async function cmdRooms(opts: { format: string }): Promise<void> {
  const cfg = readConfig();
  const rooms = await listRooms(cfg.token);
  rooms.sort((a, b) => b.last_update_time - a.last_update_time);

  const cacheEntries: RoomCacheEntry[] = rooms.map((r) => ({
    rid: r.room_id,
    name: r.name,
    type: r.type,
  }));
  writeRoomsCache({ fetched_at: Date.now(), rooms: cacheEntries });

  if (opts.format === "json") {
    console.log(JSON.stringify(rooms, null, 2));
  } else {
    console.log(formatRoomsTable(rooms));
  }
}
