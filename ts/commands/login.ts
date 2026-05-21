import { createInterface } from "node:readline/promises";
import { getMe } from "../api.ts";
import { writeConfig } from "../config.ts";
import {
  listChromeProfiles,
  readCookiesForDomain,
  cookieHeader,
  parseTokenFromHtml,
  type ChromeProfile,
} from "../chrome.ts";

const TOKEN_URL =
  "https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php";

async function readTokenFromStdin(): Promise<string> {
  process.stdout.write(
    "Paste Chatwork API token (https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php): ",
  );
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function selectChromeProfile(): Promise<ChromeProfile> {
  const profiles = listChromeProfiles();
  if (profiles.length === 0) {
    throw new Error("No Chrome profiles found.");
  }
  console.log("Chrome profiles:");
  for (const [i, p] of profiles.entries()) {
    const email = p.userEmail ? ` <${p.userEmail}>` : "";
    console.log(`  [${i}] ${p.dir.padEnd(12)} ${p.displayName}${email}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Pick a profile [0]: ")).trim();
  rl.close();
  const idx = answer === "" ? 0 : Number(answer);
  if (!Number.isInteger(idx) || idx < 0 || idx >= profiles.length) {
    throw new Error(`Invalid selection: ${answer}`);
  }
  return profiles[idx]!;
}

async function fetchTokenViaChrome(): Promise<string> {
  const profile = await selectChromeProfile();
  const cookies = readCookiesForDomain(profile, "chatwork.com");
  if (cookies.length === 0) {
    throw new Error(
      `No chatwork.com cookies in profile ${profile.dir}. Sign in to Chatwork in that profile first.`,
    );
  }
  const res = await fetch(TOKEN_URL, {
    headers: {
      cookie: cookieHeader(cookies, TOKEN_URL),
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "accept-language": "ja,en;q=0.8",
    },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `Chatwork session in profile ${profile.dir} is expired (got ${res.status} → ${res.headers.get("location") ?? "?"}). Re-login in Chrome.`,
    );
  }
  if (!res.ok) {
    throw new Error(`token.php returned HTTP ${res.status}`);
  }
  const token = parseTokenFromHtml(await res.text());
  if (!token) {
    throw new Error(
      `Could not find an API token on token.php. Open ${TOKEN_URL} in Chrome and click 新規発行 first.`,
    );
  }
  return token;
}

export async function cmdLogin(opts: {
  token?: string | undefined;
  fromChrome?: boolean | undefined;
}): Promise<void> {
  let token: string;
  if (opts.token) {
    token = opts.token;
  } else if (opts.fromChrome) {
    token = await fetchTokenViaChrome();
  } else {
    token = await readTokenFromStdin();
  }
  if (!token) {
    console.error("Empty token. Aborting.");
    process.exitCode = 1;
    return;
  }
  const me = await getMe(token);
  writeConfig({ token, account_id: me.account_id, name: me.name });
  console.log(`✓ logged in as ${me.name} (account_id=${me.account_id})`);
}
