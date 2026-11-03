# Domain Workflow binding contract

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); design-only for Office; implementation NOT started; runtime claims UNVERIFIED.**
>
> The one-Kernel/two-domain product direction is approved. This document remains authoritative for Workflow Profile authority, DomainBinding lifecycle, revocation and cross-domain ScopedReadGrant; field shapes are owned by [Kernel data model](kernel-data-model.md) and per-domain execution policy by [Execution Strategy](execution-strategy.md).

## 1. Purpose

A Workflow Profile selects the domain-specific schemas, cognitive policy, tool capabilities, resource envelope, artifact vocabulary, and verification obligations for one Task.

The profile prevents the Kernel from importing domain semantics while ensuring that every model request, plan, tool invocation, artifact, and completion report is evaluated against one consistent domain contract.

A Workflow Profile is not an Agent, security principal, plugin runtime, or permission grant.

## 2. DomainBinding

Every Task has exactly one active DomainBinding in the initial platform scope.

Field shapes, enums and identifier semantics are owned by [Kernel data model §3.4](kernel-data-model.md); they are not restated here. A binding carries at minimum: domain and profile identity/version/digest; the contract/schema version map (goal, plan, evidence, artifact, tool); the immutable tool-snapshot digest; `strategy_ref`; `resource_policy_ref`; `verification_policy_ref`; `authority_epoch`; and status/provenance including the activation event.

Every one of these must be **declared or referenced by id in the DomainManifest** ([Domain Extension §2](domain-extension.md)); a profile field the manifest neither declares nor references is not bindable, and registration fails closed.

The domain_id is immutable for the lifetime of a Task. Changing from Coding to Video Editing (or vice versa) requires a new Task and an explicit artifact handoff; it is not a profile migration. The DomainBinding/profile version is immutable for an accepted Task/plan version. A same-domain profile change creates a new binding candidate and triggers GoalContract/PlanRevision impact analysis. If it changes scope, capabilities, resource authority, or evidence obligations, it must pass the same user-confirmation and plan-switch rules as any other protected change.

## 3. Workflow Profile

A profile declares:

- supported domain and contract versions;
- the bound ExecutionStrategy reference and the Host enforcement profiles the profile requires;
- domain GoalContract payload schema and criterion vocabulary;
- domain PlanStep payload kinds and artifact outputs;
- domain context projections and their freshness/invalidation rules;
- tool capability manifest and immutable tool snapshot references;
- each tool's effect class, conflict scope, resource needs, idempotency class, and approval requirements — the declared effect class is a **proposal** that Kernel re-derives from the digested tool definition, canonical arguments and target, rejecting any mismatch;
- hard budget dimensions and verification/repair reserve;
- criterion-class-to-evidence requirements and evidence-independence classes, expressed as `verification_policies[]` entries with explicit policy id/version — never a policy-free class;
- render/build/analysis environment requirements where applicable;
- delivery artifact kinds, publication gate and post-delivery retention rules;
- cancellation, process convergence, recovery, and UNKNOWN reconciliation rules.

A profile can narrow available tools and capabilities. It cannot expand the user's authorization or override Kernel policy. Kernel combines the profile's declared limits with the current principal, capability, approval, policy, budget, workspace/project, and fencing state at each admission. The profile's `verification_policies[]` is the **sole owner** of required evidence class, independence floor and human gates; the bound strategy may add review triggers and tighten thresholds, never restate, weaken or lower them ([DES §2–§3](execution-strategy.md)).

### 3.1 Profile lifecycle, current-effective authority, and revocation

A Workflow Profile version is immutable and content-digested. The registry lifecycle is logically Draft → Validated → Active → Superseded, with RevocationPending and Revoked authority states for a withdrawal. Superseded/revoked versions remain addressable for historical provenance but cannot authorize new work. RevocationPending means new Kernel admission/ticket issuance have stopped and Host fences are being installed. A **previously issued** valid ticket may still cross a locally authorized Host gate before HostFenceInstalled, but never offline and never after its local fence installation. Request acceptance alone is not retroactive physical revocation.

**One activation authority.** Registering a DomainManifest creates candidates only; activation, supersession and revocation are the single registry lifecycle for manifest, profile and strategy, performed by an `operator` principal holding `profile.activate` / `profile.revoke` ([Permissions §3](../security/permissions.md)). There is no adapter-side or second activation path. Changing a manifest, profile, strategy or adapter-artifact digest on a live Task is a structural L2 change under the migration protocol in this section — never an in-place binding rewrite.

