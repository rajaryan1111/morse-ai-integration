import { channel } from "node:diagnostics_channel";
import { createServer, get as httpGet } from "node:http";

const simulationMode = process.argv.find((argument) => argument.startsWith("--simulate-"));
const isSimulation = Boolean(simulationMode);
const otlpPath = "/api/v1/otlp/v1/traces";
const responseEvents = [];
const requestIds = ["x-request-id", "request-id", "trace-id", "cf-ray"];
const requestStartTimes = new WeakMap();
let mockServer;
let observedHost = configuredEndpointHost();

function configuredEndpointHost() {
  try {
    return new URL(process.env.MORSE_ENDPOINT ?? "https://api.morseai.dev").hostname;
  } catch {
    return "api.morseai.dev";
  }
}

function isOtlpRequest(request) {
  let host;
  try {
    host = new URL(`http://${request?.host ?? ""}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  const path = String(request?.path ?? "").split("?", 1)[0];
  return host === observedHost && path === otlpPath;
}

function safeRequestId(value) {
  return typeof value === "string" && value.length <= 128 &&
    /^[A-Za-z0-9._:/+=-]+$/.test(value) &&
    !/^(?:mhq_|sk[-_]|gh[pousr]_|xox[baprs]-|akia[0-9a-z]{16}|eyj[a-z0-9_-]{8,}\.)/i.test(value)
    ? value
    : undefined;
}

const onRequestStart = ({ request }) => {
  requestStartTimes.set(request, Date.now());
};
const onResponse = ({ request, response }) => {
  if (!isOtlpRequest(request)) return;
  const diagnostic = {
    event: "morse_http_response",
    path: otlpPath,
    status: response?.statusCode,
    accepted: response?.statusCode >= 200 && response?.statusCode < 300,
  };
  for (const name of requestIds) {
    const value = safeRequestId(response?.headers?.[name]);
    if (value) diagnostic[name] = value;
  }
  responseEvents.push(diagnostic);
};
const onRequestError = ({ request, error }) => {
  if (!isOtlpRequest(request)) return;
  const rawCode = error?.code;
  const code = typeof rawCode === "string" && rawCode.length <= 64 && /^[A-Z0-9_]+$/.test(rawCode)
    ? rawCode
    : undefined;
  const elapsedMs = Date.now() - (requestStartTimes.get(request) ?? Date.now());
  const timedOut = error?.name === "AbortError" || code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" || elapsedMs >= 3_500;
  responseEvents.push({
    event: "morse_http_error",
    path: otlpPath,
    error: timedOut ? "request_timeout" : "request_failed",
    ...(code ? { code } : {}),
  });
};

const requestStartChannel = channel("http.client.request.start");
const responseChannel = channel("http.client.response.finish");
const requestErrorChannel = channel("http.client.request.error");
requestStartChannel.subscribe(onRequestStart);
responseChannel.subscribe(onResponse);
requestErrorChannel.subscribe(onRequestError);

if (!isSimulation && !process.env.MORSE_API_KEY?.trim()) {
  throw new Error("MORSE_API_KEY is not set in this process; no key value was read or printed.");
}

if (isSimulation) {
  const statusSequence = simulationMode === "--simulate-retry"
    ? [503, 200]
    : simulationMode === "--simulate-second-export-fails"
      ? [200, 401]
    : [Number(simulationMode.match(/--simulate-status=(\d{3})/)?.[1]) ||
      (simulationMode === "--simulate-success" ? 200 :
        simulationMode === "--simulate-accepted" ? 202 :
          simulationMode === "--simulate-secret-request-id" ? 200 : 401)];
  let requestCount = 0;
  mockServer = createServer((request, response) => {
    request.resume();
    if (simulationMode === "--simulate-unrelated-then-reject" && request.url === "/unrelated") {
      response.writeHead(200, { "x-request-id": "unrelated-request-id" });
      response.end("synthetic-response-body-marker");
      return;
    }
    if (simulationMode === "--simulate-timeout" && request.url === otlpPath) return;
    const status = statusSequence[Math.min(requestCount, statusSequence.length - 1)];
    requestCount += 1;
    const requestId = simulationMode === "--simulate-secret-request-id"
      ? `mhq_${"0".repeat(64)}`
      : `simulated-attempt-${requestCount}`;
    response.writeHead(status, { "x-request-id": requestId });
    response.end("synthetic-response-body-marker");
  });
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const { port } = mockServer.address();
  observedHost = "127.0.0.1";
  process.env.MORSE_ENDPOINT = `http://127.0.0.1:${port}/?synthetic-endpoint-query-marker`;

  if (simulationMode === "--simulate-connection-refused") {
    await new Promise((resolve, reject) => mockServer.close((error) => error ? reject(error) : resolve()));
    mockServer = null;
  }
}

const originalConsole = Object.fromEntries(
  ["debug", "info", "log", "warn", "error"].map((method) => [method, console[method]]),
);
for (const method of Object.keys(originalConsole)) {
  console[method] = () => {};
}

let morse;
let runError;
try {
  // Load after installing the HTTP listeners; the SDK's OTLP transport uses node:http(s).
  morse = await import("@morsehq-dev/sdk");
  morse.init(isSimulation
    ? { apiKey: `mhq_local_test_${"0".repeat(64)}` }
    : undefined);

  if (simulationMode === "--simulate-unrelated-then-reject") {
    await new Promise((resolve, reject) => {
      const request = httpGet(`http://127.0.0.1:${mockServer.address().port}/unrelated`, (response) => {
        response.resume();
        response.on("end", resolve);
      });
      request.on("error", reject);
    });
  }

  try {
    await morse.run({ agentName: "morse-delivery-verification" }, async (handle) => {
      if (isSimulation) {
        morse.setContext({ test_marker: "synthetic-request-body-marker" });
      }
      const result = await morse.spanAsync(
        { name: "verify-deterministic-operation", type: "tool" },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return 6 * 7;
        },
      );
      const succeeded = result === 42;
      handle.setOutcome(succeeded, succeeded ? "deterministic_check_passed" : "deterministic_check_failed");
      if (!succeeded) throw new Error("The deterministic verification operation failed.");
    });
    if (simulationMode === "--simulate-second-export-fails") {
      await morse.flush();
      await morse.run({ agentName: "morse-secondary-test-run" }, async () => {});
    }
  } catch {
    runError = true;
  }

  await morse.flush();
  await morse.shutdown();
} catch {
  runError = true;
} finally {
  requestStartChannel.unsubscribe(onRequestStart);
  responseChannel.unsubscribe(onResponse);
  requestErrorChannel.unsubscribe(onRequestError);
  if (mockServer) {
    mockServer.closeAllConnections();
    await new Promise((resolve) => mockServer.close(() => resolve()));
  }
  for (const [method, original] of Object.entries(originalConsole)) {
    console[method] = original;
  }
}

for (const event of responseEvents) {
  const output = JSON.stringify(event);
  if (event.event === "morse_http_response") console.info(output);
  else console.error(output);
}

const finalAttempt = responseEvents.at(-1);
const deliveryAccepted = finalAttempt?.event === "morse_http_response" && finalAttempt.accepted;
if (!deliveryAccepted) {
  const requestId = finalAttempt?.["x-request-id"] ?? finalAttempt?.["request-id"] ??
    finalAttempt?.["trace-id"] ?? finalAttempt?.["cf-ray"];
  console.error(JSON.stringify({
    event: "morse_delivery_unconfirmed",
    reason: finalAttempt
      ? finalAttempt.status === undefined ? finalAttempt.error : `HTTP ${finalAttempt.status}`
      : "no Morse OTLP response was observed",
    ...(requestId ? { request_id: requestId } : {}),
  }));
  process.exitCode = 1;
} else if (runError) {
  console.error(JSON.stringify({ event: "morse_run_failed", reason: "run_or_export_failed" }));
  process.exitCode = 1;
} else {
  console.info("Morse returned a successful OTLP HTTP response; check the dashboard for visibility.");
}
