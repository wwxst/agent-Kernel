# Minimal provable Kernel protocol — architecture convergence draft

> **Status: PROPOSED / NOT APPROVED / NOT IMPLEMENTED.** Architecture review amendment, not an ADP owner disposition or runtime authorization. This document narrows and links the cross-module protocol described in [Trusted ToolHost](../security/trusted-host.md), [Model and Budget](model-and-budget.md), [PlanRevision](plan-revision.md), [Completion](completion.md), and [Domain Workflow](domain-workflow.md). In case of disagreement, the corresponding authority-owning contract must be amended before any architecture freeze; this draft alone does not silently override approved decisions.

## 1. Objective and non-goals

The minimum authoritative Kernel protects identity, versioned Task/Plan state, admission, budget reservations, durable intent, idempotency, evidence bindings, and completion transitions. Domain Orchestration owns strategic/tactical/assurance decisions and domain semantics. A Trusted ToolHost owns its physical launch boundary and Host Ledger. Context Engine, evidence indexing, artifact storage, and Model Gateway are composed components, not necessarily distributed services.

This protocol describes **logical authorities** and requires no microservice split. It does not claim OS spawn is atomic with a database write, remote side effects are exactly once, a multi-Host global fence exists, or a model is capable of completing a real task.

## 2. Authority scope, event identity, and **transaction ownership**

Each Kernel command binds a stable command/idempotency key and the **version of its owning aggregate**, not an automatically required global Task version. Structural Goal/Plan/cancel/terminal commands use `taskControlVersion`; ModelStep selection uses `modelStepVersion`; Invocation/receipt updates use `invocationVersion`; budget changes use `budgetScopeVersion`. Admission binds a **selective protected read-set**: accepted GoalContract and active PlanRevision epoch, DomainBinding/profile, exact tool/argument digest, current authority/fence, relevant workspace/project generation, budget reservation version, and any affected PlanStep/precondition identity. K validates that read-set atomically with its local admission/write-set. A global Journal sequence is audit order, **not** a mandatory CAS token for every operation. A repeated command ID with the same digest returns its original durable disposition; the same ID with different bytes is quarantined. A Host run binds Invocation ID, LaunchAttempt ID, Host identity/incarnation, one-use nonce, authority fence, exact target/input snapshot and tool digest.

**Distinct logical records do not mean distinct physical transaction domains.** The first protocol has exactly these independent durable owners:

| Owner / transaction | Records committed atomically within that owner | Recovery scanner and replay |
| --- | --- | --- |
| **K: Kernel Persistence** | Separate TaskControl, ModelStep, ToolInvocation and BudgetScope versioned aggregates; Kernel Journal, Command Inbox, ToolInvocation durable Intent, budget reservation and Dispatch Outbox **atomically co-commit at ToolInvocation admission**. ModelStep final selection, Completed and ResponseDeliveryOutbox commit together. Authenticated Host receipt import, HostResultInbox dedup and Invocation projection commit together. Ordinary Invocation/receipt/budget operations do **not** CAS on an unrelated TaskControl version. | Kernel Dispatcher scans pending K-Outbox after restart and redelivers **the same** message ID, Invocation ID, exact payload and dispatch nonce. Kernel Receipt Importer retries/reconciles trusted results under original IDs. |
| **O: Orchestration Persistence** | ResponseDeliveryInbox, local projection, immutable sealed Kernel CommandPlan, CommandIntents and Orchestration Command Outbox in one O-local transaction. | Orchestration scans unacknowledged deliveries/commands, resends the exact command IDs and payloads; does not generate new commands upon replay. |
| **H: Trusted ToolHost Persistence** | Host DispatchInbox dedup disposition, unique consumed nonce and LaunchAttempt/IntentDurable in one H-local transaction **before spawn**. Persist Host process/result receipts and pending Host Result Outbox using H-local transactions. | Host scans its own Inbox, Ledger and Result Outbox after restart, reconciles process/output facts and resends original authenticated receipts. |
| **Physical process / external target** | OS spawn, descendants, filesystem/remote side effects. **Not** transactionally combined with K, O or H storage. | Host reconcilers inspect trusted process identity, output/target state and idempotency evidence; ambiguity stays OutcomeUnknown. |

