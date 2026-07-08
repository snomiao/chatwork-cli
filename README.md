# chatwork-cli

Chatwork CLI mirroring the `slack-term` pattern. Send / read messages, list rooms, with a confirm-code send guard so an LLM agent can't fire off a message by accident.

## Install (local dev)

```bash
git clone https://github.com/takusym/chatwork-cli && cd chatwork-cli
bun install
bun ts/cli.ts --help
```

To wire `chatwork` (and the `cw` short alias) globally:

```bash
chmod +x ts/cli.ts
ln -sf "$(pwd)/ts/cli.ts" ~/.bun/bin/chatwork
ln -sf "$(pwd)/ts/cli.ts" ~/.bun/bin/cw
chatwork --help        # same as `cw --help`
```

## Commands (v0.1)

### `chatwork login`

Stores your API token at `~/.config/chatwork-cli/config.json` (mode 0600). Generate a token at:

https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php

```bash
chatwork login                  # prompts stdin
chatwork login --token=...      # non-interactive
chatwork login --from-chrome    # macOS: pick a Chrome profile, scrape token.php
```

`--from-chrome` lists Chrome profiles from `~/Library/Application Support/Google/Chrome/Local State`, decrypts the chosen profile's chatwork.com cookies (Keychain prompt for "Chrome Safe Storage" the first time), then fetches token.php with those cookies and pulls the API token out of the rendered HTML. If the session has expired, open Chatwork once in Chrome and retry. macOS only.

### `chatwork rooms [--format table|json]`

Lists rooms sorted by last activity. Caches `rid → name` to `~/.config/chatwork-cli/rooms.json` for 5 min so `send`/`read` can resolve `#name`.

### `chatwork send <room> "<msg>" [--code XXXX]`

Two-step send guard. The first call is a read-before-write confirm gate: it
previews the room's recent messages (so you see the context before replying) and
warns if the outgoing text is near-identical to a recent message (probable
re-post), then prints the `--code` you re-run with to actually send.

```bash
chatwork send 111111111 "hello"
# → --- Last messages in room (rid=111111111) ---------------
#     [2026-07-02 10:31] taku: 先ほどの件、確認しました
#     [2026-07-02 11:05] client: ありがとうございます
#   --- Sending ------------------------------------
#     → room: 111111111 (rid=111111111)
#     Message: hello
#   ------------------------------------------------
#   Re-run within 60s with --code=ab12cd34 to send.

chatwork send 111111111 "hello" --code=ab12cd34
# → ✓ sent to rid=111111111 (msg_id=...)
```

The context preview is best-effort: if the room can't be resolved or its
messages can't be fetched, the gate shows `(room context unavailable)` and still
mints the code — the send flow is never blocked by a preview failure.

**Anti-spam nudge.** If your own most recent message in the room was sent within
the last 60s, the gate prints a non-blocking warning suggesting `cw edit` instead
of stacking another message. It never blocks (intentional multi-sends are valid).
Tune or disable the window with `CHATWORK_RESEND_WARN_SECONDS` (`0` = off):

```bash
chatwork send 222222222 "追記です"
# → ⚠ 直前(12秒前)に同じルームへ送信しています(message_id=1234567890)。
#     連投ではなく、その内容を編集する方が適切かもしれません:
#     cw edit 222222222 1234567890 "<新しい本文>"
#     続けて新規送信する場合はそのまま --code で確定してください。
#   --- Last messages in room ... (preview continues) ---
```

**`--to <account_id|name>` mentions.** Prepend a Chatwork `[To:]` mention. The
target is an `account_id` or a member name resolved against the room member list
(exact match first, then substring — same order as room-name resolution).
Repeatable for multiple mentions. The mention becomes part of the confirmed body,
so it shows in the preview and is bound by the `--code`.

```bash
chatwork send 222222222 "確認お願いします" --to Alice
# → Message: [To:100]Aliceさん\n確認お願いします   (then the usual --code gate)
chatwork send 222222222 "全員ご確認ください" --to Alice --to 田中太郎
```

`<room>` accepts a numeric `rid`, a bare `<name>`, or `#<name>` — name lookup tries exact match first, then case-sensitive substring against the cached rooms list. Ambiguous matches error out with the candidate rids so you can disambiguate. So `cw read マイチャット` and `cw read #マイチャット` and `cw read 333333333` all reach the same room.

### `chatwork edit <room> <message_id> "<new_body>" [--code XXXX]`

Edit a sent message via `PUT /rooms/{rid}/messages/{message_id}`, using the same
two-step `--code` confirm as `send`. The first call previews the current message
body (read-before-write) next to the replacement; re-run with the code to commit.
Get the `message_id` from `read`/`tail` (`--format json`) or the send success line.

```bash
chatwork edit 222222222 1234567890 "訂正: 打ち合わせは15時からです"
# → --- Editing message in room (rid=222222222) -------
#     message_id: 1234567890
#     current: [2026-07-08 14:00] taku: 打ち合わせは14時からです
#   --- New body -----------------------------------
#     → room: 222222222 (rid=222222222)
#     Message: 訂正: 打ち合わせは15時からです
#   ------------------------------------------------
#   Re-run within 60s with --code=abcd1234 to edit.

chatwork edit 222222222 1234567890 "訂正: 打ち合わせは15時からです" --code=abcd1234
# → ✓ edited msg_id=1234567890 in rid=222222222
```

### `chatwork read <room> [-n 20] [--format text|json]`

```bash
chatwork read 111111111 -n 5
# → [2026-05-20 12:26] taku (123456): リモートアクセスのお願いです …
```

`[To:{aid}]` mentions are replaced with `@<name>` via the room's member list.

### `chatwork tail <room> [-n 10] [--interval 20] [--format text|json]`

Print the last N messages, then poll every `--interval` seconds and print any new ones (dedup by `message_id`). Ctrl-C to stop.

```bash
chatwork tail 111111111 -n 5
chatwork tail マイチャット --interval 10 --format json
```

### `chatwork watch <room1> <room2> ... [-n 10] [--interval 20] [--format text|json]`

Tail multiple rooms concurrently. Each printed line is prefixed with `[room_name]` so you can tell rooms apart.

```bash
chatwork watch マイチャット 111111111 #team
```

## Rate limits

Chatwork enforces:

- **300 req / 5 min** global
- **10 req / 10s** on `POST /rooms/{rid}/messages`

The client surfaces 429 with the `x-ratelimit-reset` time so the caller knows when to retry.

## Test / typecheck

```bash
bun test
bun tsc --noEmit
```

## Roadmap

- v0.2: `chatwork upload <room> <file>` (single multipart POST, 5 MB cap)
- v1.0: `chatwork task add/list/done` (Chatwork-native task surface — no Slack equivalent)
- v1.0: multi-profile support (multi-org), `chatwork me`, semantic-release packaging
