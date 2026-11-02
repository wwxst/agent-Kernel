# Response delivery and durable inbox contract

> **Status: Approved delivery principles re-authored as an initial contract.** The contract is not yet implemented or verified.

## 1. Delivery boundary

Only a ModelStep that has atomically reached Completed with one immutable `selectedAttemptId` may be delivered to Orchestration. Candidate pointers, partial responses, truncated responses, and OutcomeUnknown execution results are not deliverable. A complete selected response **is deliverable before final provider billing settlement** when the owning Attempt and all concurrent charge-bearing Attempts remain covered by credible maximum reservations under hard-budget policy (or the Task has explicitly authorized soft-budget mode). A missing invoice is never treated as zero charge and never releases a reservation. See [Model and Budget](model-and-budget.md).

The Kernel creates a durable ResponseDeliveryOutbox record in the same local transaction as ModelStep Completed and final response selection.

## 2. Stable envelope

A delivery envelope contains at least:

- `deliveryId`
- `idempotencyKey`
- `modelStepId`
- `selectedAttemptId`
- `modelStepVersion`
- `sourceJournalSequence`
- `responseReference` and `responseDigest`
- `schemaVersion`
- `payloadDigest`
- creation time and delivery status

The delivery identity and idempotency key are created once and persisted. Retrying delivery reuses the original IDs and digest. Same identity with a different digest is an integrity conflict and must be quarantined; it must not overwrite the original payload.

## 3. Durable Orchestration Inbox

On first receipt, Orchestration verifies the Kernel identity, envelope, digest and proof that the selected ModelStep is Completed.

In one Orchestration-local transaction it must persist:

1. The unique Inbox record.
2. The local projection update, if required.
3. The complete immutable plan of required Kernel Commands.
4. Every Command Intent with stable `commandId`, canonical payload, `payloadDigest`, ordinal and required flag.
5. Pending dispatch records.

The command plan is sealed in that transaction. It must not exist only in memory. A restart must load the exact original command IDs, payloads and digests; it must not regenerate IDs, reorder commands, or recompute different command content from newer state.

`projection Applied` is not equivalent to `CommandCommitted`.

## 4. Kernel Command Inbox

Kernel deduplicates each command by `commandId`.

- Same command ID + same payload digest: return the original durable result.
- Same command ID + different digest: return an idempotency conflict, audit and quarantine; do not execute the target transition.
- New command: validate identity, permission, the **owning aggregate's version** and the relevant protected read-set (TaskControl CAS only for accepted Goal/structural plan/cancel/terminal); commit the target transition / Journal event and KernelCommandInbox result in one K-local transaction. An unrelated Task event or Journal sequence advance is not by itself a conflict.

Persisted command results include Applied, Rejected or NoOp. A business rejection is still a durable result; receipt of a request is not.

## 5. Dispatch and final ACK

Orchestration restarts by scanning sealed command plans with Pending / Dispatching / partially committed commands. It resends the exact original command IDs, digests and payloads.

When Kernel returns a durable result, Orchestration stores the result reference and sequence locally. If that local update is lost, it resends the same command and Kernel returns the original result without repeating the transition.

The delivery batch is complete only when every required command has a durable Kernel result. Only then may the final Delivery ACK become eligible. ACK confirms durable processing, not business success; it must include references to any rejected command results.

ACK is bound to delivery ID, idempotency key, payload digest, consumer identity, projection result and all required command/result references. ACK loss is handled by resending the same ACK. Duplicate ACKs are idempotent. Conflicting digests are quarantined.

## 6. Delivery semantics

The system provides:

**At-least-once delivery + Durable Inbox / Command Intent + Idempotent Kernel Command Commit.**

It does not claim distributed exactly-once delivery. **Physical transaction ownership** is: Kernel Journal + Kernel admission/Intent + Kernel Dispatch Outbox + Kernel CommandInbox outcome share K-local atomic persistence; Orchestration ResponseDeliveryInbox + sealed projection/CommandPlan/CommandOutbox share O-local atomic persistence; Host DispatchInbox + one-use nonce + LaunchAttempt share H-local atomic persistence. K, O and H are separate transaction domains; OS spawn and external side effects are non-transactional. Outbox send, remote Inbox receive, Host execution/receipt and final ACK remain distinct cross-owner durability barriers. See [Core protocol](core-protocol.md).

## 7. Recovery cases

- Crash before Kernel Completed transaction: no final selection or outbox is assumed.
- Crash after Completed/outbox commit but before send: scan K Outbox and resend the original envelope; no new response selection or budget reservation.
- Crash after Inbox receive but before command plan sealing: impossible if the first-receipt transaction is implemented correctly; otherwise treat as a contract violation.
- Crash after one of several commands commits: resend remaining and committed commands with their original IDs; Kernel returns original results for committed commands.
- Kernel commits but Orchestration loses the response: resend the same command and recover its original result.
- K ToolInvocation Intent+Outbox commits but dispatch is not sent: restart K Dispatcher, scan pending Outbox and resend original ToolInvocation/nonce; Host dedup ensures one launch attempt.
- H has an executed/settled run receipt but K has not imported it: H Result Outbox resends same authenticated receipt; K atomically deduplicates its HostResultInbox and Journal outcome. A missing H result after OS spawn is OutcomeUnknown, not a known non-execution.
- ACK is lost: resend the same ACK; do not redo commands.
- Same ID with different digest: quarantine and alert; never overwrite.

Persistence, authentication, transaction isolation and crash recovery are **UNVERIFIED** until fault-injection tests demonstrate them.
