# Decision 0001: Deterministic stateful rules

Date: 2026-08-29

Status: Accepted

## Context

Retry and resilience tests need failure sequences that can be reproduced. A purely random proxy can find problems, but a failed test is difficult to investigate when its action sequence cannot be replayed. Stateless path rules also cannot express common cases such as "fail twice, then recover."

## Decision

RelayFault uses an ordered stateful rule engine. Each rule counts requests that satisfy its method and path predicate. An ordinal, periodic cadence, or seeded probability decides whether the rule is active. The first active rule wins, and the status endpoint exposes seen and applied counts.

The probability generator is local to one compiled scenario and seeded explicitly. Delay jitter uses the same deterministic stream. No source of wall-clock randomness affects rule selection.

## Consequences

- A scenario plus seed is replayable.
- Rule order is semantically significant and must be documented in review.
- Adding or reordering a probabilistic rule can change later random draws.
- Process restart resets counters and the random stream.
- Multi-instance coordination is out of scope; independent instances do not share ordinals.
