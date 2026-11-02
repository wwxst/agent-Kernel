# Documentation map

This documentation is the self-contained, evolving project baseline for agent-Kernel. The former source repository has been deleted; no document here depends on it being available. Historical provenance identifiers are retained only to explain the origin of selected architecture principles.

## Architecture

- [Architecture overview](architecture/overview.md) — logical responsibilities, authority boundaries, intelligent execution flow, and invariants.
- [Lifecycle and state model](architecture/lifecycle.md) — Task, GoalContract, PlanRevision/PlanStep, ModelStep, Attempt, ToolInvocation, cancellation, and recovery.
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

- [Autonomous Coding Agent intelligence](research/autonomous-coding-agent/README.md) — end-to-end design, reference review, failure model, and evaluation protocol.
- [Intelligent execution architecture](research/autonomous-coding-agent/design.md)
- [Reference implementation review](research/autonomous-coding-agent/reference-review.md)
- [Failure model and recovery policy](research/autonomous-coding-agent/failure-model.md)
- [Evaluation and experiment protocol](research/autonomous-coding-agent/evaluation.md)
- [Open decisions](decisions/open-decisions.md)
- [Roadmap and gates](development/roadmap.md)
- [Legacy asset policy](migration/asset-policy.md)

## Status rule

The existence of a document does not mean its entire content is final. Each document labels approved principles, proposals, open questions, and unverified implementation contracts. See AGENTS.md.
