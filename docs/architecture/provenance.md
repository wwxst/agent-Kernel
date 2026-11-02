# Architecture provenance and adoption boundary

> **Status: Historical provenance recorded; current baseline is self-contained.** The former source repository has been deleted. This document preserves the available source identifiers and explains exactly what this project adopted.

## Historical source record

The initial architecture baseline was re-authored from an architecture review recorded as V2.1.2 in the former repository:

- Historical repository identity: `wwxst/agent-`
- Repository status: **deleted by its owner; no longer accessible**
- Historical source commit: `d824e873ef47a7479f98ef7223a084fbf889db40`
- Historical source document: `docs/architecture/10-架构评审候选方案-V2.1.2-2026-11-01.md`
- Recorded review conclusion: **APPROVED — architecture principles and contract baseline**

The commit SHA and document path are archival identifiers only. Because the repository has been deleted, this project does not claim that the source commit, document, branches, or other historical assets remain retrievable.

The documents in this repository are a selective re-authoring of the architecture principles and contracts needed as an initial baseline. They are not a byte-for-byte copy of the historical source, do not preserve its full history, and do not imply that every proposal in that source was adopted.

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

## New repository authority

The former source repository's project-ownership statements are historical and do not apply to this project.

- `wwxst/agent-Kernel` is the sole formal repository and source of truth for the new Agent Kernel.
- The former `wwxst/agent-` repository has been deleted and is not an active source, dependency, or required reference.
- The new repository has its own Git history, documentation authority, decision process, and future implementation baseline.
- No old repository links are required to understand, build, test, or maintain this project.

## Deliberately not inherited

This project does not import:

- old Git commits, branches, PRs, or development history;
- old project directory structure or obsolete architecture versions;
- old Kernel source code or tests as if they were already compliant;
- old ADR numbering or historical decision status;
- the former repository's implementation or technology choices as binding;
- Multi-Agent / D9 implementation authorization.

The former repository's deletion also means that no unreviewed historical code asset is assumed to be available for migration. If a specific asset is needed later, it must be supplied independently and reviewed for provenance, license, behavior, security, dependencies, and compatibility with the new contracts.

## Interpretation rule

The baseline is a starting architecture contract, not an untouchable design. We may refine it as the autonomous Coding Agent research exposes missing capabilities or better trade-offs. Changes must preserve traceability: state what is being changed, why, what evidence supports it, what risks are introduced, and which previously agreed invariants are affected.

All concrete runtime behavior remains **UNVERIFIED** until this repository contains implementation and reproducible evidence.
