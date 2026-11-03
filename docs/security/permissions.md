# Permission, approval and tenancy contract

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; runtime claims UNVERIFIED.** This document defines who may authorize what, how an approval is consumed exactly once, and how tenant scope is enforced. It does not select an authorization policy language, identity provider or secret store.

## 1. Why this contract exists

Before this document, "approval" appeared only as a version number and a prose check (e.g. `core-protocol.md` L0/L1/L2, `plan-revision.md` invocation approval). That is not implementable and leaves three concrete attacks open:

1. **Replay** — one approval re-used for a second invocation, tenant, target or argument set.
2. **Confused deputy** — a permitted component performs an action for a principal who lacks the right.
3. **Self-approval** — the implementer identity grants its own elevation.

A strategy, profile, tool schema or model statement is **never** a permission. Only the records below are.

## 2. Principals

| Kind | Examples | May |
| --- | --- | --- |
| `user` | end user in a session | request tasks, clarify, approve within granted capability, cancel, revoke |
| `operator` | deployment owner | activate/revoke profiles and Hosts, set risk policy, resolve safety holds; cannot self-approve its own effectful task |
| `reviewer` | independent/human reviewer | issue `NoBlockingFinding`/`BlockingFinding`/human disposition for criteria; may not admit invocations |
| `service` | Kernel, Gateway, Host, Orchestrator | perform only its contract actions; identities are pairwise distinct and authenticated |
| `policy` | versioned rule set, not a person | deterministic decisions (deny/allow by rule); never invents scope |

Every principal has `principal_id` (immutable), `kind`, `tenant_id`, `authority_epoch`, `status` (`Active|Suspended|Revoked`), and an authenticator reference. A principal belongs to exactly one tenant in the initial scope. Kernel never derives a principal from model output, retrieved text or an argument field.

## 3. Capability grants

A `CapabilityGrant` is the only way authority is widened:

`{grant_id, version, tenant_id, principal_id, capability, scope, constraints, issued_by, issued_at, expires_at, authority_epoch, revocation_epoch?, status: Active|Expired|Revoked}`

- `capability` is a closed enum: `task.create`, `task.cancel`, `plan.structural_change`, `approval.grant`, `artifact.read`, `artifact.publish`, `host.launch`, `profile.activate`, `profile.revoke`, `hold.resolve`.
- `scope` narrows by: task, domain, profile, tool set, target (workspace/project/document/host), artifact digest, path prefix, network destination class.
- `constraints` may narrow but never widen: effect class ceiling (≤ global policy), resource ceiling, time window, tenant.
- Grants are **not inheritable**: a child task, consumer domain or delegated principal receives a separate grant. No approval, token, context or budget is inherited across a handoff.
- Revocation advances `authority_epoch` and immediately blocks new admission for the scope; already-launched work follows the Host fence/drain policy ([Trusted Host](../security/trusted-host.md)).

## 4. Approval request and decision

An approval is a durable two-party record, not a boolean.

`ApprovalRequest`: `{approval_request_id, tenant_id, task_id, invocation_id?, request_summary, tool_digest, args_digest, effect_class, target, risk_class, requested_by, approver_class, created_at, expires_at, max_uses: 1, status: Requested|Granted|Denied|Expired|Revoked}`

`ApprovalDecision`: `{approval_id, approval_request_id, approver_principal_id, approver_class, tenant_id, decision, scope_digest, args_digest, authority_epoch, decided_at, expires_at, nonce, consumed_by_invocation_id?, consumed_at?, status: Granted|Denied|Expired|Revoked|Consumed}`

Rules:

1. **One use.** `max_uses` is exactly 1 in v1. Consumption is a K-local CAS on the approval record together with `InvocationAdmitted`; a design that consumes at the Host is invalid because a second Host could reuse it. A consumed approval never returns to `Granted`.
2. **Binding.** The decision binds tenant, task, exact tool digest, exact canonical argument digest, effect class and target. Any mismatch is `ApprovalScopeMismatch`, not a new approval.
3. **Separation of duties.** The approver must not be the principal or service that authored the action, must not be the implementer identity for the same criterion, and must satisfy the required `approver_class` (e.g. `user`, `reviewer`, `operator`). Self-approval is denied even if the principal holds `approval.grant`.
4. **Freshness.** Approval is revalidated at admission and at the Host gate against current `authority_epoch`, profile version and expiry. Expired, revoked or epoch-stale approval denies launch. No silent renewal: renewal is a new request/decision pair.
5. **Denial is durable.** A denied request is recorded and returned; a denial is not a transient error and cannot be retried with the same identity.
6. **An approval cannot expand the plan envelope.** If the action exceeds the accepted plan's effect/scope/risk envelope, the correct path is L2 structural replanning, not an approval.
7. **`human` criterion dispositions are separate** from tool approvals: they are evidence-bearing review records (see [Completion](../contracts/completion.md)), bound to criterion id, artifact digest and reviewer independence.

