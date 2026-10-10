# Wolfpack for Codex

[简体中文](README.md) | **English**

Wolfpack connects Codex to local worker CLIs: Antigravity CLI (`agy`) and Claude Code CLI (`claude`). Codex leads the work: it defines the task, constraints, and acceptance checks, delegates implementation, and reviews evidence. The worker reads and edits files in its own session. Wolfpack runs the baseline and acceptance commands, records the run, and returns a bounded digest.

This edition is for the Codex captain workflow. It uses native Node.js modules and has no third-party runtime dependencies. It works through six local stdio MCP tools or the CLI.

## Choose an edition

The three editions share a design, but maintain separate implementations.

| Edition | Integration | Best fit |
| --- | --- | --- |
| [Codex](README.en.md) | Six MCP tools, CLI, captain instructions in [AGENTS.en.md](AGENTS.en.md), standalone HTTP panel | Development already organized in Codex |
| [DSH](../dsh/README.en.md) | Native plugin switch, worker checkboxes, tool cards and sidebar panel; four tools | The complete DSH host experience |
| [Universal](../universal/README.en.md) | Six MCP tools, CLI, standalone HTTP panel | Other MCP clients and scripts |

The Codex edition has no DSH native buttons. Configure worker paths and preferences through environment variables or JSON. Worker authentication and providers belong to the worker CLIs; Wolfpack does not require changing the Codex host provider. Unlike the snapshot fallback in other editions, this edition reports artifact detection as undetermined outside Git.

## The captain workflow

The captain is responsible for decisions and acceptance; the worker is responsible for implementation. A worker does **not** receive the captain's conversation. Every delegated task must contain the background it needs.

1. Clarify the goal and define observable completion.
2. Keep small changes and decisions with the captain. Delegate a substantial, self-contained deliverable; use a team only for independent tasks.
3. Write a goal-oriented task brief with boundaries, disk deliverables, required worker checks, and an uncertainty policy.
4. Supply independent acceptance commands through `verify`; add a focused `verify_baseline` when checking whether a known failure still exists.
5. Review the digest's worker claims separately from measured evidence. Inspect relevant artifacts and resolve uncertainties before reporting completion.

The [captain manual](AGENTS.en.md) describes the full process. Merge relevant instructions into an existing project as appropriate; do not replace its instructions or override higher-priority user constraints.

### Pick the right scope

| Scope | Method | Guidance |
| --- | --- | --- |
| Small change or reading/judgment | Captain does it | Expected to finish in one round, or the output is principally a decision |
| One substantial deliverable | `wolf_delegate` | Roughly 2–5 captain rounds if done directly |
| Several independent deliverables | `wolf_team` | Larger work that can split into at least three independent parts |

These are planning heuristics, not engine restrictions. The engine accepts 1–8 team tasks with concurrency 1–4, default 2. Tasks with dependencies must run in sequence. Concurrent tasks share the same workspace; coordinate file ownership and shared resources yourself.

### Context and cost design

Delegation can keep repository exploration, commands, and long worker conversations out of the captain's context. One call combines dispatch, execution, and acceptance. Reusing a stable task ID can preserve the worker session instead of restarting it.

This is a context-management design, **not a guaranteed saving**. Actual costs depend on each provider, model, cache behavior, task size, and rework. Cold starts have overhead, and poorly defined tasks can be more expensive to delegate. Use actual worker usage reports when available; missing usage is not zero usage. The continuation token threshold controls session reuse, not spending or a hard per-run token cap.

`wolf_status` and `wolf_live` do not call a worker model, but their responses enter the captain's context. Repeated polling can grow that context. Use the browser panel for continuous observation: its refreshes read local data without worker model calls and do not inject transcript data into the captain's conversation. For a long run, the captain manual recommends only 1–2 status snapshots unless investigation requires more.

## Install and connect

### Requirements

- Node.js 20 or later.
- At least one installed and configured worker CLI. Check `agy --help` or `claude --version`; executable discovery alone does not establish authentication, quota, or service health.
- A client capable of launching a local stdio MCP server if using MCP. A web chat interface alone does not provide that capability.

```sh
git clone https://github.com/Cofran-77/wolfpack.git
cd wolfpack/codex
node --version
node tests/run.mjs
node bin/wolf.mjs status --json
node bin/wolf.mjs health --json
```

