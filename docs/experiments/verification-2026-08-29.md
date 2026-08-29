# Verification record, 2026-08-29

## Environment

- Operating system: Windows
- Runtime: Node.js 26.5.0
- Package dependencies: none
- Demo seed: `20260829`

## Local checks

| Check | Actual result |
|---|---|
| Package installation | Lockfile generated; 1 package audited; 0 vulnerabilities |
| Static syntax | All source, demo, and example JavaScript files passed `node --check` |
| Native tests | 18/18 passed after replacing one invalid connection-header assumption and adding an unknown-option CLI check |
| Deterministic demo | Status sequence `[503, 503, 200]`; 3 events recorded |
| Demo accounting | 3 total, 2 synthetic, 1 forwarded, 0 upstream errors |

## Covered behavior

- strict scenario validation and readable multi-error reporting;
- method, exact path, and prefix-path predicates;
- request ordinal and periodic selection;
- seeded probability and delay jitter;
- ordered first-active-rule behavior and counters;
- real HTTP forwarding with method, query, headers, and body;
- hop-by-hop header removal;
- synthetic response, delay, disconnect, and default forwarding;
- body-limit rejection without upstream contact;
- read-only status statistics;
- newline-delimited JSON events;
- default remote-target blocking and explicit override;
- CLI validate, explain, invalid-scenario, and unknown-option behavior.

## Interpretation

The demo proves the intended stateful sequence through local HTTP sockets. It does not measure production throughput, packet behavior, TLS interception, HTTP/2, or multi-instance coordination. Test timings are correctness evidence only and are not a performance benchmark.

## Public verification

[GitHub Actions run 33244285752](https://github.com/Ikteder/relayfault/actions/runs/33244285752) passed at commit `abde007625c042aa95536b9e615d9f29305852ad`.

| Public job | Result |
|---|---|
| Node.js 22 | Success |
| Node.js 24 | Success |
| Node.js 26 | Success |

Each job ran package installation, syntax checks, all 18 tests, the deterministic demo, and the package dry run.
