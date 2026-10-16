---
name: code-review
description: Run the team code review checklist against a diff, PR, or file/directory. Use when asked to review changes, before opening a PR, or as a second opinion on another agent's work.
---

# Code review

Apply every section below to the target (a given path, or current uncommitted
changes if none given).

## Correctness & Consistency

- Logic errors, edge cases, off-by-one errors
- Inconsistent naming conventions, patterns, or abstraction levels across the codebase
- Type mismatches or implicit assumptions between components

## Code Quality

- DRY violations — identify every instance of duplicated logic and propose specific abstractions
- Dead code, unused imports, unreachable branches
- Functions doing too much (SRP violations) — flag any function over ~30 lines

## Performance & Resource Management

- Memory leaks: unclosed connections, missing cleanup, unremoved event listeners, circular references
- N+1 queries, unnecessary re-renders, unbounded data structures
- Missing timeouts, rate limits, or backpressure on I/O operations
- Blocking calls in async contexts

## Overengineering

- Premature abstractions — code that adds indirection without a second use case
- Unnecessary design patterns, wrapper classes, or config-driven logic that could be a simple function
- Layers that just pass through without transforming

## Error Handling & Resilience

- Silent failures, swallowed exceptions, missing error propagation
- Missing input validation at trust boundaries
- No retry/fallback logic where external calls can fail

## Output format

For each issue found, provide:

- File:line — exact location
- Severity — critical / major / minor
- Issue — one-sentence description
- Fix — concrete code change or refactor (not just "consider improving")
