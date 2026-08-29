# RelayFault design specification

Date: 2026-08-29

Status: Approved for implementation

## Purpose

RelayFault is a dependency-free Node.js command-line proxy that lets developers reproduce HTTP failure sequences against services running on their own machine. It is intended for testing retry policies, timeout budgets, idempotency, and fallback behavior without changing application code or relying on a hosted chaos platform.

## User-visible behavior

The command line has three operations:

1. `validate` checks a scenario file and reports specific schema errors.
2. `explain` prints the ordered rules and their effects without starting a server.
3. `serve` starts a loopback proxy, applies the scenario, exposes local runtime statistics, and optionally records newline-delimited JSON evidence.

A scenario contains ordered match rules. Each rule can match an HTTP method and path, then select request ordinals, a periodic cadence, or a seeded probability. The first active rule wins. Supported actions are:

- forward the request unchanged;
- delay, then forward;
- return a synthetic HTTP response;
- disconnect the client socket.

Rules count only requests that satisfy their method and path predicate. The same scenario and seed must produce the same action sequence.

## Safety boundaries

- The proxy listens on loopback by default.
- Upstream targets must resolve to a loopback hostname or address unless the user explicitly passes `--allow-remote-target`.
- Scenario files are data only. They cannot execute programs, import modules, interpolate environment variables, or write arbitrary files.
- Request bodies are bounded. Oversized bodies receive HTTP 413 and are not forwarded.
- Hop-by-hop headers are removed in both directions.
- The tool never retries a request itself because replaying non-idempotent requests would change application behavior.
- The internal status endpoint is local and read-only.

## Scenario format

```json
{
  "version": 1,
  "rules": [
    {
      "name": "first two payment attempts fail",
      "match": { "method": "POST", "path": "/payments" },
      "when": { "requests": [1, 2] },
      "action": {
        "type": "respond",
        "status": 503,
        "headers": { "retry-after": "1" },
        "body": "temporarily unavailable"
      }
    }
  ],
  "defaultAction": { "type": "forward" }
}
```

Paths are exact by default and may end in `*` for a prefix match. Method matching is case-insensitive. Probability values are in `[0, 1]` and use a seeded deterministic generator.

## Architecture

- `src/scenario.js` owns validation, compilation, rule counters, and deterministic action selection.
- `src/proxy.js` owns bounded request collection, HTTP forwarding, fault execution, statistics, and event recording.
- `src/cli.js` owns argument parsing, readable errors, startup, and graceful shutdown.
- `examples/` provides a runnable upstream and scenario.
- Native `node:test` coverage exercises the rule engine and real ephemeral HTTP servers.

## Evidence and acceptance criteria

- Invalid scenarios fail with actionable messages and a nonzero exit code.
- Ordered ordinal, cadence, and seeded probability behavior is deterministic in tests.
- Real proxy tests cover forwarding, synthetic responses, delay, disconnection, body limits, status statistics, and event recording.
- The example demonstrates two failures followed by a successful forwarded request.
- Static syntax checks and the full test suite pass locally and in public CI on supported Node.js versions.
- The README states limitations and contains no em dash characters.

## Non-goals

- TLS interception, certificate generation, packet capture, raw TCP manipulation, bandwidth shaping, production traffic management, and distributed coordination are out of scope.
- RelayFault is not a security scanner and does not claim protocol compliance beyond the tested HTTP behavior.