K, O and H are independent transaction domains. The **Kernel Journal and Kernel Dispatch Outbox are distinct logical records but must share K's atomic durability boundary**. If an implementation places them in independently committed stores, it cannot claim this protocol without a separately proved equivalent transactional-outbox mechanism. The same rule applies to O's inbox/command plan and H's nonce/LaunchAttempt. The Host may receive the same dispatch repeatedly, but H deduplicates using the original Invocation/dispatch identity and nonce: an already consumed nonce never creates a second OS spawn.

**Crash trace K-1: Intent committed but no message sent.** In one K transaction, commit Invocation=Admitted, Intent, budget reservation and Outbox=Pending; crash before dispatch. On recovery K scans Pending Outbox and sends exactly the original message and nonce. H either accepts it once or returns the original durable disposition. No second Kernel admission, reservation, or Invocation is made.

**Crash trace H-1: Host executed but Kernel has not imported Receipt.** H durably recorded nonce/LaunchAttempt before OS spawn and subsequently has a trustworthy process/result fact and authenticated receipt in H Result Outbox. The result network delivery or K import then fails. On recovery H resends the *same* receipt; K validates it, atomically commits HostResultInbox dedup + Journal/Invocation projection, and ACKs. If the process outcome or receipt itself is missing or ambiguous after a crash, K keeps OutcomeUnknown and Host reconciles; absence of a K receipt never means not executed.

**Crash trace O-1: response delivery accepted but command ACK lost.** O's Inbox + sealed command plan + command outbox were committed locally; it resends exactly those original commands. K CommandInbox dedup returns the original outcomes. Neither side regenerates plan contents, command IDs, nor a second effectful Invocation.

No cross-owner atomic transaction or distributed exactly-once side effect is claimed. See [Response delivery and Inbox](delivery-and-inbox.md) and [Trusted Host](../security/trusted-host.md).

## 3. Authoritative state projections

These tables define a **minimal projection** of the existing richer contracts; they do not rename or remove their additional states.

| Aggregate | Minimal states and allowed progress | Owner |
| --- | --- | --- |
| TaskControl / Plan | Accepted GoalContract, one active PlanRevision, structural switch/cancellation/terminal facts use TaskControl CAS; Planning/Ready/Running/Verifying/Waiting are **derived display modes**. PlanRevision structural cutover remains atomic. | Kernel |
| ModelStep selection | Open → CandidateRecorded → Selected/Completed; selection is irreversible; no candidate if response incomplete/stale | Kernel |
| ModelAttempt execution | Requested → InFlight → Complete/FailedKnown/Cancelled/OutcomeUnknown; charging is a separate dimension | Model Gateway facts, Kernel committed |
| Budget reservation | Reserved → ProvisionallyAccounted → Settled/Adjusted or HeldUnknown; no release on timeout | Kernel |
| ToolInvocation | Proposed → Admitted → DispatchPending → Running/Rejected/OutcomeUnknown → reconciled terminal outcome; lifecycle applies only to Invocation, **not to an ActionProposal batch** | Kernel logical admission; Host owns physical truth |
| Host LaunchAttempt | IntentDurable → GateRejected or LaunchBoundaryRecorded or OutcomeUnknown; nonce never re-usable | Trusted ToolHost |
| Verification / Completion | Bound evidence → criterion review → CompletionGuardAccepted/Blocked; Completed commits once | Kernel Guard |

No planner, verifier or model output is an authority to change these states directly. A non-terminal UNKNOWN can coexist with durable facts and must be handled with a typed reconciliation reason and conflict scope.

## 4. Required transitions and guards

All K-transaction events below require expected aggregate version + stable command ID. Only exact records in the same owner row of section 2 are atomic.

