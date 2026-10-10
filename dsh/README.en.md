# Wolfpack for DSH

[中文](README.md) · [Architecture](docs/ARCHITECTURE.en.md) · [Worker contracts](docs/WORKERS.en.md)

## The recommended native plugin edition

DSH is the repository's recommended host for Wolfpack's native interaction. Its Cordis plugin system brings tools, configuration, dynamic system instructions, managed subprocesses, and client UI together. This edition puts a mode switch and worker dropdown beside the conversation input, exposes four delegation tools, renders status/kill cards, and offers a live panel in the host sidebar.

Install **this `dsh/` directory**, not the repository root. The package keeps the name `wolfpack-unified` for existing Cordis patch compatibility. The universal edition uses the same package name but has its own implementation and host entry points; the directories are not interchangeable.

| Edition | Intended use | Integration |
|---|---|---|
| **DSH, this directory** | Native plugin interaction | Four tools, Cordis Config and systemPrompt, managed subprocesses, worker dropdown, host HTTP route and sidebar |
| [Codex](../codex/README.en.md) | Codex as captain | AGENTS.md workflow, six tools, separate panel implementation |
| [Universal](../universal/README.en.md) | Other local MCP clients, CLI, or programmatic callers | Six tools, standalone panel, no DSH peer requirements |

These editions share design ideas and maintain separate code. Features or fixes in another edition are not automatically present here. In particular, DSH still has acceptance, cross-process cancellation, and transcript-monitoring limits described below.

Wolfpack delegates a self-contained task to a local worker CLI, runs acceptance commands independently, and separates **“the worker claims”** from **“I verified”** in a bounded digest. A worker's report is useful context; it is not acceptance evidence.

## 1. Start with the native UI

Requirements are Node.js **20 or newer**, a compatible DSH host (the client integration targets DSH **0.2.0+**), and at least one locally installed, configured, authenticated worker CLI. The plugin does not install workers or supply their credentials or subscriptions.

From a terminal with the DSH launcher available:

```powershell
dsh plugin --profile <profile> add <absolute-path-to-repository>/dsh
```

The package declares `dsh.bundle.patch` and `dsh.client`. Its `cordis.patch.yml` inserts `{ id: wolfpack, name: wolfpack-unified }` into the profile composition. Local-directory installation is recorded as a `link:`; restart the host after changing host-side source.

1. Fully exit and reopen DSH after installation.
2. Turn on the Wolfpack capsule beside the input, or its setting in the settings page. Mode defaults to off.
3. Open `▾` and choose workers. DSH defaults to **agy enabled, Claude disabled**. Enable Claude only when its own local configuration and quota are ready.
4. Give the captain a task with a concrete deliverable, boundaries, and an acceptance command. Each worker receives the task text, not the captain's whole conversation.
5. Read the verification evidence in the returned digest. Open the live sidebar for ongoing observation.

Example task brief:

```text
Repair the failing parser test in this workspace. Keep the public API unchanged.
Use task_id parser-regression. Before delegation, run npm test as a failing
baseline; after the worker finishes, run npm test as acceptance. Report the
actual exit codes and any checks that could not start.
```

The mode switch, worker selections, and setting row use the same plugin namespace, `wolfpack`. Changes to volatile settings apply without restarting. Host source changes, environment changes, or refreshed module-load roster defaults require a full host restart; refreshing the page only reloads client code.

## 2. Worker directory: 28 entries, two core adapters

`lib/core/worker/` contains native `agy` and `claude` adapters plus **26 opt-in declarative specifications**. The complete [worker directory](docs/WORKERS.en.md) lists all 28 with binaries, aliases, evidence, confidence, and unresolved details. It is not a claim of 28 installed or end-to-end tested integrations.

Without a nonempty enabled list, automatic selection considers only the two core workers. DSH narrows that further through its defaults. Extension workers enter the pool only when explicitly selected. `iflow` and `codebuff` have `contract: unknown`; their preflight fails closed even if their binaries exist. A documented contract can still have unknown output/authentication/resume details.