## 5. Admission check order (deterministic)

Kernel evaluates in this order and stops at the first failure. The order is normative because it determines the audit code and whether a reservation is created.

1. Tenant/principal active and authenticated; tenant matches task, binding and target.
2. Command idempotency and aggregate version.
3. Capability grant covers the action's scope and constraints.
4. Profile/strategy/DomainBinding version current; effect class allowed by policy.
5. Per-invocation approval, when required, unconsumed and in scope.
6. Budget reservation admissible (`spent + outstanding_max + proposed_max ≤ limit`).
7. Conflict scope free or explicitly serialized per strategy.
8. Read-set (goal/plan/authority/workspace/project/budget/tool/precondition) current.
9. Durable intent + outbox committed (the admission transaction).

A failure after step 6 must release nothing implicitly: if a reservation was created and admission later fails, the reservation is explicitly released in the same K transaction, or retained with a typed hold. Half-admitted state is forbidden.

## 6. Tenancy isolation

- Every Task, artifact, evidence record, journal entry, budget scope, Host run and grant carries `tenant_id`; it is immutable and never reused.
- Kernel queries are tenant-scoped by construction; a cross-tenant read is a protocol violation even for an operator, who uses an audited break-glass capability with explicit approval and a separate audit trail.
- Cross-domain handoff within one tenant still requires a `ScopedReadGrant`. Cross-tenant handoff is **not supported in v1**.
- Hosts are bound to one tenant in the initial deployment. A shared Host requires a separate isolation proof and is deferred.

## 7. Denial and error codes

`PermissionDenied`, `TenantMismatch`, `CapabilityMissing`, `CapabilityExpired`, `SelfApprovalForbidden`, `ApproverClassMismatch`, `ApprovalMissing`, `ApprovalExpired`, `ApprovalRevoked`, `ApprovalConsumed`, `ApprovalScopeMismatch`, `EffectClassDisabled`, `EpochStale`, `DelegationDepthExceeded`.

Every denial emits a security event with principal, tenant, action, scope digest and reason. Denials are auditable even when no side effect occurred.

## 8. Delegation

- Delegation is explicit: a grantor with `approval.grant` may issue a narrower grant to another principal, depth ≤ 1, expiry ≤ grantor's expiry, scope ⊂ grantor's scope.
- Delegation never transfers a human-review obligation, an approver-class requirement, or a plan's protected authority.
- A delegated principal cannot re-delegate in v1.
- A delegation chain is recorded on the grant; a missing link denies admission.

## 9. Conformance fixtures (design; NOT RUN)

| Fixture | Expected |
| --- | --- |
| P-1 approval replay | Same approval used for a second invocation → `ApprovalConsumed`, no admission |
| P-2 argument swap | Approval for args A, invocation for args B → `ApprovalScopeMismatch` |
| P-3 cross-tenant | Approval from tenant A used in tenant B → `TenantMismatch`, security event |
| P-4 self-approval | Author approves own R1 action → `SelfApprovalForbidden` |
| P-5 epoch revocation | Grant revoked, then a queued admission → `EpochStale`; Host ticket rejected at gate |
| P-6 expired at gate | Approval valid at admission, expired before spawn → Host rejects, Invocation `Rejected(GrantExpired)` with no side effect |
| P-7 delegation depth | A→B→C chain → `DelegationDepthExceeded` |
| P-8 operator break-glass | Operator cross-tenant read → audited, requires separate approval, task-level operation denied |
| P-9 no-approval-needed R0 | Read-only inspect with current capability → admitted once, no approval record created |
| P-10 plan-envelope escape | Approval attempts to widen capability beyond accepted plan → rejected, L2 required |

## 10. Deliberately deferred

- Authorization policy language, IdP integration, SCIM, SSO and secret storage.
- Multi-tenant shared Hosts and tenant-level resource quotas (see [Data model](../contracts/kernel-data-model.md) resource dimensions).
- Automated approver selection, risk scoring and approval UX.
- Delegation depth > 1 and organizational role hierarchies.
