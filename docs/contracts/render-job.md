# Long-running RenderJob and media execution contract

> **Status: PROPOSED Video Editing execution contract.** RenderJob maps long-running media rendering onto shared ToolInvocation, budget, Trusted ToolHost, cancellation, recovery, and evidence controls. No renderer implementation or process-control property is verified.

## 1. Purpose and authority

A RenderJob is a typed Video-domain correlation record for a render attempt. It does not create a second execution authority or bypass Kernel/Host.

| Fact or decision | Authority | RenderJob role |
| --- | --- | --- |
| Task/Plan/GoalContract state, admission, permissions, approvals, budget reservation/settlement, cancellation intent, fencing, legal transitions | Kernel Journal / Kernel state machine | References exact authoritative versions and invocation IDs |
| Process creation/start/exit, descendants, signals, resource observations, writable-handle convergence, staging output facts, Host receipt | Host Ledger / Trusted ToolHost | Correlates Host run/job and receipt |
| Narrative/timeline semantics and criterion interpretation | Video Domain Intelligence and its versioned domain artifacts | References NarrativePlan/TimelineRevision |
| Technical/content verification findings | Independent domain verifier and trusted machine runs; human disposition where required | References evidence/report versions |
| Artifact identity/finalization and task completion | Artifact/Kernel contracts and Completion Guard | References immutable output and publication evidence |

Kernel Journal and Host Ledger are separate fact boundaries. No database transaction makes a physical process or file write atomic with a Kernel state transition.

## 2. RenderJob binding

A RenderJob binds at minimum:

- RenderJob ID/schema version;
- Task/Turn/Step/ModelStep/Attempt/ActionProposal/ToolInvocation IDs;
- DomainBinding and Workflow Profile version;
- accepted GoalContract and active PlanRevision/PlanStep;
- MediaProject ID, ProjectSnapshot generation/digest;
- TimelineRevision ID/digest and RenderPlan ID/digest;
- source MediaAsset digests, stream IDs, analysis/provenance manifest;
- renderer/FFmpeg build and environment digest;
- canonical argv/filtergraph/compiler digest;
- input/output path bindings and protocol/filesystem/network policy IDs;
- output profile and expected output artifact kind;
- resource reservation IDs and hard limits;
- unique staging identity, final ArtifactRef target, and idempotency key;
- Host run/job ID, cancellation/fencing epoch, and receipt obligations.

A changed source, project generation, timeline, RenderPlan, compiler/build, output target, resource policy, authorization, or fencing epoch makes an unstarted proposal stale. Kernel revalidates every invocation at admission.

## 3. State authority: separate state dimensions

RenderJob must not duplicate Kernel or Host state as a competing source of truth. Its displayed status is a projection of four distinct state dimensions:

1. **Kernel Invocation state:** proposed, admitted, cancellation requested, reconciliation required, and a reconciled terminal outcome such as Succeeded, FailedKnown, Cancelled, or OutcomeUnknown. Kernel owns the authoritative transition.
2. **Host execution state:** launch intent durable, process observed, running, termination requested, process quiescent, output sealed, receipt issued, or Host evidence unavailable. Host Ledger owns physical facts.
3. **Verification state:** not started, technical pass/fail, content pass/fail/inconclusive, and human disposition pending/accepted/rejected. The domain verifier and authorized human review own their respective findings.
4. **Artifact publication state:** unstaged, quarantined, verified-ready, finalized, published, or rejected. Publication is committed only after artifact integrity, current fencing, and required evidence are reconciled.

Progress percentage is a telemetry field, not a state authority. A RenderJob summary must expose all unresolved dimensions rather than flattening them into one misleading "done" flag.

## 4. Admission and Host launch protocol