The dropdown reads a host-provided `workers_roster` JSON snapshot, `{ version: 1, workers: [...] }`, rather than maintaining its own 28-name list. Selection writes an ordered **CSV** to `workers_enabled`. The UI prevents removing the last selected worker. If an older host snapshot lacks a usable roster, the client uses a legacy two-worker fallback.

Installed badges come from host-side PATH/filesystem checks at module load, **without spawning worker processes**. They show command existence, not successful authentication, working permissions, quota, compatibility, or verified contracts. Extension roster probes use the primary binary; a configured extension path or alias may be usable despite a missing badge. Conversely an installed unknown-contract worker remains unavailable. The client cannot inspect the host's filesystem.

To inspect the directory from `dsh/`:

```powershell
node bin/wolf.mjs workers
node bin/wolf.mjs workers --json
```

Both are offline inspection. `workers --probe` is an explicit execution option that runs resolved CLIs with `--version`; it is not required to open the UI and does not validate a full task.

## 3. The four tools

DSH, this directory's CLI, and its MCP server use these four tool concepts. The DSH tool schemas do **not** expose a per-call `worker` parameter; choose an enabled pool in configuration. Host descriptions retain some historical agy wording, but execution goes through the worker registry.

| Tool | Inputs | Behavior |
|---|---|---|
| `wolf_delegate` | Required `task_id`, `task`; optional `verify[]`, `verify_baseline[]`, `fresh`, `model` | Delegates one independent task, applies the baseline gate, runs acceptance, returns evidence and a bounded digest |
| `wolf_status` | Optional `task_id`, `limit` | Reads folded ledger state without worker or acceptance execution; default 20, maximum 100 tasks |
| `wolf_kill` | Required `task_id` | Stops a matching running worker handle and records cancellation; completed or unknown runs return a reason |
| `wolf_team` | Required `tasks[]`; optional `concurrency` | Runs 1–8 tasks with concurrency 1–4, default 2; input-order results and aggregate digest |

Each team item accepts `task_id`, `task`, and optional `verify`, `verify_baseline`, `fresh`, and `model`. A duplicate task ID within a batch rejects the batch before worker launch. Independent task failure does not cancel every other item. Concurrency is not file isolation: two tasks writing the same files can conflict. Divide ownership in their briefs.

Four tools declare concurrency safety, but a single task ID cannot be run twice simultaneously inside one process. The active registry rejects a duplicate rather than silently sharing a conversation. Cross-process coordination has additional limits below.

### Alternative CLI entry

CLI/MCP use the same `lib/core/**` with `NodeRuntime`; they do not require DSH peer packages for ordinary execution. Run from this directory, or use absolute entry-point paths:

```powershell
node bin/wolf.mjs status --json
node bin/wolf.mjs delegate --task-id parser-regression --task 'Repair the parser tests without changing the public API' --verify-baseline 'npm test' --verify 'npm test'
node bin/wolf.mjs kill --task-id parser-regression
node bin/wolf.mjs team --tasks tasks.json --concurrency 2
```

These delegation examples execute real work when run. Status and ordinary worker listing are read-only. Team input can also arrive through stdin. Use `--fresh` to start a new worker session for the same task, and `--model` for a model override where the adapter supports it.

### Alternative MCP entry

```toml
[mcp_servers.wolfpack]
command = "node"
args = ["<absolute-path-to-repository>/dsh/bin/wolf-mcp.mjs"]
env = { WOLFPACK_AGY = "<absolute-worker-path>" }
```

The server implements MCP Tools over stdio, protocol version `2024-11-05`: initialize, initialized notification, tools/list, tools/call. It does not advertise Resources or Prompts. Unknown methods and unknown tools return `-32601`. Explicit environment paths avoid dependence on a client-selected cwd when locating configuration files. This MCP entry has four tools; it is not the six-tool entry from the other editions.

