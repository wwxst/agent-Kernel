# Construction readiness review (ARB-01)

> **Status: ACCEPTED (construction scope, 2026-11-03). Verdict: DF PASS — Ready for Implementation at the documentation/design level. PE and VI are NOT RUN.** This record is the acceptance artifact for the construction baseline. It is a document-level review; it is not runtime evidence, an external certification, or implementation authorization.

## 1. Scope and method

**Baseline reviewed:** commit `f1c027f` (main) plus the changes on `docs/rfi-construction-20261103`.
**Method:** eight role-separated reviews, each reading the assigned documents directly and citing line numbers, followed by chief-architect adjudication, contract repair, and a construction work breakdown.

| Role | Assignment | Verdict on the unrepaired baseline |
| --- | --- | --- |
| Kernel runtime | core protocol, lifecycle, plan revision, delivery, model/budget | NOT READY (4 P0) |
| Performance/Token | context engine, model/budget, shared evaluation | NOT READY (5 P0) |
| Coding domain | Coding design/failure/evaluation | NOT READY (8 P0) |
| Video domain | Video design/contracts/render | NOT READY (5 P0) |
| Domain extension/Office | extension, workflow, domain architecture | READY-WITH-FIXES (6 P0) |
| Security/reliability | host, freeze, completion, delivery | NOT READY (5 P0) |
| Independent adversarial | whole set, over-design, readiness logic, proof of superiority | NOT READY |
| Documentation integrity | all 43 files, links, statuses, duplication | Structural pass with stale claims and no precedence |

Reviewers were AI subagents with no edit rights; the chief architect adjudicated and edited. The Video repair was completed by the architect after the Video editor terminated mid-task, and was re-checked by the same acceptance pass. Design, review and acceptance were role-separated: no reviewer approved its own repair, and the acceptance checks in §5 were run against the repaired tree, not against reviewer claims. This is disclosed because a document-level AI review is not an external human certification.

## 2. What the review established

**Genuinely strong in the baseline (retained):** K/G/H transaction separation; durable `SendMayHaveOccurred` with no blind provider resend; UNKNOWN ≠ failure; sealed read-only source plus `ExecutionViewManifest`; single-Host honesty; the subtraction of the three-loop model, the ActionProposal lifecycle and mandatory EvidenceGraph; and the evaluation protocol in `research/shared-kernel/evaluation.md`.

**Systemic gaps (repaired):** the documentation had no canonical record/permission schema, no per-domain execution policy, no domain tool/operation registries or compiler algorithm, three conflicting loop orders, two conflicting terminal rules, and a readiness gate that required a finished implementation. Domain-specific clauses had also leaked into "neutral" contracts.

## 3. P0 findings and disposition

All P0 findings below are resolved in this change or explicitly converted into a build-time capability probe with fail-closed behaviour. P1/P2 findings that do not block construction are listed in §6.