| Event / transition | Preconditions | Durable owner and one-transaction write-set | Crash / duplicate recovery |
| --- | --- | --- | --- |
| AdmitModelAttempt | valid policy; price-envelope certificate and full maximum reservation in hard mode | K: Attempt admission + reservation + Journal event + outbound request intent | K-outbox replay; no new Attempt or reservation |
| RecordCandidate | complete schema/arguments; current snapshot; before effective cancellation | K: candidate digest + Attempt/Step version + Journal order | reject replay conflicts; no executable partial candidate |
| SelectCandidate | first eligible durable candidate, all charge exposure reserved | K: selectedAttemptId + Step Completed + ResponseDeliveryOutbox + Journal | same selected Attempt on replay; O Inbox dedup |
| AdmitToolInvocation | active PlanStep, relevant **selective version read-set** (Plan/Goal, authority, workspace, tool, reservation), per-invocation approval; no unrelated TaskControl CAS | **K: validate read-set + Invocation=Admitted + DurableIntent + Journal + budget hold + DispatchOutbox together** | K-1; no ghost dispatch; unrelated receipts may progress |
| ReceiveHostDispatch | valid original ticket/nonce, valid Host identity | **H: DispatchInbox + nonce consumption + LaunchAttempt/IntentDurable together** | duplicate returns original disposition; no respawn |
| EnterLaunchGate | Host-local fence/version/snapshot/lease state proved current under the *local* gate | H gate serializes local spawn against local fence; later receipts use H transaction | unknown spawn outcome is OutcomeUnknown, never replay nonce |
| InstallHostFence | ordered inside the **same Host-local gate** as physical process creation | H: HostFenceInstalled(seq, epoch, Host incarnation), durable acknowledgement | local fence blocks old launches; Kernel request itself does not |
| MarkRevoked | K RevocationRequested exists and all eligible H gates have trusted installed-fence ACK or verified disablement | K: Revoked + acknowledgements + Journal | never mark Revoked with unaccounted Host |
| ActivateNewPlan | conflicting work converged; snapshot current; L2 accepted | K: old superseded + new active + Plan pointer + barrier event | exactly one Active revision |
| CompleteTask | required evidence including exact execution view; no conflicting effectful UNKNOWN; current sealed artifact | K: CompletionCommitted + TaskCompleted + Journal + delivery reference | exactly one terminal fact |

The Host Ledger + OS spawn are never atomic. A stable Host launch attempt is only proof that the exact physical step occurred where independently evidenced, not proof of external business success. Missing physical evidence is recorded as OutcomeUnknown.

**Forbidden transition:** K-Outbox delivery is not permitted until K Intent/Admission/Outbox commit is durable. A consumer cannot reconstruct a new nonce for an unresolved original dispatch. A stale or denied per-Invocation approval never authorizes launch. **No global TaskControl CAS on every Attempt/Invocation/receipt:** it would generate artificial conflicts and is not part of this minimized protocol. Domain/Kernel state reads must still revalidate the *relevant* protected epochs and read-set under K-local transaction isolation. If the chosen persistence cannot prove this, G1 cannot pass.

## 5. Single-Host launch and revocation ordering (initial scope)

**Three authoritative events, two ordering domains:**

1. `RevocationRequested(K, requestedEpoch)`: durable K transaction, immediately prevents new related admission/ticket issuance and records desired epoch. This is **not** a guarantee that a previously issued ticket cannot still launch on H.
2. `HostFenceInstalled(H, installedEpoch, gateSequence, hostIncarnation)`: a durable local H gate event serialized against the physical spawn boundary. After installation, a ticket with an older epoch **cannot** start on that H. An old launch that crossed the local gate first remains in flight even if K had already committed RevocationRequested.
3. `Revoked(K, hostAckSet)`: K transition only when every eligible Host gate is verified fenced or verifiably disabled. It means no eligible old-epoch **new launch**, not that running jobs or descendants are stopped; `ProcessConverged` remains independent.

The intermediary authority state is `RevocationPending`. The interval `K.RevocationRequested < H.physicalLaunch < H.HostFenceInstalled` is **allowed and auditable**; a test must not misclassify it as a violation of the local-fence contract. Conversely `H.HostFenceInstalled < H.launchAttempt(old epoch)` must reject without spawn. If H is unreachable and its disablement cannot be independently proved, K cannot mark Revoked.

**Proof eligible for the Host gate:** H must be authoritative for a locally serialized and durably persisted effective authorization/fence snapshot. An execution grant must bind scope, Host ID/incarnation, immutable profile/tool, authority version vector, installed-fence epoch, workspace generation, budget reservation generation, exact invocation nonce and a short bounded validity interval. H must establish (a) authenticity, (b) unexpired grant and Host live-authority channel/lease, (c) no locally installed newer fence or known invalidation, and (d) no inconsistent workspace/reservation view. Remote changes not installable through the same H gate are **not globally linearized**: their effectiveness is defined by H's acknowledged local installation. A cached grant alone, an offline Host, or a stale independent read is insufficient. A Host without a bounded and trusted authority/fencing channel must refuse effectful launch.

Under the **same serialized local critical section**, H validates effective local snapshot, durably consumes the nonce with LaunchAttempt, then crosses the process-creation boundary; H fence installation and any locally mutable validity invalidations must use that same serialization. Checking outside the critical section and spawning later is forbidden TOCTOU. The gate must not remain authorized beyond the grant's permitted launch deadline; an unprovable expiration or network loss fails closed. A long-running operation launched before the local fence is governed by drain/cancel policy, not retroactive non-execution.

