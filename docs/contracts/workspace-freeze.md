# Workspace Freeze and authenticated receipt contract

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; runtime claims UNVERIFIED.** Record shapes are owned by [Kernel data model](kernel-data-model.md); receipt-key and ledger-integrity properties by [Trusted Host](../security/trusted-host.md) §4.

## 1. Separate facts

- Kernel Journal records the task's freeze intent, authorization, `authority_epoch` and `workspace_generation`, receipt validation and final commit/abort decision.
- Trusted ToolHost Host Ledger records the physical workspace state, process/handle convergence, snapshot creation, receipt issuance and finalization.
- Neither ledger may impersonate the other. There is no distributed atomic transaction spanning Kernel Persistence and Host Ledger.

## 2. Freeze request

A PrepareFreeze request must be issued by an authenticated and authorized Kernel service identity. It binds at least:

- requestId and freezeId;
- workspaceId, `workspace_generation` and the `authority_epoch` of the Kernel control scope under which the request is issued;
- a Kernel-generated, single-freeze `kernelChallenge`;
- a per-request anti-replay `nonce`;
- expiry / validity window;
- canonical request payload and request digest.

The kernelChallenge and nonce serve different purposes. The challenge binds the Host response to the specific Kernel freeze request; the nonce prevents replay of an individual authenticated request. Both must be durably bound to the request identity, workspace and generation.

The request digest and authenticator cover the challenge. Host PrepareFreeze Inbox and Host Ledger persist the challenge/nonce binding atomically. A retry of the same *in-flight, unexpired* request reuses the same request ID, challenge, nonce and digest. Cross-freeze replay or same ID with different digest is rejected.

### 2.1 Request state machine (normative)

`Requested → InProgress → Completed | Expired | Aborted`

- **Expired** is terminal for that request ID. An expired request must never be retried under the same request ID, challenge or nonce, and no Host may act on it.
- After expiry the Kernel issues a **new** request ID with a fresh challenge, nonce and validity window — but only after the prior request on that workspace/generation is reconciled to `Expired` or `Aborted` and the Host Ledger shows no freeze attempt for it. An unfinished or `Aborted` freeze on the same workspace/generation must be explicitly reconciled (or aborted and acknowledged) before a new freeze is requested. Two concurrent freeze requests for one workspace/generation are rejected.
- `Completed` means a receipt was validated by the Kernel; a receipt received for an `Expired` or `Aborted` request is quarantined, not adopted.
- The Kernel persists the request state durably before sending; a request that cannot be durably recorded is not sent. A crash before send recovers the same request identity; a crash after send but before the Host reply is resolved by querying the Host Ledger, never by opening a second request.

## 3. Host convergence and snapshot

On an accepted PrepareFreeze:

1. Fence the workspace by installing at the Host gate a barrier that rejects all further writes under the requested `workspace_generation`; the next generation is created only by a later authorized Kernel decision, never by the freeze itself.
2. Reject new writes arriving under the fenced or any older `workspace_generation`, including writes from in-flight invocations admitted under it.
3. Revoke old write capabilities and admission tickets through the normal authority path (`authority_epoch` / `RevocationPending`); the freeze request is not a second revocation mechanism and cannot itself declare `Revoked`.
4. Drain active write invocations and their process trees.
5. Confirm writable handles and mounts are quiescent within the declared host contract.
6. If convergence cannot be proved, quarantine the workspace; do not continue to snapshot or finalize.
7. Create an immutable, read-only final acceptance snapshot.
8. For Coding compute the final acceptance **protected-input** digest from that snapshot and the trusted, predeclared versioned ProtectedInputScope; verification output/log/cache artifacts have separate provenance manifests. For Video retain the relevant immutable project/media/artifact digest bindings.
9. Issue a receipt that binds the snapshot, hash, scope, epoch, challenge and host evidence.

For Coding verification, the baseline Host profile must provide a **sealed read-only SourceSnapshot** and **disjoint writable output/cache/temp roots**. The authenticated `ExecutionViewManifest` binds exact command/Host run, source snapshot and protected scope digest, execution cwd, immutable read-only mount/root identity, symlink/bind-mount and path-search restrictions, allowed isolated output roots, toolchain/environment identity and enforcement through process/descendant convergence. The Host must forbid writable overlays/remounts or alternate protected file paths and **attest** that effective protected inputs equal the accepted SourceSnapshot. This is an attested Host claim, not independent proof: a compromised Host can lie about its own enforcement, and that residual risk is accepted and must be stated in the deployment threat model. Matching immutable lower-layer hashes alone never proves what the test executed.

**No mandatory full file tracing or distributed transaction coordinator:** for the first Host target, prefer enforceable read-only mounts/namespace and isolated outputs. A toolchain that cannot work under that profile is Unsupported/Unverified until an approved different Host profile is demonstrated; do not silently permit a writable source overlay or make a hash-only verification report Passed. Full file-open/mutation tracing is a separately evaluated alternative, not an implicit first-slice dependency. See [Completion](completion.md) and [Core protocol](core-protocol.md).

