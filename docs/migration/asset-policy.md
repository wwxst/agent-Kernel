# Legacy asset review and migration policy

> **Status: Initial policy.** This is not a completed exhaustive inventory, and it authorizes no code migration.

## 1. Repository roles

- `wwxst/agent-Kernel`: the new project's sole formal repository and future source of truth.
- `wwxst/agent-`: old project and source of candidate knowledge, research evidence and historical code.
- The old repository remains unchanged until the new repository has been reviewed and accepted by its owner.

## 2. Asset classes

Every candidate asset must be classified before it is brought into the new repository.

| Class | Examples | Default treatment |
| --- | --- | --- |
| Requirements and durable domain knowledge | User goals, business rules, constraints, failure cases | Extract and re-author with source/provenance |
| Approved architecture principles | V2.1.2 authority and lifecycle contracts | Re-author and adapt to the new repository identity |
| Historical proposals and rejected designs | Older architecture versions, obsolete ADRs, draft options | Do not import as current specification; consult only when needed |
| Research evidence | Source reviews, experiments, test traces and fixed commit results | Preserve as references with scope/limitations; do not imply current verification |
| Candidate code modules | Provider adapters, parsers, scheduling algorithms, host utilities | No direct copy by default; review API, semantics, security, dependencies, license and tests |
| Old Kernel implementation | Old state machine, runtime, persistence and orchestration | Do not migrate wholesale; redesign against the new contracts |
| Build and project configuration | package manifests, CI, compiler config, scripts | Re-select for the new project; do not inherit automatically |
| Historical process records | Old commits, branches, PRs, milestone logs | Do not import into the new Git history |

## 3. Required review for a code asset

Before proposing code reuse, record:

- exact source repository, path and commit;
- license and provenance;
- original purpose and actual supported behavior;
- dependencies and transitive risk;
- interface and state assumptions;
- security boundary and privilege requirements;
- tests, actual CI status and environment;
- known limitations and failure modes;
- changes required to satisfy the new contracts;
- reuse-versus-rewrite recommendation and rationale.

A test file existing is not evidence that the test passed. A historical PASS applies only to its exact commit, environment and test scope.

## 4. Migration decision

Possible outcomes:

- **RE-AUTHOR** — retain knowledge but write a new document or contract.
- **REFERENCE ONLY** — retain a source link and evidence summary, without copying the asset.
- **SELECTIVE REUSE CANDIDATE** — technically independent code may be proposed for a separate review.
- **REWRITE** — useful behavior, but implementation does not satisfy new contracts.
- **DO NOT MIGRATE** — obsolete, unsafe, unlicensed, tightly coupled or no longer needed.

No asset becomes part of the new project merely because it was previously implemented or tested.

## 5. Clean-history requirements

- Do not import old Git commits, tags, branches or PR history.
- Do not copy the old repository wholesale or use it as a submodule.
- Do not preserve obsolete architecture version chains as normative documents.
- Do not carry over old package manifests or dependency lockfiles by default.
- Keep only re-authored current documentation, reviewed evidence references and individually approved code.

## 6. Current migration state

- Knowledge and architecture principles: initial re-authoring has begun.
- Complete asset inventory: **NOT COMPLETE**.
- Candidate code review: **NOT STARTED**.
- Code migration: **NOT STARTED**.
- Old repository deletion or archival: **NOT AUTHORIZED**; keep it unchanged until new-repository acceptance.
