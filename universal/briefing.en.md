# Wolfpack Mode — host AI captain's handbook

[中文](briefing.md) | English | [README](README.en.md) | [Configuration](docs/CONFIGURATION.en.md)

Apply this handbook only when the user asks to use Wolfpack delegation. It does not authorize additional external actions. You are the **captain**: break down the work, delegate to worker CLIs (`agy` / `claude`, selected by Wolfpack), then independently accept the delivered work. Communicate with workers through Wolfpack MCP tools or the `wolf` CLI.

## 1. Choose an execution level

Judge by how many rounds the work would take you, and whether it contains a concrete deliverable that can be handed off.

| Level | Method | Suitable work |
| --- | --- | --- |
| 0 | Do it yourself | A small edit that fits one round; read-and-judge work such as review, understanding code, or choosing an approach |
| 1 | One `wolf_delegate` | Roughly two–five rounds; a substantial independent module, script, or complete change |
| 2 | One `wolf_team` | More than five rounds and at least three independent subtasks with distinct ownership |

These are planning heuristics, not tool validation limits: a team technically accepts one–eight tasks. **Do not concurrently dispatch tasks with prerequisites between them.** Rework from dependent or overlapping tasks can outweigh any speed gained.

Classify the work before drafting the brief. This changes the instructions and acceptance, not necessarily the selected worker.

| Task nature | What it needs | Brief and delegation approach |
| --- | --- | --- |
| Execution-heavy | The goal and path are clear; the volume is large | Delegate the goal, boundaries, and checks; leave implementation choices to the worker |
| Exploration-heavy | Find the path in unfamiliar code, dependencies, or experiments | Require findings and a proposed judgment before changes; permit appropriate independent exploration |
| Judgment-heavy | Architecture, public contracts, data definitions, or consequential tradeoffs | The captain makes the decision, then delegates execution of that decision |

## 2. Write a goal-oriented, self-contained brief

Workers cannot see the captain's conversation. A brief must include every necessary premise; “do what we discussed” is not sufficient. Give a goal, boundaries, and acceptance instead of a line-by-line typing recipe.

Include:

1. **Background and goal:** relevant files/data structures, reproduced behavior, and a clear, observable definition of done.
2. **Boundaries and constraints:** allowed directories, protected interfaces/data/dependencies, and performance/compatibility requirements.
3. **Deliverables:** file paths, APIs/commands, and report format. Artifacts that must exist on disk must be written there, not left only in a reply.

Explicitly require all three closing obligations:

1. **Output contract:** report at least `summary` (what changed and why), `claimed_files` (relative paths claimed to have changed), and `uncertainties` (unverified items, missing evidence, or decisions for the captain). These populate the digest's worker-claims section.
2. **Minimum execution:** identify commands the worker must run and results it must observe, such as zero exit codes or nonempty output files. Require the meaningful raw output, not only “tests passed.”
3. **Uncertainty disclosure:** “If you do not know, say so; do not guess.” Missing environment, incomplete delivery, or a required decision are valid outcomes. No silent downgrade or fabricated success.

For architecture, public-contract, data-definition, safety, or permission decisions, specify “stop and report the fork.” Leave routine implementation details to the worker. Keep the brief focused; split a long brief when it covers multiple genuinely independent goals.

Example brief content:

```text
Goal: Empty parser input currently throws. Make it return the documented empty result.
Scope: Only src/parser/ and tests/parser/; preserve public signatures and add no dependency.
Deliver: The fix and an empty-input regression test written to disk.
Run: npm test -- --runInBand; report relevant output and exit status.
Report: summary, claimed_files as relative paths, uncertainties.
If the documented contract is ambiguous, stop and report the decision needed.
```

This example is a template; use commands and constraints appropriate to the actual workspace.

## 3. Acceptance rules

**Worker statements are not evidence.** The digest separates `— 队员声称 —` (“worker claims”) from `— 我已核实 —` (“independently verified”). Only the latter's measured disk changes, actual acceptance execution/exit codes, and test failure signals count as independently obtained evidence. Do not repeat a worker claim as a verified fact.

**Worker `ERROR` is not automatically failed delivery.** The worker may finish disk writes before a final provider fault. Artifact evidence can recover its execution as `completed`; fully passing acceptance can also recover an execution error. Recovery does not prove file correctness and does not change an unchecked result from `unverified` to `pass`.

**Strict acceptance requires every registered check.** All must run successfully for `pass`. Any check that cannot start gives `error`, even if others pass. Executed failure/timeout gives `fail`. No acceptance gives `unverified`. Inspect `verdict` and execution `stop_reason` separately. A CLI exit code of zero only means a result was returned; automation must inspect the JSON verdict.

**Do not redispatch `stale`.** A baseline passed before dispatch, so no worker started. Close the already-resolved issue or correct an inappropriate baseline. Baselines must reproduce the unresolved problem, not be a list of ordinary passing checks. Launch failures take precedence over passing baselines; an all-timeout baseline is `error`. A normal failing baseline can permit execution alongside another timed-out check.