Profile activation, supersession, and revocation advance a monotonic `authority_epoch` for each affected invocation-authority scope. The same epoch advances when any revocable launch prerequisite changes, including principal, capability, policy, approval, or an equivalent grant. The immutable DomainBinding records the exact profile ID/version/digest and is never rewritten by authority changes. A separate current authority record references that binding and carries the current `authority_epoch`. Each dispatch ticket also binds the exact authority-version vector; workspace/project generation and budget-reservation version remain explicit execution-snapshot fields. A ToolInvocation records the exact binding/profile and epoch under which it was admitted. Completed operations, artifacts, and evidence retain that historical version; they are never rewritten to the latest profile.

The accepted PlanRevision's profile pin is a provenance and compatibility binding, not perpetual permission to launch tools. Kernel Admission checks the current K authority; **physical Host launch checks the current effective locally installed authority** plus a live, bounded and authenticated grant at the serialized local gate. They do not share an instantaneous cross-system atomic snapshot. The respective checks establish that:
- the invocation references the effective Active profile version/digest, the respective current **K admission** or **H-installed launch** `authority_epoch`, and the exact bound authority-version vector;
- the accepted PlanRevision and DomainBinding still match that profile;
- current principal, capability, approval, policy, budget-reservation version, workspace/project generation, and fencing checks pass.

A queued or admitted-but-not-launched invocation must be rejected at dispatch if the Host has installed a fence or invalidation after its ticket epoch, if local profile/authority or proven workspace/reservation generation no longer matches, or if no live-bound launch proof is available. K RevocationRequested before H fence is an acknowledged in-flight race rather than proof of a forbidden launch. A stale dispatch authorization cannot be replayed. If current authority cannot be established, Host launch fails closed. An old accepted plan cannot bypass revocation by presenting its historical approval.

A revocation request atomically advances the desired `authority_epoch` in Kernel and blocks new admission and dispatch-ticket issuance for profile, principal, capability, policy, and approval revocations; physical Host fencing is acknowledged separately. Any concurrent launch is ordered by the Host LaunchGate described in Section 3.2: a launch boundary committed before the authority fence is treated as already in flight; a fence committed first rejects the old ticket without process creation. After the Host-local fence is installed, no queued/admitted invocation under the old epoch may launch on that Host. For operations already across the launch boundary, the predeclared revocation policy determines graceful drain versus cancellation request. A cancellation request is not process convergence; the Host must reconcile descendants and writable handles. An invocation in UNKNOWN blocks migration, replay, and conflicting new side effects until reconciled; changing the profile cannot clear that hold.

A same-domain migration uses freeze → stop admission → drain/reconcile → refresh → compatibility/impact validation → required user confirmation → new DomainBinding and accepted PlanRevision activation. No old PlanRevision is silently rebound. New operations begin only after the new binding is current. A Coding ↔ Video change always requires a new Task and explicit artifact handoff.

**Additional risk-policy constraint (owner ratification pending; provisional defaults in ARB-01.6):** revocation of already issued tickets is physically effective only when the Host-local fence is installed, the authenticated launch grant expires at the spawn boundary, or Host launch ability is verifiably disabled. An Owner must choose acceptable bounded request-to-fence exposure and grant lifetime/clock assumptions per effect class. Reversible isolated writes need an approved window; destructive/irreversible/high-impact external effects remain **disabled by default** until an Owner accepts a verified bounded window or separately proves a stronger online launch protocol. Revoke request does not imply ProcessConverged. See [Trusted Host risk policy](../security/trusted-host.md) and [Open decisions](../decisions/open-decisions.md).

### 3.2 Dispatch and revocation ordering — single-Host scope (construction baseline)

The Host performs **physical** dispatch only on an exact one-use ticket and live, coherent **Host-installed** effective authority. Three separate events apply:

- `Kernel.RevocationRequested`: stop new relevant admission/ticket issuance immediately and advance the **desired** epoch. Enter RevocationPending; this does not retroactively revoke already issued tickets at a remote Host.
- `Host.HostFenceInstalled`: one durable local gate event ordered with physical OS process creation. A ticket of an older epoch is rejected **after local installation**. A ticket crossing the local launch boundary *after Kernel request but before Host fence installation* remains a permitted in-flight launch, subject to declared cancellation/drain.
- `Kernel.Revoked`: only after verified fence ACK/disablement from every eligible Host gate. This does not imply physical process convergence, which requires its own Host evidence.