The above proof does **not** assert that H has a linearizable view of K's most recent revocation request at every instant. Such a stronger requirement would prohibit the acknowledged-request/pending-local-fence race and would require a different protocol. Multi-Host global ordering remains deferred. See [Trusted Host](../security/trusted-host.md).

## 6. Model usage, budget and liveness

Execution, candidate selection, and final financial settlement are independent. **Hard-budget admission requires a ProviderAdapter maximum-charge certificate**, durably tied to that exact Attempt/request, pricing contract and all possible provider-generated billable actions; merely observing an output token cap is insufficient.

A certificate must bind at least: Provider/account and model/SKU; pricing version/effective interval/currency; canonical request digest; exact **maximum billable input** (including system/tool/cache, variable input and provider prompt transformations); enforced maximum output/reasoning/tool tokens where billed; cache write/read minimum/maximum price treatment; fixed fees, batch, retrieval, image/audio/video/other modalities and extras; retry/redirect/continuation multiplier with a provider-enforced ceiling; conservative rounding/taxes/FX policy where applicable; computed total upper bound and evidence of each enforceable limit; validity/expiry and verifier identity. Unknown extra charges, unbounded server-side retries, uncapped output or mutable unpinned pricing invalidate the certificate.

The adapter computes the upper bound conservatively and supplies enforceability evidence; Kernel **validates the certificate's coverage, version and trusted adapter identity, but does not trust model assertions**. For each funding scope, reserve every concurrently chargeable Attempt using `confirmed_spend + outstanding_reserved_max + proposed_max <= hard_limit`. Abort hard-budget admission if any bound is unprovable; explicitly opt-in to separately tracked Soft Budget or choose another Provider. A late bill above the certificate triggers append-only overrun/enforcement hold and incident classification; it does not rewrite the winning response or a terminal Task.

A complete valid winning response can commit while losing Attempts/invoices remain unresolved **only if all outstanding charge exposure remains reserved**. Timeouts and cancellation do not release reservations. See [Model and Budget](model-and-budget.md).

## 7. One main Agent Loop and plan-change fast path

A **single primary Task Orchestrator** chooses Strategic, Tactical or Assurance as **decision purposes**, not independently running control loops or separate ControlProposal state machines. It observes current authoritative facts, selects one next decision, admits each proposed side effect independently, updates the domain projection, and returns to the same loop. A higher-priority cancellation, conflicting UNKNOWN, user instruction or assurance failure preempts the next decision, not the already started Host facts. See [Architecture subtraction review](../decisions/architecture-subtraction-review.md).

- **L0 TacticalAdjustment:** search, debugging hypothesis, tool choice, and an existing planned operation's *one-use InvocationApproval* grant/denial within the current GoalContract, PlanStep, declared capability/effect/scope and risk ceiling. A per-invocation approval is checked at admission/launch, recorded with the exact Invocation, argument digest, authority versions, expiration and nonce. It does **not** alter immutable PlanRevision, so does not trigger cutover.
- **L1 PlanStepRework:** explicit rerun of the same objective and authority envelope, retaining current PlanRevision and invalidating affected verification evidence. An ordinary InvocationApproval may independently be required for a rework tool.
- **L2 StructuralReplan:** the accepted GoalContract/PlanRevision protected scope, capability/effect envelope, risk policy, required approval **policy or approval boundary**, task-level resource envelope, dependency graph or acceptance obligation changes. Full freeze/drain/reconcile/refresh/validate/cutover is mandatory.

**Revocation is orthogonal to plan classification.** Revoking an individual invocation's approval immediately stops further K admissions for that approval and initiates its H fence/needed cancellation; it does not *automatically* create L2. Domain Orchestration assesses whether the existing plan can continue with alternative authorized invocations; only a protected plan/goal/policy change triggers L2. A grant may not silently widen plan scope, capability or risk level. Kernel checks the effective protected-field diff rather than trusting the model's L0/L1 label.

## 8. Evidence snapshot, **actual execution view** and completion

For Coding, pin a trusted immutable `SourceSnapshot`, versioned `ProtectedInputScope`, toolchain/environment, and **ExecutionViewManifest**. The SourceSnapshot digest alone is not evidence of what a test process actually read. The Manifest binds Host run/process tree identity, working directory, root filesystem/namespace and mount tree configuration, read-only source mount identity, overlay lower/upper ordering and whiteouts, allowed writable scratch/output roots, environment/config inputs, relevant inherited file descriptors, symlink and path resolution policy, and exact digest of the protected files as **resolved in the process's effective filesystem view**.

