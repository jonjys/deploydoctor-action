import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scan = fileURLToPath(new URL("./scan.mjs", import.meta.url));

function run(status, data, paid = false, extraEnv = {}) {
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
      DD_FAIL_ON_HIGH_RISK: "false",
      GITHUB_OUTPUT: "",
      GITHUB_STEP_SUMMARY: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/?request=fixture",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
      ...extraEnv,
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
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::DeployDoctor returned 429/);
    assert.doesNotMatch(result.stdout, /free scan|::error::/);
    const gated = run(429, data, false, { DD_FAIL_ON_HIGH_RISK: "true" });
    assert.equal(gated.status, 1, gated.stderr);
    assert.match(gated.stdout, /::error::DeployDoctor returned 429/);
  }
});

test("payment and capacity failures pass unless fail-on-high-risk is set", () => {
  for (const status of [401, 402, 429]) {
    const result = run(status, { paywall: true, error: "Rejected" }, true);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`::warning::DeployDoctor returned ${status}`));
    const gated = run(status, { paywall: true, error: "Rejected" }, true, { DD_FAIL_ON_HIGH_RISK: "true" });
    assert.equal(gated.status, 1, gated.stderr);
    assert.match(gated.stdout, new RegExp(`::error::DeployDoctor returned ${status}`));
  }
});

test("the default reports high-risk findings without failing the job", () => {
  const data = { overall: "red", ref: "a".repeat(40), url: "https://deploydoctor.example/r/fixture", summary: { red: 1, yellow: 0, green: 0 }, checks: [] };
  const reported = run(201, data, false, { DD_FAIL_ON: "never" });
  assert.equal(reported.status, 0, reported.stderr);
  assert.match(reported.stdout, /https:\/\/deploydoctor\.example\/r\/fixture/);
  const blank = run(201, data, false, { DD_FAIL_ON: "", DD_FAIL_ON_HIGH_RISK: "" });
  assert.equal(blank.status, 0, blank.stderr);
  const gated = run(201, data, false, { DD_FAIL_ON: "never", DD_FAIL_ON_HIGH_RISK: "true" });
  assert.equal(gated.status, 1, gated.stderr);
  assert.match(gated.stdout, /::error::DeployDoctor found 1 failed/);
});

test("a scanner outage or unreadable response passes unless fail-on-high-risk is set", () => {
  for (const [flag, status] of [["false", 0], ["true", 1]]) {
    const mock = `globalThis.fetch = async (url) => { if (String(url).startsWith("https://oidc.example/")) return Response.json({value:"fixture-oidc"}); throw new Error("network down"); };`;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, scan], {
      encoding: "utf8",
      env: { ...process.env, DD_REPOSITORY: "acme/site", DD_REF: "a".repeat(40), DD_API_URL: "https://deploydoctor.example", DD_TOKEN: "", DD_GITHUB_TOKEN: "", DD_FAIL_ON: "never", DD_FAIL_ON_HIGH_RISK: flag, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/?request=fixture", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token" },
      timeout: 10_000,
    });
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stdout, /network down/);
  }
  const html = `globalThis.fetch = async (url) => { if (String(url).startsWith("https://oidc.example/")) return Response.json({value:"fixture-oidc"}); return new Response("<html>", {status:502}); };`;
  const unreadable = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(html)}`, scan], {
    encoding: "utf8",
    env: { ...process.env, DD_REPOSITORY: "acme/site", DD_REF: "a".repeat(40), DD_API_URL: "https://deploydoctor.example", DD_TOKEN: "", DD_GITHUB_TOKEN: "", DD_FAIL_ON: "red", DD_FAIL_ON_HIGH_RISK: "false", GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/?request=fixture", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token" },
    timeout: 10_000,
  });
  assert.equal(unreadable.status, 0, unreadable.stderr);
  assert.match(unreadable.stdout, /::warning::DeployDoctor returned 502: the response was not JSON/);
});

test("fail-on-high-risk only accepts true or false", () => {
  const result = run(201, { overall: "green", summary: { red: 0, yellow: 0, green: 1 }, url: "https://deploydoctor.example/r/fixture", checks: [] }, false, { DD_FAIL_ON_HIGH_RISK: "yes" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /fail-on-high-risk/);
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

test("mixed production findings keep review annotations as warnings", () => {
  const result = run(201, {overall:"red",summary:{red:1,yellow:0,green:0},url:"https://deploydoctor.example/r/report",checks:[{id:"production-safety",title:"Production safety",status:"red",explanation:"Source risks",fix:"Review",findings:[{file:"app/a.ts",line:1,status:"red",problem:"Invalid runtime",fix:"Use nodejs"},{file:"app/b.ts",line:2,status:"yellow",problem:"Review payment redirect",fix:"Confirm production URL"}]}]});
  assert.equal(result.status,1);assert.match(result.stdout,/::error file=app\/a.ts,line=1,/);assert.match(result.stdout,/::warning file=app\/b.ts,line=2,/);assert.doesNotMatch(result.stdout,/::error file=app\/b.ts/);
});