At the gate, a trusted Host-local authority snapshot and scope/Host/incarnation-bound time-limited grant/live channel must prove exact authority/profile/version vector, invocation, workspace generation, reservation, deadline and local fence sequence. All local mutations able to invalidate that proof and **OS spawn** must use the same serialized critical section; no separate check followed by delayed spawn. Independent remote reads, cached tickets or offline grants alone are insufficient. A Host without a provable live-authority path must reject effectful launch. This local proof does not claim instantly linearizable awareness of the latest Kernel request. See [Trusted Host](../security/trusted-host.md).

The Host durably consumes nonce + LaunchAttempt + DispatchInbox dedup before spawn in H-local persistence; OS spawn is non-atomic with that transaction and ambiguous results remain OutcomeUnknown. Host reconnect/restart reconciles Host Ledger/process/target facts without replaying nonce. A partitioned Host unable to prove disablement leaves Kernel RevocationPending. Multi-Host ordering remains OPEN.

Same-domain profile migration still fences old tickets, drains/reconciles started or UNKNOWN conflicting side effects, validates impact, obtains required user confirmation, then atomically installs the new DomainBinding/PlanRevision at Kernel. A plan/profile pin cannot grant a revoked capability. Invocation-level approvals within the unchanged plan are handled by per-invocation admission, not profile migration.

## 4. Common GoalContract envelope

The shared GoalContract retains the existing immutable UserIntent, append-only clarification, versioning, protected-field confirmation, provenance, and acceptance lifecycle.

Common fields include:

- desired outcome;
- scope and exclusions;
- constraints and compatibility commitments;
- stable acceptance-criterion IDs;
- assumptions, ambiguity, risk, and user-control policy;
- domain ID and Workflow Profile binding;
- typed domain_goal_payload with schema ID/version and content digest.

Examples of domain payload responsibilities:

- Coding: repository identity, behavior/API intent, affected packages, compatibility constraints, migration and test expectations.
- Video Editing: source asset set, narrative/editing intent, target duration/aspect/output profile, inclusion/exclusion rules, audio/caption expectations, and delivery constraints.

Kernel validates that the payload conforms to the bound schema and that all references/versions are present. Domain Intelligence decides whether the payload faithfully represents the user's intent.

A protected domain-field change requires explicit confirmation unless an immutable intake-time authorization record covers the exact change.

## 5. Common PlanRevision and PlanStep envelope

PlanRevision remains the existing immutable, versioned dependency graph and uses the current freeze/drain/reconcile/refresh/validate/atomic-activate protocol.

A domain PlanStep contains:

- generic objective, dependencies, preconditions, expected artifact references, criterion links, effect/risk, capability needs, evidence obligations, verification, and recovery;
- a typed domain_step_payload with schema ID/version;
- DomainBinding and GoalContract version references.

Examples:

- Coding step kinds: inspect dependency graph, edit implementation, run targeted tests, repair regression, verify API compatibility.
- Video step kinds: probe source assets, analyze shots/audio, select source ranges, build a timeline revision, render, inspect rendered output.

Kernel checks the schema, identity/version bindings, DAG, declared capability/effect envelope, budget, and legal state transition. It does not judge whether a code change is correct or whether the selected shots tell a coherent story.

PlanStep granularity is domain-defined, not a shared semantic unit. A Coding profile may choose fine-grained inspect/edit/test/debug steps; a Video profile may choose coarser analyze-project/build-narrative/create-timeline/render/verify steps. One PlanStep may result in zero, one, or multiple separately admitted ToolInvocations. A ToolInvocation is the unit of Kernel admission and Host side-effect accounting; it is not required to equal one PlanStep. Each invocation remains bound to the active plan/profile, effect/conflict scope, resource reservation, idempotency class, and evidence obligations. Kernel validates the generic envelope and legal lifecycle but does not split or merge domain work according to a universal granularity rule.

Video-specific NarrativePlan, moment-selection, pacing, continuity, and timeline semantics remain in the Video payload. Coding-specific repository, patch, test, and debugging semantics remain in the Coding payload. A shared DAG and evidence envelope do not imply a shared cognition model or identical verification algorithm.

## 6. Shared evidence and artifact envelopes

Evidence and artifacts share generic envelopes:

- stable ID and schema/version;
- domain/profile binding;
- source or parent references;
- content/payload digest;
- captured/created time;
- source version, environment, workspace/project generation, and freshness where applicable;
- actor/tool/Host execution provenance;
- trust/sensitivity class;
- invalidation conditions and lineage.

