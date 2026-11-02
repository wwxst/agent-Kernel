# Cross-domain architecture consistency review

> **Status: PROPOSED review record — product direction approved; architecture approval pending.** This review checks whether Autonomous Coding and Autonomous Video Editing can use one Kernel without collapsing their domain models. It is a documentation/contract review only; no Runtime, media processing, benchmark, or fault-injection test was run.

## 1. Review basis

The owner confirmed:

- one shared Agent Kernel for Autonomous Coding and Autonomous Video Editing;
- independent domain intelligence and domain execution capabilities;
- common Task/Planning/Context/Model/Tool/Permission/Budget/Journal/Recovery/Verification infrastructure;
- a separate RepositoryModel for Coding and MediaProjectModel for Video;
- separate Workflow Profiles, domain tools, and acceptance criteria;
- Video first-phase scope is natural-language-driven automatic editing, not a full video editor;
- architecture research and documentation only; Runtime is not authorized.

The approved direction is recorded in [Unified domain direction](unified-domain-direction.md). The architecture proposal is [Unified domain architecture](../architecture/domain-architecture.md).

## 2. Cross-domain consistency matrix

| Review question | Proposed answer | Contract/location | Review status |
| --- | --- | --- | --- |
| What is shared? | Task/Turn/Step, GoalContract/PlanRevision envelopes, Model Gateway, context infrastructure, Tool Runtime, permission, budget, Journal, Host, cancellation, recovery, evidence envelope, Completion Guard, delivery | [Architecture overview](../architecture/overview.md), [Domain Workflow](../contracts/domain-workflow.md) | CONSISTENT PROPOSAL |
| What stays independent? | RepositoryModel vs MediaProjectModel; coding vs editing planning semantics; tools; evidence vocabularies; domain verifiers; evaluation | [Domain architecture](../architecture/domain-architecture.md), [Context Engine](../context/context-engine.md) | CONSISTENT PROPOSAL |
| How do both use GoalContract? | Common immutable intent/version/provenance envelope plus typed domain payload and schema version | [Domain Workflow](../contracts/domain-workflow.md), [PlanRevision](../contracts/plan-revision.md) | CONSISTENT PROPOSAL |
| How do both use PlanRevision? | Common immutable DAG and cutover lifecycle; typed PlanStep payloads/artifacts; Kernel validates structure/authority, Domain Intelligence judges semantic adequacy | [PlanRevision](../contracts/plan-revision.md) | CONSISTENT PROPOSAL |
| How are tools controlled? | Every domain operation uses ToolInvocation, current profile, Kernel admission, budget/approval, durable intent, Trusted ToolHost, receipt, and UNKNOWN reconciliation | [Domain Workflow](../contracts/domain-workflow.md), [RenderJob](../contracts/render-job.md) | CONSISTENT PROPOSAL |
| How is media state modeled? | MediaProject is the persistent artifact container; MediaProjectModel is its separate Context projection with asset/stream/time/analysis provenance | [Context Engine](../context/context-engine.md), [Media Timeline](../contracts/media-timeline.md), [Video design](../research/multimedia-domain-architecture/design.md) | CONSISTENT PROPOSAL |
| How is the edit persisted? | Immutable TimelineRevision, source PTS/timebase, rational timeline ticks, parent revision, EditIntent, source digests, and render lineage | [Media Timeline](../contracts/media-timeline.md) | CONTRACT PROPOSED |
| How is long rendering handled? | Typed RenderJob over shared Host process lifecycle; progress is telemetry; cancellation requires process convergence; UNKNOWN blocks blind retry/publication | [RenderJob](../contracts/render-job.md) | CONTRACT PROPOSED; RUNTIME UNVERIFIED |
| How is final video verified? | Technical probe/decode, timeline invariants, audio/video integrity, content match, perceptual review, and human review when required | [RenderJob](../contracts/render-job.md), [Video design](../research/multimedia-domain-architecture/design.md) | CONTRACT PROPOSED; QUALITY UNVERIFIED |
| How can users revise an edit? | Append-only EditIntent creates a new TimelineRevision/RenderPlan/RenderJob; prior renders remain immutable | [Media Timeline](../contracts/media-timeline.md) | CONTRACT PROPOSED |
| How are quality results compared? | Separate Coding and Video task sets/metrics/baselines; shared Kernel safety metrics across both | [Coding evaluation](../research/autonomous-coding-agent/evaluation.md), [Video evaluation](../research/multimedia-domain-architecture/evaluation.md) | METHOD PROPOSED |
| Is a full editor required? | No. Timeline is a canonical artifact; first phase is automatic editing only | [Unified domain direction](unified-domain-direction.md), [Video design](../research/multimedia-domain-architecture/design.md) | SCOPE APPROVED |
| Is Multi-Agent required? | No. D9 remains deferred and unauthorized | [Open decisions](open-decisions.md), [Roadmap](../development/roadmap.md) | DEFERRED |