If the repository requires access, authenticate with GitHub before cloning. There is no required `npm install`. The test suite uses fake workers and does not consume real worker quota. A successful empty `status` response checks local records, not the ability to execute a real worker task.

### Register with Codex

Add a server entry to your Codex MCP configuration, typically `~/.codex/config.toml`. Replace all placeholder paths with real absolute paths:

```toml
[mcp_servers.wolfpack]
command = "node"
args = ["/absolute/path/to/wolfpack/codex/bin/wolf-mcp.mjs"]
env = { WOLFPACK_AGY = "/absolute/path/to/agy", WOLFPACK_CLAUDE = "/absolute/path/to/claude" }
```

Windows paths can use forward slashes. Set an absolute Node.js path in `command` if the client cannot find `node`. A worker path that is not set still uses PATH discovery; setting one path does not disable the other worker. An explicit absolute worker path is checked for existence rather than replaced by a PATH search.

Alternatively, register using the Codex CLI (the line continuations below use POSIX shell syntax; on PowerShell use one line):

```sh
codex mcp add wolfpack --env "WOLFPACK_AGY=/absolute/path/to/agy" --env "WOLFPACK_CLAUDE=/absolute/path/to/claude" -- node "/absolute/path/to/wolfpack/codex/bin/wolf-mcp.mjs"
```

Reload the client or start a new session, then call `wolf_status` to check discovery. If a configuration manager such as CC Switch rewrites `config.toml`, add Wolfpack to that manager's MCP list for Codex. After switching providers, check that the server entry still exists and restart the client. Claude Code inherits its own settings, including provider configuration in `~/.claude/settings.json`; switching that provider does not require changing Wolfpack.

### Working directory and permissions

Worker execution, baseline checks, and acceptance commands all run in the **service process's working directory**. The tools do not accept a per-task `cwd`. For CLI use, start from the target project and invoke Wolfpack by absolute path. For MCP use, verify how your client sets the server's working directory.

Both adapters bypass worker permission prompts by default using `--dangerously-skip-permissions`. Claude can instead receive `--permission-mode` through `WOLFPACK_CLAUDE_PERMISSION_MODE`, for example `plan` or `acceptEdits`. Wolfpack adds no sandbox, directory isolation, or Git worktree. Use it within the workspace and permissions authorized for the task. Configuration does not grant new permission to modify files or run commands.

## Six MCP tools

| Tool | Purpose | Arguments |
| --- | --- | --- |
| `wolf_delegate` | Execute one task and independently check it | Required `task_id`, `task`; optional `verify`, `verify_baseline`, `fresh`, `model` |
| `wolf_team` | Execute independent tasks with bounded concurrency | Required `tasks` array (1–8); optional `concurrency` (1–4, default 2) |
| `wolf_status` | Read task history and worker health | Optional `task_id`, `limit` (default 5, maximum 100) |
| `wolf_kill` | Cancel the worker process tree for a task | Required `task_id` |
| `wolf_live` | Read current progress, grouped by worker | Optional `limit` (default 8, maximum 50), `transcript` (default false) |
| `wolf_panel` | Start or reuse a local read-only HTTP panel | Optional `port` (default 8787) |

There are no MCP Resources, Prompts, or subscriptions. Health reset is a CLI operation, not a seventh MCP tool. Status and live are observation tools: they neither dispatch a worker nor run acceptance commands.

## Delegate a task

```json
{
  "task_id": "fix-parser-empty-input",
  "task": "Fix the parser's empty-input behavior in the current project and add a regression test. Keep public interfaces unchanged; edit only src/parser and its tests. Write deliverables to disk. Run the relevant tests and report the command, exit code, and key original output. Return summary, claimed_files (relative paths), and uncertainties. If an interface or permission decision is required, stop and report it; do not guess or claim unverified success.",
  "verify": ["npm test"]
}
```

Replace `npm test` with the target project's actual check. The task brief should include:

- Background and a completion definition that can be evaluated.
- Allowed paths, protected interfaces/data/dependencies, compatibility and performance constraints.
- Deliverable paths and a fixed response contract: `summary`, `claimed_files`, `uncertainties`.
- Minimum commands the worker must run, expected results, and key original output.
- An explicit instruction to report uncertainty, missing environment, or decisions that require the captain.

Give the goal and boundaries while leaving implementation choices to the worker. Keep critical architecture, public contract, data interpretation, security, and permission decisions with the captain. Worker checks do not replace Wolfpack's independent `verify` checks.

