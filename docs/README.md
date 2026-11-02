# Documentation map

This documentation is the self-contained, evolving project baseline for agent-Kernel. The former source repository has been deleted; no document here depends on it being available. Historical provenance identifiers are retained only to explain the origin of selected architecture principles.

## Architecture

- [Architecture overview](architecture/overview.md) — shared Kernel, two domain profiles, authority boundaries, and invariants.
- [Unified domain architecture](architecture/domain-architecture.md) — three-layer model, shared contracts, domain isolation, and scope.
- [Lifecycle and state model](architecture/lifecycle.md) — Task, GoalContract, PlanRevision/PlanStep, ModelStep, Attempt, ToolInvocation, cancellation, recovery, and DomainBinding.
- [Architecture provenance](architecture/provenance.md) — source and exact adoption boundary for the initial baseline.

## Contracts

- [Model execution and budget](contracts/model-and-budget.md)
- [Response delivery and durable inbox](contracts/delivery-and-inbox.md)
- [Workspace freeze and receipt](contracts/workspace-freeze.md)
- [PlanRevision and PlanStep lifecycle](contracts/plan-revision.md)
- [Domain Workflow binding](contracts/domain-workflow.md)
- [Media Timeline artifact](contracts/media-timeline.md)
- [Long-running RenderJob](contracts/render-job.md)
- [Verification and completion](contracts/completion.md)

## Security and context

- [Trusted ToolHost](security/trusted-host.md)
- [Context Engine](context/context-engine.md)

## Research and decisions

- [Autonomous Coding Agent intelligence](research/autonomous-coding-agent/README.md) — retained Coding Domain Intelligence design, reference review, failure model, and evaluation.
- [Multimedia Domain Architecture](research/multimedia-domain-architecture/README.md) — natural-language Video Editing domain design and evaluation.
- [Shared Kernel reference review](research/shared-kernel/reference-review.md) — source-grounded review of Pi, Codex, DeepSeek Harness, and Claude Agent SDK.
- [Intelligent execution architecture](research/autonomous-coding-agent/design.md)
- [Coding reference implementation review](research/autonomous-coding-agent/reference-review.md)
- [Failure model and recovery policy](research/autonomous-coding-agent/failure-model.md)
- [Coding evaluation and experiment protocol](research/autonomous-coding-agent/evaluation.md)
- [Unified domain direction](decisions/unified-domain-direction.md)
- [Cross-domain architecture review](decisions/cross-domain-architecture-review.md)
- [Second-round Coding contract review](decisions/second-round-contract-review.md)
- [Open decisions](decisions/open-decisions.md)
- [Roadmap and gates](development/roadmap.md)
- [Legacy asset policy](migration/asset-policy.md)

## Status rule

The existence of a document does not mean its entire content is final. The one-Kernel/two-domain product direction is approved; detailed architecture and contracts are proposed until reviewed. Runtime behavior remains unverified until implementation and reproducible evidence exist. See AGENTS.md.