1. Domain Intelligence creates a RenderPlan bound to an accepted TimelineRevision and exact source/project snapshot.
2. Kernel validates GoalContract/PlanRevision/DomainBinding, current authorization, tool snapshot, source digests, output target scope, budget reservation, Host capability profile, fencing epoch, and absence of conflicting UNKNOWN work.
3. Kernel durably records ToolInvocation intent and idempotency identity before side effects; it issues a short-lived admission ticket bound to exact arguments/digests/policy/approval/budget/fencing.
4. Host validates the ticket, writes a durable Host Ledger launch intent with Host run/job identity, and only then attempts process creation.
5. Host records process identity and start evidence before reporting Running. Process identity includes more than a reusable PID: Host run ID, process birth/start identity, job/process-group identity, and fencing binding.
6. FFmpeg runs in the isolation boundary defined by [RenderPlan security contract](render-plan-security.md).
7. Host records progress as non-authoritative telemetry and records exit/signal, resource use, descendant convergence, staging output identity/digest, and receipt evidence.
8. Kernel reconciles the receipt into ToolInvocation state. Domain verification and artifact publication remain separate subsequent stages.

A Host crash between durable launch intent and observed process creation is not automatically a failed render. Recovery must inspect Host Ledger and process identity before classifying the outcome.

## 5. Resource and admission policy

Workflow Profile declares hard limits and accounting rules for wall-clock time; CPU time/threads; peak memory; GPU where enforceable; temporary/final disk; source size/duration/resolution/stream count and decoded workload; output size/duration; analysis/transcription usage; and verification/repair reserve.

Kernel owns reservations, consumption, settlement, overrun records, and enforcement holds. Orchestration may estimate and propose allocation but cannot raise a hard limit or silently consume verification reserve.

Admission checks source/project identity, current TimelineRevision/RenderPlan, output target scope, policy/approval, tool snapshot, resource reservation, fencing epoch, Host capability, and conflicting render/UNKNOWN state.

A Host reports enforceable versus advisory dimensions. If a required hard limit cannot be enforced, admission fails closed. Numeric caps remain OPEN pending supported Host profiles and measurements.

## 6. Progress and physical execution evidence

- Renderer receives canonical argv and validated filtergraph, never a model-composed shell string.
- Host records durable intent and process/job creation before reporting start.
- Process is contained in the declared Host boundary and associated process group/job.
- Progress is associated with RenderJob and Host run ID and is persisted or recoverably sampled under Host contract.
- FFmpeg progress records and stdout/stderr digests are telemetry/evidence of execution, not content-quality evidence.
- Host records exit code/signal, start/finish times, resource observations, process convergence, temporary output state, output digest, and authenticated receipt.

A progress=end record, zero exit code, or complete progress stream does not prove finalization or fulfillment of user-facing criteria.

## 7. Cancellation and process convergence

1. Kernel durably records cancellation intent and fences new dependent admissions/publication.
2. Host receives the exact Host run/job ID, ToolInvocation ID, admission binding, and fencing epoch.
3. Host requests graceful termination, then enforces the declared process-tree termination policy if required.
4. Host drains pipes and waits for declared descendants and writable handles to become quiescent.
5. Host records whether the staging output is complete, partial, absent, or unknown and seals/quarantines it where safe.
6. Host issues a receipt with process convergence and output facts.
7. Kernel reconciles the receipt and commits Cancelled only when the declared cancellation conditions are met.

A kill signal, timeout, disconnected client, missing progress event, or parent-process exit is not proof that the render stopped. If a descendant may still write, the invocation remains OutcomeUnknown/Reconciling and conflicting publication is blocked.

Cancellation races are resolved from Host facts plus Kernel fencing: if the process physically completed before termination took effect, record that execution fact; do not publish it if the accepted plan/revision has since been superseded or cancellation revoked its publication authority.

## 8. UNKNOWN and crash recovery

A Host crash or lost acknowledgement after durable intent may leave OutcomeUnknown. UNKNOWN is neither FailedKnown nor permission to retry.

Recovery must:

1. Load Kernel Journal intent, exact invocation/idempotency key, cancellation/fencing epoch, accepted plan, and reservation.
2. Query Host Ledger and receipt registry by Host run ID and invocation identity.
3. Reconcile process/job identity, descendant set, resource settlement, staging path/file identity, writable handles, and output digest.
4. Determine whether the process is still running, quiescent with complete output, quiescent with partial output, never started, or not provable.
5. Verify any complete candidate output from a sealed immutable staging artifact; never trust a model-generated path/hash.
6. Commit a reconciled outcome only when required evidence is sufficient; otherwise preserve UNKNOWN and hold conflicting work/publication.

