# Response delivery and durable inbox contract

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; runtime claims UNVERIFIED.** Scope: at-least-once response delivery, durable Inboxes/Outboxes, bounded redelivery and the Kernel→Orchestration event subscription. Record, event and error shapes are owned by the [Kernel data model](kernel-data-model.md). The contract is not yet implemented or verified.

## 1. Delivery boundary

Only a ModelStep that has atomically reached Completed with one immutable `selectedAttemptId` may be delivered to Orchestration. Candidate pointers, partial responses, truncated responses, and OutcomeUnknown execution results are not deliverable. A complete selected response **is deliverable before final provider billing settlement** when the owning Attempt and all concurrent charge-bearing Attempts remain covered by credible maximum reservations under hard-budget policy (or the Task has explicitly authorized soft-budget mode). A missing invoice is never treated as zero charge and never releases a reservation. See [Model and Budget](model-and-budget.md).

The Kernel creates a durable ResponseDeliveryOutbox record in the same local transaction as ModelStep Completed and final response selection.

**Terminal task delivery is a separate record.** `TaskDelivery` ([Kernel data model §3.20](kernel-data-model.md)) is created by `PrepareDelivery` with the terminal fact (or references it), delivered at-least-once with a stable `delivery_id`, and acknowledged by `AcknowledgeDelivery`. A missing ACK is retried with bounded backoff and dead-lettered; it never reopens a terminal Task and never creates a second delivery for the same terminal fact.

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

Persisted command results include Applied, Rejected, NoOp or Conflict. A business rejection is still a durable result; receipt of a request is not.

## 5. Dispatch and final ACK

Orchestration restarts by scanning sealed command plans with Pending / Dispatching / partially committed commands. It resends the exact original command IDs, digests and payloads.

When Kernel returns a durable result, Orchestration stores the result reference and sequence locally. If that local update is lost, it resends the same command and Kernel returns the original result without repeating the transition.

The delivery batch is complete only when every required command has a durable Kernel result. Only then may the final Delivery ACK become eligible. ACK confirms durable processing, not business success; it must include references to any rejected command results.

ACK is bound to delivery ID, idempotency key, payload digest, consumer identity, projection result and all required command/result references. ACK loss is handled by resending the same ACK. Duplicate ACKs are idempotent. Conflicting digests are quarantined.

### 5.1 Bounded redelivery and retention

Every Outbox/Inbox dispatch — delivery envelopes, commands, ACKs, Host receipts and Kernel events — uses **bounded** redelivery: an attempt cap, exponential backoff with jitter, and a durable dead-letter record with operator escalation when the cap is reached. No sender retries indefinitely, including K→G model-request delivery. An exhausted retry becomes a typed stall (`StorageUnavailable` or `DeliveryStalled`) for the owning scope and is visible; it is never an invisible infinite loop. Attempt counts and next-attempt times are recorded on the Outbox record, not in memory only, so a restart cannot reset an exhausted budget.

**Retention.** Dedup state (CommandInbox, HostResultInbox, delivery dedup, event-subscription cursor) is retained at least for the maximum redelivery window plus the correlation window of the facts it guards, and is archived with audit provenance before deletion. GC never removes an unresolved Inbox/Outbox entry, an unacknowledged delivery, an UNKNOWN correlation, a hold or a terminal fact. Retention durations are deployment configuration; no numeric default is claimed here.

## 6. Delivery semantics

The system provides:

**At-least-once delivery + Durable Inbox / Command Intent + Idempotent Kernel Command Commit.**

It does not claim distributed exactly-once delivery. **Physical transaction ownership** is: Kernel Journal + Kernel admission/Intent + Kernel Dispatch Outbox + Kernel CommandInbox outcome share K-local atomic persistence; Orchestration ResponseDeliveryInbox + sealed projection/CommandPlan/CommandOutbox share O-local atomic persistence; Host DispatchInbox + one-use nonce + LaunchAttempt share H-local atomic persistence. K, O and H are separate transaction domains; OS spawn and external side effects are non-transactional. Outbox send, remote Inbox receive, Host execution/receipt and final ACK remain distinct cross-owner durability barriers. See [Core protocol](core-protocol.md).

### Model-request Outbox is not Provider retransmission

This response-delivery/command Inbox protocol must not be generalized into an **unqualified at-least-once HTTP Provider request**. Kernel may replay its durable `ModelRequestOutbox` to **Model Gateway** with the exact admitted Attempt ID/request digest/reservation. Gateway has its own durable `SendMayHaveOccurred` marker **before** sending Provider bytes, deduplicates K deliveries, and **does not resend to Provider after ambiguous acceptance** unless a qualified server-enforced execution-and-billing idempotency contract permits exact same-Attempt replay. Otherwise ProviderOutcomeUnknown and original cost reservation persist. An independent new submission uses an independent admitted Attempt and budget reservation. See [Model and Budget](model-and-budget.md) and [Core protocol](core-protocol.md). This adds one local send marker, not a distributed transaction coordinator.

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

## 8. Kernel event subscription (K→O)

ModelStep responses use the delivery path above. Every other fact the loop needs to wake on — `TaskTerminal`, `HostReceiptImported`, `WaitPersisted`/`WaitResolved`, `CompletionHoldOpened`/`CompletionHoldResolved`, `AuthorityFenceChanged`, `PlanRevisionActivated` — uses **one** durable subscription, not a second inbox:

- **Durable cursor.** Orchestration persists `(subscription_id, consumer_identity, last_journal_sequence)`, reads events strictly after it, and advances the cursor in the same O-local transaction as its projection update.
- **At-least-once, idempotent by `event_id`.** A duplicate event is a `NoOp`; the same `event_id` with different bytes is an integrity conflict and is quarantined.
- **Gap and rebuild.** If the cursor falls behind the retained Journal window, or an event schema major is unknown, Orchestration rebuilds its projection from the last Kernel checkpoint/snapshot plus the Journal cursor instead of guessing or skipping.
- **No duplicate channel for the same fact.** A ModelStep response travels only on the delivery path; other facts travel only on the subscription. If both are ever emitted for one fact, the event is a wake hint and the delivery envelope remains the authoritative payload carrier.
- **Facts, not authority.** An event never authorizes an action; Orchestration re-reads current Kernel admission state before acting, and an adapter that writes the Journal directly is a protocol violation.
