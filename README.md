# chatwork-cli

Chatwork CLI mirroring the `slack-term` pattern. Send / read messages, list rooms, with a confirm-code send guard so an LLM agent can't fire off a message by accident.

## Install (local dev)

```bash
cd lib/chatwork-cli
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

Two-step send guard:

```bash
chatwork send 111111111 "hello"
# → Re-run within 60s with --code=ab12cd34 to send:
#     room: 111111111
#     body: hello

chatwork send 111111111 "hello" --code=ab12cd34
# → ✓ sent to rid=111111111 (msg_id=...)
```

`<room>` accepts a numeric `rid` or `#<name>` (resolved against the cached rooms list).

### `chatwork read <room> [-n 20] [--format text|json]`

```bash
chatwork read 111111111 -n 5
# → [2026-05-20 12:26] taku (123456): リモートアクセスのお願いです …
```

`[To:{aid}]` mentions are replaced with `@<name>` via the room's member list.

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

- v0.2: `chatwork watch <room>` (5–10s polling, message-id dedupe)
- v0.2: `chatwork upload <room> <file>` (single multipart POST, 5 MB cap)
- v1.0: `chatwork task add/list/done` (Chatwork-native task surface — no Slack equivalent)
- v1.0: multi-profile support (multi-org), `chatwork me`, semantic-release packaging
