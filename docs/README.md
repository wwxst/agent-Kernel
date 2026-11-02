# Documentation map

This documentation is the evolving project baseline. It is re-authored for `agent-Kernel`; it is not a mirror of the previous repository.

## Architecture

- [Architecture overview](architecture/overview.md) — logical components, authority boundaries, execution flow, and invariants.
- [Lifecycle and state model](architecture/lifecycle.md) — Task, ModelStep, Attempt, ToolInvocation, cancellation, and recovery.
- [Architecture provenance](architecture/provenance.md) — source and exact adoption boundary for the initial baseline.

## Contracts

- [Model execution and budget](contracts/model-and-budget.md)
- [Response delivery and durable inbox](contracts/delivery-and-inbox.md)
- [Workspace freeze and receipt](contracts/workspace-freeze.md)
- [Verification and completion](contracts/completion.md)

## Security and context

- [Trusted ToolHost](security/trusted-host.md)
- [Context Engine](context/context-engine.md)

## Research and decisions

- [Autonomous Coding Agent intelligence research](research/autonomous-coding-agent/README.md)
- [Open decisions](decisions/open-decisions.md)
- [Roadmap and gates](development/roadmap.md)
- [Legacy asset policy](migration/asset-policy.md)

## Status rule

The existence of a document does not mean its entire content is final. Each document labels approved principles, proposals, open questions, and unverified implementation contracts. See [AGENTS.md](../AGENTS.md).
