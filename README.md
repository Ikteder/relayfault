# RelayFault

[![CI](https://github.com/Ikteder/relayfault/actions/workflows/ci.yml/badge.svg)](https://github.com/Ikteder/relayfault/actions/workflows/ci.yml)

RelayFault is a deterministic local HTTP fault-injection proxy for testing retries, timeouts, idempotency, and fallback behavior. It sits between a client and a development service, applies an ordered JSON scenario, and records evidence about what happened.

It has no runtime dependencies and does not require application code changes. The same scenario and seed produce the same rule sequence.

## Why it is useful

Resilience code often works only on the happy path because real outages are difficult to reproduce. RelayFault makes a few important cases repeatable:

- return two `503` responses before allowing a request through;
- delay every third matching request by a known amount;
- disconnect selected requests to exercise transport-error handling;
- apply a seeded probability without turning a test into an unrepeatable coin flip;
- inspect counters and newline-delimited JSON events after the test.

RelayFault never retries requests itself. The client under test remains responsible for deciding whether a request is safe to replay.

## Quick start

Requirements: Node.js 22 or newer.

```bash
npm install
npm test
npm run demo
```

The demo starts an ephemeral upstream and RelayFault instance, sends the same payment request three times, and verifies this sequence:

```text
503, 503, 200
```

To run the included upstream and proxy manually, use two terminals:

```bash
node examples/upstream.js 9090
node src/cli.js serve \
  --target http://127.0.0.1:9090 \
  --scenario examples/scenario.json \
  --events relayfault-events.ndjson
```

Then send requests through `http://127.0.0.1:8787` instead of port `9090`.

## Scenario example

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

Validate or explain a scenario before serving it:

```bash
node src/cli.js validate examples/scenario.json
node src/cli.js explain examples/scenario.json
```

Validation is strict. Unknown keys, duplicate rule names, malformed paths, invalid status codes, unsafe header values, and conflicting `when` selectors receive specific errors.

## Rule behavior

Rules are evaluated in file order. The first rule whose match and `when` condition are active wins. A rule ordinal counts only requests that satisfy that rule's method and path predicate.

Path matching is exact unless the path ends in `*`, which enables prefix matching. Method matching is case-insensitive.

| Selector | Meaning |
|---|---|
| `{ "requests": [1, 2] }` | Apply on selected matching ordinals |
| `{ "every": 3 }` | Apply on every third matching request |
| `{ "probability": 0.25 }` | Apply from a deterministic seeded random sequence |
| omitted | Apply to every matching request |

| Action | Effect |
|---|---|
| `forward` | Send the request to the upstream once |
| `delay` | Wait for the configured delay and optional seeded jitter, then forward |
| `respond` | Return a synthetic status, headers, and body without contacting upstream |
| `disconnect` | Close the client socket without contacting upstream |

## Command reference

```text
relayfault validate <scenario.json>
relayfault explain <scenario.json>
relayfault serve --scenario <file> --target <origin> [options]

--listen <host:port>       Loopback listener (default: 127.0.0.1:8787)
--seed <integer>           Deterministic unsigned seed (default: 1)
--max-body <bytes>         Request body limit (default: 1048576)
--events <path>            Append newline-delimited JSON evidence
--allow-remote-target      Permit a non-loopback upstream target
```

The read-only `GET /__relayfault/status` endpoint reports totals, rule hits, the seed, and per-rule seen/applied counters. Status reads do not change those counters.

## Safety model

- The listener accepts loopback addresses only.
- The upstream must be loopback unless `--allow-remote-target` is passed explicitly.
- Target URLs cannot contain credentials, paths, queries, or fragments.
- Scenario files are inert JSON. They cannot run commands, import code, or expand environment variables.
- Request bodies are bounded and oversized requests receive `413` without reaching upstream.
- Hop-by-hop headers are removed in both directions.
- RelayFault performs one upstream attempt at most and never modifies files belonging to the service under test.

The remote-target option exists for controlled staging tests. Confirm authorization and understand the traffic impact before enabling it.

## Verification

The project uses Node's built-in test runner with real ephemeral HTTP servers. Local verification on Node.js 26.5.0 covers scenario validation, ordered rule selection, seeded probability and jitter, forwarding, synthetic responses, delay, disconnect, body limits, hop headers, status counters, event recording, target safety, and CLI failures.

Run all checks with:

```bash
npm run check
npm test
npm run demo
npm pack --dry-run
```

See the [verification record](docs/experiments/verification-2026-08-29.md) for exact observed results.

## Current limitations

- RelayFault is an HTTP/1.1 development proxy, not a raw TCP or HTTP/2 fault injector.
- HTTPS upstreams are supported, but TLS interception and downstream HTTPS termination are not.
- Delay buffers the complete request body before the timer starts, so it does not model slow streaming uploads.
- There is no bandwidth shaping, partial-body corruption, DNS failure simulation, or packet-level control.
- Event recording uses synchronous append operations to preserve simple ordered local evidence. Very high request rates are not the intended use.
- Counters are process-local and reset on restart. RelayFault does not coordinate scenarios across multiple proxy instances.

## Design notes

- [Approved design specification](docs/superpowers/specs/2026-08-29-relayfault.md)
- [Deterministic rule engine decision](docs/decisions/0001-deterministic-stateful-rules.md)
- [Working notes](docs/notes/2026-08-29.md)
- [Dataset note](docs/datasets/README.md)
- [Model note](docs/models/README.md)

## License

MIT
