
# Merciless Simplification

## Overview

Systematic code simplification via micro-tickets: one small, verified, committed refactoring at a time, always preserving externally observable behavior. **Merciless in ambition, incremental in execution** — boy-scout rule, always strive for the simplest possible long-term solution.

## When to Use

- Whole-codebase complexity reduction
- Removing dead code, unused abstractions, duplication, middle men
- Code-smell cleanup after features land
- When asked to "simplify", "clean up", or "reduce complexity" in code

**When NOT to use**: codebase already minimal; no test coverage at all (build coverage first); major architectural rewrite planned; team lacks buy-in.

## Hard Rules (non-negotiable)

1. **Safety net calibrated to risk**: tiny tidies (dead-code removal, renames) rely on smallness and revert; structural changes get CHARACTERIZE tickets first; boundary changes get human approval. TDD designs new behavior; characterization captures existing behavior.
2. **Backward compatible**: never change externally observable behavior (API, error messages, formats, timing, side effects). Internal implementation only.
3. **Scope**: public API / service boundary changes are out of scope by default and require explicit human approval.
4. **Evidence over naming**: every ticket states concrete evidence for its smell (grep results, diff, call-site count). Citing a Fowler refactoring name is not enough.
5. **Human approval**: present the ticket batch; the human approves direction and criteria, not every ticket. High-risk tickets (public API, large deletions, core modules) are gated.
6. **Small bits only**: one ticket at a time, commit after each. Never batch changes.
7. **Stop, don't churn**: stop after 3 consecutive tickets with no evidence-backed smell, when targeted modules pass a pre-agreed CRAP threshold, or when a timebox is reached. If a change is uncertain or tests can't go green, revert and record why.

## Workflow

Per ticket: **ANALYSIS → CHARACTERIZE → TIDY → SIMPLIFY/CONSOLIDATE → VERIFY** → commit.

| Ticket | Purpose | Exit |
|---|---|---|
| CHARACTERIZE | Capture existing behavior (safety net) | Behavior captured in tests |
| ANALYSIS | Document dependencies and smells | Safe path identified |
| TIDY | Prepare structure (requires tests) | Structure improved, green |
| SIMPLIFY | Inline/remove abstraction | Simpler, all tests pass |
| CONSOLIDATE | Merge duplicates | Duplication eliminated |
| VERIFY | Suite + mutation on changed modules | All green, no behavior change |

## Measurement

Goal is **complexity reduction, not fewer lines**: CRAP score (cyclomatic complexity × coverage), mutation testing (tests must assert behavior), architectural/dependency tests. Coverage is a constraint, never a target; metrics are diagnostics, not gates. Lines of code and file counts are never success metrics.

## Full Methodology

See [references/methodology.md](references/methodology.md) for the complete guide: smell detection table with evidence requirements, ticket templates, key patterns, Fowler refactoring catalog, and limitations.