| ID | Finding | Resolution |
| --- | --- | --- |
| KR-01 | Three normative loop priority orders; no wake contract | Core §12 rewritten as one numbered algorithm with `WakeEvent` causes, coalescing and an iteration bound; DES and extension now reference it |
| KR-02 | Deadline with unresolved effect: terminal fail vs non-terminal wait | One rule: `Failed(reason=UnresolvedEffect)` + separate durable hold, or `Open` + `WaitRecord`; "agent decision task" deleted |
| KR-03 | PlanStep state called derived yet has a transition table and no version | `plan_step_version`; persisted event-sourced state with guards; invalidation rule |
| KR-04 | Completion trigger ambiguous between command and wake handler | `CommitTerminal` is the only terminal path; Guard runs inside it |
| KR-05/08 | Missing Invocation edges and reconciliation enum | Edge table incl. gate reject, expired grant, consumed nonce, late receipt; `Succeeded|FailedKnown|NotExecutedProven|Abandoned` |
| KR-07 | Approval referenced but never modelled | [Permissions](../security/permissions.md): principals, capability grants, one-use approvals, SoD, tenancy |
| SR-01 | R1 required an owner window that did not exist while verification needs writable roots | Effect Admission Matrix v0 with provisional, ratifiable defaults and a startup refusal when no policy exists |
| SR-02 | No reconciliation oracle for filesystem effects | Per-effect-class UNKNOWN oracle table with closure evidence, lifetime, owner, escalation and reservation release |
| SR-04 | Three unnamed epoch counters; "eligible Host set" undefined | Epoch registry (authority epoch, workspace generation, ticket epoch); membership and decommission rules |
| SR-05 | No permission authority | Same as KR-07 |
| SR-07/08 | Freeze request/decision state machine incomplete | Request lifecycle, expiry/retry, intent-before-send, Host rejects the opposite decision |
| CD-01/02/03/04 | Recon had no budget; tools were names; no patch formalism; no test selection record | Coding §14 registry, recon budget/coverage/stop predicate, patch rules, `TestSelection` record |
| CD-09/11/14 | Sealed-input equality contradicted hidden oracles and real toolchains | `DependencyRoot` + `HiddenOracleInput` as declared digest-bound inputs; `ProtectedInputScope` membership rule; supported-toolchain matrix |
| CD-12/13 | Evidence was prose; no fail-to-pass or baseline | Evidence catalog with `EV-TEST-F2P`/`EV-TEST-HIDDEN`; mandatory baseline capture |
| VD-01 | Media identity and snapshot digest not canonical | Canonical serialization, full-content fingerprint, duplicate-bytes rule |
| VD-02 | Operation registry cited but never enumerated | Closed v1 registry with args, ranges, rounding, evidence, compiler rule ids |
| VD-03 | "Deterministic compiler" had no mapping rules | New [Render Compiler](../contracts/render-compiler.md): normalization prefix, per-op mapping, audio/transition rules, canonical argv, TCB |
| VD-11/13 | Publication fencing and Pass authority undefined | Idempotent publication protocol; decode-scan/tolerance catalog; only verifier proposal + Guard may write Pass |
| DE-01/02/04/05 | Manifest lacked fields; effect class adapter-declared; no Kernel floor; second activation authority | Manifest parity, Kernel re-derivation, single assurance owner + Kernel floor, activation merged into DomainBinding/authority epoch |
| DE-03 | Kernel/Host/Guard contained domain-named branches | Replaced with generic evidence classes (`protected_input_view`, `output_inspection`, `external_target_identity`, `provenance_map`); long-job cap renamed |
| DE-06 | No per-domain strategy object | [Execution Strategy](../contracts/execution-strategy.md) with Kernel floor F1–F12 and reference strategies |
| PT-01 | Token ceilings required but declared OPEN | Context TARGET envelope table (per domain × purpose), explicitly UNMEASURED |
| PT-02 | Cost gate non-computable | `exposure_adjusted_cost` and `cost_per_verified_success` formulas plus explicit denominators |
| PT-03 | No per-domain policy | Same as DE-06 |
| PT-04 | Adaptive verification unproven | Shadow-audit design, sensitivity/specificity/missed-defect/false-block metrics; gate cannot pass without audit |
| PT-05 | No cheating control | N0–N4 unsafe arms that must fail; harness invalid if a cheat passes |
| O1 | Assurance had two owners | `VerificationPolicy` is the sole owner; DES may only tighten and add triggers |
| O2 | Shared report had domain-shaped fields | `domain_evidence_refs[]` (schema + digest) only; conformance scan includes shared schemas |
| O3 | "Minimal Kernel" unproven and unbounded | Deletion/retention ledger in the Decision Log; marginal-cost-of-domain metric and A1–A4 comparison designed (NOT RUN) |
| — | RFI gate required a finished implementation | DF → SA → PE → VI model; RFI = DF; PE/VI remain NOT RUN |

## 4. Adjudications

| Proposal from review | Decision | Reason |
| --- | --- | --- |
| Require prototype evidence (PE) before any "ready" claim; rename readiness "Construction Ready" | **PARTIALLY REJECTED** | The owner's mandate is documentation-only. Requiring PE to declare construction readiness makes the task logically impossible. DF is defined as construction readiness; PE/VI are separately required for release claims, and this record states that explicitly. |
| Narrow the freeze to a Coding-first slice and make Video informative | **REJECTED** | Owner requires Coding, Video and the Office extension test to be buildable from this baseline. The build order is still Kernel → Coding → Video (§ roadmap milestones), but the document freeze covers all three. |
| Delete ActionProposal entirely | **ACCEPTED in substance** | It is now only a bounded `decision_id` on Invocations; no parallel lifecycle. |
| Move ScopedReadGrant/handoff to informative until composite tasks are authorized | **PARTIALLY ACCEPTED** | The handoff contract stays normative because composite delivery is a stated requirement; its *implementation* is a later milestone, and no composite Task aggregate is introduced. |
| Drop `publisher_attestation`/PKI from the extension manifest | **ACCEPTED** | Digest/version is sufficient for v0.2; no third-party plugin market exists. |
| Merge the 12-field maximum-charge certificate into a provider policy version | **REJECTED** | Billing bound is a safety property; hard budget fails closed without it. Soft-only mode remains available and explicit. |
| Keep only L2 and make L0/L1 informative | **PARTIALLY ACCEPTED** | L2 remains the only structural replan trigger; L0/L1 remain operational behavior with per-invocation approval, because they answer a real question (when a cutover is required). |
| EvidenceGraph should be removed from the shared-contract list | **ACCEPTED** | It is documented as an optional rebuildable index in one place and linked, not restated. |
| Add A1–A4 architecture comparison and marginal domain cost | **ACCEPTED** | Added to the evaluation protocol as a NOT RUN experiment with explicit falsifiers. |

