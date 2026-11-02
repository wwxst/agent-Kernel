# Development roadmap and gates

> **Status: Provisional sequencing.** This roadmap is a planning aid, not blanket authorization to begin every phase.

## Stage 0 — Establish the new project baseline

- Create this repository with a clean Git history.
- Re-author the approved architecture principles and contracts.
- Record source provenance and explicit adoption exclusions.
- Establish research, decision, testing and documentation conventions.

**Current state:** documentation baseline has been started. This does not mean the architecture is complete.

## Stage 1 — Research autonomous Coding Agent intelligence

- Study source implementations and design mechanisms in Pi, Codex, DeepSeek Harness and Claude Code.
- Model the end-to-end autonomous coding loop, not only the low-level runtime.
- Define goal understanding, repository exploration, planning, execution, feedback, debugging, verification, repair and stopping behavior.
- Study long-task context, memory, checkpoint and recovery.
- Build a reproducible evaluation task set and compare alternatives.
- Separate source facts, inference, hypotheses and unknowns.

**Exit:** a coherent intelligent-execution design, evidence map, trade-off report, failure model and proposed contracts ready for owner review.

## Stage 2 — Reconcile and review architecture

- Integrate the intelligent-execution design with Kernel authority and Trusted ToolHost contracts.
- Resolve contradictions and identify contracts that need revision.
- Decide which design elements are approved, proposed, deferred or unverified.
- Update open decisions and acceptance criteria.

**Exit:** owner-reviewed architecture and explicit implementation scope.

## Stage 3 — Implementation plan and authorization

- Select runtime, persistence, provider strategy and sandbox approach only after evidence and trade-off review.
- Define module boundaries, ports, data schemas, test plan and security threat model.
- Define implementation order, rollback strategy and verification gates.

**Exit:** explicit owner approval for the implementation scope. No code implementation is implied before this gate.

## Stage 4 — Short-cycle contract verification

If separately authorized, use controlled fake providers/hosts and deterministic traces to test critical state, budget, delivery, cancellation, recovery and completion contracts. Report PASS / FAIL / NOT RUN / SKIP without overclaiming.

## Stage 5 — Controlled real-model Coding Agent vertical slice

Requires separate explicit approval of model/provider, task set, workspace isolation, budget, tools, network policy and stop conditions. Use a disposable repository/workspace and no production credentials. A fixture-only provider does not count as a real-model coding result.

## Stage 6 — Strengthen long-task context and trusted execution

Validate checkpoint/compaction, memory lifecycle, Host isolation, process convergence, receipt authenticity, UNKNOWN reconciliation and Completion Guard through fault injection and adversarial tests.

## Stage 7 — Productization

Only after the core contracts and controlled execution are demonstrated, evaluate SDK/API/CLI/IDE/Desktop integration, remote workers, multi-user deployment and extension lifecycle.

## Hard gates

- A phase does not automatically authorize the next phase.
- Architecture approval does not equal implementation authorization.
- Passing a contract spike does not equal production readiness.
- D9 / Multi-Agent remains deferred until separately reopened and authorized.
- No legacy code migration without per-asset review and explicit approval.
