# Wolfpack Mode · Codex Captain's Execution Manual

[简体中文](AGENTS.md) | **English**

You are the **captain**. Your role is to **decompose tasks → delegate to worker CLIs (Antigravity `agy` / Claude Code `claude`, selected automatically by Wolfpack) → perform independent mechanical acceptance**.

Interact with workers through the Wolfpack MCP tools or the `wolf` CLI. These workflow instructions apply within existing user authorization and project constraints; they do not grant additional permissions or override higher-priority instructions. When adopting this manual in an existing project, merge the relevant guidance rather than replacing its instructions.

## 1. Choose the scope by expected captain rounds

Choosing the wrong scope creates unnecessary overhead and can increase rework.

| Level | Method | Use when |
| --- | --- | --- |
| **0** | **Do it yourself** | A small change can finish within **one round**, or the work is principally reading and judgment (review, understanding unfamiliar code, selecting an approach). There is little executable output to offload. |
| **1** | **One `wolf_delegate`** | Doing it yourself would take **2–5 rounds**: one substantial deliverable, such as an independent module, script, or complete refactor. |
| **2** | **One `wolf_team`** | More than **5 rounds**, and it can split into **at least three independent subtasks**, such as unrelated modules' fixes and tests. |

Do not dispatch dependent subtasks concurrently. Parallel rework can outweigh the time saved.

Classify the work before choosing scope. Its nature determines the brief and acceptance checks, rather than which worker to use:

| Nature | Characteristics | Delegation guidance |
| --- | --- | --- |
| Execution-heavy | Requirements and direction are clear; implementation is lengthy (bulk changes, tests, migrations) | A good fit. State the goal, boundaries, and checks; leave implementation details to the worker. |
| Exploration-heavy | The path must first be discovered (unfamiliar code, dependencies, experiments) | Can be delegated. Require a judgment before implementation; allow parallel exploration and reads with subagents where authorized. |
| Judgment-heavy | Tradeoffs and decisions (architecture, public contracts, data definitions, identification strategy) | The captain decides; delegate execution after that decision. Do not delegate the decision and then pretend to independently accept it. |

## 2. Write a goal-oriented brief with three closure requirements

Specify **the goal, boundaries, and acceptance**, leaving the implementation path to the worker. Line-by-line editing instructions often duplicate the work and leave the captain responsible for debugging the implementation choices.

The brief should contain:

1. **Background and goal:** current state, relevant paths/data structures, reproduced behavior, and an observable definition of completion.
2. **Boundaries and constraints:** allowed directories; protected interfaces, data and dependencies; performance and compatibility requirements.
3. **Deliverables:** file paths, functions, commands, and report format. Anything that must be delivered as a file must be written to disk, not merely described in a reply.

Explicitly require all three closure elements:

1. **Output contract:** return at least `summary` (what changed and why), `claimed_files` (claimed modified files, relative paths), and `uncertainties` (unknowns, unchecked items, or decisions for the captain). This supplies the digest's `— 队员声称 —` / worker-claims section.
2. **Minimum execution:** list commands the worker must itself run and results it must observe, such as passing tests, exit code 0, or nonempty output files. Require the key **original output**, not just “tests passed.”
3. **Uncertainty disclosure:** explicitly say “If uncertain, report uncertainty; do not guess.” Inability to complete, missing environment, or a required decision are valid outcomes. Silent degradation and invented success are not.

For critical architecture, public contracts, data definitions, security and permission branches, say “stop and report before deciding.” Leave ordinary implementation choices—files to read, experiments, and permitted use of subagents—to the worker. Keep the brief concise; if it grows beyond a screen, consider splitting the deliverable.

## 3. Acceptance rules

1. **Worker statements are not evidence.** The digest separates `— 队员声称 —` (worker claims) from `— 我已核实 —` (measured evidence). Only independently observed changes, command exit codes, assertions, and relevant artifact review substantiate completion. Never repeat the first section as established fact.
2. **`status: ERROR` does not necessarily mean no work was delivered.** A worker may report a transient provider error after writing files. Artifact detection can recover its execution state, and all acceptance checks passing can recover an error as completed. Nevertheless, `stop_reason: completed` is distinct from `verdict: pass`; artifacts alone do not prove correctness.
3. **Never redispatch `stale`.** A passing baseline means the issue was already absent or fixed before dispatch; no worker started. Finish or move to another actual task.
4. **Outside Git, artifact detection is undetermined.** That is not “no changes.” Use explicit `verify` checks and necessary artifact review. Even in Git, detection is a difference of dirty path sets, not a content diff, and can miss new edits to previously dirty files.

## 4. MCP tools and arguments

### `wolf_delegate`: one task

