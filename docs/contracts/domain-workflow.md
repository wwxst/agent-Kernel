# Domain Workflow binding contract

> **Status: PROPOSED cross-domain contract.** The one-Kernel/two-domain product direction is approved. This document proposes the deterministic binding contract for domain workflows; schema implementation and runtime enforcement are unverified.

## 1. Purpose

A Workflow Profile selects the domain-specific schemas, cognitive policy, tool capabilities, resource envelope, artifact vocabulary, and verification obligations for one Task.

The profile prevents the Kernel from importing domain semantics while ensuring that every model request, plan, tool invocation, artifact, and completion report is evaluated against one consistent domain contract.

A Workflow Profile is not an Agent, security principal, plugin runtime, or permission grant.

## 2. DomainBinding

Every Task has exactly one active DomainBinding in the initial platform scope.

Minimum fields:

| Field | Meaning |
| --- | --- |
| domain_id | Stable domain identifier, initially coding or video_editing |
| workflow_profile_id | Stable profile identifier within the domain |
| workflow_profile_version | Immutable profile version |
| domain_contract_version | Version of the domain payload and artifact contracts |
| goal_schema_id/version | Schema used for the typed GoalContract domain payload |
| plan_schema_id/version | Schema used for typed PlanStep payloads |
| evidence_schema_set | Domain-specific evidence kinds and schema versions |
| artifact_schema_set | Domain-specific artifact kinds and schema versions |
| tool_snapshot_set | Immutable tool-definition snapshot references admitted by the profile |
| verification_policy_id/version | Criterion evidence and assurance policy |
| resource_policy_id/version | Hard resource dimensions, limits, and reservation policy |
| provenance | Profile source, owner/approval reference, digest, and activation event |

The domain_id is immutable for the lifetime of a Task. Changing from Coding to Video Editing (or vice versa) requires a new Task and an explicit artifact handoff; it is not a profile migration. The DomainBinding/profile version is immutable for an accepted Task/plan version. A same-domain profile change creates a new binding candidate and triggers GoalContract/PlanRevision impact analysis. If it changes scope, capabilities, resource authority, or evidence obligations, it must pass the same user-confirmation and plan-switch rules as any other protected change.

## 3. Workflow Profile

A profile declares:

- supported domain and contract versions;
- domain GoalContract payload schema and criterion vocabulary;
- domain PlanStep payload kinds and artifact outputs;
- domain context projections and their freshness/invalidation rules;
- tool capability manifest and immutable tool snapshot references;
- each tool's effect class, conflict scope, resource needs, idempotency class, and approval requirements;
- hard budget dimensions and verification/repair reserve;
- criterion-to-evidence requirements and evidence-independence classes;
- render/build/analysis environment requirements where applicable;
- delivery artifact kinds and post-delivery retention rules;
- cancellation, process convergence, recovery, and UNKNOWN reconciliation rules.

A profile can narrow available tools and capabilities. It cannot expand the user's authorization or override Kernel policy. Kernel combines the profile's declared limits with the current principal, capability, approval, policy, budget, workspace/project, and fencing state at each admission.

### 3.1 Profile lifecycle, current-effective authority, and revocation

A Workflow Profile version is immutable and content-digested. The registry lifecycle is logically Draft → Validated → Active → Superseded, with RevocationPending and Revoked authority states for a withdrawal. Superseded/revoked versions remain addressable for historical provenance but cannot authorize new work. RevocationPending means new admission and ticket issuance have stopped while all Host launch gates are being fenced; it is not a state in which an old ticket may be trusted offline.

Profile activation, supersession, and revocation advance a monotonic AuthorityFenceEpoch for each affected invocation-authority scope. The same epoch advances when any revocable launch prerequisite changes, including principal, capability, policy, approval, or an equivalent grant. The active DomainBinding records the exact profile ID/version/digest and current epoch. Each dispatch ticket also binds the exact authority-version vector; workspace/project generation and budget-reservation version remain explicit execution-snapshot fields. A ToolInvocation records the exact binding/profile and epoch under which it was admitted. Completed operations, artifacts, and evidence retain that historical version; they are never rewritten to the latest profile.

The accepted PlanRevision's profile pin is a provenance and compatibility binding, not perpetual permission to launch tools. Both Kernel admission and the physical Host dispatch boundary must establish that:
- the invocation references the current effective Active profile version/digest and current authority epoch;
- the accepted PlanRevision and DomainBinding still match that profile;
- current principal, capability, approval, policy, budget, project/workspace, and fencing checks pass.

A queued or admitted-but-not-launched invocation must be rejected at dispatch if the profile was revoked/superseded or its authority epoch changed after admission. A stale dispatch authorization cannot be replayed. If current authority cannot be established, Host launch fails closed. An old accepted plan cannot bypass revocation by presenting its historical approval.

