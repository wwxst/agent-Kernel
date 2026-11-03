# Workspace Freeze and authenticated receipt contract

> **Status: Approved architecture contract re-authored as an initial baseline.** Cryptographic profile, key management, Host implementation and crash recovery remain unverified.

## 1. Separate facts

- Kernel Journal records the task's freeze intent, authorization, fencing epoch, receipt validation and final commit/abort decision.
- Trusted ToolHost Host Ledger records the physical workspace state, process/handle convergence, snapshot creation, receipt issuance and finalization.
- Neither ledger may impersonate the other. There is no distributed atomic transaction spanning Kernel Persistence and Host Ledger.

## 2. Freeze request

A PrepareFreeze request must be issued by an authenticated and authorized Kernel service identity. It binds at least:

- requestId and freezeId;
- workspaceId and fencingEpoch;
- a Kernel-generated, single-freeze `kernelChallenge`;
- a per-request anti-replay `nonce`;
- expiry / validity window;
- canonical request payload and request digest.

The kernelChallenge and nonce serve different purposes. The challenge binds the Host response to the specific Kernel freeze request; the nonce prevents replay of an individual authenticated request. Both must be durably bound to the request identity and workspace/epoch.

The request digest and authenticator cover the challenge. Host PrepareFreeze Inbox and Host Ledger persist the challenge/nonce binding atomically. A retry of the same request reuses the same request ID, challenge, nonce and digest. Cross-freeze replay or same ID with different digest is rejected.

## 3. Host convergence and snapshot

On an accepted PrepareFreeze:

1. Fence the workspace by advancing or enforcing the current fencing epoch.
2. Reject new writes from all stale or unauthorized epochs.
3. Revoke old write capabilities and admission tickets.
4. Drain active write invocations and their process trees.
5. Confirm writable handles and mounts are quiescent within the declared host contract.
6. If convergence cannot be proved, quarantine the workspace; do not continue to snapshot or finalize.
7. Create an immutable, read-only final acceptance snapshot.
8. For Coding compute the final acceptance **protected-input** digest from that snapshot and the trusted, predeclared versioned ProtectedInputScope; verification output/log/cache artifacts have separate provenance manifests. For Video retain the relevant immutable project/media/artifact digest bindings.
9. Issue a receipt that binds the snapshot, hash, scope, epoch, challenge and host evidence.

For Coding verification, the baseline Host profile must provide a **sealed read-only SourceSnapshot** and **disjoint writable output/cache/temp roots**. The authenticated `ExecutionViewManifest` binds exact command/Host run, source snapshot and protected scope digest, execution cwd, immutable read-only mount/root identity, symlink/bind-mount and path-search restrictions, allowed isolated output roots, toolchain/environment identity and enforcement through process/descendant convergence. The Host must forbid writable overlays/remounts or alternate protected file paths and attest that effective protected inputs equal the accepted SourceSnapshot. Matching immutable lower-layer hashes alone never proves what the test executed.

**No mandatory full file tracing or distributed transaction coordinator:** for the first Host target, prefer enforceable read-only mounts/namespace and isolated outputs. A toolchain that cannot work under that profile is Unsupported/Unverified until an approved different Host profile is demonstrated; do not silently permit a writable source overlay or make a hash-only verification report Passed. Full file-open/mutation tracing is a separately evaluated alternative, not an implicit first-slice dependency. See [Completion](completion.md) and [Core protocol](core-protocol.md).

A process kill or timeout is not proof of convergence. The Host must provide evidence for the declared process/handle boundary.

## 4. Receipt integrity and authentication

A receipt payload must be canonical, versioned and authenticated. It binds at least:

- receipt version, canonicalization profile and digest algorithm;
- receipt ID and PrepareFreeze request binding;
- kernelChallenge, freezeId, workspaceId and fencingEpoch;
- snapshot ID and final acceptance protected-input/project snapshot digest (according to domain), plus Coding ExecutionViewManifest identity and effective protected-path digest when applicable;
- hash algorithm, hash-scope version and hash-scope descriptor digest;
- process/handle convergence counts and evidence digests;
- host identity, host key ID, Host Ledger sequence and capture time.

The digest and authenticator are computed over a canonical payload that excludes the digest and authenticator themselves, avoiding a circular construction. The authenticator must prove the binding between host identity and host key identity.

The source baseline proposes versioned canonical JSON using RFC 8785 JCS, UTF-8 canonical bytes and NFC strings. This is a candidate serialization contract, not proof of interoperability or a final cryptographic/key-management choice.

Kernel validates the returned receipt against the exact original FreezeRequested record, including the unchanged kernelChallenge. A receipt with a mismatched challenge, epoch, workspace, snapshot or digest is rejected and quarantined.

## 5. Commit / Abort

CommitDecision and AbortDecision must be issued by an authenticated and authorized Kernel identity and bind freezeId, workspaceId, fencingEpoch, snapshotId, receiptDigest and a stable decisionId.

Commit and Abort are mutually exclusive and irreversible. Repeating the same decision with the same digest is idempotent; a different decision, changed digest or stale epoch is rejected.

Host records its decision and ledger transition atomically in its own persistence boundary. Kernel records its decision in its own journal and recovers by resending the original decision identity.

## 6. Recovery and failure policy

- Kernel crash after FreezeRequested: recover the same request ID, challenge, nonce and digest.
- Host crash after PrepareFreeze acceptance: recover the original inbox/ledger state; do not create a new freeze from memory.
- Receipt returned but not recorded by Kernel: query Host Ledger and recover the same receipt.
- Host cannot prove process/handle convergence: Quarantined.
- Receipt authentication or binding fails: reject and quarantine.
- Commit/Abort outcome is unknown: reconcile using both ledgers; do not infer success from a lost ACK.

Exact signing algorithms, certificate format, trust root, key custody, rotation/revocation propagation, clock skew and cross-host recovery are **OPEN / UNVERIFIED**.
