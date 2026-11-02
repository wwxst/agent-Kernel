# Trusted ToolHost and security boundary

> **Status: Security architecture baseline.** No production sandbox, host identity, admission ticket, or receipt implementation is claimed.

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

1. Task / Turn / Step / Invocation identity and ownership.
2. Complete canonical arguments and schema.
3. Immutable tool definition and implementation identity for the current Step.
4. Principal, capability, policy and approval versions/revocation state, plus the current AuthorityFenceEpoch.
5. Workspace/project identity, generation/hash, and current fencing epoch.
6. Budget reservation and limits.
7. Host target and required isolation profile.
8. Durable Intent and stable idempotency identity.

Kernel issues a short-lived AdmissionTicket bound to the exact invocation, profile/DomainBinding digest, tool version, argument hash, principal/capability/policy/approval version vector, AuthorityFenceEpoch, workspace/project identity and generation/hash, Host target, fencing epoch, budget-reservation ID/version, expiry and nonce. Tool Runtime cannot manufacture or widen it. Host validates it again at execution time.

A model statement that a tool is approved is not approval evidence.

### 2.1 Serialized Host LaunchGate — single-Host authority scope (second-round PROPOSED refinement)

An AdmissionTicket is a Kernel admission fact, **not** a physical launch permission. A short-lived one-use dispatch ticket binds ToolInvocation, exact tool/argument digests, profile/DomainBinding, authority epoch/version vector, workspace/project generation, budget reservation, target Host/incarnation, expiry and nonce. The initial authority scope has **one eligible Host launch arbiter** and a locally serialized gate; global multi-Host ordering remains unapproved.

**Three separate events and guarantees:**

| Event | Owner | Meaning and guarantee |
| --- | --- | --- |
| `RevocationRequested` and desired `AuthorityFenceEpoch` | Kernel transaction | Stops **new** related Kernel Admission/ticket issuance immediately. Does **not** prove a previously issued ticket cannot still launch before Host fence installation. |
| `HostFenceInstalled` (epoch, gate sequence, Host incarnation) | Trusted Host Ledger and serialized local LaunchGate | The fence is durably installed in the **same local order** as OS process creation. No older ticket can cross that Host gate **after installation**. Earlier launched operations stay in flight. |
| `Revoked` (acknowledged eligible Host set) | Kernel transaction | Only after all eligible Host gates provide verified HostFenceInstalled ACKs or verified disablement; not proof that already-started processes are terminated. `ProcessConverged` is a separate trusted fact. |

**Request-before-fence race is permitted:** `Kernel.RevocationRequested → Host.launch(old ticket) → Host.HostFenceInstalled → Kernel.Revoked` is valid if the old launch crossed the Host-local gate before fence installation. Kernel maintains `RevocationPending` throughout this interval. An `HostFenceInstalled → Host.launch(old ticket)` order is forbidden and must reject without process creation. The request and local installation do not share an atomic transaction.

**What counts as usable authority proof inside LaunchGate:** a trusted, versioned *locally effective* authorization state + authenticated, scope/Host-incarnation-bound, finite-lived execution grant or equivalent live authority channel. It must prove the immutable profile and exact invocation/arguments, current **installed local** authority epoch/version, admitted workspace/project generation, budget-reservation version, revocation policy and nonce; identify the authority source and local fence sequence; have an enforceable launch deadline; and demonstrate Host liveness/connectivity as required by its authority policy. Changes to mutable local versions or resource fences must be serialized against spawn through **the same local gate**. Independent remote reads, stale caches, a ticket alone, or an offline Host do not suffice. This is a proof about the latest **Host-installed** authority, **not** a claim that the Host sees a newly committed Kernel revocation instantly. If global immediacy is required, this protocol is insufficient and execution must not be enabled under that requirement.

**No TOCTOU launch:** inside a single serialized Host critical section, (1) read/validate the local effective authority and lease/grant, expiry and conflicting input/permission/resource fences, (2) durably consume one unique nonce and persist a LaunchAttempt/IntentDurable with Host DispatchInbox dedup key, and (3) invoke the physical process-creation operation **before releasing the gate**, ordered against HostFenceInstalled. Never validate outside the gate and later spawn. A grant expiring before the physical launch boundary, a lost required authority channel, or inability to prove local validity fails closed. The Host persists a LaunchBoundaryRecorded receipt before reporting a known Started result.

**Crash and remote effects:** durable Host Ledger + OS process creation is not one atomic operation. Crash after durable nonce consumption, within spawn, or before process receipt may leave OutcomeUnknown. The consumed nonce cannot be replayed and a replacement needs reconciliation of original Invocation/process/output. Host records and retries its authenticated result under the original receipt identity; Kernel imports via its own deduplicating Inbox. No exactly-once remote effect or multi-Host fencing claim is inferred. See [Core protocol](../contracts/core-protocol.md).

**Host not reachable:** no offline new dispatch. If a Host's old launch capability cannot be proven disabled, Kernel keeps `RevocationPending`, even when the desired epoch is already advanced. A lost Host fence ACK is reconciled from Host Ledger; never infer fence installation from a timeout.

### 2.2 Scoped ArtifactResolver