**Default admission rule:** protected inputs must be resolved from the immutable source read-only layer, with no writable overlay/bind mount or symlink/hardlink/path redirection capable of shadowing them. All allowed writable roots must be disjoint from protected inputs and cannot provide alternative search-path/test script/config origins. Host records authenticated pre-execution view identity and runtime mutation/mount restrictions, verifies relevant effective paths and view at process termination, and supplies a receipt bound to the verification command, snapshot digest and mount/namespace configuration. If a platform cannot enforce these restrictions, it needs an equivalent trusted continuous open/path + mutation trace and final effective-view validation; **unknown visibility is not Passed**.

The acceptance condition is **both** `sourceDigestBefore == sourceDigestAfter == sourceDigestAtGuard` on the immutable protected inputs **and** `effectiveProtectedInputDigestBefore == effectiveProtectedInputDigestAfter == sourceDigestAtGuard` with verified same source identity/approved path resolution. A different effective view, shadowed protected config/test script, unapproved symlink, late mount replacement, or unverifiable direct/external input marks the run Invalid/Stale even when all raw snapshot hashes match. The Completion Guard checks Host-signed ExecutionViewManifest, enforcement outcome, actual-view digests and process convergence; output caches/coverage remain separately attested artifacts, not protected inputs. See [Completion](completion.md) and [Workspace freeze](workspace-freeze.md).

Video continues with source/project/timeline/render/output lineage and its own render execution view where relevant. Completion remains evidence-gated, never inferred from a model assertion; conflicting effectful UNKNOWN blocks completion.

## 9. Safety invariants and illegal combinations

1. An incomplete or invalid model response has no executable tool proposal.
2. One ModelStep has no more than one irreversible selected Attempt; later candidates cannot replace it.
3. A ToolInvocation has no physical launch without exact current Host gate authority.
4. A consumed ticket nonce never becomes launchable after restart.
5. An installed Host fence rejects the older epoch; revocation completion requires all eligible gates accounted for.
6. OutcomeUnknown is not FailedKnown; no automatic effectful retry, cutover or publish through a conflicting UNKNOWN.
7. One Task cannot have two Active PlanRevisions; no old revision may newly admit work after its barrier.
8. The summed outstanding financial exposure in hard-budget scopes never exceeds the reserved ceiling at admission.
9. No TaskCompleted without current required criterion evidence, final snapshot and relevant process convergence.
10. Inbox/Outbox replay cannot create a second authoritative selection, plan activation, completion or consumed launch token.
11. Coding/Video semantic judgments stay outside Kernel; Domain does not grant physical execution authority.
17. Ordinary ModelStep/Invocation/receipt/evidence operations use owning-aggregate CAS and protected read-set checks; they do **not** require global TaskControlVersion equality. TaskControl CAS still protects Goal/Plan/cancel/terminal transitions.
18. ActionProposal is a bounded immutable intent envelope with no authoritative executing/settled state; per-Invocation events determine its derived progress. EvidenceGraph is a non-authoritative optional index, not a second ledger.
19. Strategic/Tactical/Assurance are modes of one controller; Task and PlanStep work/verification display views are derived from canonical facts and may not act as independent approval authorities.

Additional G0 invariants:

12. `K.RevocationRequested` without `H.HostFenceInstalled` cannot be used as evidence that an existing ticket was unable to launch; `K.Revoked` requires trusted Host ACK/disablement. `H.HostFenceInstalled` must forbid later old-epoch spawn.
13. `AdmitToolInvocation` is one K-local atomic write-set (Journal + durable Intent + budget hold + DispatchOutbox); separate K/O/H owners have no distributed atomic guarantee.
14. A passed Coding verification report requires actual `ExecutionViewManifest` identity and trustworthy no-shadow protected-path evidence; equality of lower-layer source digests alone is insufficient.
15. One-use `InvocationApproval` inside an existing immutable PlanRevision is not L2; expanding the plan's protected authorization envelope is L2.
16. Hard-budget Attempt admission requires a validated, bound `MaximumChargeCertificate` covering all potentially billable dimensions; unbounded provider charges cannot enter Hard Budget.

