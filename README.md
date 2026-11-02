# Agent Kernel

> **Project status: Second-round architecture contract revision — proposed and under owner review.**
>
> This repository is the new, independent home for the Agent Kernel. It starts with a clean Git history. The documentation baseline re-authors approved architecture principles. The autonomous Coding Agent design and second-round Kernel reconciliation remain proposals, not a frozen implementation specification, and do not authorize runtime development by themselves.

## Purpose

Build a reliable, autonomous Coding Agent system that can understand development goals, inspect a codebase, build a repository/problem model, plan and revise work, modify code, run and interpret verification, debug failures, and recover from long-running or interrupted tasks.

The Kernel must make execution safe and auditable without becoming the place where all planning intelligence is hard-coded. The boundary between adaptive Orchestration and deterministic Kernel authority is a central design concern.

The primary goal is **verified completion of complex software-engineering tasks**, not faster tool calls or a larger number of agents.

## Repository rules

- This repository is the sole formal development home for the new Kernel.
- The former repository wwxst/agent- has been deleted by its owner. It is not an available source, dependency, or ongoing project.
- Only knowledge and architecture principles already re-authored in this repository are available; do not assume deleted files, branches, or commits can be recovered.
- No old Git history, old Kernel implementation, obsolete architecture draft, or development-process archive is imported.
- Knowledge may be re-authored when useful; code is not migrated unless it is reviewed independently against this repository's contracts.
- Architecture principles and contracts are versioned here. Unresolved design and technology choices remain explicitly open.
- No production implementation, dependency stack, or security capability is claimed until it is implemented and verified.

## Architecture baseline

The initial design separates:

- **Kernel** — authoritative state, accepted plan versions, legal transitions, hard budgets, admission, durable intent, and completion gates.
- **Orchestration** — goal understanding, repository reconnaissance, evidence modeling, adaptive planning, action selection, debugging, verification decisions, and human escalation.
- **Model Gateway** — provider protocols, complete-response normalization, usage evidence, and provider errors.
- **Context Engine** — provenance-aware repository/evidence projections, Planning/Execution/Verification Context, checkpoint candidates, compaction, and memory projections.
- **Tool Runtime** — immutable tool-definition snapshots, effect/conflict-aware scheduling, and Host dispatch; it does not grant authority.
- **Trusted ToolHost** — isolated side-effect execution, Host Ledger, receipts, and process/workspace controls.
- **Policy & Security / Persistence** — authorization evidence and Kernel-owned durable facts, with the Host Ledger kept as a separate fact boundary.

See [Architecture overview](docs/architecture/overview.md).

## Autonomous Coding Agent design

The second-round intelligent-execution design refines the first-round proposal with GoalContract versioning, PlanRevision cutover, orthogonal PlanStep status, ActionProposal lifecycle, EvidenceGraph minimum records, decision arbitration, layered verification independence, checkpoint recovery, and staged evaluation gates.

Start with [the design](docs/research/autonomous-coding-agent/design.md) and the [PlanRevision lifecycle contract](docs/contracts/plan-revision.md), then review the [reference comparison](docs/research/autonomous-coding-agent/reference-review.md), [failure model](docs/research/autonomous-coding-agent/failure-model.md), [evaluation protocol](docs/research/autonomous-coding-agent/evaluation.md), and [second-round consistency review](docs/decisions/second-round-contract-review.md).

## Current state

- Documentation baseline: established.
- Autonomous Coding Agent intelligent-execution design: second-round proposed draft; owner review pending.
- Kernel architecture reconciliation: second-round proposed draft; owner review pending.
- Technology choices: open.
- Runtime implementation: not started in this repository.
- Legacy code migration: not started.
- Multi-Agent / D9: deferred and not authorized.

## How to work in this repository

Read [AGENTS.md](AGENTS.md) before changing project files. Use [Open decisions](docs/decisions/open-decisions.md) and the research documents to distinguish approved principles, proposals, and unknowns.

The first milestone is to make the architecture coherent enough to review and evolve. Implementation starts only after the relevant contracts, experiments, and scope have been explicitly agreed.
