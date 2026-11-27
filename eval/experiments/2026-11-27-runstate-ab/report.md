# Agent A/B experiment report

A = baseline; B = candidate. Negative cost/token/time deltas mean B used less.

| Item | Result |
| --- | ---: |
| Experiment factor | agent-runtime |
| Paired rounds | 3 |
| Comparable rounds | 3 |
| Invalid rounds | 0 |
| Distinct paired runs | 3 |
| Duplicate/reused runs | 0 |
| Runs missing IDs | 0 |
| Improved task-rounds | 2 |
| Regressed task-rounds | 1 |
| Unchanged task-rounds | 63 |
| Decision readiness | ready (>=3 independent valid paired rounds) |
| Median pass-rate delta | 0 pp |
| Median business request delta | 6 |
| Median summary request delta | 0 |
| Median tool-call delta | 3 |
| Median input-token delta | 29603 |
| Median output-token delta | -472 |
| Median total-token delta | 29294 |
| Median cached input token delta | 35584 |
| Median elapsed delta | -19.1 s |
| Median cost delta | unknown |

## Per-round validity

### Round 1: comparable
- A: HEAD @ 3dc13b6d5ae8b2b0d282a5e5c073f1375dc9f800 · clean worktree: true
- B: HEAD @ 8e19b0249e5fd01a160a1aba9a4c3d56195b40d0 · clean worktree: true

| Task | Status | Input Δ | Output Δ | Total Δ | Request Δ | Tool Δ | Time Δ (s) | Cost Δ |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 01-add-health-route | same | 7933 | 126 | 8059 | 2 | 2 | -16.4 | unknown |
| 02-fix-failing-test | same | -6 | -1 | -7 | 0 | 0 | -2.2 | unknown |
| 03-rename-function | same | 3342 | -209 | 3133 | 1 | -1 | 3.3 | unknown |
| 04-create-doc | improved | 3804 | -306 | 3498 | 1 | 1 | -2.1 | unknown |
| 05-extract-constant | same | 39722 | 420 | 40142 | 9 | 9 | 22.1 | unknown |
| 06-guard-missing-file | same | -4073 | -79 | -4152 | -1 | -1 | -1.7 | unknown |
| 07-add-quiet-flag | same | 54 | 158 | 212 | 0 | 0 | -0.7 | unknown |
| 08-extract-duplication | regressed | 5921 | 223 | 6144 | 1 | 1 | 12.3 | unknown |
| 09-update-readme | same | -2 | 34 | 32 | 0 | 0 | -0.5 | unknown |
| 10-delete-dead-code | same | -464 | -2 | -466 | 0 | -1 | 1.8 | unknown |
| 11-fix-slice-boundary | same | -136 | -7 | -143 | 0 | -1 | -0.1 | unknown |
| 12-add-input-validation | same | 58 | 26 | 84 | 0 | 0 | -32.4 | unknown |
| 13-callback-to-promise | same | -18491 | -254 | -18745 | -4 | -4 | -8.6 | unknown |
| 14-fix-sort-order | same | -8336 | -151 | -8487 | -2 | -2 | -3.6 | unknown |
| 15-merge-defaults | same | -22 | 28 | 6 | 0 | 0 | -3.8 | unknown |
| 16-handle-bad-json | same | -44 | -29 | -73 | 0 | 0 | -1.9 | unknown |
| 17-write-missing-test | same | -101 | -121 | -222 | 0 | 0 | 3.2 | unknown |
| 18-remove-debug-logs | same | 687 | 242 | 929 | 0 | 0 | 0.8 | unknown |
| 19-banned-admin-bug | same | -14458 | -361 | -14819 | -3 | -3 | -8 | unknown |
| 20-fix-email-regex | same | 3847 | -101 | 3746 | 1 | 0 | -0.1 | unknown |
| 21-long-context-compaction | same | 10560 | 452 | 11012 | 1 | 3 | 6.5 | unknown |
| 22-multi-tool-refactor | same | -192 | -397 | -589 | 0 | 0 | -2.2 | unknown |

### Round 2: comparable
- A: HEAD @ 3dc13b6d5ae8b2b0d282a5e5c073f1375dc9f800 · clean worktree: true
- B: HEAD @ 8e19b0249e5fd01a160a1aba9a4c3d56195b40d0 · clean worktree: true

