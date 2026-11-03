# Minimal provable Kernel protocol — construction baseline

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; runtime claims UNVERIFIED.** Scope: the cross-module protocol linking [Trusted ToolHost](../security/trusted-host.md), [Model and Budget](model-and-budget.md), [PlanRevision](plan-revision.md), [Completion](completion.md), and [Domain Workflow](domain-workflow.md). This document owns authority boundaries, guards and transitions; record shapes, enums, events and error codes are owned by the Kernel data model, domain execution policy by the Execution Strategy contract, and principals/approvals by the Permissions contract. In case of disagreement on authority, the corresponding authority-owning contract must be amended in the same change; no clause here is evidence of runtime behaviour.

## 1. Objective and non-goals

The minimum authoritative Kernel protects identity, versioned Task/Plan state, admission, budget reservations, durable intent, idempotency, evidence bindings, and completion transitions. Domain Orchestration owns strategic/tactical/assurance decisions and domain semantics. A Trusted ToolHost owns its physical launch boundary and Host Ledger. Context Engine, evidence indexing, artifact storage, and Model Gateway are composed components, not necessarily distributed services.

This protocol describes **logical authorities** and requires no microservice split. It does not claim OS spawn is atomic with a database write, remote side effects are exactly once, a multi-Host global fence exists, or a model is capable of completing a real task.

## 2. Authority scope, event identity, and **transaction ownership**

Each Kernel command binds a stable command/idempotency key and the **version of its owning aggregate**, not an automatically required global Task version. Structural Goal/Plan/cancel/terminal commands use `taskControlVersion`; ModelStep selection uses `modelStepVersion`; Invocation/receipt updates use `invocationVersion`; budget changes use `budgetScopeVersion`. Admission binds a **selective protected read-set**: `tenant_id` and principal scope, accepted GoalContract and active PlanRevision epoch, DomainBinding/profile, exact tool/argument digest, current authority/fence, relevant workspace/project generation, budget reservation version, and the affected PlanStep identity with its `plan_step_version` and precondition digest. K validates that read-set atomically with its local admission/write-set. A global Journal sequence is audit order, **not** a mandatory CAS token for every operation. A repeated command ID with the same digest returns its original durable disposition; the same ID with different bytes is quarantined. A Host run binds Invocation ID, LaunchAttempt ID, Host identity/incarnation, one-use nonce, authority fence, exact target/input snapshot and tool digest.

**Distinct logical records do not mean distinct physical transaction domains.** The first protocol has these **local durable owners** (Gateway G can be colocated with K without a new service):

| Owner / transaction | Records committed atomically within that owner | Recovery scanner and replay |
| --- | --- | --- |
| **K: Kernel Persistence** | Separate TaskControl, ModelStep, ToolInvocation and BudgetScope versioned aggregates; Kernel Journal, Command Inbox, ToolInvocation durable Intent, budget reservation and Dispatch Outbox **atomically co-commit at ToolInvocation admission**. ModelStep final selection, Completed and ResponseDeliveryOutbox commit together. Authenticated Host receipt import, HostResultInbox dedup and Invocation projection commit together. Ordinary Invocation/receipt/budget operations do **not** CAS on an unrelated TaskControl version. | Kernel Dispatcher scans pending K-Outbox after restart and redelivers **the same** message ID, Invocation ID, exact payload and dispatch nonce. Kernel Receipt Importer retries/reconciles trusted results under original IDs. |
| **G: Model Gateway send ledger** | Per-Attempt Gateway-delivery dedup identity, immutable Provider request digest/key and durable `SendMayHaveOccurred` **before any outbound Provider bytes**; subsequent authenticated status/response/usage observations append under the same Attempt. This may live in K storage when colocated; it is never atomic with external Provider acceptance. | Gateway recovers the marker and original request/Provider status without blindly reissuing HTTP. K Outbox repeats only delivery **to G**, not Provider submission. |
| **O: Orchestration Persistence** | ResponseDeliveryInbox, local projection, immutable sealed Kernel CommandPlan, CommandIntents and Orchestration Command Outbox in one O-local transaction. | Orchestration scans unacknowledged deliveries/commands, resends the exact command IDs and payloads; does not generate new commands upon replay. |
| **H: Trusted ToolHost Persistence** | Host DispatchInbox dedup disposition, unique consumed nonce and LaunchAttempt/IntentDurable in one H-local transaction **before spawn**. Persist Host process/result receipts and pending Host Result Outbox using H-local transactions. | Host scans its own Inbox, Ledger and Result Outbox after restart, reconciles process/output facts and resends original authenticated receipts. |
| **Physical process / external target** | OS spawn, descendants, filesystem/remote side effects. **Not** transactionally combined with K, O or H storage. | Host reconcilers inspect trusted process identity, output/target state and idempotency evidence; ambiguity stays OutcomeUnknown. |

K, O, H, and G (unless G is colocated with K) are independent transaction domains. **Provider acceptance/billing is another non-transactional external boundary.** The **Kernel Journal and Kernel Dispatch Outbox are distinct logical records but must share K's atomic durability boundary**. If an implementation places them in independently committed stores, it cannot claim this protocol without a separately proved equivalent transactional-outbox mechanism. The same rule applies to O's inbox/command plan and H's nonce/LaunchAttempt. The Host may receive the same dispatch repeatedly, but H deduplicates using the original Invocation/dispatch identity and nonce: an already consumed nonce never creates a second OS spawn.

**Crash trace K-1: Intent committed but no message sent.** In one K transaction, commit Invocation=Admitted, Intent, budget reservation and Outbox=Pending; crash before dispatch. On recovery K scans Pending Outbox and sends exactly the original message and nonce. H either accepts it once or returns the original durable disposition. No second Kernel admission, reservation, or Invocation is made.

