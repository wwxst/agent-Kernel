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
4. Principal, capability, policy and approval versions/revocation state.
5. Workspace identity/hash and current fencing epoch.
6. Budget reservation and limits.
7. Host target and required isolation profile.
8. Durable Intent and stable idempotency identity.

Kernel issues a short-lived AdmissionTicket bound to the exact invocation, tool version, argument hash, policy/approval/capability versions, workspace, fencing epoch, budget reservation, expiry and nonce. Tool Runtime cannot manufacture or widen it. Host validates it again at execution time.

A model statement that a tool is approved is not approval evidence.

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

- bind a durable Host run/job ID to the exact ToolInvocation, AdmissionTicket, DomainBinding, tool snapshot, budget reservation, and fencing epoch;
- record process/job creation before reporting the operation as started;
- contain the process tree and retain stdout/stderr/progress channels under the declared resource limits;
- report progress as non-authoritative telemetry associated with the Host run ID;
- on cancellation, stop dispatch, terminate the process tree under policy, drain pipes, and confirm descendants/writable handles are quiescent;
- record exit/signal, resource consumption, partial-output state, output digest, and an authenticated receipt;
- preserve OutcomeUnknown when it cannot prove whether a process or output side effect completed.

A missing progress event, timeout, client disconnect, or kill request is not proof of process convergence. Recovery must reconcile the Host Ledger and target/output state before retry or publication.

For media-specific staging, validation, retry, and publication rules, see [RenderJob contract](../contracts/render-job.md). These Host requirements are proposed and remain unverified until process-tree and crash-recovery tests exist.


## 8. Verification status

Production authentication, principal-to-OS identity binding, approval revocation propagation, sandbox enforcement, cgroup isolation, network policy, process-tree convergence, receipt signing, key rotation and cross-host recovery remain **UNVERIFIED**.


