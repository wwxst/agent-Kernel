# Executable Kernel contract prototype — experimental, not a production Runtime

**Status: IMPLEMENTED locally / synthetic tests verified / external G0–G5 gates OPEN.**

This branch is deliberately based on the architecture review Draft PR #1, NOT on the production-ready main branch. Owner approval of G0, ADP-03–11 and a final language/OS/Provider technology choice remains open. This Python 3.11+ standard-library slice is a **disposable executable reference** of a subset of the protocol: it does not imply approval of Python as the final Kernel stack. No inherited/deleted legacy code is used.

## Run

```bash
python -m unittest discover -s tests -v
python scripts/bench_contracts.py --iterations 50
```

No dependencies, model API keys, OS permissions or external tools are needed. Test databases are temporary SQLite files; they never contact a Provider or spawn a subprocess. Keep Kernel and Gateway store files separate.

## Scope and exact outcome

| Issue | Executable coverage | Limit / remaining gate |
| --- | --- | --- |
| P0 K-local idempotent admission + durable Model/Tool Outbox | SQLite `BEGIN IMMEDIATE`, command digest dedup, journal/intent/outbox in one local transaction; concurrent two-connection budget race | No real dispatcher, K/O/H recovery protocol, filesystem fsync/storage fault proof (G1 partial) |
| P0 Provider ambiguous send + runaway cost | Separate durable G send marker, no automatic replay, UNKNOWN held, new Attempt independently funded, bill/selection separated | Issuer `synthetic-test-issuer` is a TEST DOUBLE, not a real charge certificate; no authenticated Provider status/billing (G1 partial) |
| P0 bounded candidate/termination | Incomplete candidate rejected, journal-order irreversible selection; Completed/Failed/Cancelled/TimedOut immutable, stop needs effects converged | No actual model tool-call argument schema/stream parser, delivery consumer, or real long-job reconciler |
| P0 Host revocation/nonce | Synthetic local gate serializes fence/launch callback, consumes nonce durably, expires ticket, denies offline/unknown/R2 | **No OS spawn, sandbox, cryptographic grants, real clock/lease/Host ledger attestation**. These are G2 specification checks, not a G2 PASS |
| P0 verification guard | Coding criterion/effective digest/read-only/disjoint output/receipt fields must match; UNKNOWN/failed/unconverged tools block terminal | Receipt trust is an injected boolean; **no actual sealed SourceSnapshot mount** or actual test execution view. S1–S3 and Video verification NOT RUN |
| P1 selective versions / plan changes | Routine Attempt/Tool do not CAS on global TaskControl; protected workspace/plan/authority epoch checks; L2 structural CAS; old evidence invalidated | No full protected-field L0/L1/L2 classifier, no multi-Host, no Domain intelligence path |
| P1/P2 single loop and bounded progress | One decision driver with fast completion, task-local derived progress, decision cap, no-progress cap, deadline, explicit BLOCKED | No model scheduling, adaptive context assembler, retry policy, watchdog service or real Coding/Video loop |

**Do not interpret the synthetic tests as a G1 or G2 gate pass.** `ChargeBound.all_billable_dimensions_proven`, `authenticated=True` and `sealed_readonly=True` are deliberately injected by tests, not trusted/cryptographically verified facts. A live adapter/Host MUST replace these seams and fail closed until proof is available. This code must not be exposed as a production API for effectful tools.

## Invariants/operating boundaries

- `Kernel` owns Task, Attempt, Step, Invocation, Budget, evidence bindings and terminal state in one K SQLite file. `_command` commits command dedup and effect in one local transaction. It does not claim atomicity with `GatewaySendLedger`, ToolHost or external side effects.
- `GatewaySendLedger` must use a separate file. Duplicate K→G envelopes produce no second Provider send; after `mark_may_have_sent`, a crash **may** mean zero external sends, so the outcome remains UNKNOWN rather than retransmitting automatically.
- The simulated Host LaunchGate stores a one-use nonce before the spawn callback. A crash can leave `INTENT_DURABLE` forever until reconciled. Restart may not reuse it. Kernel does not mark `Revoked` based on Host fence simulation; there is no trustworthy K/H ACK channel yet.
- The accepted workspace/plan changes invalidate previously bound model candidates and completion evidence. Task completion is an irreversible guarded transition. Unknown Provider billing alone does not block a complete selected response as long as the original reservation stays held.
- R1 remains disabled by default; an explicit test-only flag exists. R2 is always denied. No capability can be granted by model text.
- A `WAIT` decision returns `BLOCKED` without a busy loop. There is **no durable external wakeup supervisor or deadline reconciliation service**; this gap must be closed before running unattended tasks.
- The prototype uses `time.time()` for synthetic charge certificate expiry and a monotonic process clock for Host simulation. It cannot prove real Host clocks, timeout persistence, lease validity or OS-level check/spawn atomicity.

## Validation status (record results independently from this file)

- The unit suite additionally covers unrelated-task activity not resetting stall detection, known Host outcome followed by later process convergence, and blocking workspace cutover while a tool is unresolved. Tests cover idempotent replay, missing charge certificate, ambiguous Gateway send and restart, competing reservations, budget overrun, candidate ordering, snapshot invalidation, unsafe shadow/false completion, cancel/timeout/failure finalization, bounded no-progress, local Host fence ordering and nonce recovery.
- Tests are **synthetic local deterministic tests**, not full Coding/Video tasks. Workload quality/latency/token cost versus pi-agent, Codex, Claude Code, DeepSeek Harness or an existing baseline is **not comparable**, because this repository has no runnable production baseline.
- Benchmark script reports only local micro-operation timings, no model tokens or external tool timings; never label them as end-to-end Agent performance gains.

## Next dependency-ordered work / rollback

1. **Owner G0 decision:** approve/adjust the minimal protocol, risk classes/TTL/clock tolerance, required Host enforcement and supported Provider financial bounds; retain proposals as open until then.
2. **G1 real capability adapters:** signed/trusted maximum-charge proof verifier; authenticated Provider acceptance/billing status; Gateway send marker crash tests across actual transport and independent K/G crash processes. Add real inbox/outbox dispatch/recovery and persistent timer/watchdog.
3. **G2 real Trusted ToolHost:** actual short-lived authority, nonce/fence, process identity + convergence, enforce readonly sealed source and isolated outputs, Linux/OS-specific fault and mount tests, real evidence attestation. Keep R1/R2 disabled until proved/approved.
4. **G3/G4 domains:** real repository patch/test/repair loop and media render/inspect/revise loop; compare single loop against richer Domain policies under equal limits.
5. **G5 reuse:** two domains pass shared safety invariants without transferring semantic authority into Kernel.

**Rollback:** This prototype adds only `kernel_contracts/`, `tests/`, `scripts/`, `.github/workflows/` and this file. Delete these on the feature branch or revert their commits. It does not migrate any schema or data in `main`, change the draft contracts, merge PR #1 or deploy anything.