**Crash trace G-1: K model Outbox committed, Gateway ACK lost.** K resends the **identical** ModelAttempt envelope to G; G dedup/SendMayHaveOccurred marker is queried/replayed without automatically sending Provider request bytes again. A send may have occurred even if the Provider ACK, headers, output or invoice is missing; original Attempt stays ProviderOutcomeUnknown and its full reservation remains held. Only validated Provider dedup and exact-key/charge coverage permit retransmission of **the same** request; a truly independent execution is a freshly admitted new Attempt with independent budget and a hold for the old exposure.

**Crash trace H-1: Host executed but Kernel has not imported Receipt.** H durably recorded nonce/LaunchAttempt before OS spawn and subsequently has a trustworthy process/result fact and authenticated receipt in H Result Outbox. The result network delivery or K import then fails. On recovery H resends the *same* receipt; K validates it, atomically commits HostResultInbox dedup + Journal/Invocation projection, and ACKs. If the process outcome or receipt itself is missing or ambiguous after a crash, K keeps OutcomeUnknown and Host reconciles; absence of a K receipt never means not executed.

**Crash trace O-1: response delivery accepted but command ACK lost.** O's Inbox + sealed command plan + command outbox were committed locally; it resends exactly those original commands. K CommandInbox dedup returns the original outcomes. Neither side regenerates plan contents, command IDs, nor a second effectful Invocation.

No cross-owner atomic transaction, atomic Provider acceptance or distributed exactly-once side effect is claimed. A Provider key is trustworthy only if its server-side execution **and charging deduplication** are documented and independently qualified for the request/billing scope; a client-generated key alone proves nothing. See [Response delivery and Inbox](delivery-and-inbox.md) and [Trusted Host](../security/trusted-host.md).

### 2.1 Storage and retention profile (required properties)

An implementation may choose any persistence technology, but it cannot claim this protocol without proving these properties for K persistence. Record, event and error shapes are fixed in [Kernel data model](kernel-data-model.md).

1. **Read-set validation.** Validation of the owning aggregate version and every protected read-set field is serializable — or an equivalent mechanism with the same guarantee — inside one K-local transaction with a documented lock/acquisition order. A field validated outside that transaction, or a read-then-write split across transactions, is not this protocol.
2. **Retry.** A serialization conflict aborts with a typed retryable result and no partial write. The caller retries the **same** command ID and digest; a retry may not re-reserve budget.
3. **Durability point.** Journal, Intent, reservation and Outbox are durable (fsync or equivalent) **before** any Outbox dispatch. A crash between commit and send leaves a pending Outbox record, never an inferred send.
4. **Bounded recovery.** Startup scanning is bounded by a configured high-water/age window, reports skipped or unreadable records, and never runs an unbounded scan.
5. **Bounded redelivery.** Every Inbox/Outbox redelivery is bounded by attempts and backoff, then dead-lettered with operator escalation. No retry loop is unbounded, including K→G delivery.
6. **Retention and GC.** Journal, Command Inbox, HostResultInbox and dedup tables have configured retention; dedup entries outlive the maximum redelivery and correlation window. GC archives audit-relevant records before deletion and never deletes an unresolved Intent, UNKNOWN, hold or terminal fact.
7. **Tamper evidence.** Journal and Ledger records are hash-chained or equivalently ordered so that deletion, reordering or truncation is detectable, with a periodic signed digest and an external anchor requirement. The mechanism is an implementation choice; without an anchor the property is `UNVERIFIED`.
8. **Fail closed.** Disk-full, corruption, a broken hash chain or unavailable storage rejects new admission with typed `StorageUnavailable`; Kernel never admits without durable intent and never silently drops an unresolved record.

## 3. Authoritative state projections

These tables define a **minimal projection** of the existing richer contracts; they do not rename or remove their additional states.