The payload is domain-specific. A repository test result and a media probe result are not forced into one semantic record. Both are bound by the minimum shared EvidenceRef/criterion evidence envelope and VerificationReport; a richer EvidenceGraph is optional.

Kernel Journal and Host Ledger remain separate fact boundaries. Domain projections do not replace either ledger.

## 6.1 Minimal shared orchestration (PROPOSED subtraction)

One primary Task Orchestrator loop chooses Strategic/Tactical/Assurance as decision modes. Coding and Video keep independent full domain intelligence and criterion verification. Shared PlanRevision is an **L2 structural outcome contract**, not every tactic; PlanStep WorkStatus/VerificationStatus are event-derived views. ActionProposal is a bounded immutable decision intent and not a separate execution lifecycle. A minimal EvidenceRef and criterion evidence binding suffice; EvidenceGraph can be an optional projection. Context Planning/Execution/Verification are purpose views, not separate stores. Sequential execution is default, with bounded read/disjoint parallelism only where Host conflict containment is proven. Kernel ToolInvocation Admission and trusted Host execution remain mandatory for each effectful action; no abstraction simplification grants authority.

## 7. Shared ModelStep, ToolInvocation, and Host path

All model calls are Kernel-managed ModelSteps regardless of domain. Each ModelStep/Attempt binds the Task, DomainBinding/profile version, GoalContract/PlanRevision snapshot where applicable, and context/evidence manifest. Model purpose labels may include domain-specific purposes, but do not create new authority.

Every tool call:

1. references the active DomainBinding and Workflow Profile version;
2. references the immutable tool-definition snapshot;
3. declares effect/conflict scope, target, resource needs, and idempotency class;
4. passes Kernel policy, capability, approval, budget, workspace/project, and fencing admission;
5. receives durable intent before a possible side effect;
6. executes through the Trusted ToolHost;
7. returns Host receipt, output digest, and artifact references;
8. is reconciled into Kernel state and domain evidence projections.

A profile's tool allowlist is not a substitute for per-invocation admission. A model response or domain planner cannot authorize itself. The dispatch gate rechecks the current effective profile version/digest and profile-authority epoch immediately before Host launch; admission-time approval alone is insufficient. If the revocation/current-version state cannot be verified, the Host must not launch. Every invocation and Host receipt retain the exact historical profile binding and epoch used for that operation.

A long-running Video render is represented by a domain RenderJob correlated to the exact RenderPlan and render ToolInvocation/Host run. RenderJob status is a projection across Kernel invocation state, Host physical execution facts, domain verification, and artifact publication; it is not a second state authority. See [RenderJob contract](render-job.md) and [RenderPlan security contract](render-plan-security.md).

## 8. Domain-specific context projections

Context Engine provides common provenance, freshness, retrieval, checkpoint, compaction, and version-binding facilities.

Each domain supplies a separate projection:

- Coding → RepositoryModel and coding evidence projections.
- Video Editing → MediaProjectModel and media evidence projections.

A Task loads only the projection(s) authorized by its DomainBinding. Shared session history may refer to cross-domain artifact IDs, but a domain must not interpret another domain's opaque payload as if it were its own model.

## 9. Verification and delivery

A domain verifier produces criterion-level evidence and a VerificationReport using the common envelope.

- The domain verifier decides which observations, probes, tests, and perceptual assessments are relevant to its criteria.
- Kernel Completion Guard validates report binding, evidence presence, provenance, freshness, independence class, required human disposition, workspace/project snapshot, bounded outstanding budget exposure, and absence of **conflicting effectful** UNKNOWN. Final bounded provider invoices may settle later; the reservation is retained.
- A model verifier's conclusion is not a substitute for trusted execution evidence or required human review.
- Delivery references immutable domain artifacts and the exact accepted GoalContract, PlanRevision, DomainBinding, and VerificationReport.

## 10. Initial cross-domain limits

- One Task, one domain, one Workflow Profile version at a time.
- No universal RepositoryModel/MediaProjectModel.
- No universal semantic PlanStep vocabulary.
- No domain-specific tool bypass around Kernel/Host.
- No implicit cross-domain delegation or Multi-Agent.
- No automatic profile migration while operations are active.
- A multi-domain request is an ordered set of independently authorized Tasks linked by an explicit `CompositePlan` **derived record**; a composite Task, shared execution authority, fan-out and autonomous delegation remain OPEN / DEFERRED.

