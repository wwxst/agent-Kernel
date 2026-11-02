# Legacy asset review and migration policy

> **Status: Former source repository deleted.** This policy records what is already available in the new project and how any independently supplied historical asset must be reviewed. It is not a completed exhaustive inventory and authorizes no code migration.

## 1. Repository status and authority

- `wwxst/agent-Kernel` is the sole formal repository and source of truth for the new Agent Kernel.
- The former `wwxst/agent-` repository has been deleted by its owner and is no longer accessible.
- The deleted repository is not an active source, dependency, or ongoing project.
- No future work may assume that its branches, files, commits, pull requests, or code can be fetched or recovered.
- The owner has confirmed the deletion; GitHub also returns 404 for the former repository.

Only knowledge and architecture principles already re-authored in `agent-Kernel`, or assets independently supplied later by the owner, are available for review.

## 2. Asset classes

| Class | Examples | Default treatment |
| --- | --- | --- |
| Requirements and durable domain knowledge | User goals, business rules, constraints, failure cases already captured in this repository | Retain and refine with clear status and provenance |
| Approved architecture principles | V2.1.2 authority and lifecycle principles recorded in this repository | Treat the re-authored documents here as the working baseline, subject to ongoing review |
| Historical proposals and rejected designs | Older architecture versions, obsolete ADRs, draft options | Do not treat as current specification; unavailable unless independently supplied |
| Research evidence | Source reviews, experiments, test traces and fixed commit results | Use only evidence already captured here or independently supplied with exact scope and provenance |
| Candidate code modules | Provider adapters, parsers, scheduling algorithms, host utilities | Not currently available from the deleted repository; review only if independently supplied |
| Old Kernel implementation | Historical state machine, runtime, persistence and orchestration | Do not migrate wholesale; redesign against the new contracts |
| Build and project configuration | Package manifests, CI, compiler config, scripts | Re-select for the new project; do not inherit automatically |
| Historical process records | Old commits, branches, PRs, milestone logs | Do not import into the new Git history |

## 3. Required review for any independently supplied code asset

Before proposing code reuse, record:

- exact source repository or archive, path, and commit/version where available;
- who supplied the asset and its provenance;
- license and redistribution rights;
- original purpose and actual supported behavior;
- dependencies and transitive risk;
- interface and state assumptions;
- security boundary and privilege requirements;
- tests, actual CI status and execution environment;
- known limitations and failure modes;
- changes required to satisfy the new contracts;
- reuse-versus-rewrite recommendation and rationale.

A test file existing is not evidence that the test passed. A historical PASS applies only to its exact commit, environment and test scope. An asset with unknown provenance or license must not be copied into the project until resolved.

## 4. Review outcomes

Possible outcomes for a supplied asset:

- **RE-AUTHOR** — retain knowledge but write a new document or contract.
- **REFERENCE ONLY** — retain a source identifier and evidence summary, without copying the asset.
- **SELECTIVE REUSE CANDIDATE** — technically independent code may be proposed for a separate review.
- **REWRITE** — useful behavior, but implementation does not satisfy new contracts.
- **DO NOT MIGRATE** — obsolete, unsafe, unlicensed, tightly coupled or no longer needed.

No asset becomes part of the new project merely because it was previously implemented or tested.

## 5. Clean-history requirements

- Do not import old Git commits, tags, branches or PR history.
- Do not copy the former repository wholesale or use it as a submodule.
- Do not preserve obsolete architecture version chains as normative documents.
- Do not carry over old package manifests or dependency lockfiles by default.
- Keep only re-authored current documentation, reviewed evidence references and individually approved code.

## 6. Current migration state

- Knowledge and architecture principles: initial re-authoring has been committed to this repository.
- Complete historical asset inventory: **NOT COMPLETE**; the deleted repository is unavailable, so an exhaustive inventory cannot be claimed.
- Candidate code review: **NOT STARTED**; no candidate source code is currently available for review from the deleted repository.
- Code migration: **NOT STARTED**.
- Former repository deletion: **CONFIRMED**; no further action against that repository is planned.
- Recovery or archival copy of the former repository: **NOT CONFIRMED**; do not assume one exists.

Any future code reuse requires the owner to provide the specific asset independently and authorize its review. It must then pass the review in Section 3 before migration is proposed.
