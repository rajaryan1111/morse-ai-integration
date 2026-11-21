# Morse AI SDK delivery evaluation

A minimal Node.js integration check for `@morsehq-dev/sdk@0.8.0`. It records a
deterministic agent run with a child tool span and a checked outcome, flushes
the SDK, and verifies the HTTP status returned by Morse's OTLP trace endpoint.
It uses no model provider or provider API key.

## Prerequisites and installation

- Node.js 18.19+ or 20.6+ (verified here with Node 24.10.0)
- npm
- A Morse API key for the real integration run

```sh
npm ci
```

`npm ci` installs the pinned lockfile dependencies; no extra test framework or
runtime dependency is required.

## Configure credentials securely

Set `MORSE_API_KEY` in the shell using your secret manager or enter it at a
hidden prompt. Do not put the key in source, a command argument, or a log.

```sh
read -s "MORSE_API_KEY?Morse API key: "
export MORSE_API_KEY
printf '\n'
```

The SDK reads this variable during `morse.init()`. `.gitignore` excludes
`.env` and `.env.*`; `.env.example` is only a blank `MORSE_API_KEY=` placeholder.
The integration does not load or print `.env`.

## Run the integration

```sh
npm run verify
```

The script runs `morse.run({ agentName: "morse-delivery-verification" })`,
records a local deterministic tool span, and reports a success outcome only
when the check returns 42. It calls `await morse.flush()` and watches Node's
HTTP response diagnostics channel. It prints only the trace endpoint path,
HTTP status, allowlisted request ID headers, and sanitized network error
categories. It never reads/logs request headers, request payloads, or response
bodies. It exits nonzero if the OTLP trace request has no observed 2xx response.
Even with an HTTP 2xx response, dashboard visibility is a separate check.

Remove the key from the current shell when finished:

```sh
unset MORSE_API_KEY
```

## Tests

```sh
npm test
```

The built-in Node test runner exercises two local HTTP cases without using a
real key or contacting Morse:

- Synthetic HTTP 200: expects exit code 0, an accepted status, and the synthetic
  request ID.
- Synthetic HTTP 401: expects exit code 1, a rejected status, and the synthetic
  request ID.

`node --check connection-test.mjs` checks script syntax. To run either test
case directly, use `node connection-test.mjs --simulate-success` or
`node connection-test.mjs --simulate-rejection`. The rejection command's
nonzero exit is expected.

## Architecture and findings

- SDK docs support `init()`, `run({ agentName }, callback)`, `spanAsync(...)`,
  `handle.setOutcome(...)`, and `await flush()`.
- The SDK README and installed package confirm `run()` emits OpenTelemetry
  spans over OTLP. The SDK's startup line prints a batch URL ending in
  `/api/v1/traces/batch`, but it derives the OTLP trace request URL as
  `/api/v1/otlp/v1/traces`. The batch URL is not the actual trace request for
  `run()`.
- The OTLP request uses `Authorization: Bearer <key>` and protobuf with gzip
  compression. The credentials are supplied by the SDK; this integration does
  not construct or expose the auth header.
- In SDK 0.8.0, `flush()` awaits the OpenTelemetry provider's force flush, but
  export failures are absorbed and the function returns no acceptance result.
  A local “flush completed” message cannot establish server acceptance.
- The SDK retries retryable failures. Its normal error reporting is deliberately
  best effort; the response observer gives this short script explicit status
  evidence and exits unsuccessfully on missing or rejected trace responses.
- A bare run with no child span or outcome is less informative and may be
  marked low-signal. Morse's current dashboard says low-signal rows are shown
  while the workspace is getting set up, then can be hidden after enough AI
  runs. This evaluation includes a child tool span and outcome.

The dashboard also contained the earlier `connection-test` run: one entry was
513 ms at 5:40 PM, matching the original script's 500 ms delay, and two older
6 ms entries were labeled low-signal. This confirms the baseline was reaching
the selected workspace. The reported “not visible” symptom was therefore not
reproduced as an ingest failure; a different workspace, time range, filter, or
hidden low-signal view can explain the display discrepancy, but the original
browser state was not captured, so its exact UI cause cannot be proven.

Official references: [Installation](https://docs.morseai.dev/sdk/installation),
[Quickstart](https://docs.morseai.dev/start/quickstart),
[SDK overview](https://docs.morseai.dev/sdk/overview), and
[Self-diagnostics](https://docs.morseai.dev/sdk/self-diagnostics).

## Verification record

The authenticated run reported by the operator returned **HTTP 200** from
`/api/v1/otlp/v1/traces` with request ID
`0acffce3-18ff-47ff-923a-d926d0ea9292`. HTTP 200 establishes HTTP-level
acceptance. In the authenticated Morse **Default Workspace**, the Traces view
and detail panel showed:

- Agent: `morse-delivery-verification`
- Trace ID: `832e2207-f14b-000d-ada8-de885af9881f`
- Outcome: `deterministic_check_passed` (Succeeded, reported by SDK run)
- Spans: 2 total, including `verify-deterministic-operation` (`tool`)
- Revision displayed by Morse: `65b160d`

Thus dashboard visibility is confirmed for the authenticated run. The Traces
page showed low-signal traces while the workspace was getting set up. Older
`connection-test` entries were also present; at least two were explicitly
marked low-signal. If a future trace is absent, verify the selected workspace,
time range, filters, and the **Show them** control for hidden low-signal runs.

The real authenticated result above is recorded from the operator-provided test
result and the live dashboard inspection. This checkout's process did not have
`MORSE_API_KEY`, so the authenticated request was not repeated during the final
local audit. No `.env` file was read or copied.

## Troubleshooting and limits

- **Missing key:** export `MORSE_API_KEY` in the same shell that runs `npm run
  verify`; the script stops before initializing the SDK if it is absent.
- **HTTP 401/403:** verify that the key is active and belongs to the intended
  Morse environment. The script reports status and request ID only.
- **No HTTP response / network failure:** check outbound HTTPS access and any
  configured `MORSE_ENDPOINT`; only sanitized failure category and error code
  are reported.
- **2xx but no visible row:** confirm workspace and time range, clear filters,
  and reveal hidden low-signal traces. Use the request ID with Morse support if
  the trace still does not appear.
- HTTP 2xx confirms acceptance at the HTTP layer; it does not promise indexing
  latency or explain downstream dashboard filtering.

## Security review

- No credential or request/response body is printed by the integration.
- `.env` and `.env.*` are ignored; the blank `.env.example` is intentionally
  tracked.
- Tests use only a synthetic local key and loopback HTTP server.
- The commit contains only `README.md`, `connection-test.mjs`, and
  `connection-test.test.mjs` plus the package script update in `package.json`;
  no secret files or generated dependencies are part of the branch.