Forbidden pairs include: `RevocationRequested + falsely reported Revoked without HostFenceInstalled ACK`, `CompletionPassed + unproven actual protected input view`, `KernelDispatchOutbox committed without same-transaction Intent`, `HardBudgetAttempt + missing max-charge certificate`, `Revoked + unacknowledged eligible Host`, `Completed + unresolved conflicting effectful UNKNOWN`, `Superseded Plan + new admitted old-plan write`, `HardBudgetAttempt + unbounded charge`, `Selected + incomplete candidate`, and `HostStarted + no matching durable LaunchAttempt` (except that missing facts after a crash are explicitly represented as OutcomeUnknown, not silently fabricated).

## 10. Reproducible traces and architecture gates

Each fixture specifies initial durable records, interleaving, injected crash/partition/fence, expected committed events, final state and allowed next actions. Required traces:

| Fixture | Expected result |
| --- | --- |
| **R1** K RevocationRequested commits; H gate still on old epoch; old ticket crosses spawn; then H installs fence | Old launch recorded as **in flight**; K remains Pending until trusted ack; cancellation/drain policy applies; no claim of instantaneous revoke |
| **R2** H HostFenceInstalled first; old ticket arrives | Rejected before spawn; nonce never yields process |
| **R3** H unreachable before fencing / lease or liveness proof expires | No further launches without live proof; K RevocationPending until verified disablement or acknowledgement; never false Revoked |
| **R4** Host checks local authority, fence races with OS spawn | Exactly one local gate order; no validation-then-spawn TOCTOU, failure of proof fails closed |
| **T1** K Invocation Intent + Journal + Outbox commit, crash before sending | K Outbox scan resends same ID/nonce; H one consumption; no duplicate reservation or invocation |
| **T2** H process executed + result durable, K receipt import lost | H Result Outbox retries; K HostResultInbox + Journal atomically dedupes and applies one outcome |
| **T3** H crashes after nonce consumption before/around spawn | Original ticket never replayed; unresolved spawn and effects remain UNKNOWN |
| **T4** Duplicate O command, duplicate Host receipt, changed digest on same ID | Same digest returns original result; mismatch quarantined; never double commit |
| **V1** Writable overlay shadows actual test script/config while immutable snapshot digest stays constant | Host view proof detects shadow or cannot establish equality; Completion Guard rejects evidence |
| **V2** Symlink/bind mount/path-search resolves to unexpected protected input | Host rejects or emits Invalid/Stale; not Passed |
| **V3** Writes only to approved cache/coverage output root | Trusted actual-view digest unchanged; no false Stale |
| **P1** Once-only invocation approval within existing plan | Grant checked at Admission/Host; no L2; revocation blocks old ticket independent of plan revision |
| **P2** A plan-wide capability/approval policy/risk boundary changes | Structural L2 required |
| **B1** Maximum-charge certificate omits provider retries/cache/modality fees or uses unpinned pricing | Hard-budget admission denied; explicit Soft Budget only |
| **B2** Candidate wins while another Attempt hangs with bounded reservation | Winner completes and delivers; loser reservation retained; late authoritative adjustment is append-only |
| **C1** Coding/Video common identity/admission/receipt/Completion envelope | Same Kernel authority semantics, no domain import |

**G0 — documentation gate (NOT APPROVED):** review transaction ownership/write-sets and normalized crash traces; Host requested/installed/Revoked distinction and live local authority proof; actual effective verification view; InvocationApproval versus structural PlanRevision; maximum-charge certificate; state tables/illegal combinations; pending ADPs.

**G1 — protocol feasibility (NOT RUN):** deterministic replay, race, fault and financial-bound fixtures. **G2 — Host trust (NOT RUN):** actual single-Host serialized spawn/fence, protected execution view, crash and descendant containment. **G3/G4 — Domain slices (NOT RUN). G5 — Cross-domain reuse (NOT RUN).** Each requires separate authorization; no PASS may be inferred from these documents.

## 11. Architecture-review checklist

- Are any two documents still assigning the same authoritative transition to different components?
- Is each 'atomic' claim scoped to one actually shared transactional or serialized boundary?
- Does an unresolved UNKNOWN block only operations that conflict with its potential effects?
- Can an otherwise valid selected response proceed without awaiting unrelated invoices?
- Are protected input scope and verification output lineage disjoint and frozen?
- Is the L0/L1/L2 classifier tied to protected-field comparisons rather than model preference?
- Have single-Host and multi-Host promises been kept separate?
- Are ADP-03 through ADP-11 explicitly still OPEN until owner decisions?
