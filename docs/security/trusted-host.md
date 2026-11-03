# Trusted ToolHost and security boundary

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; runtime claims UNVERIFIED.** No production sandbox, host identity, admission ticket, receipt or ledger-chain implementation is claimed. Record shapes are owned by [Kernel data model](../contracts/kernel-data-model.md); authorization and approval by [Permissions](permissions.md).

## 1. Threat model

Treat model output, repository files, comments, web pages, MCP responses, third-party tool results and client-supplied metadata as untrusted data. They may contain forged tool names, parameters, IDs, paths, identity claims, approvals or instructions intended to bypass policy.

Keep these principals and boundaries distinct:

- user / authenticated principal;
- application client;
- model provider and adapter;
- Kernel;
- policy and approval authority;
- Tool Runtime;
- Trusted ToolHost;
- isolated worker process;
- Kernel Persistence and Host Ledger.

Only trusted authorization components and the Host execution boundary can admit a real side effect.

## 2. Admission sequence

Before any side-effecting invocation, Kernel must validate:

1. Task / Invocation identity and ownership (Turn and runtime Step are UI-derived concepts, not bound identities).
2. Complete canonical arguments and schema.
3. Immutable tool definition and implementation identity for the current Step.
4. Principal, tenant, capability, policy, approval **records** and versions including approval consumption state, plus current `authority_epoch` ([Permissions](permissions.md)).
5. Workspace/project identity, `workspace_generation`, and content generation/hash.
6. Budget reservation and limits, plus the active `EffectPolicyId` ([Effect Admission Matrix](#212-effect-admission-matrix-v0)).
7. Host target and required isolation profile.
8. Durable Intent and stable idempotency identity.

Kernel issues a short-lived AdmissionTicket bound to the exact invocation, profile/DomainBinding digest, tool version, argument hash, principal/capability/policy/approval version vector, `authority_epoch`, workspace/project identity and `workspace_generation`, content generation/hash, Host target and incarnation, `ticket_epoch`, budget-reservation ID/version, `EffectPolicyId`, expiry and nonce. Tool Runtime cannot manufacture or widen it. Host validates it again at execution time.

**Epoch registry (normative). Exactly three counters exist; no other epoch name is valid.** Earlier drafts and sibling sections that say `AuthorityFenceEpoch`, "fencing epoch" or `fencingEpoch` refer to these counters and must be amended to the names below in the same change; an implementation must not introduce a fourth counter.

| Counter | Granularity | Advanced by |
| --- | --- | --- |
| `authority_epoch` | one **authority scope** = principal + capability + policy + approval + profile | Kernel, on any grant/approval/profile/principal change or revocation in that scope ([Permissions](permissions.md) §3) |
| `workspace_generation` | one workspace/project | Kernel record plus Host-installed fence at freeze, snapshot, publication or declared write-boundary change |
| `ticket_epoch` | value bound into one dispatch ticket | Not independent: it is the pair `{authority_epoch, workspace_generation}` plus `gate_sequence` and `host_incarnation` used for ordering at the Host gate |

**One comparison rule.** At the Host gate, a launch is rejected without process creation unless **all** hold inside the serialized critical section: `ticket.authority_epoch == locally_installed.authority_epoch`; `ticket.workspace_generation == locally_installed.workspace_generation`; the grant is unexpired under the policy clock budget; the nonce is unconsumed. "Newer" is never accepted implicitly — an unverifiable or mismatched component fails closed. Kernel admission separately compares current aggregate versions (goal/plan/profile/authority/workspace/budget/tool) in its own transaction; it never derives authority from a Host-installed epoch.

**Eligible Host set (normative).** The set is the registered, `Active` Hosts in the same tenant holding a live lease bound to their `host_incarnation`. It is an explicit registry record, not a configuration guess: a Host not in the registry can never satisfy `MarkRevoked`, and a Host removed from the registry must first be decommissioned — lease revoked, launch authority verifiably disabled (session/key withdrawn and fence installed, or the Host destroyed under operator attestation), and the evidence recorded. If a Host cannot be proven disabled, Kernel stays `RevocationPending` with a durable escalation record `{owner, deadline, evidence_refs[]}`, and no new effectful launch is admitted for the affected scope. It never becomes `Revoked` by timeout, missing ACK or absence of a reply. Escalation expiry denies launch; it does not grant it. `ProcessConverged` remains a separate Host fact.

A model statement that a tool is approved is not approval evidence.

### 2.1 Serialized Host LaunchGate — single-Host authority scope (ACCEPTED for construction v0)

An AdmissionTicket is a Kernel admission fact, **not** a physical launch permission. A short-lived one-use dispatch ticket binds ToolInvocation, exact tool/argument digests, profile/DomainBinding, authority epoch/version vector, workspace/project generation, budget reservation, target Host/incarnation, expiry and nonce. The initial authority scope has **one eligible Host launch arbiter** and a locally serialized gate; global multi-Host ordering remains unapproved.

**Three separate events and guarantees:**

| Event | Owner | Meaning and guarantee |
| --- | --- | --- |
| `RevocationRequested` and desired `authority_epoch` | Kernel transaction | Blocks any Kernel admission **transaction committed after** this record, provided admission reads the epoch inside its own serializable transaction (otherwise the guarantee does not hold and PE-1 must fail). It does **not** prove a previously issued ticket cannot still launch before Host fence installation, and it never implies cross-system immediacy. |
| `HostFenceInstalled` (`ticket_epoch`, gate sequence, Host incarnation) | Trusted Host Ledger and serialized local LaunchGate | The fence is durably installed in the **same local order** as OS process creation. No ticket with an older component can cross that Host gate **after installation**. Earlier launched operations stay in flight. |
| `Revoked` (acknowledged eligible Host set) | Kernel transaction | Only after all eligible Host gates provide verified HostFenceInstalled ACKs or verified disablement; not proof that already-started processes are terminated. `ProcessConverged` is a separate trusted fact. |

**Request-before-fence race is permitted:** `Kernel.RevocationRequested → Host.launch(old ticket) → Host.HostFenceInstalled → Kernel.Revoked` is valid if the old launch crossed the Host-local gate before fence installation. Kernel maintains `RevocationPending` throughout this interval. An `HostFenceInstalled → Host.launch(old ticket)` order is forbidden and must reject without process creation. The request and local installation do not share an atomic transaction.

**What counts as usable authority proof inside LaunchGate:** a trusted, versioned *locally effective* authorization state + authenticated, scope/Host-incarnation-bound, finite-lived execution grant or equivalent live authority channel. It must prove the immutable profile and exact invocation/arguments, current **installed local** authority epoch/version, admitted workspace/project generation, budget-reservation version, revocation policy and nonce; identify the authority source and local fence sequence; have an enforceable launch deadline; and demonstrate Host liveness/connectivity as required by its authority policy. Changes to mutable local versions or resource fences must be serialized against spawn through **the same local gate**. Independent remote reads, stale caches, a ticket alone, or an offline Host do not suffice. This is a proof about the latest **Host-installed** authority, **not** a claim that the Host sees a newly committed Kernel revocation instantly. If global immediacy is required, this protocol is insufficient and execution must not be enabled under that requirement.

**No TOCTOU launch *ordering* (not atomicity):** inside a single serialized Host critical section, (1) read/validate the local effective authority and lease/grant, expiry and conflicting input/permission/resource fences, (2) durably consume one unique nonce, persist a LaunchAttempt record and the Host DispatchInbox dedup key, and write a **run cookie** bound to the LaunchAttempt, and (3) invoke the physical process-creation operation **before releasing the gate**, ordered against HostFenceInstalled. Never validate outside the gate and later spawn. This claims *ordering*: steps (2) and (3) are not one atomic operation, so a crash between them cannot be reported as a launch. The in-gate authority/liveness check has its own bounded deadline; a check that cannot complete inside the gate window fails closed and releases the gate rather than blocking other launches. A grant expiring before the physical launch boundary, a lost required authority channel, or inability to prove local validity fails closed. The Host persists a LaunchBoundaryRecorded receipt before reporting a known Started result.

**LaunchAttempt state machine (normative; record shape in [Data model](../contracts/kernel-data-model.md)):**

`IntentDurable → Spawning → LaunchBoundaryRecorded | ProvenNotLaunched | OutcomeUnknown`

- `Spawning` is entered **after** nonce consumption and run-cookie persistence, **before** OS process creation. It is not evidence of either outcome.
- After a Host restart, the Host may record `ProvenNotLaunched` only when the run cookie is unclaimed **and** no process/handle/output evidence for that cookie or LaunchAttempt exists. Absence of a Kernel receipt is never such proof.
- `IntentDurable` alone plus a crash is `OutcomeUnknown`, not `ProvenNotLaunched`, because the same critical section continues immediately into spawn. A `ProvenNotLaunched` record allows a fresh Kernel admission for the same Invocation under a **new** nonce and ticket; it never reuses the old one.
- The nonce stays consumed in every branch. `ProcessConverged` and any output/publication evidence are separate Host facts.

**Crash and remote effects:** durable Host Ledger + OS process creation is not one atomic operation. Crash after durable nonce consumption, within spawn, or before process receipt may leave OutcomeUnknown. The consumed nonce cannot be replayed and a replacement needs reconciliation of original Invocation/process/output. Host retries its authenticated result under the original receipt identity with bounded backoff and a dead-letter/escalation deadline (unbounded redelivery is not permitted); Kernel imports via its own deduplicating Inbox. No exactly-once remote effect or multi-Host fencing claim is inferred. See [Core protocol](../contracts/core-protocol.md).

**Host not reachable:** no offline new dispatch. If a Host's old launch capability cannot be proven disabled, Kernel keeps `RevocationPending`, even when the desired epoch is already advanced. A lost Host fence ACK is reconciled from Host Ledger; never infer fence installation from a timeout.

### 2.1.1 Revocation-effective window and expiry (ACCEPTED for construction v0)

**Preserve the existing Host-local ordering guarantee; do not claim immediate physical revoke at K request.** For a previously issued live ticket, the exposure window is the interval from `K.RevocationRequested` **until the first of** (a) H-local `HostFenceInstalled`, (b) the ticket/grant's **enforceable launch deadline**, or (c) verifiable disablement of the Host's launch authority. The Host may launch inside that interval only if all original scope, signed grant, current **Host-installed** epoch, liveness and local expiry checks pass **inside the serialized gate**. No revoked operation is newly admitted at K. A wall-clock latency bound is **not established** unless both maximum grant lifetime, issued-at/expiry verification, clock uncertainty and channel-loss fail-closed behavior are proven. A signed expiry without enforceable monotonic/clock semantics is not a safety bound.

**Initial minimal expiry mechanism:** exact invocation-bound, short-lived, non-renewable-for-the-same-ticket grant plus the Host-local installed fence state. H uses monotonic elapsed-time limits for locally received grants with authenticated initial time evidence, enforces a conservative clock-skew/uncertainty budget, checks expiry at the **physical spawn boundary** and aborts if validity lapses while waiting in the critical section. Renewals are *new authenticated authority decisions*, never silent ticket lifetime extension. Network/channel loss, stale grant identity or unbounded clock uncertainty causes **fail closed to new effectful launch**. Timer expiry does not mean a process already launched has stopped: drain/cancel and ProcessConverged require separate Host evidence. Grant TTL, skew budget and fence-ACK target are policy values in the `EffectPolicyId` record, not code constants ([§2.1.2](#212-effect-admission-matrix-v0)).

**Risk-sensitive launch rule** — see the [Effect Admission Matrix](#212-effect-admission-matrix-v0) below. Risk is determined by the effective operation/tool/target/effect profile, **not by the model's label**. Higher risk cannot be downgraded by splitting commands.

### 2.1.2 Effect Admission Matrix v0

This matrix replaces the earlier open risk table's role: it is the record a deployment must hold before any effectful launch. It is **not** a measured safety result and it does not prove any claim.

| Class | Examples | Admissible only when |
| --- | --- | --- |
| **R0 Read-only bounded** | Inspect repository, inspect declared media/project metadata, no external publication | Active `EffectPolicyId` record; Host-local fence; declared read scopes; no write and no network mutation |
| **R1 Reversible isolated write** | Writes confined to a disposable workspace, isolated build/test output roots, staged non-published renders | Active `EffectPolicyId` + enforceable grant TTL + clock-uncertainty budget + fence-ACK target + fail-closed rule + per-invocation approval where the profile requires it ([Permissions](permissions.md) §4). Nothing else — no credential export, no external mutation, no publication, no final-artifact overwrite |
| **R2 High-risk or non-reversible** | Destructive operations, credential/secret export, external network mutation, production deployment, remote publication, final irreversible overwrite | **Denied in v0.** No deployment configuration enables R2; enabling it requires a separate owner decision plus a proved protocol and its own G2 evidence |

**Provisional construction defaults (PROVISIONAL POLICY VALUE — owner-ratifiable; not a measurement or certification):** grant TTL ≤ 30 s; clock-uncertainty budget ≤ 2 s; fence-ACK acknowledgement target ≤ 5 s. Each value is a field of the `EffectPolicyId` record, not a constant in code; changing any value creates a new policy version and requires the R1 envelope to be re-validated.

**No silent default.** If no active `EffectPolicyId` record covers the tenant, tool, target and effect class, admission fails closed (`PolicyDenied` / `EffectClassDisabled`) and emits a security event. A deployment may not proceed on "no window configured". An R1 policy record lacking an enforceable TTL, a clock budget, a fence-ACK target or a fail-closed rule is **invalid**, not weak: the class is not admissible with it.

**Owner ratifications still required (do not block construction of R0 or the R1 envelope above):** (a) ratify or replace the provisional TTL/skew/ACK values per class; (b) ratify the R2 map and keep it denied unless a stronger protocol is proved; (c) pre-existing process policy per class (graceful drain vs mandatory cancel/kill, descendant/writable-handle checks, what cannot be rolled back); (d) Host lease/channel/clock evidence and disablement proof; no multi-Host guarantee is approved. See [Open decisions](../decisions/open-decisions.md).

**G2 tests:** force request-before-fence with valid grant; fence-before-launch; expiry while waiting for the serialized gate; lost Host authority channel; clock skew beyond allowed bound; no active policy record; crash in `Spawning` with and without a claimed run cookie; high-risk request without approved policy; and previously launched process still writing after Revoked. PASS requires exact H Ledger gate ordering, no post-fence/expired launch, correct `RevocationPending` vs `Revoked`, correct `ProvenNotLaunched` vs `OutcomeUnknown`, safe denial of R2 and of unconfigured effects, and independent `ProcessConverged` evidence. See [Core protocol](../contracts/core-protocol.md).

### 2.2 Scoped ArtifactResolver

Artifact IDs and ArtifactRefs are identifiers, not filesystem authority. The Host resolves payload bytes through a trusted ArtifactResolver using a server-side ScopedReadGrant bound to the exact handoff, artifact ID/digest/schema, consumer Task/DomainBinding, purpose, access mode, authorizing principal and policy version, expiry, and the current `authority_epoch`. No model-supplied path, producer workspace path, signed URL, or bearer secret is accepted as a payload locator.

The resolver verifies the artifact digest and grant before opening the payload and before each subsequent range/stream read. It exposes only the exact authorized payload; it does not traverse parent, derived-from, sibling, project, workspace, or producer-Task references. Each related artifact requires a separate grant. Grant material remains outside model context and ordinary tool output.

When a grant expires or is revoked, the resolver denies new opens and stops further range/stream delivery after the revocation fence. Bytes already delivered or copied cannot be recalled and remain governed by the declared retention/deletion policy. The consumer's derived artifacts retain the source handoff/digest as provenance but do not inherit producer authority or usage rights.



## 3. Host isolation requirements

The Host is responsible for the physical execution boundary for both short commands and long-running jobs, including as applicable:

- namespace / mount / process isolation;
- filesystem allowlist and workspace confinement;
- symlink, hardlink, path traversal and mount-boundary checks;
- network restrictions and explicit destination allowlists;
- CPU, memory, process-count, wall-clock, temporary/final disk and output-size limits, plus GPU limits where available and enforceable;
- process-tree and writable-handle convergence;
- secret and credential separation;
- host identity and trustworthy receipt signing.

Linux candidates include Bubblewrap / namespaces, cgroup v2 and seccomp. These are not selected production capabilities merely because historical experiments used them. The actual enforcement path must be tested. If a required isolation control cannot be established, fail closed rather than falling back to an unrestricted host process.

## 4. Host Ledger and receipts

Host Ledger records physical facts such as request acceptance, process start, execution outcome, workspace writes, cancellation, freeze, snapshot and receipt issuance. Kernel Journal records intent, authorization, control state and references to Host evidence.

The two ledgers are separate. Reconciliation can establish what happened; it cannot make external side effects transactionally atomic with Kernel database writes.

### 4.1 Receipt signing and key lifecycle (required properties, no algorithm selected)

- Every receipt names its `key_id`; Kernel resolves `key_id` to a pinned public key from a **trust root** it holds, never from a key supplied by the Host in the same message. An unresolvable or unpinned `key_id` rejects the receipt.
- Host key material lives in a Host keystore/HSM the signing process cannot export for arbitrary use; the signing service identity is distinct from the worker process identity and from the Kernel service identity ([Permissions](permissions.md) §2).
- **Rotation overlap window:** a new key is published before use, and the old key remains verification-only for a declared overlap period. Kernel records both `key_id` and the signing-validity interval, so a receipt signed while its key was valid remains verifiable after rotation.
- **Revoked key:** a receipt signed by a revoked key is accepted only if it verifies, its signing time is inside the key's validity interval, and the key is not recorded as compromised. If the key was compromised, or the signing time cannot be established, the receipt is `Quarantined` and cannot support completion; a re-issued receipt must be signed with a currently valid key.
- Signing time is Host-asserted and is not trusted for authority. Kernel binds the receipt to its own arrival/receipt-import time and to the Host Ledger position; where a genuine timestamp is required, an authenticated external time source is required rather than a wall clock.
- Nothing here selects an algorithm, certificate encoding, canonical-encoding library or trust-root delivery mechanism: those remain **OPEN** and must be fixed before any cryptographic claim is made.

### 4.2 Ledger integrity, tamper evidence and storage failure

- Both the Kernel Journal and the Host Ledger are append-only and **hash-chained**: each record commits to the previous record digest and its own sequence number. A gap in the chain is an integrity failure, not a warning.
- The chain head is periodically **anchored outside** the owning database (Kernel-side anchor for the Host Ledger, and an independent anchor for the Journal) with a signed digest and sequence. Anchoring frequency and the anchor store remain build-time choices; the property is that tampering with a historical record is detectable without trusting the same operator.
- Tamper evidence is not tamper prevention: an operator with write access to both a ledger and every anchor cannot be detected by this mechanism. That residual risk is accepted and must be stated in the deployment threat model.
- Storage failure is fail-closed: on write failure, checksum/page-integrity failure, or detected chain discontinuity, the owner stops admitting new work for affected scopes, keeps existing holds and UNKNOWNs, and surfaces a typed storage fault. A record that cannot be durably written is not "committed", and no caller may treat a transport success as durability.
- Disk full, corruption and restore are operational states with a required procedure: stop admission, preserve the last verified anchor and chain head, restore from backup into a **new** location, replay/verify the chain and every referenced receipt digest, and only then resume. A restore that cannot reproduce the anchored head is not a valid restore and cannot be used to claim prior completion evidence.

## 5. UNKNOWN and reconciliation

If the Host has accepted a request but cannot provide a complete trusted result, the invocation is OutcomeUnknown. Do not convert it to FailedKnown because a process exited, a timeout occurred or a client disconnected.

Reconcile using Host Ledger, signed receipt, target-system state and verified idempotency evidence. If the outcome remains unknown, preserve the block and execution ownership; do not blindly retry.

**Reconciliation oracle per effect class (normative).** Each unresolved Invocation is bound to one row; "no oracle" is itself an answer that forbids resolution by retry.

| Effect class | Oracle | Closure evidence | Max lifetime | Owner | Escalation | Reservation release |
| --- | --- | --- | --- | --- | --- | --- |
| Workspace/filesystem write | Host Ledger write record + target digest + publication fence + writer quiescence + acceptance snapshot | Pre-image/post-image digest pair, absence of a live writer/handle for the target, and a sealed snapshot containing the resulting content | Bounded by the Invocation's reconciliation deadline (a policy value; no unbounded wait) | Task owner (operator on expiry) | Typed hold + operator incident; no retry under the same Invocation | Only on proven no-effect or on final settled accounting; never on timeout |
| Provider request | Authenticated provider status/billing lookup, or a qualified execution-and-billing dedup contract | Provider-issued status/usage for the exact request identity, or dedup proof accepted by the adapter | Provider-dependent, recorded on the Attempt | Gateway + budget owner | `ProviderOutcomeUnknown` retained; replacement needs a new admitted Attempt and budget | Retained at full maximum until trusted financial evidence |
| External API mutation | Target revision/ETag/status endpoint | Exact target identity re-read plus a revision/ETag that proves the intended state or proves it absent | Bounded by target system's reconciliation window | Domain adapter + operator | Manual verification with the target owner; never replay the same idempotency key | As above (trusted evidence only) |
| Render / long job | Staging digest + process/descendant and writable-handle convergence + output probe | Host staging identity/digest, convergence evidence, independent probe of the staged output | Bounded by Host reconciliation deadline | Host operator | Quarantine staging, keep target-conflict hold, no publication | Host resource reservation settles on measured usage; unknown usage stays held |

**Single disposition rule.** At the reconciliation deadline: if the unresolved effect can still conflict with the accepted deliverable or a protected target, the Task fails with `UnresolvedEffect` and a **separate durable hold** remains (never a silent completion, never a retry). If no such conflict exists, the Task may stay `Open` with a persisted `WaitRecord` (`owner`, `max_wait_until`, `recovery_strategy`) that carries sole responsibility, and may complete only through the `G12 unknown_closure` check in [Completion](../contracts/completion.md) §6. A hold is cleared only by trusted reconciliation evidence, never by elapsed time. This mirrors the Kernel decision rule in [Data model](../contracts/kernel-data-model.md) and [Core protocol](../contracts/core-protocol.md).

## 6. Extensions and sub-agents

Skills, MCP adapters, Hooks, plugins, workers and future sub-agents are untrusted or lower-trust extensions. They may use public scoped APIs, but cannot directly access Kernel internals, Kernel Persistence, Host Ledger, or bypass AdmissionTicket validation.

Multi-Agent / D9 remains **DEFERRED / NOT AUTHORIZED**. This baseline does not authorize ChildTask scheduling, worker pools, distributed execution or inherited capability implementation.

## 7. Long-running Host jobs

A long-running operation such as FFmpeg rendering remains a Kernel ToolInvocation executed by Trusted ToolHost; a typed RenderJob does not create a second execution authority.

The Host must:

- bind a durable Host run/job ID to the exact ToolInvocation, AdmissionTicket, DomainBinding, Workflow Profile ID/version/digest, `authority_epoch`, tool snapshot, `workspace_generation`, budget reservation ID/version and `EffectPolicyId`;
- enter the serialized LaunchGate and durably consume a one-use dispatch authorization bound to the current effective Active profile version/digest, `authority_epoch`, authority-version vector, `workspace_generation`, `ticket_epoch` and budget reservation at the physical process-creation boundary; a previously accepted plan, cached allowlist, or offline ticket is not sufficient;
- serialize physical process creation against **Host-local fence installation** within the same eligible launch arbiter; the remote Kernel revocation request and OS spawn are not one transaction. If current authority or local ordering cannot be established, fail closed and do not create the process;
- record process/job creation before reporting the operation as started;
- contain the process tree and retain stdout/stderr/progress channels under the declared resource limits;
- report progress as non-authoritative telemetry associated with the Host run ID;
- on cancellation, stop dispatch, terminate the process tree under policy, drain pipes, and confirm descendants/writable handles are quiescent;
- record exit/signal, resource consumption, partial-output state, output digest, and an authenticated receipt;
- preserve OutcomeUnknown when it cannot prove whether a process or output side effect completed.

A missing progress event, timeout, client disconnect, or kill request is not proof of process convergence. Recovery must reconcile the Host Ledger and target/output state before retry or publication. A profile revoked or superseded after plan approval invalidates any not-yet-consumed dispatch authorization. Revocation remains Pending until every eligible Host gate acknowledges the new fence or is verifiably disabled; a Host that cannot check current authority launches nothing. A launch boundary that linearized before the fence is an already-running invocation and follows the predeclared drain/cancel policy. UNKNOWN remains held and cannot be cleared by profile migration.

For media-specific staging, validation, retry, and publication rules, see [RenderJob contract](../contracts/render-job.md) and [FFmpeg RenderPlan security contract](../contracts/render-plan-security.md). These Host requirements are ACCEPTED for construction; their enforcement remains **UNVERIFIED / NOT RUN** until process-tree and crash-recovery tests exist.

### 7.1 Media render-specific Host obligations

For an FFmpeg RenderJob, the Host must establish a per-invocation filesystem view with immutable read-only source/sidecar bindings, a unique writable staging directory, and no access to final artifact namespaces, home directories, secrets, Kernel/Host persistence, unrelated projects, device nodes, or host sockets. Artifact IDs are resolved by trusted code; model-provided path strings are never accepted as filesystem authority.

The render worker has no network egress in the initial profile. FFmpeg protocol allowlisting and demuxer/filter restrictions are defense in depth; they do not replace OS-level network and filesystem confinement. FFmpeg receives a canonical argv vector and compiler-generated, allowlisted filtergraph representation, not a shell string or raw model graph.

The Host pins source identity/digests for the duration of the render, applies enforceable CPU/memory/process/wall-time/disk/output-size limits, contains descendants, and proves writable-handle convergence before sealing staged output. If a required Host capability is unavailable, admission fails closed. Linux namespaces/cgroup v2/seccomp and Windows Job Objects are research candidates, not selected platform requirements; platform-specific guarantees remain unverified.

The Host Ledger records the durable launch intent, Host run identity, process/job identity, exit/signal, resource facts, descendant convergence, staging file identity/digest, and authenticated receipt. Kernel Journal remains authoritative for admission, cancellation intent, budget settlement, fencing, and legal invocation state. A Host crash, missing receipt, or uncertain writable process leaves the invocation UNKNOWN; no retry or publication is permitted until reconciliation proves a safe outcome.

FFmpeg may write only to a unique staging target. Host seals the output after process convergence and supplies its digest/receipt to independent technical and content verification. Final ArtifactRef publication is a separate recoverable step; the renderer never writes directly to a final deliverable or overwrites an earlier version.


## 8. Verification status

Production authentication, principal-to-OS identity binding, approval revocation propagation, sandbox enforcement, cgroup isolation, network policy, process-tree convergence, receipt signing, key lifecycle/rotation, Journal and Ledger hash chaining/anchoring, disk-full/corruption handling, backup-and-restore verification and cross-host recovery remain **UNVERIFIED / NOT RUN**. No key, chain, anchor or receipt mechanism exists in this repository.

## 9. Scheduling, bounded waits and physical termination (ACCEPTED for construction v0)

Tool Runtime may queue or coalesce **proven read-only** observations and schedule disjoint work within declared Host resource dimensions; it never mints launch rights. Every invocation preserves unique identity, intent, reservation, timeout, conflict scope and the current one-use Host gate ticket. Host local gate/fence proof still serializes **physical spawn against local invalidations**, even when read-only requests are concurrently queued. Default same-Task write concurrency is one; any higher concurrency must show disjoint targets, isolated writable roots and absence of cross-process cache/handle interference.

The Host enforces wall-clock, CPU, memory, descendant/process, disk/output and, for Video, GPU/media limits **only where supported and proven by the selected profile**. Deadline or cancellation signals are commands to terminate and reconcile, not evidence of convergence. If the Host cannot prove all relevant descendants and writable handles have stopped, return `OutcomeUnknown`, quarantine staging/output and retain target-conflict holds. Reconciliation should be event-driven from Host Ledger/outbox/status checks with a persisted owner/deadline rather than unbounded model polling. The first deployment is a single-Host authority scope; multi-Host scheduler/fence semantics remain deferred. Host/OS-specific enforcement and target latencies are **NOT VERIFIED**.