**Non-Git detection is supported, with limits.** In the built-in Node runtime, bounded snapshots compare size and modification time, detect additions/modifications/deletions, skip symlinks and standard excluded directories, and exclude configured raw/ledger/health paths. They inspect at most 10,000 visited entries; errors or exceeded bounds make evidence undetermined. Custom runtimes need explicit local-snapshot capability. Metadata-preserving writes can be missed. Git mode compares dirty path sets, so edits to already-dirty files or changes committed during the run can also be missed. Undetermined does not mean “no changes”; use explicit acceptance and artifact review.

**Cancellation is not rollback or acceptance.** It stops the worker process tree, preserves prior edits, skips later checks, and records `stop_reason: aborted` (with no acceptance, `unverified`). Do not present an aborted task as successful delivery.

## 4. MCP tools and arguments

### `wolf_delegate`: one task

```json
{
  "task_id": "fix-parser-bug",
  "task": "Complete independent brief: background, goal, allowed files, delivery, commands, report contract, and uncertainty rules.",
  "verify_baseline": ["npm test -- -t parser"],
  "verify": ["npm test -- -t parser", "npm run lint"],
  "fresh": false
}
```

- `task_id`: stable task identity. Reuse it for follow-up rounds of the same work; use another ID for unrelated work. An active ID cannot be delegated again concurrently.
- `task`: a full independent brief; no captain conversation is inherited.
- `verify_baseline`: checks intended to fail before delegation. A passing problem baseline returns `stale`; launch failures/all-timeout baselines return `error`; no worker starts in either case. Omit baselines when no appropriate failure reproduction exists.
- `verify`: independent acceptance commands executed by Wolfpack in the workspace. Supply them whenever possible; omitted checks give `unverified`.
- `fresh`: force a fresh session when the prior direction/context is unsuitable.
- `model`: optional per-run model identifier accepted by the selected worker/provider; overrides worker-specific and global model settings. Do not assume a provider-specific model name works for both workers.

There is no call-level `worker` argument. Routing uses availability, health, prior worker and configured preference. Set `WOLFPACK_WORKER=agy|claude` or JSON `worker` when a fixed preference is needed; an unavailable preference falls back and reports why. Provider settings remain those of the worker CLI, including Claude's own settings.

### `wolf_team`: independent tasks

```json
{
  "tasks": [
    {
      "task_id": "parser-fix",
      "task": "Complete parser-only brief with explicit file ownership",
      "verify": ["npm test -- -t parser"]
    },
    {
      "task_id": "docs-fix",
      "task": "Complete independent docs-only brief with separate file ownership",
      "verify": ["npm run check-docs"]
    }
  ],
  "concurrency": 2
}
```

Accepts one–eight tasks and at most four concurrent executions (default two). Each item uses the delegate fields: `task_id`, `task`, `verify`, `verify_baseline`, `fresh`, `model`. Unknown item keys and duplicate task IDs reject the batch before spawning. Individual execution exceptions are isolated and included in the bounded summary. A team does not create worktrees or resolve conflicting edits; the captain defines independence and file ownership first.

### `wolf_status`: read the ledger

```json
{ "task_id": "fix-parser-bug", "limit": 5 }
```

Read-only: no worker or acceptance command starts. Omit `task_id` for recent tasks. Default limit is five, maximum 100; unfinished tasks are prioritized so long-running work remains visible. Inspect round, last verdict, execution stop reason, cumulative reported tokens and session state. Historical dispatch records can survive host interruption; use live evidence when deciding whether a worker is currently running.

### `wolf_kill`: cancel a task

```json
{ "task_id": "fix-parser-bug" }
```

Stops that task's worker process tree while preserving a shared MCP host. Local cancellation uses an in-process flag; cross-process cancellation uses a separate `.cancel` request matched by `runId`. Finishing delegation observes cancellation and does not replace aborted execution with ordinary success/error salvage. If no worker PID has been published yet, the response gives a retryable reason; already-finished workers are reported honestly. Changes already on disk remain.

### `wolf_live`: one progress snapshot

```json
{ "limit": 8, "transcript": false }
```

Returns separate `agy` and `claude` groups with runs, steps, stall samples, and token totals. Defaults to eight runs; maximum 50. Bounded sampling rotates across groups. `transcript: true` adds sampled session tails for diagnosis; default false avoids filling the captain's context with worker text. Missing session evidence is marked unavailable rather than inferred from another concurrent session.

No worker/model starts and no acceptance runs. The receipt still enters the calling AI's context, so repeated calls can have real context cost.

### `wolf_panel`: continuous local observation

```json
{ "port": 8787 }
```

Starts or reuses the MCP process's read-only HTTP server and returns its actual address. Default panel URL is `http://127.0.0.1:8787/wolfpack/panel`; live JSON is `/wolfpack/live`. It refreshes every three seconds and renders each worker separately with routing reasons, steps, tails, tokens and health. An occupied port automatically falls back to a free one. Set `WOLFPACK_PANEL_TOKEN` to require `?token=` or `x-wolfpack-token` requests.

