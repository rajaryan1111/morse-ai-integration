import { channel } from "node:diagnostics_channel";
import { createServer } from "node:http";

const simulateRejection = process.argv.includes("--simulate-rejection");
const simulateSuccess = process.argv.includes("--simulate-success");
const simulateResponse = simulateRejection || simulateSuccess;
const traceStatuses = [];
const requestIdHeaders = ["x-request-id", "request-id", "trace-id", "cf-ray"];
let mockServer;
let observedHost = "api.morseai.dev";

// Observe only response status and allowlisted request IDs. Never inspect
// request headers, request bodies, or response bodies.
channel("http.client.response.finish").subscribe(({ request, response }) => {
  const host = String(request?.host ?? "").split(":")[0];
  const path = String(request?.path ?? "").split("?")[0];
  if (host !== observedHost || !path.endsWith("/api/v1/otlp/v1/traces")) return;
  const requestIds = Object.fromEntries(
    requestIdHeaders
      .map((name) => [name, response?.headers?.[name]])
      .filter(([, value]) => typeof value === "string"),
  );
  const diagnostic = {
    event: "morse_http_response",
    path,
    status: response?.statusCode,
    accepted: response?.statusCode >= 200 && response?.statusCode < 300,
    ...requestIds,
  };
  traceStatuses.push(diagnostic);
  console.info(JSON.stringify(diagnostic));
});
channel("http.client.request.error").subscribe(({ request, error }) => {
  const host = String(request?.host ?? "").split(":")[0];
  const path = String(request?.path ?? "").split("?")[0];
  if (host !== observedHost || !path.endsWith("/api/v1/otlp/v1/traces")) return;
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : undefined;
  const diagnostic = {
    event: "morse_http_error",
    path,
    error: error?.name === "AbortError" ? "request_timeout" : "request_failed",
    ...(code ? { code } : {}),
  };
  traceStatuses.push(diagnostic);
  console.error(JSON.stringify(diagnostic));
});

if (!simulateResponse && !process.env.MORSE_API_KEY?.trim()) {
  throw new Error("MORSE_API_KEY is not set in this process; no key value was read or printed.");
}

if (simulateResponse) {
  mockServer = createServer((request, response) => {
    request.resume();
    response.writeHead(simulateRejection ? 401 : 200, {
      "x-request-id": simulateRejection ? "simulated-rejection" : "simulated-acceptance",
    });
    response.end();
  });
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const { port } = mockServer.address();
  process.env.MORSE_ENDPOINT = `http://127.0.0.1:${port}`;
  observedHost = "127.0.0.1";
} else if (process.env.MORSE_ENDPOINT) {
  try {
    observedHost = new URL(process.env.MORSE_ENDPOINT).hostname;
  } catch {
    // Leave the default host filter in place; the SDK reports bad endpoints.
  }
}

// Subscribe before loading the SDK so the exporter request is observed.
const morse = await import("@morsehq-dev/sdk");
morse.init(simulateResponse
  ? { apiKey: `mhq_local_error_test_${"0".repeat(64)}` }
  : undefined);

await morse.run(
  { agentName: "morse-delivery-verification" },
  async (handle) => {
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
  },
);

await morse.flush();

const accepted = traceStatuses.some(({ accepted: wasAccepted, path }) =>
  wasAccepted && path.endsWith("/api/v1/otlp/v1/traces"),
);
if (mockServer) await new Promise((resolve) => mockServer.close(resolve));

if (!accepted) {
  const last = traceStatuses.at(-1);
  const requestId = last?.["x-request-id"] ?? last?.["request-id"] ??
    last?.["trace-id"] ?? last?.["cf-ray"];
  console.error(JSON.stringify({
    event: "morse_delivery_unconfirmed",
    reason: last
      ? last.status === undefined ? last.error : `HTTP ${last.status}`
      : "no Morse HTTP response was observed",
    ...(requestId ? { request_id: requestId } : {}),
  }));
  process.exitCode = 1;
} else {
  console.info("Morse returned a successful OTLP HTTP response; check the dashboard for visibility.");
}