CLI equivalent, run from the target project:

```sh
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" delegate --task-id fix-parser-empty-input --task "Fix empty-input handling, add a regression test, preserve public interfaces, and report files, checks and uncertainties" --verify "npm test" --json
```

Repeat `--verify` to register multiple commands. A returned CLI result can contain `fail` or `error` while the CLI exits normally: scripts must inspect the JSON `verdict`, rather than relying solely on the process exit code.

### Baseline gate

Use `verify_baseline` / repeatable `--verify-baseline` only for focused checks expected to fail while the issue exists. A passing baseline yields `stale`, records a skipped run, and launches no worker. Do not redelegate a stale task. A command that cannot launch yields `error`; if all nonpassing baseline checks time out with no ordinary failure, the gate also reports `error`. An ordinary failed check can allow dispatch even if another check timed out, so read all baseline results.

Do not put unrelated passing lint or build checks in the baseline array: any passing check can skip the task. Worker selection is resolved before the baseline gate, but this does not mean a worker was launched.

### Worker selection

Tool calls do not have a `worker` argument. In `auto` mode, Wolfpack uses the available worker; with both healthy, it keeps the previous worker for the same task or rotates for new work. Selection and its reason are reported honestly. Switching workers starts a new session because agy and Claude session IDs are not interchangeable.

Set `WOLFPACK_WORKER=agy` or `claude`, or JSON `worker`, to prefer a fixed worker. If unavailable, selection falls back to the other installed worker. An explicit preference overrides cooldown when that worker is available, and the digest marks the override. Rotation is held in process memory: a persistent MCP service rotates across calls, while a fresh CLI process starts from agy when both are available and no history or preference selects another worker.

### Continue or start fresh

Use the **same `task_id`** for follow-up on the same task, and a new ID for unrelated work. The ledger holds the previous worker and session ID; agy continues with `--conversation`, Claude with `--resume`. A currently running ID is rejected rather than queued.

`fresh: true` / `--fresh` discards the previous session for that run. Automatic cold starts also occur when continuation is disabled, the configured round limit is reached, recorded cumulative tokens reach the continuation threshold (default 1,000,000), the missing-usage fallback cap is reached (default 20), or the selected worker changes. Fresh-start reasons appear in the digest. These policies start another session; they do not impose a spending ceiling or stop a task midway through a run.

## Run a team

Save an array as `tasks.json`:

```json
[
  { "task_id": "parser-tests", "task": "Add parser regression tests; edit only parser tests; report files, checks and uncertainties", "verify": ["npm test -- parser"] },
  { "task_id": "cli-docs", "task": "Update CLI usage documentation; edit only docs/cli.md; report files and uncertainties", "verify": ["npm run check:docs"] }
]
```

```sh
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" team --tasks tasks.json --concurrency 2 --json
```

For MCP use `{ "tasks": [...], "concurrency": 2 }`. Task entries accept the same fields as `wolf_delegate`. Duplicate IDs reject the whole batch. Individual task exceptions are isolated so they do not collapse the batch. Tasks still share files and resources; independence is the caller's responsibility. `--tasks -` reads the array from stdin.

## Observe and cancel

```sh
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" status --json
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" status --task-id fix-parser-empty-input --json
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" live --limit 8
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" live --json
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" panel --port 8787
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" kill --task-id fix-parser-empty-input
```

MCP `wolf_status` defaults to five tasks and includes health. CLI `status` defaults to twenty and does not append the health report; use CLI `health` separately. Both put unfinished ledger states first. A `running` ledger entry is written at dispatch so interrupted work leaves a trace, but a surviving entry alone is not proof that a worker is still alive.

`wolf_live` defaults to no transcript. CLI text `live` includes transcript excerpts for a human reader. The live views show agy and Claude separately, including routing, runs, steps, session excerpts, stall samples, and token totals. Excerpts are bounded samples, not complete logs. Use one live snapshot for a progress question; use the panel for continuous observation.

### Local panel

| Route | Content |
| --- | --- |
| `/wolfpack/panel` | Read-only HTML panel, no build step |
| `/wolfpack/live` | Bounded live JSON, maximum 32 KB |
| `/wolfpack/health` | HTTP service health check, not a worker execution test |