## 4. Baselines, acceptance, and verdicts

`verify_baseline` commands are checks that should fail **before** work begins. They establish that the problem still exists. The gate runs before worker launch:

| Baseline outcome | Decision |
|---|---|
| Any command could not start | `error`; no worker starts |
| No startup fault, and any check exits 0 | `stale`; no worker starts and no post-work acceptance runs |
| All checks time out, with no ordinary failure | `error`; no worker starts |
| Checks ran and failed, including an ordinary non-timeout failure | Proceed to delegation |

Startup faults take priority over a passing baseline. A passing baseline plus another timed-out check can still produce `stale`. Baseline success means the supplied failure condition is already absent; it is not new worker achievement.

After the worker exits, `verify` commands run in the task's workspace through the runtime. Each check records whether it started (`ran`), exit code, timeout, tail output, and failure signals. A nonzero exit or timeout in an executed acceptance command is a failure. No commands means `unverified`.

| Verdict | Current DSH rule |
|---|---|
| `pass` | At least one acceptance check actually ran, and every **executed** check passed |
| `fail` | At least one check ran and an executed check failed |
| `error` | Registered acceptance checks exist but none ran; also baseline gate faults |
| `unverified` | No acceptance commands supplied |
| `stale` | Baseline gate skipped delegation |

**Important existing limit:** a passing executed check plus another check that failed to start can currently yield `pass`. Inspect **every registered check's `ran` and exit code**, not just the overall verdict. This edition has not adopted the other editions' stricter all-registered-checks rule. Similarly, `stop_reason: completed` describes worker termination, not proven acceptance; it can coexist with `unverified` or `fail`.

The agy adapter can reconcile a reported failure with detected disk artifacts. Independently, the delegate core can recover a worker `error` when executed acceptance checks all pass; it updates health to success. That recovery inherits the same mixed-startup acceptance limit. Claims, changed files, and a successful process exit alone are not substitutes for meaningful acceptance commands.

## 5. Continuation, routing, health, and cancellation

Use a stable `task_id` for one related task across rounds; choose a new ID for unrelated work. The NDJSON ledger stores the **worker that actually ran** with its session ID. Selection happens once for a run, and that selected worker is used for argv, parsing, classification, run receipts, and the final acceptance update. An unrelated post-run choice must not relabel the session.

Automatic routing filters enabled workers through preflight and considers health. A usable explicit preference is honored, even during cooldown, with a diagnostic. An unavailable or disabled preference can fall back to an eligible worker. Automatic selection favors the previous task worker when it remains eligible and healthy; otherwise it rotates among candidates. If all eligible workers are cooling down, it attempts the earliest recovery candidate and reports that decision.

This is **session ownership**, not a permanent lock to one worker. If selection changes from agy to Claude or another worker, continuation clears the prior session ID and records a cold-start reason. agy resumes with `--conversation <id>`; Claude uses `--resume <id>`, never an implicit “last session” flag. Generic continuation requires the spec to extract a usable session ID; text-only workers often cannot provide one.

Cold starts also follow `fresh`, disabled continuation, absent session IDs, configured round limits, and budgets. DSH's cumulative continuation budget defaults to **1,000,000 tokens**. Unknown usage falls back to a default cap of **20 rounds**; unknown token usage is not treated as confirmed zero. Budget-triggered cold starts are reported in the digest.

Health state is stored beside the ledger in `worker-health.json`. Fault classification separates capacity, timeout/failure, and authentication; default cooldowns are 5, 10, and 30 minutes respectively. Health affects routing, not the mechanical acceptance rule. Disabling health restores availability-based routing. Cancellation is a neutral outcome rather than evidence that a worker is unhealthy.

DSH subprocesses are managed through `ctx.get('subprocess')` and `DshRuntime`. A captain cancellation signal, explicit kill, or configured deadline terminates the process through the runtime and yields `aborted`. The default DSH worker timeout is off; acceptance defaults to five minutes. Stall detection **warns only** and never kills a worker automatically.