A revocation request immediately blocks new admission and dispatch-ticket issuance. Any concurrent launch is ordered by the Host LaunchGate described in Section 3.2: a launch boundary committed before the authority fence is treated as already in flight; a fence committed first rejects the old ticket without process creation. After the fence commits, no queued/admitted invocation under the old epoch may launch. For operations already across the launch boundary, the predeclared revocation policy determines graceful drain versus cancellation request. A cancellation request is not process convergence; the Host must reconcile descendants and writable handles. An invocation in UNKNOWN blocks migration, replay, and conflicting new side effects until reconciled; changing the profile cannot clear that hold.

A same-domain migration uses freeze → stop admission → drain/reconcile → refresh → compatibility/impact validation → required user confirmation → new DomainBinding and accepted PlanRevision activation. No old PlanRevision is silently rebound. New operations begin only after the new binding is current. A Coding ↔ Video change always requires a new Task and explicit artifact handoff.

### 3.2 Dispatch and revocation linearization

AdmissionTicket proves that Kernel admitted a specific invocation at a point in time; it is not perpetual permission to launch. A dispatch ticket is short-lived, one-use, and bound to the exact invocation, profile ID/version/digest, AuthorityFenceEpoch, accepted PlanRevision, tool snapshot, argument digest, principal/capability/policy/approval version vector, workspace/project identity and generation/snapshot digest, budget reservation ID/version, Host target, fencing epoch, expiry, and nonce.

The Trusted ToolHost implements an abstract serialized LaunchGate. Physical process creation and AuthorityFenceEpoch advancement must share one linearizable ordering boundary for the affected invocation-authority scope. The gate validates the current epoch and exact authority-version vector, workspace/project generation, and live budget reservation at that boundary. It must not validate a ticket from a cache and then spawn later outside that boundary.

The LaunchGate has two mutually exclusive outcomes:
1. If physical process creation crosses the launch boundary before the new authority fence commits, the Host records LaunchBoundaryCommitted under the old epoch. That invocation is considered already in flight for revocation policy purposes, even if its completion receipt is delayed.
2. If the authority fence commits first, the old dispatch ticket is rejected and no process is created.

The Host receipt binds the invocation, Host run/process identity, ticket identity, profile digest, authority epoch, fencing epoch, launch-boundary sequence, and timestamp.
Before process creation, the Host durably consumes the one-use ticket nonce and records a unique LaunchAttempt in its Host Ledger. Ticket consumption, the launch attempt, process creation, and authority-fence advancement are serialized by the LaunchGate. A duplicate or replayed ticket is rejected even after Host restart. If the Host crashes after durable consumption but before process creation, the ticket remains consumed and the invocation must be reconciled before any replacement ticket is issued; if process creation may have occurred without a durable receipt, preserve UNKNOWN.
 If the Host cannot prove the ordering, it must not launch new work; an uncertain process/output outcome remains UNKNOWN until reconciliation. A crash after process creation but before receipt persistence must never be treated as proof that no process started.

A revocation request advances the affected AuthorityFenceEpoch and stops new Kernel admission and dispatch-ticket issuance. Profile, principal, capability, policy, and approval revocations all invalidate tickets bound to older authority versions. The affected authority remains RevocationPending until every Host gate that could accept an old ticket has acknowledged the new fence or has been verifiably disabled from dispatch. A Host unable to contact current authority fails closed. Revoked means stale tickets can no longer cross any eligible launch gate; it does not mean already-running processes have stopped. If a Host cannot be fenced or proven disabled, the system retains RevocationPending and blocks new work rather than claiming global revocation completion.

Profile migration orders operations as: freeze the Task; stop admission and ticket issuance; advance/fence the old epoch at every eligible Host gate; wait for fence acknowledgement; drain or cancel already-launched processes under the predeclared policy; reconcile all receipts and UNKNOWN outcomes; refresh profile/contract inputs; validate compatibility and protected-field impact; obtain required user confirmation; then atomically activate the new DomainBinding, accepted PlanRevision, and new authority epoch. No new launch may occur between the old fence and new activation.


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

The payload is domain-specific. A repository test result and a media probe result are not forced into one semantic record. Both can be referenced by the shared EvidenceGraph and VerificationReport.

Kernel Journal and Host Ledger remain separate fact boundaries. Domain projections do not replace either ledger.

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
- Kernel Completion Guard validates report binding, evidence presence, provenance, freshness, independence class, required human disposition, workspace/project snapshot, budget settlement, and absence of unresolved UNKNOWN.
- A model verifier's conclusion is not a substitute for trusted execution evidence or required human review.
- Delivery references immutable domain artifacts and the exact accepted GoalContract, PlanRevision, DomainBinding, and VerificationReport.

## 10. Initial cross-domain limits

- One Task, one domain, one Workflow Profile version at a time.
- No universal RepositoryModel/MediaProjectModel.
- No universal semantic PlanStep vocabulary.
- No domain-specific tool bypass around Kernel/Host.
- No implicit cross-domain delegation or Multi-Agent.
- No automatic profile migration while operations are active.
- Cross-domain composite workflows remain OPEN / DEFERRED.

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

The initial platform scope rejects a Task with more than one active domain binding. Composite cross-domain autonomous workflows and shared mixed-domain context remain deferred pending a separate decision.
