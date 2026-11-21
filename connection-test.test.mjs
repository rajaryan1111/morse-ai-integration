import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./connection-test.mjs", import.meta.url));

function runSimulation(mode) {
  return spawnSync(process.execPath, [script, mode], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, MORSE_API_KEY: "" },
  });
}

test("successful HTTP acceptance exits zero and reports only safe metadata", () => {
  const result = runSimulation("--simulate-success");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, output);
  assert.match(output, /"status":200,"accepted":true/);
  assert.match(output, /"x-request-id":"simulated-acceptance"/);
  assert.match(output, /Morse returned a successful OTLP HTTP response/);
  assert.doesNotMatch(output, /Authorization|mhq_[A-Za-z0-9_-]{8,}/i);
});

test("HTTP rejection exits nonzero and reports the request ID", () => {
  const result = runSimulation("--simulate-rejection");
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, output);
  assert.match(output, /"status":401,"accepted":false/);
  assert.match(output, /"request_id":"simulated-rejection"/);
  assert.doesNotMatch(output, /Authorization|mhq_[A-Za-z0-9_-]{8,}/i);
});
