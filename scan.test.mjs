import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scan = fileURLToPath(new URL("./scan.mjs", import.meta.url));

function run(status, data, paid = false) {
  const mock = `globalThis.fetch = async (url) => String(url).startsWith("https://oidc.example/")
    ? Response.json({value:"fixture-oidc"})
    : Response.json(${JSON.stringify(data)}, {status:${status}});`;
  return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, scan], {
    encoding: "utf8",
    env: {
      ...process.env,
      DD_REPOSITORY: "acme/site",
      DD_REF: "a".repeat(40),
      DD_API_URL: "https://deploydoctor.example",
      DD_TOKEN: paid ? "fixture-api-token" : "",
      DD_GITHUB_TOKEN: "",
      DD_FAIL_ON: "red",
      GITHUB_OUTPUT: "",
      GITHUB_STEP_SUMMARY: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/?request=fixture",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
    },
    timeout: 10_000,
  });
}

test("free daily quota exhaustion warns without blocking the pull request", () => {
  const result = run(429, { paywall: true, error: "One free scan used" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning::/);
  assert.doesNotMatch(result.stdout, /::error::/);
});

test("GitHub rate limiting and capacity failures are not mistaken for a free quota", () => {
  for (const data of [{ error: "GitHub rate limit" }, { paywall: false, error: "Scanner busy" }]) {
    const result = run(429, data);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /::error::DeployDoctor returned 429/);
    assert.doesNotMatch(result.stdout, /::warning::/);
  }
});

test("paid requests cannot silently skip payment or capacity failures", () => {
  for (const status of [401, 402, 429]) {
    const result = run(status, { paywall: true, error: "Rejected" }, true);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, new RegExp(`::error::DeployDoctor returned ${status}`));
  }
});

test("successful scans still report results and red findings fail the job", () => {
  for (const red of [0, 1]) {
    const result = run(201, {
      overall: red ? "red" : "green", ref: "a".repeat(40),
      url: "https://deploydoctor.example/r/fixture",
      summary: { red, yellow: 0, green: 1 - red }, checks: [],
    });
    assert.equal(result.status, red, result.stderr);
    assert.match(result.stdout, /https:\/\/deploydoctor.example\/r\/fixture/);
  }
});
