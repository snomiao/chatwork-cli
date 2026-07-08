#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { cmdLogin } from "./commands/login.ts";
import { cmdRooms } from "./commands/rooms.ts";
import { cmdSend } from "./commands/send.ts";
import { cmdEdit } from "./commands/edit.ts";
import { cmdRead } from "./commands/read.ts";
import { cmdTail } from "./commands/tail.ts";
import { cmdWatch } from "./commands/watch.ts";
import { ChatworkError } from "./api.ts";

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName("chatwork")
    .usage("$0 <command> [args]")
    .command(
      "login",
      "Store a Chatwork API token at ~/.config/chatwork-cli/config.json",
      (y) =>
        y
          .option("token", {
            type: "string",
            describe: "API token (else prompted from stdin)",
          })
          .option("from-chrome", {
            type: "boolean",
            default: false,
            describe:
              "Pick a Chrome profile and scrape the API token from token.php using its session cookies",
          }),
      async (argv) => {
        await cmdLogin({
          token: argv.token as string | undefined,
          fromChrome: argv["from-chrome"] as boolean | undefined,
        });
      },
    )
    .command(
      "rooms",
      "List rooms sorted by last activity",
      (y) =>
        y.option("format", {
          type: "string",
          choices: ["table", "json"] as const,
          default: "table",
        }),
      async (argv) => {
        await cmdRooms({ format: argv.format as string });
      },
    )
    .command(
      "send <room> <message>",
      "Send a message (two-step: first call returns --code, re-run with code to commit)",
      (y) =>
        y
          .positional("room", { type: "string", describe: "rid, name, or #name (exact match first, then substring)" })
          .positional("message", { type: "string", describe: "message body" })
          .option("to", {
            type: "string",
            array: true,
            describe: "prepend a [To:] mention; account_id or member name (exact→substring). Repeatable.",
          })
          .option("code", { type: "string", describe: "confirm code from first call" })
          .option("force", { type: "boolean", default: false, describe: "bypass the pre-send hook (emergency)" })
          .demandOption(["room", "message"]),
      async (argv) => {
        await cmdSend({
          room: argv.room as string,
          message: argv.message as string,
          code: argv.code as string | undefined,
          force: argv.force as boolean | undefined,
          to: argv.to as string[] | undefined,
        });
      },
    )
    .command(
      "edit <room> <message_id> <message>",
      "Edit a sent message (two-step: first call returns --code, re-run with code to commit)",
      (y) =>
        y
          .positional("room", { type: "string", describe: "rid, name, or #name (exact match first, then substring)" })
          .positional("message_id", { type: "string", describe: "message_id to edit (see `read`/`tail`)" })
          .positional("message", { type: "string", describe: "new message body" })
          .option("code", { type: "string", describe: "confirm code from first call" })
          .demandOption(["room", "message_id", "message"]),
      async (argv) => {
        await cmdEdit({
          room: argv.room as string,
          messageId: argv.message_id as string,
          message: argv.message as string,
          code: argv.code as string | undefined,
        });
      },
    )
    .command(
      "read <room>",
      "Read the last N messages of a room",
      (y) =>
        y
          .positional("room", { type: "string", describe: "rid, name, or #name (exact match first, then substring)" })
          .option("limit", { alias: "n", type: "number", default: 20 })
          .option("format", {
            type: "string",
            choices: ["text", "json"] as const,
            default: "text",
          })
          .demandOption(["room"]),
      async (argv) => {
        await cmdRead({
          room: argv.room as string,
          limit: argv.limit as number,
          format: argv.format as string,
        });
      },
    )
    .command(
      "tail <room>",
      "Print last N messages then poll for new ones (Ctrl-C to stop)",
      (y) =>
        y
          .positional("room", { type: "string", describe: "rid, name, or #name (exact match first, then substring)" })
          .option("limit", { alias: "n", type: "number", default: 10, describe: "initial backlog count" })
          .option("interval", { type: "number", default: 20, describe: "poll interval in seconds" })
          .option("format", {
            type: "string",
            choices: ["text", "json"] as const,
            default: "text",
          })
          .demandOption(["room"]),
      async (argv) => {
        await cmdTail({
          room: argv.room as string,
          limit: argv.limit as number,
          interval: argv.interval as number,
          format: argv.format as string,
        });
      },
    )
    .command(
      "watch <rooms..>",
      "Tail multiple rooms concurrently; each line is prefixed with [room_name]",
      (y) =>
        y
          .positional("rooms", { type: "string", array: true, describe: "rid / name / #name list" })
          .option("limit", { alias: "n", type: "number", default: 10, describe: "initial backlog count per room" })
          .option("interval", { type: "number", default: 20, describe: "poll interval in seconds" })
          .option("format", {
            type: "string",
            choices: ["text", "json"] as const,
            default: "text",
          })
          .demandOption(["rooms"]),
      async (argv) => {
        await cmdWatch({
          rooms: argv.rooms as string[],
          limit: argv.limit as number,
          interval: argv.interval as number,
          format: argv.format as string,
        });
      },
    )
    .demandCommand(1, "Pick a command: login | rooms | send | edit | read | tail | watch")
    .strict()
    .help()
    .alias("h", "help")
    .fail((msg, err) => {
      if (err) throw err;
      console.error(`chatwork: ${msg}`);
      process.exit(1);
    })
    .parseAsync();
}

main().catch((err: unknown) => {
  if (err instanceof ChatworkError) {
    console.error(`chatwork: API ${err.status}: ${err.body.slice(0, 300)}`);
  } else if (err instanceof Error) {
    console.error(`chatwork: ${err.message}`);
  } else {
    console.error(`chatwork: unknown error`, err);
  }
  process.exit(1);
});