## 3. Reference implementation review

The shared execution layer was re-reviewed against pinned Pi, Codex, and DeepSeek Harness source snapshots and current official Claude Agent SDK documentation.

The common transferable mechanisms are:

- provider-neutral model/tool loop and explicit lifecycle events;
- durable session/task history distinct from live progress events;
- user steering, approval, and resumable sessions;
- bounded effect-aware tool scheduling and cancellation/drain behavior;
- separate technical isolation and user authorization;
- explicit context/compaction and result status;
- multi-surface protocol and tool capability seams.

The references do not supply this project's complete Kernel authority, durable-intent/Host-receipt/UNKNOWN contract, domain-specific cognition, or criterion-level completion proof. None supplies the MediaProjectModel, canonical timeline, or perceptual video verification required here.

See [Shared Agent Kernel reference review](../research/shared-kernel/reference-review.md). The existing [Coding reference review](../research/autonomous-coding-agent/reference-review.md) remains a Coding-domain-specific analysis.

## 4. Consistency corrections made in this round

1. The repository purpose and Architecture overview now describe a unified two-domain platform rather than a Coding-only product.
2. The existing Coding design is explicitly retained as Coding Domain Intelligence, not the whole platform.
3. MediaProject is defined as the persistent Video artifact container, and MediaProjectModel is introduced as its sibling Context projection; RepositoryModel remains intact.
4. DomainBinding and Workflow Profile are added to lifecycle and PlanRevision envelopes.
5. Domain Workflow, Media Timeline, and RenderJob contracts are added.
6. CompletionReport bindings include DomainBinding and final domain artifact references.
7. Roadmap now plans Coding and Video domain research in parallel, followed by shared Kernel integration and cross-domain review.
8. Video scope is explicitly constrained to natural-language automatic editing; no full editor or Multi-Agent implementation is implied.

## 5. Remaining design questions

The current proposal is internally aligned at the contract level, but these items still require owner review or empirical evidence:

- the exact minimum Video Editing operation set and whether captions/titles/audio treatment are first-phase or follow-up;
- Workflow Profile acceptance, revocation, and migration semantics during long-running tasks;
- the common artifact/storage/streaming envelope for large media and derived proxies;
- source PTS, variable-frame-rate handling, audio sample alignment, and rounding across supported formats;
- FFmpeg packaging/build policy and media-analysis provider/model choices;
- cross-platform process-tree containment and hard CPU/GPU/memory/disk/time budgets;
- objective versus subjective video-quality evidence and human-review thresholds;
- how linked Coding/Video tasks share artifacts without introducing a composite cross-domain Task;
- separate benchmark assets/task sets, hidden checks, and reviewer rubrics;
- whether a minimal preview/approval surface is sufficient without creating a full editor.

These remain OPEN; no target thresholds are invented before a frozen task set and measured baseline exist.

## 6. Validation record

- Product direction and Video first-phase scope: **PASS — explicit owner decision recorded**.
- Three-layer responsibility model: **PASS — coherent proposal**.
- Shared GoalContract/PlanRevision lifecycle with typed domain payloads: **PASS — proposed contract alignment**.
- Separate RepositoryModel and MediaProjectModel: **PASS — context boundary specified**.
- Shared ToolInvocation/Host/permission/budget/recovery path: **PASS — proposed contract alignment**.
- Timeline revision and RenderJob contracts: **PASS — documented proposal**.
- Technical/perceptual verification boundary: **PASS — evidence obligations proposed**.
- Local Markdown link audit: **PASS** — all 32 Markdown files and all relative links resolve against the reviewed branch tree.
- Runtime tests and fault injection: **NOT RUN**.
- Media processing and benchmark: **NOT RUN**.
- Host process convergence, render recovery, and media quality: **UNVERIFIED**.
- Final architecture freeze: **NOT APPROVED**.

## 7. Decision requested

The current documentation is ready for owner review as a coherent cross-domain architecture proposal. Approval should confirm the responsibility boundaries, shared contracts, and first-phase Video scope.

It should not be interpreted as authorization for Runtime code, production dependencies, external media processing, real-model benchmark runs, final technology selection, or legacy migration. Those require separate explicit approval.
