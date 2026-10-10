# Wolfpack configuration reference

[中文](CONFIGURATION.md) | English | [README](../README.en.md)

Start from [wolfpack.config.example.json](../wolfpack.config.example.json) to create a local `wolfpack.config.json`. By default the loader searches upward from the current working directory; `WOLFPACK_CONFIG_FILE` selects an explicit file. The config path does not change the target workspace.

For the settings below, the implementation generally chooses the corresponding environment variable, then the merged programmatic override/JSON value, then the default. `loadConfig(overrides, cwd, env)` merges overrides over JSON first; environment variables still win for the listed fields. Nested overrides replace their JSON object during that shallow merge. Empty values are field-dependent (`||` versus `??`), so unset unused environment variables rather than relying on empty strings.

## Worker and execution settings

| JSON setting | Environment variable | Default / meaning |
| --- | --- | --- |
| `agyPath` | `WOLFPACK_AGY` | PATH lookup for `agy`; `agy.exe` on Windows. Legacy JSON alias: `workerPath` |
| `worker` | `WOLFPACK_WORKER` | `auto`: use available workers and rotate when both are eligible; `agy` / `claude` sets a preference with unavailable-worker fallback |
| `claudePath` | `WOLFPACK_CLAUDE` | PATH lookup for `claude`; `claude.exe` on Windows. Set the actual `.cmd` launcher path if appropriate |
| `claudeModel` | `WOLFPACK_CLAUDE_MODEL` | Claude-only model override; takes precedence over the global model, unless a task supplies `model` |
| `claudePermissionMode` | `WOLFPACK_CLAUDE_PERMISSION_MODE` | Unset: `--dangerously-skip-permissions`, matching agy's default behavior. Explicit modes such as `plan` or `acceptEdits` use `--permission-mode` |
| `claudeAgents` | `WOLFPACK_CLAUDE_AGENTS` | Passes `--agents <json>` to define Claude custom subagents; provide CLI-compatible JSON |
| `mode` | `WOLFPACK_MODE` | `accept-edits`; adapter-specific execution mode |
| `model` | `WOLFPACK_MODEL` | Unset: worker CLI default; global model passed to the selected worker |
| `effort` | `WOLFPACK_EFFORT` | Unset: agy CLI default; agy reasoning-effort option |
| `taskTimeoutMs` | `WOLFPACK_TASK_TIMEOUT` | `0`: no Wolfpack-imposed worker timeout |
| `verifyTimeoutMs` | `WOLFPACK_VERIFY_TIMEOUT` | `300000` milliseconds, per acceptance or baseline command |
| `shell` | `WOLFPACK_SHELL` | Platform default shell prefix; JSON may be an argv array, environment value is a command-prefix string |
| `concurrency` | `WOLFPACK_CONCURRENCY` | Loader default `2`; valid configured values are integers 1–4. Current CLI/MCP team handlers pass only the call-level argument; use `--concurrency` / tool `concurrency` to control a team |

