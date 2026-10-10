# DSH worker directory upgrade · 2026-10-10

[简体中文](2026-10-10-dsh-worker-registry.md) | [Project home](../../README.en.md)

This update imports the latest user-supplied wolfpack-dsh source. The package version remains **2.1.0**. The date identifies a source snapshot, not a new semantic version. Codex and Universal remain separate implementations with their detailed manuals preserved.

## Changed behavior

| Area | New behavior |
| --- | --- |
| Directory | 28 entries: two native adapters (agy/Claude) plus 26 opt-in declarations; a generic adapter uses declared arguments and text/JSON/JSONL output contracts |
| Native selection | workers_roster drives dynamic UI; workers_enabled stores the pool; legacy agy_enabled/claude_enabled remain supported, default agy on/Claude off |
| Disabled workers | Enabled sets reach the delegation core; cooling agy no longer permits selecting disabled Claude |
| Offline inventory | workers / workers --json inspect files/PATH only; workers --probe explicitly executes --version |
| Windows Claude | Missing default .exe can fall back to npm .cmd/.bat launchers, with paths containing spaces covered |
| Output boundary | Lossless JSON strips undefined object properties and rejects nonfinite numbers, -0, cycles, undefined array elements, and nonplain objects rather than silently coercing data |

Configuration follows directory worker names, not binary names: cursor executes agent but uses WOLFPACK_CURSOR/cursorPath. CLI/MCP use WOLFPACK_WORKERS_ENABLED or JSON workers_enabled; DSH's enabled pool uses Cordis workers_enabled. See the [worker directory](../../dsh/docs/WORKERS.en.md) and [architecture](../../dsh/docs/ARCHITECTURE.en.md).

## Validation and remaining limits

The local DSH run passed **306 tests across 11 suites**, using real host peer dependencies and simulated workers. No real worker accounts or model quota were used. Root tests and the six GitHub matrix combinations cover Codex/Universal, not DSH cloud integration.

The 28 entries are not 28 verified real-CLI integrations. “Installed” means a file was found. iflow/codebuff lack confirmed headless contracts and fail preflight. Authentication, quota, CLI-version compatibility, and actual continuation require environment-specific validation.

DSH still has four tools and a host-native panel. Claude-specific stall evidence, cross-process live-write wiring, and a CLI health command remain incomplete. A mixed verification run can still return pass when one check did not start and all executed checks succeeded; inspect every ran/exit-code result. This source import does not silently expand its code scope.

## Upgrade

1. Update the repository; install dsh/, never archive/.
2. Keep profile settings and enable extension workers deliberately.
3. **Fully exit and restart DSH** to load matching host/frontend source. Later switch/selection changes remain live.
4. Inspect the offline workers inventory, then run a small self-contained task with explicit checks and review both summary and sidebar.

This delivery also adds full English repository/edition manuals, bilingual per-edition runtime architecture, and bilingual contribution/community plans while retaining detailed Chinese and historical documentation.