| Aggregate | Minimal states and allowed progress | Owner |
| --- | --- | --- |
| TaskControl / Plan | Accepted GoalContract, one active PlanRevision, structural switch/cancellation/terminal facts use TaskControl CAS; Planning/Ready/Running/Verifying/Waiting are **derived display modes**. PlanRevision structural cutover remains atomic. | Kernel |
| ModelStep selection | Open → CandidateRecorded → Selected/Completed; selection is irreversible; no candidate if response incomplete/stale | Kernel |
| ModelAttempt execution | AdmittedUnsentKnown → SendMayHaveOccurred → Complete/FailedKnownNotAccepted/**ProviderOutcomeUnknown** (projection); cancellation or lost ACK does not prove non-acceptance. Financial exposure is independent. | G owns physical send facts; K commits logical Attempt and reservation |
| Budget reservation | Reserved → ProvisionallyAccounted → Settled/Adjusted or HeldUnknown; no release on timeout | Kernel |
| ToolInvocation | Proposed → Admitted → DispatchPending → Running/Rejected/OutcomeUnknown → reconciled terminal outcome; lifecycle applies only to Invocation, **not to an ActionProposal batch** | Kernel logical admission; Host owns physical truth |
| Host LaunchAttempt | IntentDurable → Spawning → LaunchBoundaryRecorded or ProvenNotLaunched or OutcomeUnknown; nonce never re-usable | Trusted ToolHost |
| Verification / Completion | Bound evidence → criterion review → CompletionGuardAccepted/Blocked; Completed commits once | Kernel Guard |

No planner, verifier or model output is an authority to change these states directly. A non-terminal UNKNOWN can coexist with durable facts and must be handled with a typed reconciliation reason and conflict scope.

## 4. Required transitions and guards

All K-transaction events below require expected aggregate version + stable command ID. Only exact records in the same owner row of section 2 are atomic.

| Event / transition | Preconditions | Durable owner and one-transaction write-set | Crash / duplicate recovery |
| --- | --- | --- | --- |
| AdmitModelAttempt | valid policy, exact canonical request, MaximumChargeCertificate, full reservation | K: Attempt admission + reservation + Journal + ModelRequestOutbox **in one commit** | K-Outbox retries only K→G, **never automatically G→Provider** |
| GatewaySendMayHaveOccurred | G delivery dedup and canonical digest match, one-use durable send marker committed **before** outbound bytes | G-local receipt + SendMayHaveOccurred; physical Provider send non-atomic | duplicate G delivery returns prior marker, no automatic Provider retransmission |
| ReconcileProvider | exact request identity + authenticated Provider status/usage or qualified dedup contract | G observation → K Attempt/usage Journal and BudgetScope facts | ACK loss/timeout/5xx remains UNKNOWN; reservation held; new Attempt requires new K admission |
| RecordCandidate | complete schema/arguments; current snapshot; before effective cancellation | K: candidate digest + Attempt/Step version + Journal order | reject replay conflicts; no executable partial candidate |
| SelectCandidate | first eligible durable candidate, all charge exposure reserved | K: selectedAttemptId + Step Completed + ResponseDeliveryOutbox + Journal | same selected Attempt on replay; O Inbox dedup |
| AdmitToolInvocation | active PlanStep, relevant **selective version read-set** (Plan/Goal, authority, workspace, tool, reservation), per-invocation approval; no unrelated TaskControl CAS | **K: validate read-set + Invocation=Admitted + DurableIntent + Journal + budget hold + DispatchOutbox together** | K-1; no ghost dispatch; unrelated receipts may progress |
| ReceiveHostDispatch | valid original ticket/nonce, valid Host identity | **H: DispatchInbox + nonce consumption + LaunchAttempt/IntentDurable together** | duplicate returns original disposition; no respawn |
| EnterLaunchGate | Host-local fence/version/snapshot/lease state proved current under the *local* gate | H gate serializes local spawn against local fence; later receipts use H transaction | unknown spawn outcome is OutcomeUnknown, never replay nonce |
| InstallHostFence | ordered inside the **same Host-local gate** as physical process creation | H: HostFenceInstalled(seq, epoch, Host incarnation), durable acknowledgement | local fence blocks old launches; Kernel request itself does not |
| MarkRevoked | K RevocationRequested exists and all eligible H gates have trusted installed-fence ACK or verified disablement | K: Revoked + acknowledgements + Journal | never mark Revoked with unaccounted Host |
| ActivateNewPlan | conflicting work converged; snapshot current; L2 accepted | K: old superseded + new active + Plan pointer + barrier event | exactly one Active revision |
| CommitTerminal | required evidence including exact execution view; no conflicting effectful UNKNOWN; current sealed artifact; expected `taskControlVersion` | K: CompletionCommitted + TaskTerminal + Journal + delivery reference (Completion Guard runs inside this command) | exactly one terminal fact; same command ID returns its original result |

The Host Ledger + OS spawn are never atomic. A stable Host launch attempt is only proof that the exact physical step occurred where independently evidenced, not proof of external business success. Missing physical evidence is recorded as OutcomeUnknown.

**Forbidden transition:** K-Outbox delivery is not permitted until K Intent/Admission/Outbox commit is durable. A consumer cannot reconstruct a new nonce for an unresolved original dispatch. A stale or denied per-Invocation approval never authorizes launch. **No global TaskControl CAS on every Attempt/Invocation/receipt:** it would generate artificial conflicts and is not part of this minimized protocol. Domain/Kernel state reads must still revalidate the *relevant* protected epochs and read-set under K-local transaction isolation. If the chosen persistence cannot prove this, PE-1 cannot pass.

### 4.1 Single terminal path and Invocation edges

`CommitTerminal` is the **only** path to a terminal Task. The Orchestrator never writes a terminal state: it emits `CommitTerminal(expected_task_control_version, proposed_status, reason_code, completion_report_ref)` as an idempotent Kernel command. Completion Guard runs **inside** that K-local command, re-reads its protected read-set together with `task_control_version`, and commits `CompletionCommitted` + `TaskTerminal` + delivery reference atomically, or rejects with a typed reason and no state change. A retried command keeps its original ID; a lost response returns the original durable result. No other command, event, receipt, model output or verifier disposition creates a terminal state.

Invocation edges not covered by the main table. Each uses `invocation_version` CAS, records a typed reason, and never invents Host evidence:

| Situation | Result | Rule / evidence |
| --- | --- | --- |
| Host gate rejects (stale fence/epoch, expired grant, profile mismatch) | `Rejected(reason)`; no spawn | Authenticated H gate-rejection receipt carries fence sequence and epoch; a ticket rejected before spawn is **not** `OutcomeUnknown` |
| Grant expires while waiting for the gate | `Rejected(GrantExpired)`; reservation per §6 | A fresh attempt needs a new admission, approval and nonce; a ticket is never renewed |
| Duplicate dispatch after crash (nonce already consumed) | Original disposition; no second launch, never `Running` | H DispatchInbox dedup |
| Receipt imported after `CancelAccepted` | `Succeeded`/`FailedKnown` from Host evidence only; historical projection | A late receipt never reopens the Task or authorizes old-plan work |
| Duplicate receipt (same identity and digest) | `NoOp`; original outcome returned | K HostResultInbox dedup |
| Same receipt identity, different digest | `Rejected(IntegrityConflict)`; quarantine, no state change | Operator escalation; never overwrite the original |
| Reconciliation of `OutcomeUnknown` | `Succeeded` \| `FailedKnown` \| `NotExecutedProven` \| `Abandoned` | `NotExecutedProven` requires Host proof that no process crossed the spawn boundary; absence of a receipt is never proof. `Abandoned` means Kernel permanently disclaims the logical operation under a terminal/hold disposition; its reservation is retained until trusted release evidence. Disposition-to-state mapping for the Invocation record: `Succeeded`→`Succeeded`, `FailedKnown`→`FailedKnown`, `NotExecutedProven`→`Rejected`, `Abandoned`→`Cancelled` |
| Reconciliation deadline reached, still ambiguous | Stays `OutcomeUnknown`; Task may terminalize only with an `UnresolvedEffectHold` (§12.4) | No automatic retry; no fabricated convergence |

A terminal Task and an `OutcomeUnknown` Invocation are different records: the Task is a decision about further autonomous work, the Invocation remains a fact that is still unresolved and remains fenced.

## 5. Single-Host launch and revocation ordering (initial scope)

**Three authoritative events, two ordering domains:**

1. `RevocationRequested(K, requestedEpoch)`: durable K transaction that records the desired epoch and blocks any admission whose transaction reads the new epoch. The epoch read and the admission write **must be serialized in one transaction**; without that, "blocks new admission" is not guaranteed and PE-1 must fail. This is **not** a guarantee that a previously issued ticket cannot still launch on H.
2. `HostFenceInstalled(H, installedEpoch, gateSequence, hostIncarnation)`: a durable local H gate event serialized against the physical spawn boundary. After installation, a ticket with an older epoch **cannot** start on that H. An old launch that crossed the local gate first remains in flight even if K had already committed RevocationRequested.
3. `Revoked(K, hostAckSet)`: K transition only when every eligible Host gate is verified fenced or verifiably disabled. It means no eligible old-epoch **new launch**, not that running jobs or descendants are stopped; `ProcessConverged` remains independent.

The intermediary authority state is `RevocationPending`. The interval `K.RevocationRequested < H.physicalLaunch < H.HostFenceInstalled` is **allowed and auditable**; a test must not misclassify it as a violation of the local-fence contract. Conversely `H.HostFenceInstalled < H.launchAttempt(old epoch)` must reject without spawn. If H is unreachable and its disablement cannot be independently proved, K cannot mark Revoked.

**Proof eligible for the Host gate:** H must be authoritative for a locally serialized and durably persisted effective authorization/fence snapshot. An execution grant must bind scope, Host ID/incarnation, immutable profile/tool, authority version vector, installed-fence epoch, workspace generation, budget reservation generation, exact invocation nonce and a short bounded validity interval. H must establish (a) authenticity, (b) unexpired grant and Host live-authority channel/lease, (c) no locally installed newer fence or known invalidation, and (d) no inconsistent workspace/reservation view. Remote changes not installable through the same H gate are **not globally linearized**: their effectiveness is defined by H's acknowledged local installation. A cached grant alone, an offline Host, or a stale independent read is insufficient. A Host without a bounded and trusted authority/fencing channel must refuse effectful launch.

Under the **same serialized local critical section**, H validates the effective local snapshot, durably records `LaunchAttempt = Spawning` with a pre-spawn run cookie, then crosses the process-creation boundary; H fence installation and any locally mutable validity invalidations use that same serialization. The record and the spawn are **ordered, not atomic**: a crash between them is `OutcomeUnknown` unless the restart can prove the cookie unclaimed and no process/handle/output evidence exists (`ProvenNotLaunched`). Checking outside the critical section and spawning later is forbidden TOCTOU. The gate must not remain authorized beyond the grant's permitted launch deadline; an unprovable expiration or network loss fails closed. A long-running operation launched before the local fence is governed by drain/cancel policy, not retroactive non-execution. See [Trusted Host](../security/trusted-host.md) §2.1.

The above proof does **not** assert that H has a linearizable view of K's most recent revocation request at every instant. Such a stronger requirement would prohibit the acknowledged-request/pending-local-fence race and would require a different protocol. Multi-Host global ordering remains deferred. See [Trusted Host](../security/trusted-host.md).

## 6. Model usage, budget and liveness

Execution, candidate selection, and final financial settlement are independent. **Hard-budget admission requires a ProviderAdapter maximum-charge certificate**, durably tied to that exact Attempt/request, pricing contract and all possible provider-generated billable actions; merely observing an output token cap is insufficient.

A certificate must bind at least: Provider/account and model/SKU; pricing version/effective interval/currency; canonical request digest; exact **maximum billable input** (including system/tool/cache, variable input and provider prompt transformations); enforced maximum output/reasoning/tool tokens where billed; cache write/read minimum/maximum price treatment; fixed fees, batch, retrieval, image/audio/video/other modalities and extras; retry/redirect/continuation multiplier with a provider-enforced ceiling; conservative rounding/taxes/FX policy where applicable; computed total upper bound and evidence of each enforceable limit; validity/expiry and verifier identity. Unknown extra charges, unbounded server-side retries, uncapped output or mutable unpinned pricing invalidate the certificate.

The adapter computes the upper bound conservatively and supplies enforceability evidence; Kernel **validates the certificate's coverage, version and trusted adapter identity, but does not trust model assertions**. For each funding scope, reserve every concurrently chargeable Attempt using `confirmed_spend + outstanding_reserved_max + proposed_max + protected_verification_repair_reserve <= hard_limit`; the reserve term is defined in [Model and Budget](model-and-budget.md) §4 and is never spent on exploration. Abort hard-budget admission if any bound is unprovable; explicitly opt-in to separately tracked Soft Budget or choose another Provider. A late bill above the certificate triggers append-only overrun/enforcement hold and incident classification; it does not rewrite the winning response or a terminal Task.

A complete valid winning response can commit while losing Attempts/invoices remain unresolved **only if all outstanding charge exposure remains reserved**. Timeouts and cancellation do not release reservations. See [Model and Budget](model-and-budget.md).

## 7. One main Agent Loop and plan-change fast path

A **single primary Task Orchestrator** chooses Strategic, Tactical or Assurance as **decision purposes**, not independently running control loops or separate ControlProposal state machines. It observes current authoritative facts, selects one next decision, admits each proposed side effect independently, updates the domain projection, and returns to the same loop. A higher-priority cancellation, conflicting UNKNOWN, user instruction or assurance failure preempts the next decision, not the already started Host facts. See [Architecture subtraction review](../decisions/architecture-subtraction-review.md).

- **L0 TacticalAdjustment:** search, debugging hypothesis, tool choice, and an existing planned operation's *one-use InvocationApproval* grant/denial within the current GoalContract, PlanStep, declared capability/effect/scope and risk ceiling. A per-invocation approval is checked at admission/launch, recorded with the exact Invocation, argument digest, authority versions, expiration and nonce. It does **not** alter immutable PlanRevision, so does not trigger cutover. Approval request/decision records, one-use consumption and separation of duties are defined in [Permissions](../security/permissions.md); a strategy, profile or model statement is never an approval.
- **L1 PlanStepRework:** explicit rerun of the same objective and authority envelope, retaining current PlanRevision and invalidating affected verification evidence. An ordinary InvocationApproval may independently be required for a rework tool.
- **L2 StructuralReplan:** the accepted GoalContract/PlanRevision protected scope, capability/effect envelope, risk policy, required approval **policy or approval boundary**, task-level resource envelope, dependency graph or acceptance obligation changes. Full freeze/drain/reconcile/refresh/validate/cutover is mandatory.

**Revocation is orthogonal to plan classification.** Revoking an individual invocation's approval immediately stops further K admissions for that approval and initiates its H fence/needed cancellation; it does not *automatically* create L2. Domain Orchestration assesses whether the existing plan can continue with alternative authorized invocations; only a protected plan/goal/policy change triggers L2. A grant may not silently widen plan scope, capability or risk level. Kernel checks the effective protected-field diff rather than trusting the model's L0/L1 label.

## 8. Verification evidence classes, protected input and Completion

Verification evidence is expressed in six **domain-neutral classes** (enum owned by [Completion §1.1](completion.md)); a Workflow Profile declares which classes each criterion requires. Kernel, Host and Completion Guard branch on class, effect and policy — **never on `domain_id`**. The four classes most relevant to first-slice Coding/Video are detailed below; `machine_check` and `human_disposition` are defined in Completion §1.1.

| Class | Meaning | First-slice instantiation |
| --- | --- | --- |
| `protected_input_view` | Exact immutable inputs an execution may read, with enforcement and authenticated effective-view attestation | Coding: sealed read-only SourceSnapshot as the effective input tree, disjoint writable output/cache/temp mounts, trusted namespace, pinned toolchain/environment, blocked remount/symlink/path shadowing, Host-attested `ExecutionViewManifest` binding command, Host run, cwd/root, source mount/digest, path-resolution restrictions and enforcement through process convergence |
| `output_inspection` | Authenticated inspection of the actual produced artifact, not metadata or agent narrative | Video: probe/decode plus content inspection of the rendered output; Coding: test/build reports from the sealed view |
| `external_target_identity` | Exact identity/version/etag of an external system mutated by the operation | Office-style remote edits under an approved profile; R2 remains disabled by default |
| `provenance_map` | Mapping from delivered output to exact inputs, versions and transformations | Video: output-interval to source-interval lineage; Coding: diff/artifact to source snapshot |
| `machine_check` | A deterministic check ran with a bound result on the sealed view | Coding build/test/type; Video decode/profile/timeline invariant |
| `human_disposition` | An authenticated authorized human judgment with declared independence | Subjective Video criteria; high-impact external actions |

Completion Guard requires the class evidence bound to the accepted final snapshot and criterion; comparing lower-layer snapshot hashes alone is insufficient.

**No default full file-open tracing or writable input overlay.** If a toolchain cannot operate against a read-only `protected_input_view` with redirected build/cache outputs, mark the affected verification Unsupported/Unverified until an Owner-reviewed Host-specific alternative is proved. A full open/mutation tracing scheme is an optional separately scoped PE experiment, not an automatic complexity escalation. Sandbox controls must actually prevent writable overlays, alternate symlink/bind-mount sources, cwd/PATH resolution to unpinned inputs and runtime mount changes; otherwise evidence is Invalid even if the before/after/at-Guard digests match. A profile that cannot declare and enforce a required class marks the affected criterion Unverified; no Host policy is selected by domain name. See [Completion](completion.md), [Workspace Freeze](workspace-freeze.md).

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
12. `K.RevocationRequested` without `H.HostFenceInstalled` cannot be used as evidence that an existing ticket was unable to launch; `K.Revoked` requires trusted Host ACK/disablement. `H.HostFenceInstalled` must forbid later old-epoch spawn.
13. `AdmitToolInvocation` is one K-local atomic write-set (Journal + durable Intent + budget hold + DispatchOutbox); separate K/O/H owners have no distributed atomic guarantee.
14. A passed verification report requires actual `protected_input_view` execution evidence (`ExecutionViewManifest` identity and digest) and trustworthy no-shadow protected-path evidence; equality of lower-layer source digests alone is insufficient.
15. One-use `InvocationApproval` inside an existing immutable PlanRevision is not L2; expanding the plan's protected authorization envelope is L2.
16. Hard-budget Attempt admission requires a validated, bound `MaximumChargeCertificate` covering all potentially billable dimensions; unbounded provider charges cannot enter Hard Budget.
17. Ordinary ModelStep/Invocation/receipt/evidence operations use owning-aggregate CAS and protected read-set checks; they do **not** require global TaskControlVersion equality. TaskControl CAS still protects Goal/Plan/cancel/terminal transitions.
18. ActionProposal is a bounded immutable intent envelope with no authoritative executing/settled state; per-Invocation events determine its derived progress. EvidenceGraph is a non-authoritative optional index, not a second ledger.
19. Strategic/Tactical/Assurance are modes of one controller; PlanStep work/verification state is persisted event-sourced state with its own `plan_step_version` and may not act as an independent approval authority.
20. K→G duplicate delivery does not imply G→Provider duplicate send. G durable SendMayHaveOccurred without reliable Provider result stays ProviderOutcomeUnknown and retains original budget exposure.
21. A distinct Provider execution must use a **new Attempt ID, new provider request identity and independent reservation**; an unresolved old reservation cannot be silently released. Same-Attempt retransmission needs a qualified Provider billing/execution dedup guarantee or is forbidden.
22. Host local revocation windows and grant expiry apply by risk policy; high-risk effects with no acceptable bounded window or strict fence proof are **not eligible** for launch.
23. A Task has exactly one terminal fact, and only `CommitTerminal` (§4.1) may create it. No receipt, model output, verifier disposition, retry or operator action writes a second terminal state; late facts create an `UnresolvedEffectHold` or a separately authorized remediation Task.
24. An ExecutionStrategy binding never lowers the Kernel safety floor F1–F12, never raises an effect class, and never introduces Kernel-visible domain semantics; a strategy that cannot be expressed within that floor reopens the extension boundary instead of adding a Kernel branch.

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

### G1/G2 protocol fixture specification (specified, NOT RUN)

**Test harness contract when separately authorized:** start from a pinned contract/schema version and K/G/H durable snapshots. Inject the indicated message/crash at a named durable boundary; capture exact event IDs, journal/ledger sequence, reservations, observed Provider submissions and Hosted/OS side effects. Replay identical commands twice and replay with changed digest. Assert both the stated safety invariant and the allowed progress/hold disposition. PASS only if deterministic event order and all expected durable facts match; blocked safe outcomes count as correct **safety**, never as autonomous task success. A trace described here is **NOT RUN** until independently executed.

| Case / Gate | Initial facts and injected order | Required final state and PASS condition |
| --- | --- | --- |
| **M1 / G1** K admission+reservation+ModelRequestOutbox commits; crash before G delivery | Exact K envelope redelivered; **one** G dedup entry and at most one Provider submission; no second Attempt/reservation. |
| **M2 / G1** G persists SendMayHaveOccurred; crash **before** Provider socket write | Original Attempt conservatively ProviderOutcomeUnknown until non-send proven; no automated resend absent qualified Provider idempotency; full reservation retained. Safety PASS even if execution pauses. |
| **M3 / G1** Provider **accepts and may bill**, reply/ACK or streamed output lost; HTTP timeout/429/5xx | Neither timeout nor status code becomes FailedKnownNotAccepted. ProviderOutcomeUnknown, no candidate/tools, retained budget; Gateway does not blind retry. |
| **M4 / G1** G restarts after send; K→G ACK lost and K Outbox redelivers | G returns same durable disposition; number of Provider submissions unchanged if dedup not proven. If qualified, exact-key Provider replay is deduplicated to **one execution and one charge** as shown by Provider/fake evidence. |
| **M5 / G1** Provider dedup key expired/unsupported, or request payload/key/account changed | Same-Attempt replay rejected; may only create fresh admitted Attempt with distinct key/identity and separately reserved maximum; old unknown exposure remains. |
| **M6 / G1** Original UNKNOWN exposure + proposed replacement race with BudgetScope limit or Completion | If combined maxima exceed hard limit, reject replacement; no silent release or TaskControl global CAS bottleneck. A late bill attaches to original ID. Side-effecting hosted tools block conflicting replacement. |
| **R5 / G2** K RevocationRequested; H installed fence delayed; valid old ticket enters gate before installation | Local launch may win and is auditable in flight; K remains RevocationPending, never falsely Revoked/ProcessConverged; drain/cancel policy applies. |
| **R6 / G2** H HostFenceInstalled first; old ticket arrives, including at grant expiry boundary | Gate rejects with no OS process; durable fence event and Host incarnation/order prove the decision. |
| **R7 / G2** H disconnected, lease/grant expired or clock uncertainty exceeds approved tolerance; high-risk request | No new effectful launch. K Pending until ACK/verified disablement; high-risk class denied unless owner-approved/proven strict/bounded policy applies. |
| **S1 / G2** Sealed read-only SourceSnapshot, writable outputs in disjoint isolated mounts, normal cache/coverage writes | Host attests source digest, effective read-only mount, cwd/tool/environment, output mount list and final source integrity; no full per-open tracing required; Completion Guard can accept valid verification evidence. |
| **S2 / G2** Writable overlay/bind mount/symlink shadows protected test script or config; or source mount becomes writable | Host cannot attest required sealed-view property: reject/Invalid evidence even when original snapshot hashes match. No false Completed. |
| **S3 / G2** Required toolchain cannot run with sealed source / disjoint outputs, platform cannot enforce protection | Mark Unverified/Unsupported and block Completion; **do not** switch silently to full file tracing or a weaker hash-only pass. Alternate monitoring is a separately reviewed experiment. |

**Gate conditions:** PE-1 (G1 group) requires M1–M6 and K/G crash/duplicate-message consistency to PASS for a concrete adapter capability profile; idempotent/provider Hard Budget eligibility must be recorded per Provider, never assumed globally. PE-2 (G2 group) requires R5–R7, S1–S3 plus pre-existing R1–R4, V1–V3 process/handle and fence cases to PASS for a concrete Host/OS/profile. If Provider idempotency is absent, a fixture **passes** by proving **no resend and correct UNKNOWN hold**, not by claiming liveness. If high-risk immediate-revocation is required but unproven, disabling that effect class is a passing safe policy result, not proof of immediate revocation.

**Fixture-group note:** `G1` (provider/transaction) and `G2` (Host) below are **fixture-group names** retained for traceability; they are evidence groups executed at PE, not gates.

**DF — design freeze (ACCEPTED by ARB-01, 2026-11-03):** K/G/H transaction ownership, Provider send/ACK ambiguity and budget, Host requested/installed/Revoked risk/TTL window, effect policy, sealed read-only input profile, state tables/invariants, normalized fault cases and ADP dispositions have been reviewed and dispositioned for construction. DF authorizes no runtime work.

**PE — prototype evidence (NOT RUN; requires SA):** G1 group M1–M6 plus transaction, candidate and budget read-set fixtures; G2 group R5–R7/S1–S3 plus LaunchGate, sealed-view, UNKNOWN and process-convergence cases; domain slices and cross-domain reuse (NOT RUN). **VI** requires the full fault matrix and domain evidence. No PASS may be inferred from these documents.

## 11. Architecture-review checklist

- Are any two documents still assigning the same authoritative transition to different components?
- Is each 'atomic' claim scoped to one actually shared transactional or serialized boundary?
- Does an unresolved UNKNOWN block only operations that conflict with its potential effects?
- Can an otherwise valid selected response proceed without awaiting unrelated invoices?
- Are protected input scope and verification output lineage disjoint and frozen?
- Is the L0/L1/L2 classifier tied to protected-field comparisons rather than model preference?
- Have single-Host and multi-Host promises been kept separate?
- Are ADP-03 through ADP-11 explicitly still OPEN until owner decisions?

## 12. Construction-level main-loop scheduling and terminalization

The following algorithm narrows, rather than replaces, Sections 2–11, [Domain Extension](domain-extension.md) and [Execution Strategy](execution-strategy.md). It is **one Orchestrator loop per Task** — not a mandatory multi-phase chain, not a parallel autonomous verifier, and not three controllers.

### 12.1 Wake contract

The loop advances only on an explicit wake:

`WakeEvent{cause ∈ TaskAdmitted | UserInput | ApprovalResolved | CancelAccepted | DeadlineDue | HostReceipt | ProviderResult | CutoverReady | RecoveryTimer; dedupe_key; seq}`

- `dedupe_key` is stable for the fact that caused the wake (event ID, wait ID, command ID or receipt ID). A duplicate wake with the same key while a cause is still pending is **coalesced**; it never produces a second decision.
- `seq` orders wakes within a Task. Wakes may arrive concurrently; only the highest-priority unconsumed cause is consumed per iteration (§12.2), and lower-priority pending causes remain pending — they are not lost.
- Host receipts, Provider results and timer expiries wake the loop; they never start an independent decision. A receipt that arrives after terminalization is imported and parked (§12.4), not executed.

### 12.2 The algorithm (one priority order)

`OnWake(task_id, WakeEvent)` — the order below is the **only** priority order in this repository; no other document may define a second one:

1. **Terminal/outbox.** If TaskControl holds a terminal fact: deliver/reconcile pending outboxes and stop. A terminal Task never runs another decision.
2. **Safety stop.** If cancel was accepted, authority was revoked, or the deadline is due: stop new admissions and follow the convergence/safe-stop path (§12.4 and [Lifecycle §8](../architecture/lifecycle.md)). No model or tool work is emitted.
3. **UNKNOWN.** If a conflicting Invocation/Provider outcome is `OutcomeUnknown`: reconcile, or park with a WaitRecord; never repeat the effect.
4. **Wait.** If a WaitRecord is active and not yet due: keep it and consume no model spin. If due: treat as `RecoveryTimer`.
5. **Completion check.** If current accepted criteria and evidence already suffice, with no hold and no conflicting UNKNOWN: emit `CommitTerminal(Completed)` and stop; Guard decides inside K. This is the cheap deterministic path and must be tried before any model call.
6. **Evidence gap.** If mandatory criterion evidence is missing: choose the minimal authorized verification action; a deterministic check suffices, so no model call.
7. **L2.** Else if an actual protected-field change is required: propose a structural replan and cutover.
8. **Decision.** Else request **at most one** bounded model decision for the next needed action, validate the exact decision/binding/digest, and admit each effectful item through its own K-local `AdmitInvocation`.
9. **Progress/limits.** If no new authoritative evidence, artifact/version, resolved blocker, completed criterion, wait resolution or user input was committed since the previous iteration: apply the strategy's no-progress bound. If a budget, iteration or repair ceiling is reached: diagnose once from existing facts, then park, terminalize through `CommitTerminal` (§4.1), or stop with a typed reason. **There is no unbounded live model loop.**

**Decision-envelope validation.** A response is admitted as a candidate only if it is complete and its envelope schema/digests validate. Each item is then validated and admitted independently: an item with a stale tool digest, out-of-envelope effect class or invalid argument is rejected with a typed reason, and valid sibling items may still proceed. The batch itself has no atomic settlement and no aggregate outcome; "no executable partial candidate" refers to a truncated/incomplete response, never to a complete envelope that contains one rejected item. A rejected item is durable evidence, not a silent omission.

Dispatch goes only through the Host gate; event-driven receipts advance progress and reschedule only affected work. The ordering does not mean a low-risk single-step task needs separate Planner, Implementer and Verifier requests. Initial Goal/Plan acceptance still uses required schema/confirmation checks. Model responses may be cached only if **identical binding, normalized request and policy/context digests** prove reuse safe; completion and side-effect admission are never cached. A selected complete candidate ends its ModelStep; incomplete provider streams cannot dispatch actions.

**Scheduler contract:** one write/effectful Invocation per Task by default. Optional parallel R0 observations require the same authorized immutable input, bounded worker/concurrency resources, distinct invocation IDs and no unresolved overlap; optional R1 jobs require proven disjoint target sets and independent Host conflict scopes. R2/external/destructive effects remain disabled by default until separately approved. Two writes that may overlap, unknown conflict scopes, tests using mutable shared caches, Git index/worktree operations and final render publication serialize. Host enforces process/resource limits for both short commands and long jobs; Kernel enforces aggregate reservations and deterministic admission, not a speculative global DAG executor. **Construction-default caps** (DES values; a profile or Host may lower them, never raise them, and they are not performance claims): `maxConcurrentR0PerTask=4`, `maxConcurrentWritePerTask=1`, `maxConcurrentLongJobPerHost=1`. If a Host cannot prove the corresponding isolation, the effective cap is 1 or admission is denied. Fairness is bounded queueing per Task/principal/resource class, not unlimited forked work.

### 12.3 Progress, waits and iteration bounds

Every wait that persists across a wake has a durable `WaitRecord` (shape owned by the Kernel data model) with a wake source, owner and `max_wait_until`; a wait missing either is a protocol defect. User approval and missing input may wait for external action but consume no model spins; provide a visible disposition. Long jobs wake from authenticated Host progress/terminal events, not polling through new LLM turns. A delayed receipt or invoice settles through the existing K/G/H Inbox/Outbox protocols, even after the Orchestrator stops. Timer expiry triggers one deterministic safe-stop/reconciliation decision, not another blind side-effect submission.

**Progress proof:** progress is a **committed fact**, not an assertion — newly accepted evidence/artifact/version, a resolved blocker, a completed criterion or user input. Extra summaries, repeated search result hashes, identical model proposals and no-op tool calls do not reset progress. Each Task carries an iteration counter incremented once per consumed wake; the strategy's `max_model_steps_per_task_class`, `progress.max_consecutive_no_progress` and `progress.max_same_step_repairs` bound decisions, and reaching a bound is a typed disposition, never a silent reset. Never silently extend a hard deadline or verification budget. Record decisions skipped because deterministic tools already established completion.

### 12.4 Terminalization (single path)

- `Completed` only through `CommitTerminal` after Completion Guard passes (§4.1). `Cancelled` only with a cancellation disposition and the proven state of effects at that time. `Failed(reason=DeadlineExceeded|NoProgress|BudgetExhausted|UnsafeEnvironment|RepairExhausted|UnresolvedEffect|DependencyFailed|PolicyDenied)` is a reason taxonomy, **not** an additional Task state.
- The loop **never** writes a terminal state. It emits the idempotent `CommitTerminal` command with `expected_task_control_version`; Guard runs inside that K-local command and commits exactly one terminal fact or a typed rejection.
- If a potentially conflicting effect may be unresolved at the deadline: commit `Failed(reason=UnresolvedEffect)` **plus** a durable `UnresolvedEffectHold{hold_id, version, task_id, invocation_ids[], conflict_scope, reconciliation_owner, next_wake_at, max_reconcile_until, disposition}` that keeps the conflicting targets fenced and is reconciled after the terminal fact. The reason must **not** claim physical failure, process convergence or rollback; a late receipt never reopens the Task, and remediation is a separate authorized Task.
- If convergence (not merely classification) cannot yet be proven and no deadline forces a disposition, the Task stays `Open` with a `WaitRecord` and `max_wait_until`; a Task that cannot prove convergence is never falsely marked terminal.
- If K persistence is unavailable, admission fails closed with `StorageUnavailable`; a failure disposition is reconstructed from a persisted intent before accepting new work.

### 12.5 Explicit fast/slow traces and failure contrast

| Scenario | Required causal sequence | Prohibited shortcut |
| --- | --- | --- |
| Low-risk Coding inspect | Bind Goal/Profile → scoped read Admission → trusted receipt/context delta → deterministic criterion checks → Completion Guard → one terminal delivery | Mandatory independent model Verifier after evidence suffices |
| Coding edit/test | Scope & plan → inspect relevant files → edit in disposable workspace → seal final source snapshot → isolated test/build on actual sealed view → criterion evidence → conditional independent review → Completion Guard | Treating edited tests, stale output or command exit alone as proof |
| Video edit/render | Source digests/probe → progressive analysis → NarrativePlan/TimelineRevision → validated bounded RenderPlan → Host RenderJob/staging → process convergence → technical decode + content inspection → exact lineage → Completion Guard/delivery | Metadata-only completion or publishing a partial render |
| Cancel while rendering | K CancelRequested → H fence/no new spawn + kill/drain requests → receipts and descendant/handle evidence → safe Cancelled, or explicit Failed with unresolved-effects hold | `kill sent` ≡ `converged`, or automatic rerender |
| Provider request timed out | G SendMayHaveOccurred → original Attempt UNKNOWN + bounded reservation retained → authenticated status reconciliation / separate funded request only if policy allows | Blind Provider retransmission, charging UNKNOWN as zero |
| Approval absent | Store exact request/scope/expiry/wake condition → park Task without model spins → resume with fresh K/H authority checks or safely fail by policy | Reuse stale approval after authority/profile change |

These are **design fixtures, NOT runtime PASS**. PE-1/PE-2 (the G1/G2 fixture groups) must test K/G/H crash boundaries and serializability; PE domain slices must test both domain end-to-end paths and quality of skipped reviews; PE cross-domain must test Office and handoff reuse.
