// Chatwork REST API wrapper. Auth header injection + rate-limit telemetry + 429 backoff.
// https://developer.chatwork.com/

export const API_BASE = "https://api.chatwork.com/v2";

export interface RateLimit {
  limit: number;
  remaining: number;
  reset: number;
}

export class ChatworkError extends Error {
  constructor(public status: number, public body: string, public rate?: RateLimit) {
    super(`Chatwork API ${status}: ${body.slice(0, 200)}`);
  }
}

export interface FetchOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: Record<string, string | number> | undefined;
  query?: Record<string, string | number | undefined> | undefined;
}

function parseRate(headers: Headers): RateLimit | undefined {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (!limit || !remaining || !reset) return undefined;
  return { limit: Number(limit), remaining: Number(remaining), reset: Number(reset) };
}

export interface ApiResponse<T> {
  data: T;
  rate?: RateLimit;
}

export async function call<T = unknown>(
  token: string,
  path: string,
  opts: FetchOpts = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ApiResponse<T>> {
  const method = opts.method ?? "GET";
  const url = new URL(API_BASE + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const init: RequestInit = {
    method,
    headers: {
      "x-chatworktoken": token,
      accept: "application/json",
    },
  };
  if (opts.body) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.body)) form.set(k, String(v));
    init.body = form.toString();
    (init.headers as Record<string, string>)["content-type"] =
      "application/x-www-form-urlencoded";
  }
  const res = await fetchImpl(url.toString(), init);
  const text = await res.text();
  const rate = parseRate(res.headers);
  if (!res.ok) {
    throw new ChatworkError(res.status, text, rate);
  }
  const data = (text ? JSON.parse(text) : null) as T;
  if (rate !== undefined) return { data, rate };
  return { data };
}

// --- typed endpoint helpers ---

export interface Me {
  account_id: number;
  name: string;
  chatwork_id?: string;
  login_mail?: string;
}

export interface Room {
  room_id: number;
  name: string;
  type: "my" | "direct" | "group";
  role: string;
  sticky: boolean;
  unread_num: number;
  mention_num: number;
  mytask_num: number;
  message_num: number;
  file_num: number;
  task_num: number;
  icon_path: string;
  last_update_time: number;
}

export interface Account {
  account_id: number;
  name: string;
  avatar_image_url?: string;
}

export interface Message {
  message_id: string;
  account: Account;
  body: string;
  send_time: number;
  update_time: number;
}

export interface Member {
  account_id: number;
  role: string;
  name: string;
  chatwork_id?: string;
  organization_id?: number;
  organization_name?: string;
  department?: string;
  avatar_image_url?: string;
}

export interface SendResult {
  message_id: string;
}

export const getMe = (token: string, f?: typeof fetch) =>
  call<Me>(token, "/me", {}, f ?? fetch).then((r) => r.data);

export const listRooms = (token: string, f?: typeof fetch) =>
  call<Room[]>(token, "/rooms", {}, f ?? fetch).then((r) => r.data);

export const listMessages = (token: string, rid: number, force = true, f?: typeof fetch) =>
  call<Message[]>(token, `/rooms/${rid}/messages`, { query: { force: force ? 1 : 0 } }, f ?? fetch)
    .then((r) => r.data ?? []);

export const listMembers = (token: string, rid: number, f?: typeof fetch) =>
  call<Member[]>(token, `/rooms/${rid}/members`, {}, f ?? fetch).then((r) => r.data);

export const sendMessage = (token: string, rid: number, body: string, f?: typeof fetch) =>
  call<SendResult>(
    token,
    `/rooms/${rid}/messages`,
    { method: "POST", body: { body } },
    f ?? fetch,
  ).then((r) => r.data);
