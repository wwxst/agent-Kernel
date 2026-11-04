# Stability experiments: pinned cross-day baseline and opt-in diagnostics

This work stays outside src/. It does not change the Agent Loop, task prompts, fixtures, or checkers.

## 1. Cross-day baseline

The measured implementation is pinned to:

- Commit: 4edd0e4ab004e184d280a95c17e41690fd58c644
- Model: hy3
- Endpoint: http://127.0.0.1:8788/v1
- Tasks: 20
- Concurrency: 4
- Rounds per natural day: 3
- Per-task limits: the values already present at the pinned commit

Run once on each of three different local natural days:

~~~bash
npm run eval:cross-day
~~~

Or specify the date explicitly (it must equal the machine's current local date):

~~~bash
npm run eval:cross-day -- --date 2026-11-05
~~~

The runner:

1. Requires API_KEY (or OPENAI_API_KEY), MODEL=hy3, and the exact baseline endpoint.
2. Requires a clean worktree, except for earlier archives under eval/baselines/cross-day/.
3. Temporarily checks out the exact baseline SHA, then imports and runs that commit's original eval/run.mjs.
4. Runs three sequential full rounds, with four tasks concurrently inside each round. It does not retry tasks.
5. Saves every round immediately and writes a daily summary.
6. Restores the branch that was checked out before the run.

Output:

~~~text
eval/baselines/cross-day/YYYY-MM-DD/
  round-01.json
  round-02.json
  round-03.json
  summary.json
~~~

Do not use the diagnostic branch's newer evaluator for these baseline measurements. The helper deliberately imports the evaluator only after checking out the pinned SHA. Do not run the command three times on one day and call that cross-day validation.

## 2. Investigating high-variance tasks

The diagnostic mode is optional and is intended for investigation, not for the baseline reliability measurement:

~~~bash
npm run eval -- --trace --keep 13-callback-to-promise
npm run eval -- --trace --keep 20-fix-email-regex
npm run eval -- --trace --keep 08-extract-duplication
~~~

Task filters mean only the selected task workspace is retained. Avoid --keep without a task filter: that retains every task workspace in the round.

The per-task trace object is saved in the normal eval/results/<timestamp>.json record and contains:

- Per-request prompt/completion/total tokens, reported-usage status, prompt-token delta, message count, and payload-size proxies.
- Tool call order, request index, tool name, bounded/redacted arguments, execution time, result character/byte counts, and error preview when applicable.
- File additions, modifications, and deletions observed after each tool call and across the whole task.
- Snapshot coverage and any diagnostic errors.

No message contents or successful tool-result bodies are copied into the trace. Secret-looking argument keys are redacted. String arguments over 512 characters are represented by length, SHA-256, and a short preview.

File snapshots skip .git and node_modules. Files up to 1 MB are fingerprinted with SHA-256; larger files use size/mtime metadata and mark snapshot coverage incomplete. The trace reports this limitation.

Diagnostic snapshots add filesystem observation overhead. Therefore, use trace runs to understand model/tool behavior, not to compare wall-clock performance with the uninstrumented baseline. The wrappers preserve the original model responses and tool results; they do not alter Agent Loop behavior.

## 3. Interpretation

- Compare actual promptTokens across requests to see whether each turn's prompt is growing.
- Compare repeated tool names and arguments to find duplicate reads, edits, or validation loops.
- Use fileChanges to distinguish useful edits from repeated writes that leave the same file state.
- A high messageChars value is only a payload-size proxy, not a token count. Use provider-reported promptTokens for token analysis.
- If usage is missing, the request is marked unknown; it is not recorded as zero.

Only after the traces identify a concrete cause should a prompt or tool-description change be proposed. Change one variable at a time and compare against the pinned baseline.
