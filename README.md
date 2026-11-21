# Morse delivery verification

This repository contains a small Node.js integration check for
`@morsehq-dev/sdk@0.8.0`. It creates a named agent trace with a child tool span
and a checked outcome, then records the HTTP result returned by Morse's OTLP
ingest endpoint.

## Findings

- `connection-test.mjs` is an ESM module (`.mjs`), so its top-level `await` and
  `import` work even though `package.json` does not set `type: "module"`.
- The SDK README documents `init()`, `run({ agentName }, callback)`,
  `spanAsync(...)`, `handle.setOutcome(...)` and `await flush()`.
- In SDK 0.8.0, `run()`/`span()` traces go through OpenTelemetry OTLP. The SDK
  prints the configured legacy batch URL (`/api/v1/traces/batch`) but derives
  the actual OTLP URL as `/api/v1/otlp/v1/traces`. It sends
  `Authorization: Bearer <key>` and gzipped protobuf. Do not send an OTLP
  protobuf trace to the batch JSON endpoint.
- `flush()` calls the OTel provider's `forceFlush()`. The SDK catches export
  failures and returns `undefined`; it does not expose HTTP status or confirm
  that Morse accepted the spans. A resolved `flush()` alone is not proof of
  delivery.
- The OTLP exporter retries retryable failures. Non-retryable responses fail
  export. The public `flush()` absorbs the resulting error, so the test uses
  Node's `http.client.response.finish` diagnostics channel to report status and
  allowlisted request ID headers. It never inspects or logs the authorization
  header, request body, or response body. SDK self-diagnostics may also report
  sanitized internal failures.
- A bare run can be classified as low-signal and hidden by the dashboard's
  Traces filter. Morse's current quickstart says to click **Show them** when
  low-signal traces are hidden. The test adds a child tool span and a real
  checked outcome to make the trace more informative, but it does not create a
  model call or cost.

The original `connection-test.mjs` ran a nameless-duration no-op callback and
printed “Morse flush completed” regardless of server outcome. That message was
only local progress. The code and package files were inspected at SDK version
0.8.0; see the official [installation](https://docs.morseai.dev/sdk/installation),
[quickstart](https://docs.morseai.dev/start/quickstart),
[overview](https://docs.morseai.dev/sdk/overview), and
[self-diagnostics](https://docs.morseai.dev/sdk/self-diagnostics) docs.

## Run

Provide `MORSE_API_KEY` in the current shell using your normal secret manager or
local environment setup. Do not paste it into a command, source file, or log.

```sh
npm ci
node connection-test.mjs
```

The command exits successfully only after it observes a successful HTTP
response for the OTLP trace export. It prints the HTTP status and, when
available, request ID headers. It never prints payloads or credentials. Then
open **Traces** in the Morse dashboard and search for
`morse-delivery-verification`; if the dashboard reports hidden low-signal
traces, click **Show them**.

To exercise the non-success path without using a real key or contacting Morse:

```sh
node connection-test.mjs --simulate-rejection
```

This redirects the SDK to a local HTTP server that returns a synthetic 401. The
expected result is a sanitized status/request-ID report and exit code 1. It
does not validate a real credential, endpoint, server acceptance, or dashboard
visibility.

## Verification limits

This checkout did not have `MORSE_API_KEY` in its process environment, and the
working folder is a fresh clone of the public repository. No `.env` file was
read or copied. Therefore the real authenticated request and dashboard lookup
could not be run here. A 2xx response proves the server accepted the OTLP
request at the HTTP layer; it does not independently prove how soon the trace
appears in the dashboard. If the integration reports 2xx but the trace is
missing after checking **Show them**, use the printed request ID with Morse
support to distinguish ingest/indexing issues from a workspace/filter issue.