Artifact IDs and ArtifactRefs are identifiers, not filesystem authority. The Host resolves payload bytes through a trusted ArtifactResolver using a server-side ScopedReadGrant bound to the exact handoff, artifact ID/digest/schema, consumer Task/DomainBinding, purpose, access mode, authorizing principal/policy version, expiry, and revocation epoch. No model-supplied path, producer workspace path, signed URL, or bearer secret is accepted as a payload locator.

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

## 5. UNKNOWN and reconciliation

If the Host has accepted a request but cannot provide a complete trusted result, the invocation is OutcomeUnknown. Do not convert it to FailedKnown because a process exited, a timeout occurred or a client disconnected.

Reconcile using Host Ledger, signed receipt, target-system state and verified idempotency evidence. If the outcome remains unknown, preserve the block and execution ownership; do not blindly retry.

## 6. Extensions and sub-agents

Skills, MCP adapters, Hooks, plugins, workers and future sub-agents are untrusted or lower-trust extensions. They may use public scoped APIs, but cannot directly access Kernel internals, Kernel Persistence, Host Ledger, or bypass AdmissionTicket validation.

Multi-Agent / D9 remains **DEFERRED / NOT AUTHORIZED**. This baseline does not authorize ChildTask scheduling, worker pools, distributed execution or inherited capability implementation.

## 7. Long-running Host jobs

A long-running operation such as FFmpeg rendering remains a Kernel ToolInvocation executed by Trusted ToolHost; a typed RenderJob does not create a second execution authority.

The Host must:

- bind a durable Host run/job ID to the exact ToolInvocation, AdmissionTicket, DomainBinding, Workflow Profile ID/version/digest, AuthorityFenceEpoch, tool snapshot, workspace/project generation, budget reservation ID/version, and fencing epoch;
- enter the serialized LaunchGate and durably consume a one-use dispatch authorization bound to the current effective Active profile version/digest, AuthorityFenceEpoch, authority-version vector, workspace/project generation, and budget reservation at the physical process-creation boundary; a previously accepted plan, cached allowlist, or offline ticket is not sufficient;
- serialize physical process creation against **Host-local fence installation** within the same eligible launch arbiter; the remote Kernel revocation request and OS spawn are not one transaction. If current authority or local ordering cannot be established, fail closed and do not create the process;
- record process/job creation before reporting the operation as started;
- contain the process tree and retain stdout/stderr/progress channels under the declared resource limits;
- report progress as non-authoritative telemetry associated with the Host run ID;
- on cancellation, stop dispatch, terminate the process tree under policy, drain pipes, and confirm descendants/writable handles are quiescent;
- record exit/signal, resource consumption, partial-output state, output digest, and an authenticated receipt;
- preserve OutcomeUnknown when it cannot prove whether a process or output side effect completed.

A missing progress event, timeout, client disconnect, or kill request is not proof of process convergence. Recovery must reconcile the Host Ledger and target/output state before retry or publication. A profile revoked or superseded after plan approval invalidates any not-yet-consumed dispatch authorization. Revocation remains Pending until every eligible Host gate acknowledges the new fence or is verifiably disabled; a Host that cannot check current authority launches nothing. A launch boundary that linearized before the fence is an already-running invocation and follows the predeclared drain/cancel policy. UNKNOWN remains held and cannot be cleared by profile migration.

For media-specific staging, validation, retry, and publication rules, see [RenderJob contract](../contracts/render-job.md) and [FFmpeg RenderPlan security contract](../contracts/render-plan-security.md). These Host requirements are proposed and remain unverified until process-tree and crash-recovery tests exist.

### 7.1 Media render-specific Host obligations

For an FFmpeg RenderJob, the Host must establish a per-invocation filesystem view with immutable read-only source/sidecar bindings, a unique writable staging directory, and no access to final artifact namespaces, home directories, secrets, Kernel/Host persistence, unrelated projects, device nodes, or host sockets. Artifact IDs are resolved by trusted code; model-provided path strings are never accepted as filesystem authority.

The render worker has no network egress in the initial profile. FFmpeg protocol allowlisting and demuxer/filter restrictions are defense in depth; they do not replace OS-level network and filesystem confinement. FFmpeg receives a canonical argv vector and compiler-generated, allowlisted filtergraph representation, not a shell string or raw model graph.

The Host pins source identity/digests for the duration of the render, applies enforceable CPU/memory/process/wall-time/disk/output-size limits, contains descendants, and proves writable-handle convergence before sealing staged output. If a required Host capability is unavailable, admission fails closed. Linux namespaces/cgroup v2/seccomp and Windows Job Objects are research candidates, not selected platform requirements; platform-specific guarantees remain unverified.

The Host Ledger records the durable launch intent, Host run identity, process/job identity, exit/signal, resource facts, descendant convergence, staging file identity/digest, and authenticated receipt. Kernel Journal remains authoritative for admission, cancellation intent, budget settlement, fencing, and legal invocation state. A Host crash, missing receipt, or uncertain writable process leaves the invocation UNKNOWN; no retry or publication is permitted until reconciliation proves a safe outcome.

FFmpeg may write only to a unique staging target. Host seals the output after process convergence and supplies its digest/receipt to independent technical and content verification. Final ArtifactRef publication is a separate recoverable step; the renderer never writes directly to a final deliverable or overwrites an earlier version.


## 8. Verification status

Production authentication, principal-to-OS identity binding, approval revocation propagation, sandbox enforcement, cgroup isolation, network policy, process-tree convergence, receipt signing, key rotation and cross-host recovery remain **UNVERIFIED**.


