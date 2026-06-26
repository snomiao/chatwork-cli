// Local config (~/.config/chatwork-cli/config.json) and room-name cache.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config", "chatwork-cli");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const ROOMS_CACHE_PATH = join(CONFIG_DIR, "rooms.json");

export interface Config {
  token: string;
  account_id?: number;
  name?: string;
  client_rooms?: number[]; // pre-send hook allowlist (room ids)
  pre_send_hook?: string; // path to pre-send factcheck hook (~ expanded)
}

export interface RoomCacheEntry {
  rid: number;
  name: string;
  type: string;
}

export interface RoomsCache {
  fetched_at: number;
  rooms: RoomCacheEntry[];
}

function ensureDir(file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`No config at ${CONFIG_PATH}. Run: chatwork login`);
  }
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Config;
  if (!parsed.token) throw new Error("Config missing 'token'. Re-run: chatwork login");
  return parsed;
}

export function writeConfig(cfg: Config): void {
  ensureDir(CONFIG_PATH);
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  chmodSync(CONFIG_PATH, 0o600);
}

export function readRoomsCache(): RoomsCache | null {
  if (!existsSync(ROOMS_CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ROOMS_CACHE_PATH, "utf8")) as RoomsCache;
  } catch {
    return null;
  }
}

export function writeRoomsCache(cache: RoomsCache): void {
  ensureDir(ROOMS_CACHE_PATH);
  writeFileSync(ROOMS_CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}