The default address is `http://127.0.0.1:8787/wolfpack/panel`. An occupied port falls back to a free port; use the address actually returned. Repeated MCP `wolf_panel` calls reuse the same server, which ends with the MCP process. CLI `panel` stays running until Ctrl+C. Default refresh is three seconds. Optional `WOLFPACK_PANEL_TOKEN` requires `?token=` or an `x-wolfpack-token` request header. CLI also supports `--host` and `--token`.

### Stall warnings

Each worker has its own session-file monitor. agy uses `~/.gemini/antigravity-cli`, including conversation databases and brain transcript logs. Claude uses `~/.claude/projects/<project>/<sessionId>.jsonl` from **Claude Code CLI**, not Claude Desktop. Default sampling is every 30 seconds, with one warning at each 5/10/15-minute window without observed writes; after three warnings it stays quiet.

Warnings go to the console and `<ledger directory>/stall.ndjson`. Desktop notifications are opt-in. Stall monitoring **only warns and never terminates** a process. A long command or thinking period can look idle; a warning is not proof of failure. Missing reliable session information is displayed as unavailable rather than invented progress.

### Cancellation

Cancellation targets the worker process tree and preserves the shared MCP service and other task runs. In-process cancellation sets a flag; cross-process cancellation uses the live record's `workerPid` and writes a run-scoped cancellation marker. The dispatch owner reads that marker after worker exit, skips subsequent acceptance checks, and retains `stop_reason: aborted`; caller cancellation does not penalize worker health. With skipped checks, the final acceptance verdict is `unverified`, not a fabricated pass.

If the worker PID has not yet been registered, cancellation reports that you should try later and keeps the host alive. If the worker has already exited and the host is finishing, it reports that state. Cancellation is not rollback: files already written remain on disk. Do not redispatch merely to refresh progress.

## Worker health and cooldown

Executable discovery does not detect a CLI that is installed but unauthenticated, out of quota, or stuck. Health records let automatic selection avoid a worker after a recognized fault.

| Fault | Default behavior |
| --- | --- |
| No output or timeout | Immediate cooldown; timeout uses 10 minutes |
| Quota/capacity failure, including relay-pool `402`, `429`, `insufficient_user_quota`, no available channel, exhausted quota | Immediate 5-minute cooldown |
| Authentication failure / not logged in, such as `401` or invalid API key | Immediate 30-minute cooldown |
| Ordinary worker-reported failure | Cooldown after 2 consecutive failures, for 10 minutes |

Cooldown expiry restores eligibility automatically. If every available worker is cooling down, selection still tries the one due to recover first and says so. A fixed preference can ignore cooldown; health affects selection, not acceptance semantics. Wolfpack does not automatically rerun the failed task or switch workers midway through it. Avoid repeatedly redispatching the same failed task.

```sh
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" health --json
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" health --reset claude
node "/absolute/path/to/wolfpack/codex/bin/wolf.mjs" health --reset all
```

Reset after repairing the cause, such as logging in or fixing provider configuration. The default file is `<ledger directory>/worker-health.json`; missing or corrupt health data is treated as empty and does not block dispatch. `WOLFPACK_WORKER_HEALTH=off` disables this mechanism. MCP status and panel sections also expose health.

## Acceptance and evidence

The digest separates `— 队员声称 —` (worker claims) from `— 我已核实 —` (measured evidence). Current output labels may remain Chinese even when using this English manual. Treat the worker's report as a claim; use checks and relevant artifact inspection to substantiate conclusions.

| Final `verdict` | Meaning |
| --- | --- |
| `pass` | Every registered acceptance command actually ran and passed |
| `fail` | Commands ran, but at least one check failed |
| `error` | A check could not launch or a baseline/environment error prevented reliable execution |
| `unverified` | No acceptance checks were supplied or they were skipped by cancellation |
| `stale` | Baseline already passed, so no worker was dispatched |

`stop_reason` and `verdict` are separate dimensions. Detected artifacts can salvage a worker-reported error as `completed`; all acceptance checks passing can also salvage an error. **`completed` does not imply `pass`, and `pass` proves only the checks you supplied.** A file existing or a dirty path appearing does not prove its contents are correct.

Artifact detection uses `git status --porcelain` before and after execution, returning paths newly present in the after set. It is a **path-set difference**, not a content diff: it can miss edits to paths already dirty at dispatch, files committed or cleaned during execution, and changes hidden inside already-reported directories. Concurrent workspace edits can also be attributed incorrectly. Outside Git, detection is undetermined, not “no changes.” Claimed paths outside the probed workspace also make detection undetermined; checking claims is not a sandbox. Always use targeted acceptance and review where these limits matter.