## 11. Explicit cross-domain ArtifactRef handoff

A cross-domain handoff links two independently authorized Tasks; it does not create a composite Task or shared execution authority.

A handoff record binds at least:
- handoff ID and immutable source Task/domain/DomainBinding references;
- exact Artifact ID, kind, schema/version, digest, and producer provenance;
- intended consumer domain/Task, purpose, permitted access mode, and retention scope;
- user/principal authorization reference bound to the exact Artifact ID/digest, source Task, consumer domain/Task, purpose, access mode, and expiry/revocation state where applicable;
- ScopedReadGrant ID/version, consumer audience, authority/revocation epoch, issue/expiry state, and resolver access-event/receipt references;
- consumer validation result and resulting derived-artifact lineage.

ArtifactRef identifies an immutable typed artifact; it is not a bearer capability. The consumer receives a separate narrowly scoped capability for the exact artifact digest, consumer Task, purpose, and access mode. The default is read-only. Producer authorization to create an artifact does not authorize cross-domain disclosure or consumption.

The ArtifactRef carries identity/type/digest metadata only; it is not a path, signed URL, or payload locator. A trusted resolver maps the reference to payload bytes only after validating a server-side ScopedReadGrant bound to the exact handoff, artifact digest, consumer Task/DomainBinding, purpose, access mode, expiry, and revocation state. Grant material is not placed in model context or ordinary tool output.

The resolver checks authorization on payload open and before each range/stream read. It returns only the exact authorized payload and does not traverse parent, derived-from, sibling, project, workspace, or producer-Task references. Each additional artifact or onward recipient requires a separate handoff. Revocation prevents new reads and further stream/range delivery after the revocation fence; bytes already delivered or copied cannot be recalled and remain subject to the declared retention/deletion policy. Derived outputs are owned by the consumer Task and retain handoff/artifact provenance without inheriting producer authority or usage rights.


The consumer Task has its own principal, DomainBinding, Workflow Profile, GoalContract, PlanRevision, tools, approvals, budgets, and verification obligations. It may read only the explicitly handed-off payload through the scoped capability. It does not inherit the producer's approvals, permissions, profile, budgets, secrets, workspace/project access, private context projection, prompts, or model/session state. It cannot traverse the producer Task or unrelated artifacts through the reference.

Only an artifact in the consumption-eligible state defined by ADP-04 may be handed off; staging, partial, quarantined, Missing, DigestMismatch, or UNKNOWN payloads are not consumable. The exact artifact state machine remains an ADP-04 dependency and is not decided here. Changes to digest, destination, purpose, access mode, or material scope require renewed authorization and consumer validation. Revocation blocks future reads/consumption but cannot recall bytes already copied into the consumer's authorized workspace; those copies follow the declared retention/deletion policy. Handoff lineage is audit metadata, not a Task aggregate or authority transfer.

**Dependency and failure semantics.** A handoff edge used in multi-domain composition declares exactly one of: `require_success` — the consumer Task is not created until the producer reaches `Completed` and a current grant exists; or `skip_on_failed_dependency` — the consumer is created with the dependent criterion `Fail`/`Unverified`, never `Pass`. Partial consumption is **not** offered, because partial payloads are not consumable by this contract. A producer `OutcomeUnknown` creates no consumer; a producer failing after consumer completion does not reopen a terminal Task, and the `CompositePlan` delivery reports the failed step. Sequence, executor and delivery rules are in [Domain Extension §5](domain-extension.md).

The initial platform scope rejects a Task with more than one active domain binding. Composite cross-domain *task* authority, shared mixed-domain context, budget pooling, fan-out and autonomous delegation remain deferred; sequential composition of independently authorized Tasks is permitted under this section.

## 12. Executable extension-port boundary (construction baseline)

The registration, `DomainManifest`, per-port contracts, typed `DecisionIntent`, canonical digest, idempotent event exchange, adapter error mapping and the Office R0/R1 validation sample are specified in [Domain Extension Contract v0.2](domain-extension.md). This document remains authoritative for Workflow Profile authority, DomainBinding lifecycle, revocation and cross-domain ScopedReadGrant, while the extension document defines how a third domain integrates **without Kernel branching on domain semantics**. A domain adapter is proposal-only: Kernel validates immutable envelope/read-set and retains all admissions, budgets, lifecycle and completion authority. The Office adapter and sequential scoped Task handoff are design-validation cases, **not** authorization to enable D9 or autonomous composite agents.