`wolf_kill` works through in-process handles. The core also contains disk-record lookup for cross-process cancellation, but the current delegate path does not call `writeLiveRecord()`. Do not promise reliable cross-process kill for every newly launched run. For existing records, the cross-process branch directly kills worker and host PIDs; it is not process-tree cancellation and may terminate a shared host. For existing records, the cross-process branch directly kills worker and host PIDs; it is not process-tree cancellation and may terminate a shared host. Disablement unregisters plugin mechanisms; it is not documented as a replacement for explicitly stopping an active task.

## 6. Output, ledger, and live panel

The digest deliberately separates the worker report from independent evidence. It includes task/round, continuation or cold-start reason, stop reason, diagnostics, disk-change determination, baseline/acceptance checks, and paths to raw or spilled stdout where available. Worker reports are limited to 4,000 characters, diagnostics to 500 UTF-8 bytes, failure signals to five items, and digest check tails to eight lines. Team summaries have their own bounded limits.

Raw stdout is persisted separately rather than automatically copied into captain context. Memory capture and spill are also bounded; “lossless JSON” does **not** mean unlimited raw-output preservation. `lib/core/lossless.mjs` ensures host tool values remain valid plain JSON: undefined object properties are omitted; nonfinite numbers, negative zero, undefined array elements, unsupported types, class instances, and cycles raise explicit errors. This prevents silent changes to invalid numeric data. It is a schema/value contract, not a claim of arbitrary-precision numbers.

The default ledger is `runs.ndjson` under the resolved DSH home's `wolfpack/` directory, with home-directory fallback. `WOLFPACK_LEDGER` overrides it. Reads fold append records into per-task state, including round, worker/session, total reported tokens, cache-read usage, last verdict, duration, and changed files. Automatic ledger limits default to 5,000 entries, 10 MiB, and ten detailed rounds per task; compaction retains folded summaries. Writes are serialized **inside a process**, without a cross-process file lock.

`wolf_status` does not execute worker models or acceptance commands. Its result still enters the captain's context, so repeated status polling has host reading cost. Prefer the sidebar for continuous observation.

The DSH panel reads **GET `/wolfpack/live`** through the host web server. It is not a `wolf_live` or `wolf_panel` tool. The route uses host connection authorization, returns 503 if the authorization service is missing, allows only GET, and disables caching. It is mounted through deferred service injection so late `webServer`/`connection` startup can be accommodated. Routing failures do not remove delegation tools.

Panel responses are bounded to 32 KiB; the default is eight displayed runs, a requested “all” limit has a hard cap of 50. Transcript reading uses a 64 KiB tail window, up to 12 events per run, and 400 characters per event before further payload trimming. The client polls with retry backoff and cleans up timers. These reads do not append conversation history or send transcript content to the model.

**Transcript limitation:** the host panel and stall monitor still use agy's Antigravity transcript layout. Claude's project/session transcript layout and extension-specific streams are not wired as separate tracks here. Missing heartbeat evidence should remain unavailable, not be interpreted as a confirmed stall. Final JSON/JSONL parsing in generic adapters is not a live stream-event distribution system.

## 7. Configuration reference

### Cordis settings

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Dynamic captain briefing and delegation mechanism switch |
| `agy_enabled` | `true` | Legacy core-worker switch when CSV is empty |
| `claude_enabled` | `false` | Legacy core-worker switch when CSV is empty |
| `workers_enabled` | empty string | Explicit registered worker names as CSV; takes precedence over legacy switches |
| `workers_roster` | module-load JSON | Hidden volatile host metadata for the dynamic menu |

Volatile writes are committed in place by the loader and trigger `loader/volatile-update`. The plugin recalculates its pool/preflight and mounts or unmounts mechanisms accordingly. The client uses `configForms` snapshots, readiness/writability checks, subscriptions, and a bounded write retry. A rejected setting change is visible rather than assumed successful.

