# Architecture provenance and adoption boundary

> **Status: Initial baseline provenance.** This file records where the first architecture principles came from and what this new repository deliberately does not inherit.

## Source

The initial architecture baseline is re-authored from the previous project's V2.1.2 architecture principles and contract review:

- Source repository: [wwxst/agent-](https://github.com/wwxst/agent-)
- Source commit: [`d824e873ef47a7479f98ef7223a084fbf889db40`](https://github.com/wwxst/agent-/commit/d824e873ef47a7479f98ef7223a084fbf889db40)
- Source document: `docs/architecture/10-架构评审候选方案-V2.1.2-2026-11-01.md`
- Review conclusion: **APPROVED — architecture principles and contract baseline**, dated 2026-11-02.

The source approval does not claim that a runtime implementation exists or that the newly specified runtime contracts have passed implementation, security, or production verification.

## Adopted principles

This repository adopts, as the starting point for discussion and refinement:

1. Kernel is the only authority for task state, legal state transitions, hard budgets, and Tool Admission.
2. Orchestration plans, coordinates, verifies, and decides; it does not become a second state machine.
3. Model Gateway owns provider protocol interaction and usage/error normalization, not task state or admission.
4. Context Engine creates provenance-aware Planning Context and version-bound Execution Context; context is not authorization.
5. Tool Runtime schedules and dispatches admitted invocations; it does not grant permission.
6. Trusted ToolHost is the isolated side-effect boundary and maintains a Host Ledger separate from Kernel Persistence.
7. Kernel Journal facts and Host execution facts are reconciled, not falsely treated as one distributed atomic transaction.
8. Complete model responses, deterministic response selection, cancellation ordering, durable delivery, and budget settlement have explicit contracts.
9. UNKNOWN is preserved until evidence resolves it; non-idempotent work is never blindly replayed.
10. Completion is a guarded state transition bound to a frozen workspace snapshot and verifiable execution evidence.
11. Workspace Freeze requests and receipts require authenticated, challenge-bound, replay-resistant evidence.
12. Task terminal states are immutable; late budget or evidence conflicts are recorded independently.

## Deliberately not inherited

The source document described `wwxst/agent-` as the future final code repository. That repository-ownership statement belongs to the old project and is **superseded for this new project** by the owner's explicit decision:

- `wwxst/agent-Kernel` is the new and only formal development repository.
- `wwxst/agent-` is a source of reference material and candidate assets only.
- The new repository starts with its own Git history and documentation authority.

This repository does not import:

- old Git commits, branches, PRs, or development history;
- old project directory structure or obsolete architecture versions;
- old Kernel source code or tests as if they were already compliant;
- old ADR numbering or historical decision status;
- the old repository's implementation or technology choices as binding;
- Multi-Agent / D9 implementation authorization.

## Interpretation rule

The baseline is a starting architecture contract, not an untouchable design. We may refine it as the autonomous Coding Agent research exposes missing capabilities or better trade-offs. Changes must preserve traceability: state what is being changed, why, what evidence supports it, what risks are introduced, and which previously agreed invariants are affected.

All concrete runtime behavior remains **UNVERIFIED** until this repository contains implementation and reproducible evidence.
