import { describe, expect, test } from "bun:test";
import { parseTokenFromHtml, cookieHeader, type DecryptedCookie } from "../ts/chrome.ts";

describe("parseTokenFromHtml", () => {
  test("extracts the 32-hex API token from the token.php input", () => {
    const html = `
<div class="displayApiToken">
  <form name="api_token" method="POST">
    <input name="token" type="text" id="token" readonly="readonly" class="inputLong" value="3b952aca57531582a6883dbbaf530847" />
    <input type="hidden" name="ecf_security_token_api_token" value="55edf34a4bf81fc484c72df30c8fc9815107109d">
  </form>
</div>`;
    expect(parseTokenFromHtml(html)).toBe("3b952aca57531582a6883dbbaf530847");
  });

  test("returns null when no token input is present", () => {
    expect(parseTokenFromHtml("<html>no token here</html>")).toBeNull();
  });

  test("does not pick the CSRF token hidden input (different name)", () => {
    const html = `<input name="ecf_security_token_api_token" value="deadbeef0123456789abcdef0123456789abcdef">`;
    expect(parseTokenFromHtml(html)).toBeNull();
  });
});

describe("cookieHeader", () => {
  const cookies: DecryptedCookie[] = [
    { host: ".chatwork.com", name: "_td", value: "abc", path: "/", expiresUtc: 0, isSecure: true },
    { host: "www.chatwork.com", name: "auto_logindefault", value: "xyz", path: "/", expiresUtc: 0, isSecure: true },
    { host: "auth.chatwork.com", name: "auth0", value: "sess", path: "/", expiresUtc: 0, isSecure: true },
    { host: "example.com", name: "unrelated", value: "no", path: "/", expiresUtc: 0, isSecure: true },
  ];

  test("includes wildcard and host-matching cookies for www.chatwork.com", () => {
    const header = cookieHeader(cookies, "https://www.chatwork.com/x");
    expect(header).toContain("_td=abc");
    expect(header).toContain("auto_logindefault=xyz");
    expect(header).not.toContain("auth0=sess");
    expect(header).not.toContain("unrelated");
  });

  test("includes wildcard and host-matching cookies for auth.chatwork.com", () => {
    const header = cookieHeader(cookies, "https://auth.chatwork.com/y");
    expect(header).toContain("_td=abc");
    expect(header).toContain("auth0=sess");
    expect(header).not.toContain("auto_logindefault");
  });

  test("returns empty string when nothing matches", () => {
    expect(cookieHeader(cookies, "https://other.example/")).toBe("");
  });
});