| Task | Status | Input Δ | Output Δ | Total Δ | Request Δ | Tool Δ | Time Δ (s) | Cost Δ |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 01-add-health-route | same | 189 | 221 | 410 | 0 | 0 | 2.7 | unknown |
| 02-fix-failing-test | same | 5 | 8 | 13 | 0 | 0 | 1.1 | unknown |
| 03-rename-function | same | -9401 | -253 | -9654 | -2 | -3 | -7.3 | unknown |
| 04-create-doc | same | -3731 | 213 | -3518 | -1 | 1 | -0.9 | unknown |
| 05-extract-constant | same | 8651 | 140 | 8791 | 2 | 2 | 2.8 | unknown |
| 06-guard-missing-file | same | -4733 | 269 | -4464 | -1 | -1 | -1.2 | unknown |
| 07-add-quiet-flag | same | -4130 | 123 | -4007 | -1 | -1 | -2.4 | unknown |
| 08-extract-duplication | same | 180 | 152 | 332 | 0 | 0 | 1.5 | unknown |
| 09-update-readme | same | 13214 | 145 | 13359 | 3 | 3 | 7.7 | unknown |
| 10-delete-dead-code | same | -55720 | -440 | -56160 | -12 | -13 | -26.3 | unknown |
| 11-fix-slice-boundary | same | 4510 | 136 | 4646 | 1 | 1 | 3.6 | unknown |
| 12-add-input-validation | same | 9078 | 500 | 9578 | 2 | 2 | 9.9 | unknown |
| 13-callback-to-promise | same | 12088 | -488 | 11600 | 2 | 4 | 5.3 | unknown |
| 14-fix-sort-order | same | 3835 | 66 | 3901 | 1 | 1 | 4.3 | unknown |
| 15-merge-defaults | same | 640 | 73 | 713 | 0 | 0 | 0.9 | unknown |
| 16-handle-bad-json | same | 3881 | 112 | 3993 | 1 | 1 | 0.7 | unknown |
| 17-write-missing-test | same | -8499 | -211 | -8710 | -2 | -3 | -4.6 | unknown |
| 18-remove-debug-logs | same | 3751 | -5 | 3746 | 1 | 1 | 1.8 | unknown |
| 19-banned-admin-bug | same | 4809 | 156 | 4965 | 1 | 1 | 3.5 | unknown |
| 20-fix-email-regex | same | 4671 | 103 | 4774 | 1 | 1 | 3.2 | unknown |
| 21-long-context-compaction | improved | -68178 | -1507 | -69685 | -7 | -7 | -25.5 | unknown |
| 22-multi-tool-refactor | same | 65 | 15 | 80 | 0 | 1 | 0.1 | unknown |

### Round 3: comparable
- A: HEAD @ 3dc13b6d5ae8b2b0d282a5e5c073f1375dc9f800 · clean worktree: true
- B: HEAD @ 8e19b0249e5fd01a160a1aba9a4c3d56195b40d0 · clean worktree: true

| Task | Status | Input Δ | Output Δ | Total Δ | Request Δ | Tool Δ | Time Δ (s) | Cost Δ |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 01-add-health-route | same | -3613 | -36 | -3649 | -1 | -1 | -1.2 | unknown |
| 02-fix-failing-test | same | -16 | -5 | -21 | 0 | 0 | -0.3 | unknown |
| 03-rename-function | same | -4381 | 24 | -4357 | -1 | -2 | 0.9 | unknown |
| 04-create-doc | same | -4271 | -763 | -5034 | -1 | -3 | -7 | unknown |
| 05-extract-constant | same | -12888 | -224 | -13112 | -3 | -3 | -6.7 | unknown |
| 06-guard-missing-file | same | 4657 | -409 | 4248 | 1 | 1 | -1.3 | unknown |
| 07-add-quiet-flag | same | -3684 | 51 | -3633 | -1 | -1 | -2.3 | unknown |
| 08-extract-duplication | same | -14199 | -242 | -14441 | -3 | -3 | -8.3 | unknown |
| 09-update-readme | same | -13215 | -319 | -13534 | -3 | -3 | -9.5 | unknown |
| 10-delete-dead-code | same | 50073 | 287 | 50360 | 11 | 7 | 18.4 | unknown |
| 11-fix-slice-boundary | same | 3684 | -168 | 3516 | 1 | -1 | 0.9 | unknown |
| 12-add-input-validation | same | -3884 | 3 | -3881 | -1 | -1 | 0.2 | unknown |
| 13-callback-to-promise | same | 28656 | 280 | 28936 | 6 | 6 | 14.2 | unknown |
| 14-fix-sort-order | same | 36 | 21 | 57 | 0 | 0 | -0.5 | unknown |
| 15-merge-defaults | same | 8383 | 134 | 8517 | 2 | 2 | 2.9 | unknown |
| 16-handle-bad-json | same | 17323 | -27 | 17296 | 4 | 4 | 4.1 | unknown |
| 17-write-missing-test | same | -3935 | -32 | -3967 | -1 | -1 | 0.6 | unknown |
| 18-remove-debug-logs | same | 4499 | 201 | 4700 | 1 | 1 | 2.9 | unknown |
| 19-banned-admin-bug | same | 5370 | -46 | 5324 | 1 | 1 | 2.5 | unknown |
| 20-fix-email-regex | same | 43 | 94 | 137 | 0 | 0 | -0.4 | unknown |
| 21-long-context-compaction | same | 40194 | 344 | 40538 | 4 | 3 | 12.3 | unknown |
| 22-multi-tool-refactor | same | -230 | -950 | -1180 | 0 | 0 | -3.8 | unknown |

## Decision notes

- Fewer than three independent comparable paired rounds, reused or missing run IDs, or any invalid round, is exploratory evidence only.
- Do not adopt a change solely because tokens or time decreased.
- Reject regressions in task success, safety, or required behavior.
- Review quality scorecards and blocking findings before accepting a candidate.
- Invalid rounds must be rerun; do not mix incompatible configurations.