## 5. DF acceptance checklist

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Kernel responsibilities, protocols, interfaces, state machines, execution flow singular and explicit | **PASS** | core-protocol, kernel-data-model, lifecycle, permissions |
| 2 | Coding and Video can be developed from the documents | **PASS** | Coding registry/evidence/fixtures; Video registry/compiler/reconciliation/fixtures |
| 3 | A new domain extends without changing the Kernel state machine | **PASS (design)** | Domain extension manifest/ports; X13 zero-diff requirement; no domain branch in loop/DES |
| 4 | Normal, failure, cancel, timeout, crash-recovery, terminal paths complete | **PASS (design)** | core §12, Invocation edges, WaitRecord, holds, M/R/S/T/P fixtures |
| 5 | Performance/Token strategy and acceptance method exist | **PASS (design)** | DES, Context TARGET envelope, cost/percentile/shadow-audit/cheat-arm protocol |
| 6 | Task breakdown with dependencies, order, acceptance | **PASS** | Roadmap §3–§4 |
| 7 | P0 closed; no major cross-document conflict | **PASS** | §3 table; link/status/ownership checks in §5.1 |

### 5.1 Integrity checks run on the repaired tree

- **Index:** every Markdown document under `docs/` is referenced from `docs/README.md` (scripted check: 0 missing).
- **Status:** every normative contract carries the ARB-01 status line; historical records are labelled HISTORICAL; no contract header claims approval without a Decision Log entry.
- **Links:** scripted scan of all 47 Markdown files found **0 broken relative file targets and 0 broken in-document anchors** (2026-11-03).
- **Ownership:** each record/enum family has one owning document (data model §7); duplicated field tables were replaced by links.
- **Claims:** no normative document asserts measured performance, quality, security certification or runtime success; provisional values are labelled.

A script proving links exist is not a proof that prose is correct; §3 and the independent review conclusions carry that judgment. No check here is a substitute for PE.

## 6. Residual risks and non-blocking findings

1. **No runtime evidence.** All protocol properties remain unproven until PE. This is the dominant residual risk.
2. **R1 provisional defaults are a risk acceptance**, not a measured safe window.
3. **Hard budget depends on a provider capability that may not exist**; the fallback is explicit soft mode, never a silent downgrade.
4. **Sealed-source compatibility is partial**; unsupported toolchains must stay `Unsupported`, which limits Coding coverage until H-04 proves an ecosystem.
5. **Video quality is unmeasured**; the acceptance catalog defines how to measure it, not that it will pass.
6. **P1/P2 items not blocking DF** are recorded as follow-ups: journal/ledger retention bounds (now specified as required properties but not sized), key-management implementation, multi-tenant shared Host, Office external effects, Browser/Data strategies, policy DSL, automatic strategy tuning.
7. **Documentation drift risk** remains: duplicated operational numbers (e.g. provisional TTLs) must be changed only in their owning document.

## 7. What may and may not be claimed

**May claim after DF:** "Construction baseline v1 is frozen; a competent team can implement it directly; no known P0 documentation defect or cross-document contradiction remains; all runtime properties are explicitly UNVERIFIED."

**May not claim:** ready for release, validated, production-ready, safe against a compromised Host, provider billing safety, faster/cheaper, or higher task success — none of these has evidence. G1–G5-style "PASS" from documents is forbidden. Only PE/VI records naming environment, commit, fixtures and raw traces can support runtime claims.

## 8. Sign-off record

| Field | Value |
| --- | --- |
| Gate | DF (Design Freeze) — construction baseline v1 |
| Scope | Kernel, Host, Gateway/budget, Context, Coding, Video, Office design sample, evaluation design |
| Baseline | `f1c027f` + branch `docs/rfi-construction-20261103` |
| Owner decision | ARB-01 (Decision Log §6) |
| Independent review | Eight role reviews (§1); adversarial reviewer verdict recorded as NOT READY on the baseline |
| Chief architect | Adjudication, contract repair, WBS (§3–§4) |
| Integrity checks | 47 files; 0 broken links/anchors; index complete (§5.1) |
| Construction simulation | Paper walk-through by domain experts: Kernel, Coding, Video, Office; documented in the roadmap tickets |
| Remaining P0 | None known |
| Residual risks | §6 |
| PE/VI | **NOT RUN** |
| Date | 2026-11-03 |

## 9. Independent reviewer conclusions (verbatim summary)

- Kernel: "authority/transaction/UNKNOWN skeleton is READY-WITH-FIXES; execution-control layer not constructible without invention."
- Performance: "budget ledger and safety design are strong and honest; performance layer had no ceiling, no computable cost gate, no per-domain policy, no safety proof for skipping verification."
- Coding: "authority envelope is buildable; the Coding execution chain was not — tools were names, hidden oracles contradicted the sealed rule, no fail-to-pass evidence."
- Video: "well-governed as obligation prose; no typed operation registry, no compiler mapping, no reproducible media identity."
- Extension: "structurally sound; failed its own falsification gate because Kernel-level domain clauses and a missing strategy object existed."
- Security: "K-local atomicity and the Host gate are implementable; no permission contract, no epoch registry, no UNKNOWN oracle for filesystem effects."
- Documentation integrity: "statuses contradicted the register; four 'Approved' headers had no decision; link-audit PASS claims were stale; no precedence rule."
- Adversarial: "NOT Ready for Implementation; RFI as defined is unreachable by a documentation-only team; assurance had two owners; domain-neutrality contradicted by shared report fields."

These verdicts apply to the **pre-repair** baseline. The repairs are mapped in §3; the reviewers did not re-approve their own fixes, and this record does not claim they did.
