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

### 2.1 Serialized Host LaunchGate — single-Host authority scope (PROPOSED refinement)

A Kernel AdmissionTicket is a scoped admission fact, not a self-sufficient physical launch grant. A short-lived, one-use dispatch ticket binds invocation, tool and arguments, immutable DomainBinding/Profile, current authority-version vector and AuthorityFenceEpoch, workspace/project generation, live budget reservation, Host target/incarnation, expiry and unique nonce. A Host must establish current authority **at its launch boundary**, not by checking only a cached ticket.

**Initial authority model:** one eligible Trusted ToolHost launch arbiter per invocation-authority scope, with a serialized local gate. This scope may run multiple non-conflicting operations. Kernel is authoritative for revocation requests, desired authority epochs and stopping new admission/ticket issuance; the Host gate is authoritative for ordering **physical launch against installation of its local fence**. The Kernel request transaction, Host Ledger write and OS process creation do not form one cross-system atomic transaction. No multi-Host linearizability claim is approved.

**Single-Host launch sequence:**

1. Under the Host's serialized gate, obtain a live, internally consistent current-effective eligibility snapshot (profile/DomainBinding, authority versions and fence, workspace generation, reservation, ticket expiry and nonce). The source of each mutable prerequisite must offer a trustworthy current proof or be fenced by the same serialized decision; independent stale reads are insufficient. If current authority cannot be established, fail closed.
2. Durably consume the one-use nonce and write a unique `LaunchAttempt / IntentDurable` to Host Ledger **before** physical process creation. A consumed nonce is never reused, even after restart.
3. While still ordering against local fence installation, attempt OS process creation with an exact process/run identity. If the fence was installed first, reject the old ticket without spawning. If launch crosses the gate first, retain its original epoch and treat it as already in flight, subject to cancellation/drain policy.
4. Persist a `LaunchBoundaryRecorded` receipt with exact invocation, attempt, Host run/process identity and incarnation, authority vector, nonce, gate sequence and snapshot digests before reporting a known Started outcome. Persisted process creation and Host Ledger writes are **not** an OS/database atomic operation: a crash in this window yields `OutcomeUnknown` until independently reconciled.
5. On a crash after durable nonce consumption but before a provably known launch result, never infer non-execution and never replay the ticket or mint a replacement without reconciling the original Invocation and potential external effect.

**Revocation sequence:** `RevocationRequested` stops relevant Kernel admission and issuance and advances the desired AuthorityFenceEpoch. The authority is `RevocationPending` while eligible Host gates install/acknowledge their local fence or are verifiably disabled. `Revoked` is recorded only after *all* eligible gates are accounted for. Request acceptance by Kernel is **not** proof that a previously issued ticket did not win a launch race before local fence installation. After the local fence is installed, older tickets cannot launch there; a launch that already crossed remains an in-flight old-epoch operation. A Host that loses live authority must fail closed for new launch; an unreachable Host that cannot be proved disabled keeps global revocation Pending. `Revoked` does not mean running processes, descendants or writable handles have converged; this is separate `ProcessConverged` evidence.

**Non-claims and extension:** This mechanism does not guarantee atomic Host Ledger + OS spawn, exactly-once remote side effects, termination of already-started work, or distributed multi-Host global ordering. Additional Host authorities, failover, partition survival and lease/membership mechanisms require separate protocol approval and fault-injection evidence. See [Core protocol and G0–G5 gates](../contracts/core-protocol.md).

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
- serialize process creation and authority-fence advancement so revocation and launch have a provable total order; if current authority or ordering cannot be established, fail closed and do not create the process;
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


