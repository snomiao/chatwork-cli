// Resolve <room> arg → rid. Accepts numeric rid or "#name".
import { listRooms } from "./api.ts";
import { readRoomsCache, writeRoomsCache, type RoomCacheEntry } from "./config.ts";

const CACHE_TTL_MS = 5 * 60 * 1000;

export async function resolveRoom(token: string, arg: string): Promise<number> {
  if (/^\d+$/.test(arg)) return Number(arg);
  const name = arg.startsWith("#") ? arg.slice(1) : arg;
  const rooms = await loadRoomsCached(token);
  const matches = rooms.filter((r) => r.name === name);
  if (matches.length === 1) return matches[0]!.rid;
  if (matches.length === 0) {
    // try substring
    const fuzzy = rooms.filter((r) => r.name.includes(name));
    if (fuzzy.length === 1) return fuzzy[0]!.rid;
    if (fuzzy.length === 0) throw new Error(`No room matching "${arg}". Try: chatwork rooms`);
    throw new Error(
      `Ambiguous "${arg}" — matches ${fuzzy.length} rooms: ${fuzzy
        .slice(0, 5)
        .map((r) => `${r.rid}=${r.name}`)
        .join(", ")}. Use rid instead.`,
    );
  }
  throw new Error(
    `Ambiguous "${arg}" — exact name matches ${matches.length} rooms: ${matches
      .map((r) => r.rid)
      .join(", ")}. Use rid instead.`,
  );
}

export async function loadRoomsCached(
  token: string,
  force = false,
): Promise<RoomCacheEntry[]> {
  if (!force) {
    const cache = readRoomsCache();
    if (cache && Date.now() - cache.fetched_at < CACHE_TTL_MS) return cache.rooms;
  }
  const rooms = await listRooms(token);
  const entries: RoomCacheEntry[] = rooms.map((r) => ({
    rid: r.room_id,
    name: r.name,
    type: r.type,
  }));
  writeRoomsCache({ fetched_at: Date.now(), rooms: entries });
  return entries;
}