## Configuration reference

Start with [wolfpack.config.example.json](wolfpack.config.example.json). Wolfpack searches upward from the working directory for `wolfpack.config.json`, or uses `WOLFPACK_CONFIG_FILE`. For normal CLI/MCP configuration, environment values take precedence over JSON, then defaults. Model selection is task `model`, then Claude-specific model when applicable, then global model. Keep local configuration, credentials, raw responses and run records out of version control.

| JSON field | Environment variable | Default / meaning |
| --- | --- | --- |
| — | `WOLFPACK_CONFIG_FILE` | Explicit configuration file path |
| `agyPath` (legacy `workerPath`) | `WOLFPACK_AGY` | `agy`; Windows `agy.exe` |
| `claudePath` | `WOLFPACK_CLAUDE` | `claude`; Windows `claude.exe` |
| `worker` | `WOLFPACK_WORKER` | `auto`; also `agy` or `claude` |
| `claudeModel` | `WOLFPACK_CLAUDE_MODEL` | Unset; overrides global model for Claude |
| `claudePermissionMode` | `WOLFPACK_CLAUDE_PERMISSION_MODE` | Unset: bypass prompts; otherwise passes `--permission-mode` |
| `claudeAgents` | `WOLFPACK_CLAUDE_AGENTS` | Unset; passes custom `--agents` JSON |
| `mode` | `WOLFPACK_MODE` | `accept-edits`, for agy |
| `model` | `WOLFPACK_MODEL` | Unset; worker default |
| `effort` | `WOLFPACK_EFFORT` | Unset; agy reasoning effort |
| `ledgerPath` | `WOLFPACK_LEDGER` | `~/.wolfpack/runs.ndjson` |
| `rawDir` | `WOLFPACK_RAW_DIR` | `~/.wolfpack/raw` |
| `taskTimeoutMs` | `WOLFPACK_TASK_TIMEOUT` | `0`: no Wolfpack worker timeout |
| `verifyTimeoutMs` | `WOLFPACK_VERIFY_TIMEOUT` | `300000` ms per baseline/acceptance command |
| `continuation` | `WOLFPACK_CONTINUATION` | Default continuation; `never` disables it |
| `continuationTokenBudget` | `WOLFPACK_TOKEN_BUDGET` | `1000000`; cumulative recorded usage threshold for a new session |
| `maxRoundsPerTask` | `WOLFPACK_MAX_ROUNDS` | Unset; optional continuation round limit |
| `unknownUsageRoundCap` | `WOLFPACK_UNKNOWN_USAGE_CAP` | `20`; missing-usage fallback |
| `shell` | `WOLFPACK_SHELL` | Platform shell; override must include command-execution arguments |
| `concurrency` | `WOLFPACK_CONCURRENCY` | Parsed by configuration, but current entry points do not apply it to team scheduling; explicitly pass tool `concurrency` / CLI `--concurrency` (default 2) |
| `maxEntries` | `WOLFPACK_LEDGER_MAX_ENTRIES` | `5000`, ledger compaction threshold |
| `maxBytes` | `WOLFPACK_LEDGER_MAX_BYTES` | `10485760`, ledger compaction threshold |
| `keepRounds` | `WOLFPACK_LEDGER_KEEP_ROUNDS` | `10`, retained recent entries per task during compaction |
| `stall.windowSeconds` / `stall.windowSecondsByWorker` | `WOLFPACK_STALL_WINDOW`, `_AGY` / `_CLAUDE` suffixes | `300` seconds; `0` / `off` disables monitoring |
| `stall.warnings` / `stall.warningsByWorker` | `WOLFPACK_STALL_WARNINGS`, `_AGY` / `_CLAUDE` suffixes | `3`; `0` samples without warnings |
| `stall.pollSeconds` | `WOLFPACK_STALL_POLL` | `30` seconds, minimum 5 |
| `stall.toast` | `WOLFPACK_STALL_TOAST` | `false`; opt-in notification (Node notifier supports macOS) |
| `stallLogPath` | `WOLFPACK_STALL_LOG` | `<ledger directory>/stall.ndjson` |
| `stall.storeRoots` (legacy `stallStoreRoots`) | `WOLFPACK_AGY_STORE_ROOT` / `WOLFPACK_CLAUDE_STORE_ROOT` | Worker session storage roots described above |
| `workerHealth.enabled` | `WOLFPACK_WORKER_HEALTH` | `true`; `off` disables cooldown |
| `workerHealth.filePath` | `WOLFPACK_HEALTH_FILE` | `<ledger directory>/worker-health.json` |
| `workerHealth.failThreshold` | `WOLFPACK_WORKER_FAIL_THRESHOLD` | `2`, ordinary consecutive failures |
| `workerHealth.cooldownMs` | `WOLFPACK_WORKER_COOLDOWN_MS` | `600000`, ordinary failure / empty-output cooldown |
| `workerHealth.capacityCooldownMs` | `WOLFPACK_WORKER_CAPACITY_COOLDOWN_MS` | `300000` |
| `workerHealth.timeoutCooldownMs` | `WOLFPACK_WORKER_TIMEOUT_COOLDOWN_MS` | `600000` |
| `workerHealth.authCooldownMs` | `WOLFPACK_WORKER_AUTH_COOLDOWN_MS` | `1800000` |
| `panelPort` | `WOLFPACK_PANEL_PORT` | `8787`, fallback to a free port |
| `panelHost` | `WOLFPACK_PANEL_HOST` | `127.0.0.1` |
| `panelToken` | `WOLFPACK_PANEL_TOKEN` | Unset; optional request token |
| `panelRefreshMs` | `WOLFPACK_PANEL_REFRESH` | `3000` ms, minimum 500 |

