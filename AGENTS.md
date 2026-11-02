# Project working rules

These rules apply to all work in this repository.

## 1. Project identity

- `wwxst/agent-Kernel` is the sole formal home of the new Agent Kernel project.
- The former repository `wwxst/agent-` has been deleted by its owner and is no longer accessible. It is not a source, dependency, or implicit authority for this project.
- Treat only the knowledge and architecture principles already re-authored in this repository as available. Do not assume deleted files, branches, commits, or code can be recovered.
- Do not import old Git history, old project structure, obsolete decisions, or the old Kernel wholesale.
- Re-author knowledge that remains useful. Review every code asset independently before proposing reuse.

## 2. Decision status

Every important statement must be distinguishable as one of:

- **APPROVED PRINCIPLE** — an agreed architectural invariant; not proof of implementation.
- **OPEN** — a question that still needs research or owner decision.
- **PROPOSED** — a candidate design that has not been accepted.
- **UNVERIFIED** — a behavior, safety property, or performance claim without sufficient evidence.
- **DEFERRED** — explicitly outside the current authorized scope.

Never turn a proposal, historical experiment, model output, or code that happens to exist into an approved project contract without review.

## 3. Research and design discipline

- Research before making consequential architecture or technology choices.
- Prefer primary source code, official technical documentation, reproducible experiments, and exact commit references.
- Separate **observed fact**, **interpretation**, **hypothesis**, and **unknown**.
- For comparisons, identify version, source location, tested behavior, limitations, and whether the result is directly comparable.
- Do not copy a mechanism merely because a reference project uses it. Explain the problem it solves, alternatives, trade-offs, and why it belongs here.
- Keep autonomous Coding Agent intelligence design explicit; do not reduce it to a list of module names.

## 4. Change boundaries

- The current authorization covers the initial documentation baseline and its iterative review.
- Do not start runtime implementation, add production dependencies, select a final technology stack, or migrate legacy code without a separate explicit approval of scope.
- Do not create a pull request, release, or deployment unless requested.
- Do not rely on the deleted repository or attempt to use it as an ongoing source. Any future review of an old code asset requires the owner to provide the asset independently, with provenance and license information.
- Do not enable Multi-Agent / D9. It remains deferred and unauthorized.

## 5. Architecture invariants

- Kernel is the sole authority for Task/Turn/Step/ToolInvocation state, hard budgets, legal transitions, and tool admission.
- Orchestration owns adaptive planning and decisions, but cannot write authoritative state directly.
- Model Gateway handles provider interaction and evidence normalization, not task authority or tool admission.
- Context is a provenance-aware projection, not an authority source.
- Tool Runtime schedules and dispatches only after Kernel admission; it cannot grant permissions.
- Trusted ToolHost owns physical execution evidence in a separate Host Ledger; it cannot rewrite Kernel state.
- Kernel Journal and Host Ledger are separate fact boundaries. Do not claim a database transaction makes external side effects atomic.
- UNKNOWN is not failure and must not trigger blind retry.
- Task terminal states are immutable. Late conflicting evidence is handled through explicit hold/overrun records and, where authorized, a separate remediation task.
- Completion requires evidence bound to the accepted plan, workspace snapshot, environment, and actual verification runs.

## 6. Documentation and testing

- Keep normative contracts separate from open design notes and research reports.
- Every runtime claim must point to reproducible tests and its supported environment.
- Distinguish PASS, FAIL, NOT RUN, SKIP, PARTIAL, and UNVERIFIED.
- Do not describe a test file as a passing test unless its execution result is known.
- Update the relevant index and decision log when a contract changes.