Executable paths and principal state paths support `~`, `~/`, and `~\` expansion. Use absolute paths when cwd or the host's PATH may vary. Availability probes establish that a launcher resolves, not that the provider is logged in or has quota.

A task's `model` overrides the Claude-specific model and the global model. Model identifiers must be accepted by the selected worker/provider; they are not translated between providers. Claude inherits its own CLI settings/provider environment. Worker selection is not a `wolf_delegate` or team-item argument: use configuration.

Default checks use `pwsh` from PATH on Windows, then Windows PowerShell under `%SystemRoot%`; POSIX uses `bash`, then `sh`. A custom shell prefix must include its command-execution arguments, for example `["bash", "-c"]`. A failed shell launch is a tool error, not evidence that the reported bug still exists. The process grace period is currently fixed by the loader at 5,000 milliseconds.

`taskTimeoutMs` and `verifyTimeoutMs` accept `0`, `off`, or `none` for no limit; invalid or non-positive values normalize to zero. The core team function's omitted-argument default is two; the loaded `config.concurrency` is not automatically applied by current CLI/MCP handlers. agy also receives a CLI print timeout: with no Wolfpack timeout, the adapter sets it to approximately 24 hours plus a minute.

## Continuation and ledger

| JSON setting | Environment variable | Default / meaning |
| --- | --- | --- |
| `continuation` | `WOLFPACK_CONTINUATION` | Unset: reuse an eligible session; `never` disables reuse |
| `continuationTokenBudget` | `WOLFPACK_TOKEN_BUDGET` | `1000000`; start fresh once prior cumulative reported token usage is at least this value |
| `maxRoundsPerTask` | `WOLFPACK_MAX_ROUNDS` | Unset: no explicit prior-round cap for session reuse |
| `unknownUsageRoundCap` | `WOLFPACK_UNKNOWN_USAGE_CAP` | `20`; fresh session after this many prior rounds with missing usage |
| `ledgerPath` | `WOLFPACK_LEDGER` | `~/.wolfpack/runs.ndjson` |
| `rawDir` | `WOLFPACK_RAW_DIR` | `~/.wolfpack/raw`; raw stdout and cross-process live/cancellation records |
| `maxEntries` | `WOLFPACK_LEDGER_MAX_ENTRIES` | `5000`; automatic ledger compaction threshold |
| `maxBytes` | `WOLFPACK_LEDGER_MAX_BYTES` | `10485760` (10 MiB); automatic compaction byte threshold |
| `keepRounds` | `WOLFPACK_LEDGER_KEEP_ROUNDS` | `10`; recent records retained per task during compaction, with older state folded into a summary |

The continuation token threshold controls context reuse; it is not a spending cap or a hard token limit for a task. Usage depends on what the selected worker reports. `0`, `off`, or `none` disables the token budget and explicit round cap, and disables the missing-usage cap when supplied to that field. `fresh: true` and changing workers also force cold starts; IDs are never shared across worker CLIs. Task round numbering continues even when the session starts fresh.

Ledger settings use numeric conversion with defaults for zero/invalid values. Do not infer that zero disables compaction: zero falls back to the default in the loader. Health/stall defaults below are derived from the ledger's directory. Separate state paths are recommended for independently running editions; old DSH state is not migrated automatically.

## Stall monitoring

| JSON setting | Environment variable | Default / meaning |
| --- | --- | --- |
| `stall.windowSeconds` / `stall.windowSecondsByWorker.agy` / `.claude` | `WOLFPACK_STALL_WINDOW`, `WOLFPACK_STALL_WINDOW_AGY`, `WOLFPACK_STALL_WINDOW_CLAUDE` | `300` seconds without progress; `0` / `off` / `none` disables that worker's monitoring |
| `stall.warnings` / `stall.warningsByWorker.agy` / `.claude` | `WOLFPACK_STALL_WARNINGS`, `WOLFPACK_STALL_WARNINGS_AGY`, `WOLFPACK_STALL_WARNINGS_CLAUDE` | `3` warning levels; `0` samples without warnings |
| `stall.pollSeconds` | `WOLFPACK_STALL_POLL` | `30` seconds; global sampling interval, minimum 5 seconds |
| `stall.toast` | `WOLFPACK_STALL_TOAST` | `false`; `true` / `1` enables optional macOS system notifications in the Node host |
| `stallLogPath` | `WOLFPACK_STALL_LOG` | `<ledger-directory>/stall.ndjson`; NDJSON warning ledger |
| `stall.storeRoots.agy` / `.claude` (legacy `stallStoreRoots`) | `WOLFPACK_AGY_STORE_ROOT`, `WOLFPACK_CLAUDE_STORE_ROOT` | `~/.gemini/antigravity-cli` and `~/.claude/projects` respectively |

Worker-specific window/warning environment variables override their global environment variable, then worker-specific JSON overrides global JSON. The poll setting is global; zero/off resets it to the default interval rather than disabling sampling. Legacy `WOLFPACK_STORE_ROOT` and JSON `stallStoreRoot` are agy-only fallbacks. Store-root strings are used as configured; use absolute paths rather than assuming shell-style tilde expansion for these fields.

Default warnings occur at one, two, and three windows (5/10/15 minutes), then stop. Monitors observe each worker's own session storage and never terminate a worker. Missing session evidence is shown as unavailable. Desktop notification support belongs to the host; CLI/MCP defaults avoid notifications. Injected programmatic notifiers are outside the JSON configuration surface.

## Worker health and cooldowns

| JSON setting | Environment variable | Default / meaning |
| --- | --- | --- |
| `workerHealth.enabled` | `WOLFPACK_WORKER_HEALTH` | `true`; `off`, `none`, `0`, `false`, or `no` disables health-based selection |
| `workerHealth.filePath` | `WOLFPACK_HEALTH_FILE` | `<ledger-directory>/worker-health.json` |
| `workerHealth.failThreshold` | `WOLFPACK_WORKER_FAIL_THRESHOLD` | `2`; consecutive ordinary worker errors before cooldown |
| `workerHealth.cooldownMs` | `WOLFPACK_WORKER_COOLDOWN_MS` | `600000` milliseconds; ordinary error or missing-output cooldown |
| `workerHealth.capacityCooldownMs` | `WOLFPACK_WORKER_CAPACITY_COOLDOWN_MS` | `300000`; quota/capacity failures, including exhausted intermediary pools |
| `workerHealth.timeoutCooldownMs` | `WOLFPACK_WORKER_TIMEOUT_COOLDOWN_MS` | `600000`; worker timeout |
| `workerHealth.authCooldownMs` | `WOLFPACK_WORKER_AUTH_COOLDOWN_MS` | `1800000`; authentication/login failure |

Infrastructure faults (`capacity`, `auth`, `timeout`, `no-output`) cool down immediately; ordinary errors use the threshold. Cancellation and skipped baselines are neutral. Successful completed execution clears consecutive failures and cooldown. Health tracks worker execution health, not whether task acceptance passed.

Cooldown durations must be positive: although the loader's timeout parser accepts zero/off, health normalization falls back to default positive durations. Disable `workerHealth.enabled` to turn the mechanism off. Explicit worker preferences can ignore a cooldown; automatic selection skips cooling workers when possible and tries the earliest recovery when all are cooling. Missing/corrupt files become empty health state. `node bin/wolf.mjs health --reset agy|claude|all` clears state after a fix.

## Local panel

| JSON setting | Environment variable | Default / meaning |
| --- | --- | --- |
| `panelPort` | `WOLFPACK_PANEL_PORT` | `8787`; occupied ports fall back to a free port |
| `panelHost` | `WOLFPACK_PANEL_HOST` | `127.0.0.1` |
| `panelToken` | `WOLFPACK_PANEL_TOKEN` | Unset; when set, requests require `?token=` or `x-wolfpack-token` |
| `panelRefreshMs` | `WOLFPACK_PANEL_REFRESH` | `3000` milliseconds; values below 500 fall back to 3000 |

The loader returns these fields as `config.panel.{port,host,token,refreshMs}`; the file inputs remain the top-level names in this table. MCP `wolf_panel` accepts a port override; CLI `panel` also accepts `--host` and `--token`. The panel is read-only and does not launch models or run acceptance commands. See the [architecture](ARCHITECTURE.en.md) for data flow.

Current live/panel CLI and MCP data-source builders omit the loaded `workerHealth` object. Their payload health sections can therefore show empty/default health; CLI `health` and `wolf_status` read the configured health file correctly. Programmatic payload hosts should pass `workerHealth` explicitly.

Local config, credentials, and run logs should stay out of version control. The repository ignores common local state files. For non-Git snapshots, explicit exclusions cover `rawDir`, `ledgerPath`, and the health file, plus standard ignored directories; a custom stall log elsewhere in the workspace is not automatically excluded by its config field.
