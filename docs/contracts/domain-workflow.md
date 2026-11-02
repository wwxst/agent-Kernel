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

The DomainBinding is immutable for the life of an accepted Task version. A profile change creates a new binding candidate and triggers GoalContract/PlanRevision impact analysis. If it changes scope, capabilities, resource authority, or evidence obligations, it must pass the same user-confirmation and plan-switch rules as any other protected change.

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

All model calls are Kernel-managed ModelSteps regardless of domain. Model purpose labels may include domain-specific purposes, but do not create new authority.

Every tool call:

1. references the active DomainBinding and Workflow Profile version;
2. references the immutable tool-definition snapshot;
3. declares effect/conflict scope, target, resource needs, and idempotency class;
4. passes Kernel policy, capability, approval, budget, workspace/project, and fencing admission;
5. receives durable intent before a possible side effect;
6. executes through the Trusted ToolHost;
7. returns Host receipt, output digest, and artifact references;
8. is reconciled into Kernel state and domain evidence projections.

A profile's tool allowlist is not a substitute for per-invocation admission. A model response or domain planner cannot authorize itself.

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
