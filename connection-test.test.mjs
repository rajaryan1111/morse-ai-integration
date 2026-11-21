import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./connection-test.mjs", import.meta.url));
const sensitiveMarkers = [
  "mhq_local_test_",
  "Authorization",
  "synthetic-endpoint-query-marker",
  "synthetic-response-body-marker",
  "synthetic-request-body-marker",
];

function runSimulation(mode, { timeout = 12_000, env = {} } = {}) {
  const childEnv = { ...process.env, MORSE_API_KEY: "", MORSE_SDK_DEBUG: "1", ...env };
  for (const name of ["MORSE_DISABLED", "MORSE_ENDPOINT", "MORSE_SDK_DISABLE_TELEMETRY"]) {
    delete childEnv[name];
  }
  return spawnSync(process.execPath, [script, mode], {
    encoding: "utf8",
    timeout,
    env: childEnv,
  });
}

function outputOf(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function assertOutputIsSanitized(output) {
  for (const marker of sensitiveMarkers) assert.doesNotMatch(output, new RegExp(marker, "i"));
  assert.doesNotMatch(output, /https?:\/\/[^\s"']+\?/i);
  assert.doesNotMatch(output, /Bearer\s+[A-Za-z0-9._-]+/i);
}

test("HTTP 200 and 202 are accepted and report the matching request ID", async (t) => {
  for (const [mode, status] of [["--simulate-success", 200], ["--simulate-accepted", 202]]) {
    await t.test(String(status), () => {
      const result = runSimulation(mode);
      const output = outputOf(result);
      assert.equal(result.error, undefined, output);
      assert.equal(result.status, 0, output);
      assert.match(output, new RegExp(`"status":${status},"accepted":true`));
      assert.match(output, /"x-request-id":"simulated-attempt-1"/);
      assert.match(output, /Morse returned a successful OTLP HTTP response/);
      assertOutputIsSanitized(output);
    });
  }
});

test("HTTP 400, 401, and 403 rejections exit nonzero", async (t) => {
  for (const status of [400, 401, 403]) {
    await t.test(String(status), () => {
      const result = runSimulation(`--simulate-status=${status}`);
      const output = outputOf(result);
      assert.equal(result.error, undefined, output);
      assert.equal(result.status, 1, output);
      assert.match(output, new RegExp(`"status":${status},"accepted":false`));
      assert.match(output, /"request_id":"simulated-attempt-1"/);
      assert.doesNotMatch(output, /Morse returned a successful/);
      assertOutputIsSanitized(output);
    });
  }
});

test("a retryable 503 followed by 200 succeeds using the final attempt", () => {
  const result = runSimulation("--simulate-retry", { timeout: 15_000 });
  const output = outputOf(result);
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 0, output);
  assert.match(output, /"status":503,"accepted":false/);
  assert.match(output, /"status":200,"accepted":true/);
  assert.match(output, /"x-request-id":"simulated-attempt-2"/);
  assertOutputIsSanitized(output);
});

test("a later failed export cannot be masked by an earlier 200", () => {
  const result = runSimulation("--simulate-second-export-fails", { timeout: 15_000 });
  const output = outputOf(result);
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /"status":200,"accepted":true/);
  assert.match(output, /"status":401,"accepted":false/);
  assert.match(output, /"event":"morse_delivery_unconfirmed"/);
  assertOutputIsSanitized(output);
});

test("an unrelated 200 response cannot satisfy the OTLP acceptance check", () => {
  const result = runSimulation("--simulate-unrelated-then-reject");
  const output = outputOf(result);
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /"status":401,"accepted":false/);
  assert.doesNotMatch(output, /unrelated-request-id/);
  assert.match(output, /"request_id":"simulated-attempt-1"/);
  assertOutputIsSanitized(output);
});

test("credential-shaped request IDs are omitted", () => {
  const result = runSimulation("--simulate-secret-request-id");
  const output = outputOf(result);
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 0, output);
  assert.match(output, /"status":200,"accepted":true/);
  assert.doesNotMatch(output, /"x-request-id"/);
  assertOutputIsSanitized(output);
});

test("connection refusal reports a sanitized network failure and exits nonzero", () => {
  const result = runSimulation("--simulate-connection-refused");
  const output = outputOf(result);
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /"event":"morse_http_error"/);
  assert.match(output, /"error":"request_failed"/);
  assert.match(output, /"code":"ECONNREFUSED"/);
  assert.doesNotMatch(output, /"status":\d+/);
  assertOutputIsSanitized(output);
});

test("request timeout reports no acceptance and exits nonzero", { timeout: 15_000 }, () => {
  const result = runSimulation("--simulate-timeout", { timeout: 14_000 });
  const output = outputOf(result);
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /"error":"request_timeout"/);
  assert.match(output, /"event":"morse_delivery_unconfirmed"/);
  assert.doesNotMatch(output, /"status":\d+/);
  assertOutputIsSanitized(output);
});