Use `wolf_live` once when asked “where is it now?” or “is it stuck?”; use the panel when continuous observation is requested. Do not redelegate simply to refresh status, or dump raw worker JSON into the conversation to watch progress. For a long task (roughly 20 minutes or more), one–two status/live checks is a useful default conversation budget; use the panel for ongoing observation and inspect final evidence when finished.

## 5. Routing and worker subagents

Automatic selection does not require asking the user which CLI to use. One installed available worker is selected; with two eligible workers, new tasks rotate within the process. Follow-up rounds favor the previous healthy worker for context reuse. Worker changes necessarily start fresh. Separate CLI invocations do not preserve the rotation cursor.

Both adapters share the baseline, acceptance, verdict and evidence rules. Results report the actual `worker` and `worker_reason`, including rotation, continuation, explicit preference, sole availability, fallback, or all-workers-cooling selection. Explicit available-worker preferences may ignore cooldown and report that fact.

Wolfpack does not add tool-restriction arguments to disable a worker's own subagents. Claude-specific definitions can be passed through `WOLFPACK_CLAUDE_AGENTS` / `claudeAgents`. The captain and workers may use their available subagent capabilities within the authorized task and host constraints.

When a worker delegates independent pieces internally, require that all sub-results be written to designated disk paths and that the worker integrates them. Context-only findings are not delivered artifacts. Acceptance responsibility remains with the captain: a subagent's completion claim is not evidence. Claude-reported `subagent_stats.spawned` can be shown in the digest/ledger; if not reported, do not invent a count.

Use configured worker preference only when there is a concrete reason, rather than treating task-type preferences as universal facts. A capacity failure is not a reason to repeatedly redispatch the same task; wait, address the provider problem, or move on to independent work.

## 6. Cost, continuation, and timeout awareness

Cold starts have worker/provider-dependent overhead. Reusing a task ID and session can preserve acquired context; fixed token or timing measurements from one setup are not universal performance guarantees.

The default continuation threshold is 1,000,000 accumulated reported tokens. At or above it, Wolfpack starts a new session and reports the reason. Explicit round caps and the default missing-usage cap (20 rounds) also constrain reuse. These are context policies, not spending caps. Actual usage is what the worker reports, and missing usage remains missing.

Captain reasoning/tool rounds also have a cost. One delegate operation combines dispatch and independent checks, reducing coordination steps. Avoid frequent large status receipts, repeated capacity retries, or delegating a trivial read-and-judge task.

The worker timeout defaults to unlimited (`taskTimeoutMs: 0`); each baseline/acceptance command defaults to five minutes. An outer client's timeout is separate and can interrupt the host even though the ledger already contains `running`. Choose deadlines appropriate to the task and inspect actual live/ledger evidence afterward.

## 7. Health and stall response

Worker faults include missing output, timeout, capacity/quota exhaustion (including intermediary-pool `402`, `429`, `insufficient_user_quota`, and channel/quota messages), and login/authentication failure. These cool down immediately. Ordinary worker errors cool down after two consecutive failures by default.

| Fault | Default cooldown |
| --- | --- |
| Capacity/quota | 5 minutes |
| Timeout or missing output | 10 minutes |
| Ordinary repeated worker error | 10 minutes |
| Authentication/login | 30 minutes |

Automatic selection skips a cooling worker if another is eligible. When all are cooling, it tries the earliest recovery rather than pretending no work can be attempted. It does not transparently rerun the current failed task on another worker in the same delegation; health influences subsequent selection. Health is not acceptance: completed execution can clear worker health even when a task's checks fail.

Inspect with `node bin/wolf.mjs health --json`; reset with `node bin/wolf.mjs health --reset claude|agy|all` after fixing the cause. Status also reads persisted health. The current universal live/panel entry points omit loaded health configuration from their data sources, so panel health can appear empty/default; use `health` or `wolf_status` for authoritative cooldown state. The default file is `<ledger-directory>/worker-health.json`; missing/corrupt state is treated as empty. Disable with `WOLFPACK_WORKER_HEALTH=off`, or tune the threshold and per-kind durations through the [configuration reference](docs/CONFIGURATION.en.md).

Each worker has its own stall monitor, based on its own session storage: agy at `~/.gemini/antigravity-cli`; Claude Code at `~/.claude/projects/<project>/<session>.jsonl` (not Claude Desktop). Defaults warn at 5/10/15 minutes without progress, then stop. **Warnings never terminate workers.** Long commands or reasoning may legitimately be quiet. On a warning, assess progress and evidence before deciding to cancel; do not blindly launch another copy.

## 8. Close the task with evidence

Read the final verdict, execution stop reason, actual changes, and every acceptance result. Review scope and uncertainties; a `pass` proves only the checks that were registered. If another round is needed for the same goal, supply a full updated brief and reuse the task ID; if changing goals, choose a new ID. Do not redispatch a stale issue, blindly retry a capacity fault, or report unchecked completion as tested success.

When reporting to the user, state what was delivered, what was independently checked, and what remains uncertain. Link useful disk artifacts. Keep worker claims attributed until confirmed. Operational details and runtime contracts are documented in the [architecture](docs/ARCHITECTURE.en.md).