Timeouts accept `0`, `off`, or `none` to remove the limit. Token/round policy fields also support disabling values where implemented. A zero Wolfpack task timeout does not override the worker CLI's own timeout or the calling client's deadline; agy still receives a long print timeout.

On Windows, verification chooses `pwsh` from PATH, then system Windows PowerShell. On POSIX it chooses `bash`, then `sh`. For a custom shell with spaces, quote its path and include its execution flags, or use a JSON argv array for `shell`.

## Boundaries and troubleshooting

- Same-ID exclusivity is synchronous within one process. Cross-process checks use live files and process-liveness probing; they are **not an atomic file lock**, so simultaneous starts have a race window. Ledger writes are serialized per instance, not coordinated as a cross-process transaction.
- Multiple tasks can run in one persistent MCP process. Killing a task must target its worker, not that shared host. Different IDs do not isolate file edits.
- Authentication, network settings, quota and provider availability remain the worker's responsibility. Cooldown does not repair the provider.
- In a first Claude run without a session ID, transcript lookup falls back to the latest session in the project directory. agy only uses a latest-brain fallback when exactly one agy run is active; with several, it reports the missing ID to avoid mixing sessions. These are progress hints, not authoritative task evidence.
- Windows defaults Claude discovery to `claude.exe`. If your npm installation exposes `claude.cmd`, set `WOLFPACK_CLAUDE` to the actual launcher. A missing executable or shell should be repaired before redispatching.
- If tools disappear after a provider switch, check MCP registration and start a new client session. If checks cannot run, read their diagnostics, confirm the working directory, and configure an available shell.

## Development and further reading

```sh
node tests/run.mjs
```

The offline suite covers baselines, verdicts, continuation, concurrency, cancellation, artifacts, health, live views and MCP discovery with fake executors. Windows and POSIX concurrency tests use separate process-exit expectations, selected by the runner; keep paired cases consistent when editing. On macOS/Linux, `node` must be on PATH for subprocess tests.

| Location | Responsibility |
| --- | --- |
| `bin/wolf.mjs`, `bin/wolf-mcp.mjs` | CLI and MCP entry points |
| `src/delegate.mjs`, `src/team.mjs` | Dispatch and bounded team scheduling |
| `src/worker/` | Worker adapters, selection, fault classification, health |
| `src/runtime/` | Injected runtime registry and host implementations |
| `src/verify.mjs`, `src/ledger.mjs`, `src/digest.mjs` | Independent checks, persistent records, bounded reporting |
| `src/live*.mjs`, `src/stall.mjs`, `src/panel-*` | Observation side path and panel |
| `tests/` | Offline tests and fake workers |

See [architecture](docs/ARCHITECTURE.en.md), [design background](docs/DESIGN.md), and the [captain manual](AGENTS.en.md). [Historical documentation](../docs/history/README-CODEX-ORIGINAL.md) preserves the earlier introduction; current commands and limits in this manual take precedence over historical descriptions.