If safely reconciled as failed/cancelled/partial, a retry is a **new ToolInvocation and Host run**, with a new attempt identity and unique staging output. Never replay the same non-idempotent render invocation or reuse a possibly writable output path.

A readable checkpoint may preserve timeline, RenderPlan, manifest, and prior progress. It does not authorize resuming physical work. Fresh policy, approval, budget, lease/fencing, and project/timeline checks are required. Arbitrary FFmpeg encodes are not assumed checkpoint-resumable; segmented rendering requires a separately verified contract.

## 9. Output finalization and publication

FFmpeg writes only to a unique temporary target. It cannot write directly to the final deliverable path or overwrite a previous artifact.

After Host proves process/handle convergence:

1. Host seals the staged bytes, records size/digest/file identity, and issues a receipt bound to RenderJob, ToolInvocation, RenderPlan, and fencing epoch.
2. A technical verifier independently reads the staged artifact and performs required probe/decode/profile checks.
3. An independent content verifier checks the actual rendered output against UserIntent, GoalContract, NarrativePlan, TimelineRevision, source provenance, and criterion obligations.
4. Required human disposition is collected for subjective/high-impact criteria.
5. Kernel rechecks current GoalContract/PlanRevision/DomainBinding, authorization, cancellation state, fencing epoch, budget settlement, and absence of conflicting UNKNOWN.
6. The artifact is finalized under a new immutable Artifact ID/digest; only then is a final delivery reference committed.
7. Completion Guard evaluates the exact final artifact and VerificationReport bindings.

A cancelled, superseded, partial, UNKNOWN, stale, or unverified output remains quarantined evidence and cannot replace the current deliverable. If an object is finalized but Kernel commit is interrupted, recovery reconciles the immutable artifact and idempotent publication intent; it must not create a conflicting second publication.

## 10. Delivery and non-claims

Delivery binds final video digest, source ProjectSnapshot, TimelineRevision, NarrativePlan, RenderPlan, RenderJob, ToolInvocation, Host receipt, source-to-output provenance map, VerificationReport, and final ArtifactRef.

This contract does not claim arbitrary FFmpeg jobs are checkpoint-resumable; a process exit code proves content quality; a model aesthetic opinion proves user satisfaction; render output can be safely overwritten in place; or Kernel and Host can atomically commit a physical file and Task transition in one distributed transaction.

All runtime process control, progress recovery, resource accounting, output publication, and media verification remain **UNVERIFIED** until implemented and fault-injection tested on named Host environments.

## 11. Render resource queue and verification economy (G0 candidate)

A RenderJob's expensive media work is asynchronous **physical Host execution**, not an autonomous LLM polling loop. Tool Runtime queues by admitted identity/resource and exposes `Queued/Running/Progress/Receipt/Unknown` as derived projections. Trusted Host reports byte/progress/physical facts through authenticated Outbox; Kernel imports idempotently. Proposed first-slice limit: one effectful final render per Host resource pool unless independence and memory/GPU/disk isolation are proven. Priority/fairness must preserve Cancellation/Fence and avoid starving short read-only tasks; queue wait is measured separately from actual render latency.

A preview is a distinct bounded Invocation and immutable nonfinal artifact; it neither authorizes a final render nor satisfies final-output inspection. Cache metadata/proxies/analysis only by exact source, transform, tool and policy digests; any reuse of previously rendered segments requires compiler-proven unchanged interval provenance and unchanged output/codec/audio context, otherwise perform a full guarded render. This is a **candidate optimization**, not a promised incremental FFmpeg guarantee. Staging is unique per invocation. UNKNOWN and cancellation keep all conflicting outputs quarantined and never permit blind rerender. Completion accepts final source/project/timeline/render/output evidence only after actual process/writable-handle convergence and criterion verification. Compare queue p50/p95, CPU/GPU time, peak memory, bytes processed, retries and semantic/technical quality under controlled G4 benchmarks.
