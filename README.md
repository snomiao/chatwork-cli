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

`<room>` accepts a numeric `rid`, a bare `<name>`, or `#<name>` — name lookup tries exact match first, then case-sensitive substring against the cached rooms list. Ambiguous matches error out with the candidate rids so you can disambiguate. So `cw read マイチャット` and `cw read #マイチャット` and `cw read 333333333` all reach the same room.

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
