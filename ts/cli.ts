#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { cmdLogin } from "./commands/login.ts";
import { cmdRooms } from "./commands/rooms.ts";
import { cmdSend } from "./commands/send.ts";
import { cmdRead } from "./commands/read.ts";
import { ChatworkError } from "./api.ts";

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName("chatwork")
    .usage("$0 <command> [args]")
    .command(
      "login",
      "Store a Chatwork API token at ~/.config/chatwork-cli/config.json",
      (y) =>
        y.option("token", {
          type: "string",
          describe: "API token (else prompted from stdin)",
        }),
      async (argv) => {
        await cmdLogin({ token: argv.token as string | undefined });
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
          .positional("room", { type: "string", describe: "rid or #name" })
          .positional("message", { type: "string", describe: "message body" })
          .option("code", { type: "string", describe: "confirm code from first call" })
          .demandOption(["room", "message"]),
      async (argv) => {
        await cmdSend({
          room: argv.room as string,
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
          .positional("room", { type: "string", describe: "rid or #name" })
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
    .demandCommand(1, "Pick a command: login | rooms | send | read")
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
