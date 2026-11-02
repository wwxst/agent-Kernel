# Architecture overview

> **Status: Cross-domain architecture proposal.** The one-Kernel/two-domain product direction is approved. The shared execution contracts, DomainBinding, Workflow Profiles, and domain-specific extensions remain proposed. No Runtime implementation or technology stack is approved.

## 1. Product objective

Build one autonomous Agent platform with two initial execution domains:

- **Autonomous Coding** — understand software repositories, plan changes, edit code, run tests, debug/repair, verify, and deliver code.
- **Autonomous Video Editing** — understand natural-language editing instructions, analyze media, generate a timeline, render, inspect the output, and deliver video.

The platform must combine:

- **Shared execution authority:** task lifecycle, model calls, scheduling, permission, budgets, durable state, trusted process execution, cancellation, recovery, and completion gating.
- **Independent domain intelligence:** each domain owns its semantic model, goal interpretation, planning quality, evidence interpretation, and verifier.
- **Typed domain execution:** domain tools use a shared admission/Host boundary but have separate capabilities and artifacts.

The product is not two agents joined by a common UI. It is one Kernel that hosts separate domain workflows. The detailed proposal is [Unified domain architecture](domain-architecture.md).

## 2. Architectural principles

1. **One shared Kernel.** Both domains use the same authoritative Task, model, tool, budget, Journal, Host, recovery, and completion controls.
2. **Separate domain cognition.** Coding uses RepositoryModel; Video uses MediaProjectModel. Their planners, evidence semantics, and verifiers remain independent.
3. **Orchestration proposes; Kernel commits.** Semantic interpretation and technical strategy are adaptive. State, budget, permission, admission, and completion are deterministic.
4. **Common contracts, typed payloads.** GoalContract and PlanRevision share lifecycle and authority envelopes; domain-specific payload schemas are versioned and validated without importing their semantics into Kernel.
5. **Workflow Profiles bind domain behavior.** Each Task binds one immutable domain/profile version, tool snapshot set, resource policy, and verification obligations.
6. **All side effects use one trusted path.** Domain tools do not bypass Kernel admission, Tool Runtime, or Trusted ToolHost.
7. **Evidence before completion.** A tool exit code or model statement is not proof that the domain deliverable satisfies the user's request.
8. **Artifacts are versioned.** Code changes and media timelines/renders are immutable, provenance-bound artifacts with explicit lineage.
9. **Context is a projection, not authority.** RepositoryModel, MediaProjectModel, EvidenceGraph, summaries, and memory cannot rewrite execution facts.
10. **No implementation topology is implied.** Logical responsibilities may be separately testable modules without becoming microservices.

## 3. Three architectural layers

| Layer | Responsibility | Must not own |
| --- | --- | --- |
| Shared Agent Kernel | Task/Turn/Step, GoalContract/PlanRevision envelopes, Model Gateway admission, Context Engine infrastructure, Tool Runtime, Permission, Budget, Journal, Host receipts, cancellation, recovery, Completion Guard, delivery | Domain semantic models, technical plan quality, narrative/pacing judgment |
| Domain Intelligence | Domain goal interpretation, domain model, evidence semantics, planning/replanning, debugging/repair, criterion selection, verification decisions | Direct provider calls, direct side-effect execution, authoritative Kernel state writes |
| Domain Execution | Domain-specific tools, media/code adapters, artifact creation, render/build/test operations under common execution controls | Permission grants, task state, plan activation, completion authority |

## 4. Shared Kernel responsibilities

The Kernel remains the sole authority for:

- Task, Turn, runtime Step, ModelStep, ModelAttempt, ActionProposal, and ToolInvocation state;
- accepted GoalContract/PlanRevision versions, PlanStep work/verification state, and legal transitions;
- deterministic contract validation, protected-field confirmation references, and plan-switch barriers;
- Model Gateway request admission, response settlement, hard model budgets, and cancellation ordering;
- ToolInvocation identity, immutable tool-definition snapshots, policy/capability/approval checks, hard resource reservations, and durable intent;
- Tool Runtime admission/scheduling/fencing and Trusted ToolHost process execution boundary;
- Kernel Journal, Host Ledger/receipt reconciliation, UNKNOWN outcomes, and recovery;
- generic artifact identity, digest, provenance, lineage, and delivery references;
- VerificationReport binding and deterministic Completion Guard checks.

The resource ledger must be able to represent more than model tokens: wall time, CPU, memory, disk, GPU where applicable, input media volume/duration, and output size are candidate dimensions. Exact resource enforcement remains open until researched and implemented.

## 5. Domain Intelligence and Context Engine

The two domains have distinct models:

| Domain | Model | Domain intelligence | Domain verifier |
| --- | --- | --- | --- |
| Coding | RepositoryModel | Repository reconnaissance, dependency-aware code plan, implementation, hypothesis-driven debugging | Tests/build/static analysis/API/security and code review evidence |
| Video Editing | MediaProjectModel | Media analysis, story/pacing interpretation, source-range selection, timeline generation/revision | Timeline, probe/decode, audio/video integrity, content and perceptual review |

Context Engine supplies shared provenance, retrieval, freshness, checkpoint, compaction, and version-binding infrastructure. It hosts separate projections; it does not create a universal semantic model.

## 6. Workflow Profiles and DomainBinding

Each Task binds one immutable Workflow Profile version. The profile selects:

- domain and contract/schema versions;
- GoalContract domain payload and PlanStep kinds;
- domain context projections and evidence types;
- tool-definition snapshots and effect/conflict declarations;
- resource dimensions, hard limits, and verification/repair reserve;
- criterion-to-evidence mapping and required assurance level;
- output artifact and delivery requirements;
- cancellation/recovery rules for long-running operations.

The profile can narrow available capabilities but cannot grant permission. Kernel still checks current principal, policy, approval, budget, workspace/project, and fencing at each invocation.

A profile change is not a prompt edit. It creates a new binding candidate and triggers impact analysis; protected scope/capability/evidence changes require confirmation and a safe plan switch.

See [Domain Workflow binding contract](../contracts/domain-workflow.md).

## 7. High-level execution path

1. Application submits a task and immutable user-intent reference.
2. Kernel admits the Task and binds the selected DomainBinding/Workflow Profile.
3. Domain Intelligence proposes a GoalContract with a typed domain payload; material ambiguity is clarified.
4. Context Engine builds the appropriate domain projection: RepositoryModel or MediaProjectModel.
5. Domain Intelligence proposes a PlanRevision using the shared PlanRevision envelope and typed domain PlanSteps.
6. Kernel validates and safely activates the revision; a subsequent revision uses freeze → drain → reconcile → refresh → validate → atomic activate.
7. Context Engine assembles a version-bound Execution Context.
8. Model Gateway runs a Kernel-managed ModelStep; Orchestration proposes an ActionProposal.
9. Kernel independently admits each ToolInvocation under current policy, approval, capability, budget, domain profile, and fencing.
10. Tool Runtime dispatches admitted work through Trusted ToolHost.
11. Host records physical process/job facts and returns receipt, artifacts, and output evidence; UNKNOWN is reconciled rather than blindly retried.
12. Domain Intelligence updates its model and decides continue, debug, replan, ask, wait, verify, or stop.
13. Domain verifier produces criterion-specific evidence; Completion Guard checks the common VerificationReport envelope and current bindings.
14. Delivery publishes the domain artifact only after required evidence and finalization rules pass.

## 8. Domain execution examples

### Autonomous Coding

RepositoryModel → coding GoalContract/PlanRevision → file/Git/build/test tools → Host receipts and diffs → code verification → verified repository artifacts.

The existing [Coding Intelligent Execution design](../research/autonomous-coding-agent/design.md) remains the domain-specific cognitive proposal.

### Autonomous Video Editing

MediaProjectModel → video GoalContract/PlanRevision → MediaAsset analysis → TimelineRevision → RenderPlan → FFmpeg RenderJob → probe/decode/content verification → video and timeline delivery.

The first phase is automatic editing, not a manual visual editor. See [Video Editing domain design](../research/multimedia-domain-architecture/design.md).

## 9. Authority and evidence boundaries

- Kernel Journal and reconstructable aggregates are authoritative for Task, accepted plans, ModelSteps/Attempts, ToolInvocations, budgets, and completion.
- Trusted ToolHost Host Ledger and authenticated receipts describe physical process/job execution; Kernel reconciles them.
- Workspace/project snapshots and content hashes are authoritative only within their declared scope and Host evidence.
- RepositoryModel, MediaProjectModel, EvidenceGraph, timeline candidates, render plans, context packs, model output, and summaries are projections/candidates, not execution authority.
- Domain Intelligence decides semantic adequacy; Kernel validates typed contracts and authority.
- A RenderJob's progress and exit code do not prove the video meets the GoalContract. A coding tool's successful exit does not prove code acceptance criteria passed.
- Kernel Journal and Host Ledger remain separate fact boundaries; there is no distributed atomic transaction spanning Kernel state and physical side effects.

## 10. Core invariants

1. One Kernel owns authoritative task and execution state for both domains.
2. Each Task is bound to one domain and Workflow Profile version at a time.
3. Domain Intelligence cannot write Kernel state or bypass Model Gateway/Tool Runtime/Host.
4. Kernel does not interpret RepositoryModel or MediaProjectModel semantics.
5. Every side effect has independent ToolInvocation identity, admission, budget, durable intent, Host receipt, and outcome.
6. UNKNOWN is not FailedKnown and cannot trigger blind retry.
7. Cancellation is a convergence protocol, not a UI flag or a claim that side effects were rolled back.
8. Domain artifacts are versioned and provenance-bound; user revisions create new versions.
9. Completion requires criterion-linked evidence bound to the current GoalContract, PlanRevision, DomainBinding, and final artifact snapshot.
10. A successful loop stop, command exit, or renderer exit is not Task completion.
11. Multi-Agent / D9 and a full Video Editor remain out of scope.
12. Current work is documentation/research only; Runtime development is not authorized.

## 11. Deployment principle

The initial design does not assume microservices. Application, Orchestration, Kernel, Gateway, Context Engine, and Tool Runtime may begin as separately testable responsibilities in one application process. Trusted ToolHost must retain a real process/OS trust boundary from untrusted tool code.

Concrete process topology, runtime, language, database, sandbox product, media-analysis models, and deployment model remain **OPEN**.

## 12. Explicit non-goals for this baseline

- No old Kernel source is treated as the implementation foundation.
- No technology stack is selected by implication.
- No production readiness or security certification is claimed.
- Multi-Agent / D9 remains deferred and unauthorized.
- No full Video Editing workstation or manual timeline editor is included in the first phase.
- No package list or microservice topology is mandated by the cognitive design.
- No runtime implementation, dependency addition, real-model benchmark, external media processing, or legacy code migration is authorized by this architecture draft.
