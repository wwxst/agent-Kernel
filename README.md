# Agent Kernel

> **Project status: Initial architecture baseline — under active review.**
>
> This repository is the new, independent home for the Agent Kernel. It starts with a clean Git history. The first documentation baseline is being reconstructed from approved architecture principles; it is not a frozen implementation specification and does not authorize runtime development by itself.

## Purpose

Build a reliable, autonomous Coding Agent system that can understand development goals, inspect a codebase, plan work, modify code, run and interpret verification, debug failures, and recover from long-running or interrupted tasks.

The Kernel must make execution safe and auditable without becoming the place where all planning intelligence is hard-coded. The boundary between deterministic authority and adaptive agent behavior is a central design concern.

## Repository rules

- This repository is the sole formal development home for the new Kernel.
- The previous repository `wwxst/agent-` is an asset and evidence source only. It is not a parent project, dependency, or implicit specification.
- No old Git history, old Kernel implementation, obsolete architecture draft, or development-process archive is imported.
- Knowledge may be re-authored when useful; code is not migrated unless it is reviewed independently against this repository's contracts.
- Architecture principles and contracts are versioned here. Unresolved design and technology choices remain explicitly open.
- No production implementation, dependency stack, or security capability is claimed until it is implemented and verified.

## Architecture baseline

The initial design adopts the approved architecture principles and contract baseline from the previous project's V2.1.2 review, re-authored for this new repository. The source is recorded in [Architecture provenance](docs/architecture/provenance.md).

The baseline separates:

- **Kernel** — authoritative state, legal transitions, hard budgets, admission, durable intent, and completion gates.
- **Orchestration** — goal decomposition, planning, strategy, coordination, verification decisions, and repair decisions.
- **Model Gateway** — provider protocols, complete-response normalization, usage evidence, and provider errors.
- **Context Engine** — provenance-aware planning/execution context, checkpoint candidates, compaction, and memory projections.
- **Tool Runtime** — immutable tool snapshots, scheduling, and host interaction; it does not grant authority.
- **Trusted ToolHost** — isolated side-effect execution, host ledger, receipts, and process/workspace controls.
- **Policy & Security / Persistence** — authorization evidence and Kernel-owned durable facts, with the Host Ledger kept as a separate fact boundary.

See [Architecture overview](docs/architecture/overview.md).

## Current state

- Documentation baseline: started.
- Autonomous Coding Agent intelligence design: research and design work is open; not frozen.
- Technology choices: open.
- Runtime implementation: not started in this repository.
- Legacy code migration: not started.
- Multi-Agent / D9: deferred and not authorized by this baseline.

## How to work in this repository

Read [AGENTS.md](AGENTS.md) before changing project files. Use [Open decisions](docs/decisions/open-decisions.md) and the research documents to distinguish approved principles from proposals and unknowns.

The first milestone is to make the architecture coherent enough to review and evolve. Implementation starts only after the relevant contracts, experiments, and scope have been explicitly agreed.