A process kill or timeout is not proof of convergence. The Host must provide evidence for the declared process/handle boundary.

## 4. Receipt integrity and authentication

A receipt payload must be canonical, versioned and authenticated. It binds at least:

- receipt version, canonicalization profile and digest algorithm;
- receipt ID and PrepareFreeze request binding;
- kernelChallenge, freezeId, workspaceId, `workspace_generation` and the kernel `authority_epoch`;
- snapshot ID and final acceptance protected-input/project snapshot digest (according to domain), plus Coding ExecutionViewManifest identity and effective protected-path digest when applicable;
- hash algorithm, hash-scope version and hash-scope descriptor digest;
- process/handle convergence counts and evidence digests;
- host identity, host `key_id`, Host Ledger sequence, the ledger chain digest at that sequence, and capture time.

The digest and authenticator are computed over a canonical payload that excludes the digest and authenticator themselves, avoiding a circular construction. The authenticator must prove the binding between host identity and host key identity, and Kernel must resolve `key_id` against its own pinned trust root — never against a key presented with the receipt.

Key resolution, rotation overlap, revoked-key handling and the requirement for a Host keystore are defined in [Trusted Host](../security/trusted-host.md) §4.1 and are not restated here. A receipt from a key that is unresolvable, outside its validity interval, or marked compromised is quarantined and cannot support completion.

The source baseline proposes versioned canonical JSON using RFC 8785 JCS, UTF-8 canonical bytes and NFC strings. This is a candidate serialization contract, not proof of interoperability or a final cryptographic/key-management choice.

Kernel validates the returned receipt against the exact original FreezeRequested record — including the unchanged kernelChallenge, workspace, generation and epoch — and against the Host Ledger chain position it names. A receipt with a mismatched challenge, generation, workspace, snapshot, digest or chain position is rejected and quarantined.

## 5. Commit / Abort

CommitDecision and AbortDecision must be issued by an authenticated and authorized Kernel identity and bind freezeId, workspaceId, `workspace_generation`, snapshotId, receiptDigest and a stable decisionId.

**Decision intent before send (normative).** Kernel durably records a `CommitIntent` or `AbortIntent` — with decisionId, freezeId, workspace/generation, snapshotId, receiptDigest and request identity — in one local transaction **before** sending the decision. Sending without a durable intent is forbidden: after a crash there must be something to resend. The intent is irreversibly bound to its direction; it is never edited into the opposite decision.

Commit and Abort are mutually exclusive and irreversible. Repeating the same decision with the same digest is idempotent; a different decision, changed digest or stale generation is rejected. The Host records its decision and the ledger transition atomically in its own persistence boundary and **rejects any decision opposite to one it already recorded**, returning the recorded decision instead. Kernel records the corresponding decision in its own journal.

**Ambiguity is resolved only by querying the Host Ledger.** If Kernel cannot prove what it sent, or sent but has no acknowledgement, it queries the Host Ledger for that freezeId and adopts the recorded decision. It never infers the outcome from a timeout, a lost ACK, a transport error or the absence of a receipt, and never issues the opposite decision on that basis. If the Host Ledger cannot be read, the freeze stays `InProgress` with a durable hold and an escalation owner — not `Aborted` by default.

## 6. Recovery and failure policy

- Kernel crash after FreezeRequested: recover the same request ID, challenge, nonce and digest while the request is unexpired.
- Kernel crash after expiry or before request state was durable: the request resolves to `Expired`/`Aborted`; a new request ID requires the §2.1 reconciliation.
- Host crash after PrepareFreeze acceptance: recover the original inbox/ledger state; do not create a new freeze from memory.
- Receipt returned but not recorded by Kernel: query Host Ledger and recover the same receipt; adopt it into `Completed`, not into a new request.
- Host cannot prove process/handle convergence: Quarantined.
- Receipt authentication or binding fails, or its `key_id`/chain position cannot be resolved: reject and quarantine; never downgrade to a hash-only acceptance.
- Commit/Abort intent recorded but outcome unknown: query the Host Ledger (both directions); do not infer success or failure from a lost ACK.
- Kernel or Host storage fault (disk full, chain discontinuity, failed restore): stop admitting new freezes/completions for affected workspaces, retain holds, and follow the ledger-integrity procedure in [Trusted Host](../security/trusted-host.md) §4.2.

Exact signing algorithms, certificate/encoding format, trust-root provisioning, key custody implementation and cross-host recovery are **OPEN**; rotation/revocation semantics, timestamp rules and ledger chaining are **ACCEPTED for construction** as properties in [Trusted Host](../security/trusted-host.md) §4. Clock-skew tolerance is a policy field of the `EffectPolicyId` record (provisional values in [Trusted Host](../security/trusted-host.md) §2.1.2) and remains **UNVERIFIED** until tested.