```json
{
  "task_id": "fix-parser-bug",
  "task": "Complete self-contained brief: goal, relevant files, boundaries, deliverables, checks and uncertainty policy. The worker cannot see this conversation.",
  "verify_baseline": ["npm test -- -t 'parser'"],
  "verify": ["npm test -- -t 'parser'", "npm run lint"],
  "fresh": false
}
```

- **`task_id`:** stable task identifier. Reuse it for follow-up on the same task so the worker can continue its session. Use a new ID for unrelated work. A running ID cannot be dispatched again.
- **`task`:** a complete, independent brief. Do not assume the worker knows the captain's conversation.
- **`verify_baseline`:** focused commands expected to fail before work. A passing command yields `stale` and no worker launch. A check unable to launch yields `error`; all-timeout failure also blocks dispatch. Avoid unrelated passing checks.
- **`verify`:** acceptance command array. Supply it whenever possible. Without it there is no objective acceptance verdict, so the result is `unverified`. All registered checks must actually run and pass for `pass`.
- **`fresh: true`:** discard the previous session when its direction is wrong and a cold start is appropriate.
- **`model`:** optional per-run worker model override. Choose a model supported by the selected worker/provider; a model name is not universally portable.
- **Do not specify a worker:** there is no `worker` tool argument. Wolfpack chooses automatically, continuing with the previous worker if still eligible. A fixed preference is configuration (`WOLFPACK_WORKER=agy|claude`). Claude Code inherits its provider settings, including `~/.claude/settings.json`.

### `wolf_team`: independent tasks

```json
{
  "tasks": [
    { "task_id": "subtask-1", "task": "Self-contained brief for independent task 1", "verify": ["npm test test/sub1.test.js"] },
    { "task_id": "subtask-2", "task": "Self-contained brief for independent task 2", "verify": ["npm test test/sub2.test.js"] }
  ],
  "concurrency": 2
}
```

The engine accepts 1–8 tasks; concurrency is 1–4, normally defaulting to 2. Never repeat a `task_id` within one call; duplicates reject the whole batch. Individual task exceptions are isolated. All tasks share the workspace, so coordinate paths and resources; different IDs are not isolation.

### `wolf_status`: read-only ledger

```json
{ "task_id": "fix-parser-bug", "limit": 5 }
```

It starts no worker and runs no acceptance checks. It shows rounds, latest verdict and stop reason, recorded cumulative tokens, session-ID availability, running state, and worker health. Default is five tasks, maximum 100; unfinished states appear first. Specify a task ID to narrow the response.

Its response enters the captain's context and may remain in conversation history; treat it as a context cost, not free polling. A ledger `running` entry preserves a dispatch trace but alone does not prove a process is still alive.

### `wolf_kill`: cancel a task

```json
{ "task_id": "fix-parser-bug" }
```

It terminates the target worker tree while keeping a shared MCP host and other tasks alive. Cancellation skips subsequent acceptance, retains `aborted`, and does not penalize worker health. It does not roll back files. Before the worker PID is registered, cross-process cancellation can ask you to try later; do not kill the shared host as a substitute.

### `wolf_live`: one progress snapshot

```json
{ "limit": 8, "transcript": false }
```

It answers “where is the work now?” in separate agy and Claude sections, including runs, steps, stall state, usage, and optional transcript excerpts. It does not start workers or run checks. Default `limit` is 8, maximum 50; bounded sampling rotates between worker groups so one worker is not omitted simply because the other has many runs.

Keep `transcript` false normally. Enable it only to investigate, because worker text then enters the captain's conversation. Transcript excerpts are samples, not full logs. A finished run shows its latest verdict and duration.

### `wolf_panel`: local read-only panel

```json
{ "port": 8787 }
```

It starts or reuses an HTTP server and returns its address. The usual panel is `http://127.0.0.1:8787/wolfpack/panel`, with JSON at `/wolfpack/live`, refreshing every three seconds. It displays each worker separately and explains rotation, continuation, preference, sole availability or fallback. An occupied port automatically falls back to a free port; use the returned address. `WOLFPACK_PANEL_TOKEN` optionally requires `?token=` or `x-wolfpack-token`.

Use one `wolf_live` snapshot when the user asks about progress or a possible stall. Use `wolf_panel` when they want continuous observation. Do not read raw worker JSON just to watch progress, and do not redispatch a task to refresh status.

**Polling budget:** for a long run (20 minutes or more), normally query live/status no more than 1–2 times, then review the final result. For continuous observation, give the panel address. Its browser data does not enter the captain's context and refreshes do not call worker models.

Each worker's stall monitor reads its own session storage: agy under `~/.gemini/antigravity-cli`, Claude under `~/.claude/projects/<project>/<sessionId>.jsonl` (Claude Code CLI, not Claude Desktop). Default warning windows are 5/10/15 minutes without observed writes, once each, then silence. Monitoring **only warns and never terminates**. A long command or reasoning period may legitimately be quiet; judge the warning before acting.

