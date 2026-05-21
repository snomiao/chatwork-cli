import { getMe } from "../api.ts";
import { writeConfig } from "../config.ts";

async function readTokenFromStdin(): Promise<string> {
  process.stdout.write("Paste Chatwork API token (https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php): ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function cmdLogin(opts: { token?: string | undefined }): Promise<void> {
  const token = opts.token ?? (await readTokenFromStdin());
  if (!token) {
    console.error("Empty token. Aborting.");
    process.exitCode = 1;
    return;
  }
  const me = await getMe(token);
  writeConfig({ token, account_id: me.account_id, name: me.name });
  console.log(`✓ logged in as ${me.name} (account_id=${me.account_id})`);
}
