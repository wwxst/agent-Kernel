# Long-running RenderJob and media execution contract

> **Status: PROPOSED Video Editing execution contract.** This contract maps long-running media rendering onto the shared ToolInvocation, budget, Trusted ToolHost, cancellation, recovery, and evidence model. No renderer implementation or process-control property is currently verified.

## 1. Purpose

Rendering is a long-running, resource-intensive Host operation. It must not be treated as a synchronous function call whose success is inferred from a returned string or an FFmpeg exit code alone.

A RenderJob is a typed domain execution record linked to one or more Kernel ToolInvocations. It does not create a second execution authority or bypass the shared Kernel/Host boundary.

## 2. RenderJob binding

A RenderJob binds at minimum:

- RenderJob ID and schema version;
- Task ID, Task aggregate version, Turn ID, ModelStep/Attempt, ActionProposal item, and ToolInvocation IDs;
- DomainBinding and Workflow Profile version;
- accepted GoalContract version and active PlanRevision/PlanStep;
- TimelineRevision ID/digest and RenderPlan ID/digest;
- source MediaAsset IDs, source content digests, stream IDs, and project generation;
- renderer/FFmpeg version/build identity and environment digest;
- canonical argv digest, filtergraph digest, working directory, input/output path bindings;
- output profile and expected output artifact kind;
- resource reservation IDs and hard limits;
- temporary output identity, final publication target, and idempotency key;
- cancellation/fencing epoch and expected Host receipt/evidence obligations.

A changed timeline, source digest, profile, renderer version, output target, resource policy, or workspace/project generation makes an unstarted proposal stale. Kernel must revalidate each invocation at admission.

## 3. Lifecycle and outcome dimensions

Proposed lifecycle:

**Proposed → Admitted → Running → Cancelling | Reconciling → Succeeded | FailedKnown | Cancelled | OutcomeUnknown**

The exact transition graph is enforced by Kernel/Host contracts. OutcomeUnknown is not equivalent to FailedKnown and blocks unsafe replay or conflicting publication until reconciled.

Progress is a separate telemetry stream. It may include frame count, output timestamp, speed, elapsed time, estimated remaining time, and structured FFmpeg progress key/value records. Progress is advisory and does not prove successful finalization or video quality.

A successful process exit, a complete progress stream, and a zero exit code are execution facts only. They are not completion evidence for user-facing media criteria.

## 4. Resource and admission policy

The Workflow Profile declares hard limits and accounting rules for:

- wall-clock render time;
- CPU time/threads and peak memory;
- GPU use where applicable;
- temporary and final disk usage;
- source media size/duration/resolution and total decoded workload;
- output file size/duration;
- model analysis/transcription usage and cost;
- verification and bounded repair reserve.

Kernel owns reservations, consumption, settlement, overrun records, and enforcement holds. Orchestration may estimate resource use and propose allocation but cannot raise a hard limit or silently consume the verification reserve.

Admission checks include source/project identity, current TimelineRevision/RenderPlan bindings, output target scope, current policy/approval, tool snapshot, resource reservation, fencing epoch, and whether a conflicting render or UNKNOWN operation already exists.

## 5. Host execution and progress

- The renderer receives a canonical argv array and validated filtergraph, not a model-composed shell string.
- The Host records durable intent and creates a uniquely identified process/job before reporting it as started.
- The process is contained within the declared Host execution boundary and associated process group/tree.
- Progress events are associated with the RenderJob/Host run ID and are persisted or recoverably sampled under the Host contract.
- FFmpeg progress output is parsed as telemetry; stderr/stdout digests and final process status are retained as evidence.
- The Host records exit code/signal, start/finish times, resource use, process convergence, temporary output state, output digest, and receipt.

A progress percentage is not authoritative. FFmpeg may emit progress=end; this indicates encoding progress termination, not that the output satisfies the GoalContract.

## 6. Cancellation and process convergence

Cancellation follows the shared cancellation protocol:

1. Kernel durably records cancellation intent and rejects new dependent admissions.
2. Host receives the exact run/job identity and fencing binding.
3. Host requests graceful termination, then enforces the declared process-tree termination policy if necessary.
4. Host drains pipes and waits for all declared descendants to exit.
5. Host confirms process/handle convergence and records whether the temporary output is complete, partial, or unknown.
6. Kernel reconciles the receipt and commits Cancelled only when the declared cancellation conditions are met.

A kill signal, timeout, disconnected client, or missing progress event is not proof that the render stopped. A process that may still write to an output must remain UNKNOWN/Reconciling and must block conflicting publication.

## 7. Crash recovery and retry safety

- A Host crash or lost acknowledgement after durable intent may leave the render OutcomeUnknown.
- Recovery queries the Host Ledger, process/job registry, output target, temporary artifact, and receipts before any retry.
- Never blindly replay the same non-idempotent render invocation.
- Each retry is a new ToolInvocation/Host run with a new attempt identity and a unique temporary output target.
- Partial output is quarantined and never presented as a successful deliverable.
- The initial implementation must **not assume that an arbitrary FFmpeg encode can resume from a checkpoint**. Unless a separately verified segmented-render contract exists, a safely reconciled failed render restarts as a new invocation from the beginning.
- Segment rendering, if introduced later, must define independently verifiable segment artifacts, timeline boundaries, stream/codec compatibility, merge rules, and manifest integrity.

A readable Checkpoint may preserve the timeline, render manifest, and prior progress while current execution authorization is expired. Resuming new work still requires fresh policy, approval, budget, lease/fencing, and project/workspace checks.

## 8. Output finalization and verification

Render output is written to a unique temporary target. It is not published to the final deliverable path until all required checks succeed.

Minimum technical verification may include:

- output file exists, is non-empty, and its digest is recorded;
- ffprobe can parse container and stream metadata;
- expected video/audio/subtitle streams exist and match the output profile;
- duration, dimensions, frame-rate/timebase, codec, sample rate, channel layout, and output size are within declared tolerances;
- full or policy-selected decode checks detect truncation/corrupt packets/frame decode failures;
- audio/video synchronization, silence/clipping/loudness, black/frozen frames, and subtitle timing are checked where required;
- timeline references, clip order, source ranges, transitions, and duration map to the accepted TimelineRevision.

Semantic/perceptual verification is separate. A fresh Video Verifier reviews sampled frames, audio/transcript evidence, the accepted GoalContract, TimelineRevision, and raw render/probe evidence. It checks requested content/order, excluded content, pacing, caption correctness/readability, and obvious visual/audio artifacts. A model review is a finding, not proof; subjective or high-risk criteria may require human review or independently specified checks.

Only after the required evidence obligations are met may the Host publish/finalize the output artifact and Completion Guard consider Task completion.

## 9. Delivery and non-claims

Delivery binds the final video digest, TimelineRevision, RenderPlan, RenderJob, Host receipt, verification report, and exact output path/URI.

This contract does not claim:

- arbitrary FFmpeg jobs are checkpoint-resumable;
- a process exit code proves content quality;
- a model's aesthetic opinion proves user satisfaction;
- render output can be safely overwritten in place;
- Kernel and Host can atomically commit a physical file and a Task transition in one distributed transaction.

All runtime process-control, progress recovery, resource accounting, output publication, and media verification properties remain **UNVERIFIED** until implemented and fault-injection tested.