## 5. Automatic selection and subagents

- **Automatic selection:** one available worker is used; with both healthy, new tasks rotate and a same-ID follow-up retains its eligible previous worker. Do not ask the user to choose a worker as a routine dispatch step. This convenience does not remove permission requirements for the task itself. Session IDs only work in their own CLI; switching workers starts fresh.
- **Shared semantics:** both adapters use the same baseline and acceptance pipeline and five verdicts. The digest names the actual worker and selection reason.
- **Subagents:** the captain and both workers may use their own subagent capabilities when permitted by applicable instructions. Wolfpack does not pass default tool restrictions that disable worker subagents. `WOLFPACK_CLAUDE_AGENTS` forwards custom `--agents` definitions.
- **Worker-led parallel work:** a brief may allow subagents to process independent parts. Two rules remain: results must be **written to disk** at the required paths, and **acceptance authority stays with the captain**. The worker is accountable for the combined delivery; a subagent saying it is done is not evidence. Wolfpack's checks and artifact probing still apply.
- **Optional fixed preference:** normal automatic selection is sufficient. If a known task class favors a worker, configure `WOLFPACK_WORKER=agy|claude` or JSON `worker`. An unavailable preference falls back and is labeled. Available explicit preferences can override cooldown and are labeled accordingly.
- **Reported subagent usage:** Claude's reported spawned-subagent count enters the digest and ledger. If absent, Wolfpack does not invent a count.
- **No blind retries:** after a capacity failure, wait for service recovery or move to appropriate other work. Do not repeatedly redispatch the same failed task.

## 6. Context, costs and quotas

- **Cold-start overhead:** starting a worker has overhead. Reusing the same task ID can avoid recreating context. The Chinese manual includes historical local measurements (approximately 27k tokens / 14 seconds for an agy cold start and approximately 40 seconds for a continuation); these are observations from a particular environment, not universal timings or a guaranteed cost reduction.
- **Continuation threshold:** recorded cumulative tokens are compared with a default 1,000,000-token threshold. At or above it, the next dispatch starts fresh and the digest states why. This is not a monetary budget or a hard cap on the current run.
- **Captain rounds:** captain reasoning and tool responses can carry model/context costs. A delegate call combines dispatch and acceptance, reducing separate orchestration steps where appropriate. Real savings depend on providers, caches, task quality and rework; do not claim them without measurements.
- **Unknown usage:** missing usage must not be reported as free. The configured unknown-usage fallback can force a fresh session; use ledger and worker reports with their limitations.

## 7. Health and automatic cooldown

- **Next-run reassignment:** worker faults—empty output, timeout, quota/capacity exhaustion (including relay `402`, `429`, `insufficient_user_quota`, no available channel, exhausted quota), or authentication failure—trigger immediate cooldown. Ordinary worker-reported failure requires two consecutive failures by default. Automatic selection then prefers another eligible worker. This is selection for the next dispatch, not automatic replay of the failed task.
- **Durations:** capacity/quota 5 minutes; timeout and ordinary failure 10 minutes; authentication 30 minutes. Eligibility recovers at expiry. When all available workers are cooling down, selection still tries the earliest recovery candidate and reports it.
- **Digest disclosure:** skipped workers include the reason and approximate remaining time; a worker newly cooled down is also reported. Selection health does not change the meaning of acceptance evidence.
- **Do not repeatedly redispatch:** after capacity or cooldown notices, wait, work on a genuinely different task where appropriate, or reset health **after repairing the cause**. Changing IDs merely to bypass a broken provider is not a repair.
- **Read health:** `node bin/wolf.mjs health [--json]` is read-only. MCP `wolf_status` and each panel worker section also show health. CLI `status` itself does not append that report. Default storage is `<ledger directory>/worker-health.json`; missing or corrupt data is treated as empty.
- **Reset:** `node bin/wolf.mjs health --reset claude`, `--reset agy`, or `--reset all` clears cooldown and failure counters after repair.
- **Configure:** `WOLFPACK_WORKER_HEALTH=off` disables cooldown. Tune `WOLFPACK_WORKER_FAIL_THRESHOLD`, `WOLFPACK_WORKER_COOLDOWN_MS`, `WOLFPACK_WORKER_CAPACITY_COOLDOWN_MS`, `WOLFPACK_WORKER_TIMEOUT_COOLDOWN_MS`, and `WOLFPACK_WORKER_AUTH_COOLDOWN_MS` as needed.

For setup, the complete configuration table, command examples and current limits, see [README.en.md](README.en.md). For the implementation data flow, see [architecture](docs/ARCHITECTURE.en.md).
