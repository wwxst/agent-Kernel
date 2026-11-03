# Open decisions and external facts

> **Status: REGISTER of genuinely unresolved items only.** Everything decided is recorded in the [Decision Log](decision-log.md). This page lists what cannot be decided by architecture review because it depends on an external fact, a build-time choice or an owner risk acceptance. Nothing here reopens an accepted contract by implication.

## 1. Product direction (decided)

One shared Kernel, independent Coding and Video domains, Office as a design-only third-domain test, Multi-Agent/D9 deferred. See [Decision Log](decision-log.md) and [Unified domain direction](unified-domain-direction.md).

## 2. Decided in this baseline (do not re-litigate without a new decision)

| Area | Decision |
| --- | --- |
| Architecture shape | One authoritative Kernel + version-pinned adapters + data-driven Execution Strategy (ARB-01.3) |
| Readiness model | DF → SA → PE → VI; RFI = DF (ARB-01.2) |
| Records/permissions | Kernel data model + permission model normative (ARB-01.4) |
| Loop/terminal | One loop, `CommitTerminal`, single unresolved-effect rule (ARB-01.5) |
| Effect policy | R2 disabled; R1 under recorded policy with provisional defaults (ARB-01.6) |
| Performance | Strategy fields normative; ceilings are TARGET/UNMEASURED (ARB-01.7) |
| Domain specs | Coding tools/evidence, Video registry/compiler, Office R0/R1 (ARB-01.8) |
| Composition | Application-level `CompositePlan`; no composite Task (ARB-01.9) |
| ADP-03…11 | Construction-scope dispositions (Decision Log §5) |

## 3. Genuinely OPEN (external facts)

These are **not** documentation gaps. No amount of further design can close them; they require evidence or an owner risk acceptance at the named gate.

| ID | Open item | Why it cannot be decided now | Closure |
| --- | --- | --- | --- |
| O-1 | Provider execution **and billing** deduplication for ambiguous sends | Depends on the actual provider's server-side contract, not on client design | PE G-01/G-02, named provider |
| O-2 | Which providers qualify for Hard Budget | Each provider's charge bounds, cache/retry/modality fees and enforceability differ | PE certificate probe per provider |
| O-3 | OS/Host ability to enforce sealed read-only source and disjoint outputs | Depends on kernel/container/OS primitives and toolchain behaviour | PE H-02/H-04 on a named OS |
| O-4 | Whether the chosen storage can validate a selective multi-aggregate read-set under one serializable transaction | Depends on the concrete engine | K-00b required-properties test |
| O-5 | Numeric R1 exposure window, grant TTL, clock uncertainty and fence-ACK target | Risk acceptance with real fleet latency data | Owner ratification after H-01 measurements |
| O-6 | Measured latency, token, cost, success and false-completion rates | No implementation exists | PE/VI E-01…E-04 |
| O-7 | Video editorial quality and human-review reliability | Requires blinded human evaluation on rights-cleared assets | VI V-05 |
| O-8 | Multi-Host ordering and membership | Explicitly outside the single-Host proof | Separate architecture decision |
| O-9 | External Office mutation (in-place edit, share, publish, delete) | R2 disabled; requires effect policy + provider controls + idempotency | Separate owner decision |
| O-10 | Third-party domain trust/signing (real plugins) | The baseline deliberately has no PKI/plugin market | Separate decision when a third party exists |

## 4. Build-time choices (constrained, not architectural)

These are free choices **within** accepted contracts. Choosing one does not require reopening the architecture; choosing one that violates a contract does.

- Language/runtime/package manager and module boundaries.
- Persistence engine, serialization transport (canonical JSON is required on the wire), queue/RPC technology.
- Sandbox product and OS profile (must satisfy `trusted-host.md` and pass G2 fixtures; otherwise the profile is `Unsupported`).
- Provider/model(s), media analyzers, FFmpeg build and packaging.
- Artifact/blob storage, encryption, retention implementation.
- UI surfaces (CLI/API/desktop) beyond the minimal preview/approval contract.
- Concrete task sets, hidden oracles and reviewer rubrics for evaluation.

## 5. What would reopen the architecture

A design change is required — not a configuration change — if any of these occur:

1. A fourth domain needs a new Kernel state, terminal enum, permission state or Host side-effect semantic.
2. A required execution strategy cannot be expressed in [DES](../contracts/execution-strategy.md) fields without exceeding the Kernel floor.
3. A provider cannot ever produce a credible maximum-charge bound, making Hard Budget unusable for a product requirement.
4. A target OS cannot enforce sealed read-only input for any mainstream toolchain, making Coding verification structurally `Unsupported`.
5. Cross-domain composition needs shared budget, inherited approval or a composite Task aggregate.
6. Multi-Agent/D9 becomes required; it is currently deferred and would need its own authority model.

## 6. Change discipline

- A new OPEN item must state why it cannot be decided now, the gate that closes it, and the fail-closed behaviour until then.
- An OPEN item is never resolved by assertion, a model statement, or a document edit alone.
- Closing an item requires a Decision Log entry with evidence reference (or an explicit owner risk acceptance) and a date.
- Removing an item requires a decision entry; silently deleting a risk is a documentation defect.