### DSH environment

Set these in the environment inherited by the **host process**, then restart the host:

| Variable | DSH behavior / default |
|---|---|
| `WOLFPACK_AGY`, `WOLFPACK_CLAUDE` | Core executable paths; agy platform default, bare `claude` for the host |
| `WOLFPACK_<NAME>` | Extension executable path derived from registry name, e.g. `WOLFPACK_CURSOR` |
| `WOLFPACK_WORKER` | Preferred worker or `auto`; not a tool argument |
| `WOLFPACK_LEDGER` | Ledger file override |
| `WOLFPACK_BRIEFING` | Captain instruction file override; otherwise `briefing.md` |
| `WOLFPACK_MODE` | Worker permission mode; default `accept-edits`; adapters map supported terms |
| `WOLFPACK_MODEL`, `WOLFPACK_EFFORT` | Worker model / reasoning options where the adapter supports them |
| `WOLFPACK_CLAUDE_MODEL` | Claude-specific model |
| `WOLFPACK_CLAUDE_PERMISSION_MODE` | Claude-specific permission override |
| `WOLFPACK_CLAUDE_AGENTS` | Claude agents JSON; no default tool restrictions are injected |
| `WOLFPACK_TASK_TIMEOUT` | **Seconds in DSH host**, default 0/off; no worker wall-clock cap |
| `WOLFPACK_VERIFY_TIMEOUT` | **Seconds in DSH host**, default 300; 0/off disables |
| `WOLFPACK_CONTINUATION` | DSH default `per-task` |
| `WOLFPACK_TOKEN_BUDGET` | Default 1,000,000; off/none/0 disables budget-based cold starts |
| `WOLFPACK_UNKNOWN_USAGE_CAP` | Default 20; off/none/0 disables unknown-usage round fallback |
| `WOLFPACK_MAX_ROUNDS` | Optional positive per-task round limit |
| `WOLFPACK_WORKER_HEALTH` | off/none/0/false/no disables cooldown routing |
| `WOLFPACK_STALL_WINDOW` | Warning window in seconds; default five minutes; off disables |
| `WOLFPACK_STALL_TOAST` | off disables host toast notification |
| `WOLFPACK_STALL_LOG` | Separate stall NDJSON path; default beside the ledger |
| `WOLFPACK_LEDGER_MAX_ENTRIES`, `WOLFPACK_LEDGER_MAX_BYTES`, `WOLFPACK_LEDGER_KEEP_ROUNDS` | Ledger retention limits; off/none/0 disables each limit |

### Host versus CLI/MCP configuration

`lib/core/config.mjs` searches upward for `wolfpack.config.json`, or uses `WOLFPACK_CONFIG_FILE`, and resolves worker environment paths before file paths. **DSH does not consume every resulting field**: its `runConfig()` uses that loader for extension paths and health defaults while Cordis controls the enabled pool and the host environment controls core paths and most policies.

In particular, `WOLFPACK_WORKERS_ENABLED` and file `workers_enabled` are CLI/MCP pool settings; use Cordis `workers_enabled` for DSH. Generic loader timeout values are parsed as milliseconds, while the DSH host helpers interpret the two timeout environment variables as seconds. Avoid copying numeric timeout configuration between entry points without checking units. Not all environment variables accepted by another edition or the CLI are forwarded by this host.

On Windows, shared resolution now tries compatible PATHEXT suffixes when a `.exe` candidate is missing. Claude's adapter wraps resolved `.cmd`/`.bat` files with `cmd`; it does not force a shell around an actual executable. Tests cover this fallback with fixtures, not a fresh live Claude installation.

## 8. Architecture and maintenance

The DSH shell is `lib/index.js` plus the hand-written browser module `lib/client.js`. The shared delegation core is under `lib/core/`, with runtime adapters under `lib/runtime/`. `bin/wolf.mjs` and `bin/wolf-mcp.mjs` provide independent entry points. `lib/agy-provider.js` is the subagent interoperability seam; model tools normally use the delegate core directly.

