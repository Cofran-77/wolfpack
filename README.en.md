# Wolfpack

English | [简体中文](README.md)

[![Tests](https://github.com/Cofran-77/wolfpack/actions/workflows/test.yml/badge.svg)](https://github.com/Cofran-77/wolfpack/actions/workflows/test.yml) · [MIT](LICENSE) · [Latest upgrade](docs/releases/2026-10-10-dsh-worker-registry.en.md) · [Community growth plan](docs/GROWTH.en.md)

**Connect AI judgment, CLI execution, and mechanical verification into one workflow.**

Wolfpack is a local AI task delegation toolkit. A captain understands the goal, splits work, defines boundaries, and reviews results. External CLI workers read files, edit code, and run commands in separate sessions. Wolfpack starts workers, resumes sessions, runs acceptance commands, records a ledger, and returns a bounded summary.

This repository maintains three independent implementations: **Wolfpack for DSH, Wolfpack for Codex, and the universal edition**. They share design principles, but their capabilities and configuration are different. Full manuals: [DSH](dsh/README.en.md), [Codex](codex/README.en.md), [Universal](universal/README.en.md).

**DSH is our recommended native plugin experience.** Its “everything is a plugin” approach provides worker selection, a live enable switch, result cards, and a sidebar panel. Choose Codex for an existing Codex captain workflow, or Universal for other local stdio MCP clients, terminal use, and scripts.

## Why use Wolfpack?

Complex work mixes decisions—understanding requirements, choosing an approach, setting acceptance criteria—with execution such as editing files, adding tests, running commands, and preparing deliverables. Keeping all execution in a long captain conversation produces raw logs, repeated reading, and growing context.

Wolfpack delegates self-contained work with independently checkable results. The captain reads measured summaries instead of the worker's entire conversation. Workers use their own authentication, provider, and model settings. A less expensive worker model may reduce costs, but savings depend on task decomposition, pricing, and rework; no fixed savings are promised.

Good fits include reproduced bug fixes, modules with clear boundaries, regression tests, batch edits, and independent documentation tasks. Architecture decisions, dependencies, permissions, and final review remain with the captain. Small edits can be done directly; dependent tasks should run sequentially; tasks touching the same files need coordination.

## Choose an edition

| Feature | DSH | Codex | Universal |
| --- | --- | --- | --- |
| Directory and manual | [dsh/](dsh/README.en.md) | [codex/](codex/README.en.md) | [universal/](universal/README.en.md) |
| Display name | Wolfpack for DSH | Wolfpack for Codex | Wolfpack |
| Best fit | Native DSH plugin, recommended | Codex captain and independent verification | Local stdio MCP clients, CLI, scripts |
| Entry points | Cordis plugin; also CLI/MCP | MCP/CLI and AGENTS.md | MCP/CLI and programmatic core exports |
| Workers | Native agy/Claude; 26 additional opt-in declarations | Antigravity agy / Claude Code claude | Antigravity agy / Claude Code claude |
| Selection | Dynamic native checkboxes restrict the pool | Environment/config preference and paths | Environment/config preference and paths |
| Enable switch | Composer and settings synchronized | No native DSH switch | No native DSH switch |
| Conversation tools | 4: delegate/status/kill/team | 6, including live/panel | 6, including live/panel |
| Live display | Native sidebar and host HTTP route | Independent local HTTP panel, worker tracks | Independent local HTTP panel, worker tracks |
| Result cards | Native status/kill cards | Text/JSON summaries | Text/JSON summaries |
| Stall evidence | Primarily agy; Claude track incomplete | Separate worker sampling | Separate worker sampling |
| Health cooldown | Core and summaries; no CLI health command | Health query/reset | Health query/reset |
| Change detection | Git path-set delta and non-Git snapshots | Git status path-set delta; unknown outside Git | Git path-set delta and bounded non-Git snapshots |
| Default state | $DSH_HOME/wolfpack, fallback ~/.dsh/wolfpack | ~/.wolfpack | ~/.wolfpack |
| Dependencies | CLI/MCP: no third-party runtime deps; plugin: DSH peers | Native Node modules, no third-party runtime deps | Same as Codex |
| Captain instructions | briefing.md injected while enabled | Detailed AGENTS.md delegation manual | briefing.md supplied to host AI as needed |

DSH has four tools because observation is integrated into its host sidebar and HTTP route. The other editions expose wolf_live/wolf_panel as observation tools, making six.

Install one edition per integration. All use the wolf/wolf-mcp command names. DSH and Universal retain the historical package name wolfpack-unified, but are different packages. When using multiple editions, invoke absolute entry paths and separate ledger/raw-output locations.

## Shared execution principles

### Self-contained tasks and acceptance criteria

Workers cannot see the captain's conversation. Include background, goals, permitted changes, interfaces to preserve, deliverables, and acceptance commands. Give the worker a decidable goal; code verifies the result and the captain reviews it.

```json
{
  "task_id": "fix-parser-empty-input",
  "task": "Fix the parser exception on empty input. Change only the parser and its tests. Preserve the public API. Add regression coverage and report summary, claimed_files, uncertainties, and checks actually run.",
  "verify_baseline": ["npm run test:parser"],
  "verify": ["npm run test:parser", "npm run build"]
}
```

### Baseline gate

verify_baseline defines checks expected to fail before delegation. A passing baseline returns stale without starting a worker. Checks that cannot run report an environment/tool error; a reproduced failure can proceed. Use checks targeting the problem, rather than mixing unrelated successful commands. Edition manuals explain mixed-result precedence.

### Selection, continuation, and cooldown

Worker availability depends on installation, configuration, the DSH enabled set, and health. DSH's 28-entry directory means two native adapters and 26 opt-in declarations—not 28 end-to-end verified CLI integrations. iflow/codebuff lack confirmed headless contracts and fail preflight.

Reusing task_id can continue the previous worker's session when it remains available and eligible. Switching workers starts a new session; session IDs are not interchangeable. Capacity, authentication, timeout, and other failures update health records. Typical cooldowns are five minutes for capacity, ten for timeout/ordinary error, and thirty for authentication. Exact fallback and all-workers-cooling behavior is edition-specific.

### Claims and evidence are separate

The first summary section contains worker claims. The second contains Wolfpack measurements: detected disk changes, whether verification ran, exit codes, and failure signals. Raw output is saved instead of being inserted wholesale into the captain's context.

A worker-reported ERROR may still leave artifacts or pass mechanical checks, allowing execution status to be recovered as completed. **completed and verdict: pass are separate dimensions. File existence does not prove correctness.**

| Verdict | Meaning |
| --- | --- |
| pass | Mechanical checks passed; see edition-specific unstarted-check limits |
| fail | Checks executed but failed |
| error | Checks could not run or another tool/environment fault occurred |
| unverified | No acceptance commands; no verified-success claim |
| stale | Baseline already passed; no worker started |

### Teams and traceable state

wolf_team accepts 1–8 independent tasks with a maximum concurrency of four. Duplicate IDs in one batch are rejected; task failures are isolated; results preserve input order. Tasks share the target workspace; no isolated directory is automatically created.

The ledger stores task IDs, rounds, sessions, worker identity, status, verdict, duration, and token usage. wolf_status reads state without delegating. Returning status repeatedly to an AI still consumes conversation context; use the panel for continuous observation.

## DSH's native plugin experience

- **Enable switch:** the composer button and general settings share enabled state. Changes take effect without restarting; disabling removes tools.
- **Worker selection:** a dynamic roster lists installed/enabled state. The UI prevents an empty pool. Default: agy on, Claude off. Enable Claude or extension workers explicitly.
- **Captain briefing:** briefing.md is injected into systemPrompt while enabled.
- **Tool cards:** status renders task rows/badges; kill renders cancellation outcomes and reasons.
- **Live sidebar:** running counts, rounds, steps, duration, tokens, and readable transcripts. Polling is faster while running, slower when idle, and paused while hidden.
- **Host subprocess lifecycle:** ctx.subprocess integrates output capture, cancellation, and host-managed process lifetimes.

These interactions are DSH's main advantage. Claude-specific stall monitoring, cross-process registration, and mixed verification failures still have boundaries. See the [DSH manual](dsh/README.en.md); do not assume backend parity.

## Latest DSH upgrade and architecture

The October 10 snapshot adds a declarative worker directory, dynamic workers_roster, an offline workers command, enabled-pool propagation fixes, lossless JSON boundaries, and Windows Claude npm-launcher fallback. The supplied package still reports 2.1.0; no new semantic version is invented. See [upgrade notes](docs/releases/2026-10-10-dsh-worker-registry.en.md).

Each architecture guide explains entry points, core/runtime/adapters, storage, task selection, baseline gates, execution, acceptance, summaries, cancellation, concurrency, continuation, and observation limits.

| Edition | English | 中文 |
| --- | --- | --- |
| DSH | [Architecture and logic](dsh/docs/ARCHITECTURE.en.md) | [运行架构](dsh/docs/ARCHITECTURE.md) |
| Codex | [Architecture and logic](codex/docs/ARCHITECTURE.en.md) | [运行架构](codex/docs/ARCHITECTURE.md) |
| Universal | [Architecture and logic](universal/docs/ARCHITECTURE.en.md) | [运行架构](universal/docs/ARCHITECTURE.md) |

## Install and start

Requires **Node.js ≥20**. Actual delegation needs at least one installed and authenticated worker CLI. Worker tools manage login, proxies, providers, and quota. Offline tests do not need real worker accounts.

```sh
git clone https://github.com/Cofran-77/wolfpack.git
cd wolfpack
```

### DSH

For DSH 0.2.0 and later, install the **dsh subdirectory** into the intended profile:

```sh
dsh plugin --profile <profile> add <absolute-repository-path>/dsh
```

Restart the host after installation. Enable the composer button and select workers. Subsequent switch/selection changes do not require restart. See [DSH manual](dsh/README.en.md) and [cutover guide (Chinese)](dsh/docs/CUTOVER.md) for peers, Cordis configuration, permissions, and rollback.

### Codex

Point the server to the **codex subdirectory**:

```toml
[mcp_servers.wolfpack]
command = "node"
args = ["<absolute-repository-path>/codex/bin/wolf-mcp.mjs"]
```

Set WOLFPACK_AGY/WOLFPACK_CLAUDE as needed and merge the [captain instructions](codex/AGENTS.md) into your project's existing instructions. See the [English Codex manual](codex/README.en.md).

### Universal CLI/MCP

Run from the target project's working directory using an absolute entry path:

```sh
node <absolute-repository-path>/universal/bin/wolf.mjs status --json
node <absolute-repository-path>/universal/bin/wolf.mjs delegate --task-id fix-parser --task "Complete self-contained task" --verify "npm test"
```

Typical JSON MCP configuration:

```json
{
  "mcpServers": {
    "wolfpack": {
      "command": "node",
      "args": ["<absolute-repository-path>/universal/bin/wolf-mcp.mjs"]
    }
  }
}
```

Client configuration locations/fields vary. The MCP server cwd is the task workspace; the script's directory does not automatically become the task directory. See the [Universal manual](universal/README.en.md).

## Layout and maintenance

```text
wolfpack/
├── README.md / README.en.md  Introduction, comparison, installation
├── dsh/                     Current native DSH plugin and detailed manuals
│   ├── lib/                 Cordis host, frontend, provider, and core
│   ├── tests/               Host contracts and simulated worker tests
│   └── archive/             Historical source, not the installation entry
├── codex/                   Codex edition, AGENTS.md, offline tests
├── universal/               CLI/MCP, briefing.md, offline tests
├── docs/                    Migration, releases, community plan, history
└── scripts/test.mjs         Universal/Codex test entry
```

The editions are maintained separately. DSH retains wolfpack-unified for existing Cordis loader compatibility. Archives remain for migration reference and are excluded from the current DSH package. The [original detailed Codex introduction](docs/history/README-CODEX-ORIGINAL.md) is preserved in Chinese.

## Validation and boundaries

Root npm test checks Universal and Codex. GitHub Actions tests these editions on Windows/macOS/Linux with Node.js 20/24. DSH tests require host peer dependencies: run node tests/run.mjs inside dsh with DSH_HOME or WP_TEST_HOME as documented. The latest local DSH run passed 306 simulated tests; that is not real-account or all-host-version end-to-end validation.

No edition automatically isolates concurrent workspaces. Cross-process coordination is not an atomic file lock. Logs, usage estimates, and artifact detection have limits; provide meaningful acceptance commands and review significant deliverables. Wolfpack does not replace authorization for publishing or other external operations.

MIT licensed. See [Contributing](CONTRIBUTING.en.md) for reproducible reports, [growth plan](docs/GROWTH.en.md) for launch experiments, and each edition's detailed configuration, architecture, and troubleshooting documentation.
