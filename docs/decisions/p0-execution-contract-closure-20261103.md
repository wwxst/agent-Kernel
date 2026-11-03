# P0 execution-contract closure (2026-11-03)

> Status: **REPAIRED IN DESIGN / AUTOMATED SCHEMA TESTS DEFINED; EXECUTION EVIDENCE PENDING**. This is a targeted amendment of ARB-01, not a claim that runtime PE/VI is passing. Historical DF PASS remains the outcome of the earlier documented audit; it must not be presented as independent approval of these subsequent changes.

## Scope and source-derived discrepancies

| ID | Verified issue | Normative resolution | Evidence required before runtime |
| --- | --- | --- | --- |
| P0-01 | Core §12.2 made *missing evidence* immediately select verification, even when the subject was not yet produced | Derive `RunnableWork` and `RunnableVerification` from dependencies, snapshot, authority and verification inputs; missing evidence is not readiness | New feature before source exists; fix-before-test; existing proof fast completion |
| P0-02 | Core WakeEvent had no internal continuation cause for empty model response, rejected action, stale CAS or Guard rejection | Closed outcomes `Dispatch / ContinueBounded / Park / Terminal / Escalate`, with durable deduplicated `InternalContinue` and limits | No orphan Open tasks; crash and duplicate wakes cannot reset budget |
| P0-03 | Completion G01 blocked *every* active Invocation while G12 conditionally permitted unrelated isolated work; G06 hardcoded Coding view semantics | G01/G12 use a proof-based dependency scope; G06 checks applicable policy, with Coding verification in Coding profile | Coding/Video/Office shared Guard; unknown overlap always blocks |
| P0-04 | Core referred to one success Guard for all terminal types, although Failed and Cancelled cannot require success evidence | One `CommitTerminal`, status-specific validation, exactly one TaskTerminal + delivery Outbox; only Completed appends CompletionCommitted; unresolved effects require separate durable Hold | Competing terminal/cancel/deadline/receipt CAS, unresolved-effect timeout |
| P0-05 | DES v0.1 §7 used names/enum values not defined in §4 | Canonical field names; adapter-specific repeat-test rule outside DES; full machine schema/fixtures required for deployment | Coding and Video full fixtures validate via stdlib checks; unknown field/enum/bound/digest rejected; live policy/Host binding still unverified |
| P0-06 | Synthetic prototype blocks successful completion if any historical tool ever failed | Completion depends on current accepted criteria/evidence and all *relevant* effects converged; historical failure remains auditable | Failure → repair → fresh Pass → Completed, with UNKNOWN and stale evidence negative controls |

## Deliberate architecture subtraction

- Preserve one primary Agent Loop, one Kernel authority and one separate Trusted Host physical launch gate.
- Start with colocated K/O/G deployments and one K-local transaction store; preserve immutable selected ModelStep/CommandPlan facts to avoid regeneration after crash. **Deleting O's independent logical transaction contract is not approved here**; a future compatibility decision requires fault injection at selected-response / command-outbox boundaries.
- Keep bounded read-only parallelism only on a proved immutable input view. Baseline build/test commands that write cache/output cannot automatically be classified R0.
- Keep typed `WaitRecord`, `UnresolvedEffectHold` and at most one persisted terminal fact; terminal Task decision and external reconciliation are separate responsibilities.
- Count accepted, goal-relevant evidence and bounded novelty; billing, wake count and incidental version changes never reset no-progress budgets.

## Required implementation trace matrix

1. On task creation: choose runnable work before verification when verification input is absent; completion with existing sufficient evidence requires zero new model steps.
2. Empty response, denied item, stale read-set and rejected Guard: one durable disposition and no orphan Open task after restart.
3. Old failed-but-converged tool + repaired current artifact + current trusted evidence: Completed; unresolved UNKNOWN, unconverged Host or stale evidence: blocked.
4. Failed and Cancelled terminal paths do not require success criteria; unresolved effects at deadline become Failed(UnresolvedEffect) plus durable Hold without alleging rollback.
5. Mixed independent R0 calls: receipts imported in completion order, next model context projected in call order; concurrent writes remain serialized.
6. DES examples pass strict schema and floor validation; malformed field names and enum values fail before Task creation.
7. Model/Gateway/Host crash injections at every commit/send boundary: unchanged command and nonce identities on redelivery; no blind Provider resend.

## Gate ownership

These are normative design repairs. Synthetic tests can establish only local logical properties, not signed receipts, OS isolation, Provider billing bounds, live Coding success or measured latency. A real PE/VI gate requires independent checks and recorded results. Any future construction-readiness claim must link the executed tests and specify unsupported capabilities.