The dynamic briefing is registered as a `systemPrompt.section` at order 1200 and reads the briefing file when assembled. Missing/empty files produce a fallback with a diagnostic. Mechanisms need soft-acquired `tools`, `subprocess`, and `subagents`; if they are missing, the captain policy can remain while delegation tools are unavailable. Only `systemPrompt` is a hard host injection. See the bilingual [architecture document](docs/ARCHITECTURE.en.md), [host matrix](docs/HOST-MATRIX.md), and [cutover guide](docs/CUTOVER.md).

### Repository checks

```powershell
node tests/run.mjs
```

The runner stages source and **11 named suites**, checks DSH peer resolution, and uses fixture/fake worker scripts. It needs installed `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-subagent`, and `@deepseek-ai/schemastery` peers. `DSH_HOME` supplies the dependency root; `WP_TEST_HOME` can override the writable staging root. When neither is provided for direct invocation, staging falls back to a system-temp root, but actual peer dependencies must still be discoverable from a real DSH installation. A missing dependency setup returns exit 2; failed suites preserve staging for inspection.

Do not reuse the older README's fixed “270 tests” claim for this checkout. The runner now includes worker registry, pin regression, roster, and Claude command fallback suites in addition to host/tool/core coverage. Read the current run output for actual results. Fixture success does not prove every real vendor CLI, live DSH lifecycle, or credential setup works. This English documentation was reviewed against source; it does not claim a fresh live-worker acceptance run.

## 9. Troubleshooting and known limits

| Symptom | Check / action |
|---|---|
| Worker unavailable | Compare enabled names, resolved path, and contract status. Use explicit paths; confirm the CLI's own login outside Wolfpack. |
| CLI uses a different pool from DSH | CLI/MCP use the loader/environment list; DSH uses Cordis CSV and legacy switches. |
| Menu selection does not stick | Check snapshot readiness/writability and visible rejection text. Fully restart after host-source upgrades; page refresh alone can leave new client code with an old host. |
| Worker marked installed but unavailable | Existence is not a contract/authentication probe. Unknown contracts always fail; configured aliases/paths can also differ from roster badges. |
| Immediate `stale` | A baseline already passed; no worker was launched. Correct the baseline if it does not represent the intended problem. |
| `pass` with a suspicious check | Inspect all `ran` fields; mixed startup failure is an existing DSH acceptance gap. |
| Changed files “undetermined” | Git falls back to a bounded filesystem mtime/size snapshot. Detected additions, modifications, or deletions can provide evidence; an unchanged or incomplete snapshot is not proof of no changes. Rely on acceptance. |
| Duplicate task rejected | Another in-process run owns that task ID. Wait, stop it explicitly, or use a distinct ID. |
| Empty/unavailable sidebar | Inspect `<ledger-directory>/live-route.log`, mode state, and host web/connection services. Empty data and route failure are different states. |
| No Claude live heartbeat | Claude transcript tracking is not separately wired in this edition; absence is not a confirmed stall. |
| Cross-process kill misses a run | Live-record readers exist, but the current launch path does not write new cross-process registrations. |
| Baseline/acceptance process cannot start | Check shell configuration. Windows prefers `pwsh`, then the absolute system Windows PowerShell path; the CLI loader can accept a shell override. |

Additional boundaries: ledger writes lack a cross-process file lock; no atomic cross-process task reservation is implemented; raw/spill retention is bounded and fallible; route authorization relies on host services; generic JSONL parsing happens after collection, without a live event dispatcher. The CLI has no health management subcommand in this edition; inspect the health file or digest instead. CLI `delegate` and `team` can differ in their exit treatment of `unverified`, so inspect verdicts explicitly in automation.

License: MIT; see the repository [LICENSE](../LICENSE).
