# Worker directory and CLI invocation contracts

[中文](WORKERS.md) · [DSH manual](../README.en.md)

This is a **28-entry registry, not a claim that 28 CLIs have been tested successfully**. The directory records contracts collected from official documentation, public source, and package metadata. That research did not install or execute the surveyed CLIs. Sources below are the repository's recorded evidence; this document does not independently revalidate their current contents.

`documented` means there is enough recorded invocation evidence to create a specification. It does not guarantee that every flag, output field, authentication method, platform, or continuation behavior is known. `confidence` describes the recorded evidence, not runtime reliability. A `contract: unknown` entry always fails preflight; finding its executable or selecting it does not bypass that protection.

## 1. All 28 registered workers

The two native core adapters are `agy` and `claude`. The other **26 specifications are opt-in**, including the two unknown-contract entries that remain unavailable.

| # | Name | Vendor | Primary executable | Aliases | Category | Contract / confidence | Recorded official evidence | Invocation notes and limits |
|---|---|---|---|---|---|---|---|---|
| 1 | `agy` | Google | `agy.exe` on Windows / `agy` | — | Core; DSH default on | documented / high | [antigravity.google](https://antigravity.google) | Native Antigravity adapter; explicit `--conversation <id>` continuation. |
| 2 | `claude` | Anthropic | `claude.exe` on Windows / `claude` | — | Core; DSH default off | documented / high | [claude.ai/code](https://claude.ai/code) | Native Claude Code adapter; explicit `--resume <id>` continuation. Windows resolution also handles `.cmd` wrappers. |
| 3 | `codex` | OpenAI | `codex` | — | Opt-in | documented / high | [Noninteractive mode](https://developers.openai.com/codex/noninteractive), [exec.md](https://raw.githubusercontent.com/openai/codex/main/docs/exec.md) | Non-Git workspaces require `--skip-git-repo-check`; JSONL output. |
| 4 | `gemini` | Google | `gemini` | — | Opt-in | documented / high | [headless.md](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/headless.md), [Headless documentation](https://geminicli.com/docs/cli/headless/) | A non-TTY enters headless mode; `--output-format json`. |
| 5 | `qwen` | Alibaba | `qwen` | — | Opt-in | documented / high | [headless.md](https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/headless.md) | JSON output is an array; headless `--resume` requires an explicit ID. |
| 6 | `opencode` | sst | `opencode` | — | Opt-in | documented / high | [CLI documentation](https://opencode.ai/docs/cli/) | JSONL event stream; `run <prompt> --format json`. |
| 7 | `iflow` | iFlow | `iflow` | — | Opt-in; unavailable | unknown / unknown | [Official README](https://raw.githubusercontent.com/iflow-ai/iflow-cli/main/README.md) | Recorded README says the service closed on 2026-04-17 (UTC+8); no verified noninteractive argv contract. Preflight fails closed. |
| 8 | `crush` | Charm | `crush` | — | Opt-in | documented / high | [run documentation](https://charm.land/crush/cli/run) | Resume appears in source and example comments, not the documented Flags table. Documentation says run sessions do not retain history by default, so continuation may not work. |
| 9 | `goose` | Block | `goose` | — | Opt-in | documented / high | [CLI commands](https://block.github.io/goose/docs/guides/goose-cli-commands) | JSON top-level fields unknown. Auto approval uses `GOOSE_MODE=auto`; the spec has `autoApproveFlags: null`. Output format is not documented. |
| 10 | `aider` | Paul Gauthier | `aider` | — | Opt-in | documented / medium | [Scripting](https://aider.chat/docs/scripting.html) | Documentation and source differ on `--yes`; the spec follows source with `--yes-always`. Usually needs `<files>`; no-file behavior is unverified. No session ID. |
| 11 | `copilot` | GitHub | `copilot` | — | Opt-in | documented / high | [Programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) | JSONL field names in `-p` mode are undocumented. Availability of `--output-format` with `-p` is supported by changelog/PR evidence rather than the command-reference table. Output structure remains unknown. |
| 12 | `cursor` | Anysphere | `agent` | `cursor-agent` | Opt-in | documented / high | [Headless CLI](https://cursor.com/docs/cli/headless) | `agent` is the official primary binary; `cursor-agent` is a legacy alias. Check for unrelated PATH commands named `agent`. Final text is top-level `.result`. |
| 13 | `amp` | Sourcegraph | `amp` | — | Opt-in | documented / high | [ampcode.com/docs](https://ampcode.com/docs) | Approval flag unknown; `AMP_API_KEY` requires the `sgamp_` prefix. JSONL event stream. |
| 14 | `droid` | Factory | `droid` | — | Opt-in | documented / high | [Factory documentation](https://docs.factory.com), [npm metadata](https://registry.npmjs.org/droid) | Multi-turn interaction uses `stream-jsonrpc`; old `stream-json` input is legacy, and the recorded source sentence was truncated (medium confidence for that detail). Top-level `result` and `session_id`. |
| 15 | `auggie` | Augment | `auggie` | — | Opt-in | documented / high | [Augment documentation](https://docs.augmentcode.com), [npm metadata](https://registry.npmjs.org/@augmentcode/auggie) | No yolo flag; JSON top-level field names have not been established. |
| 16 | `cline` | Cline | `cline` | — | Opt-in | documented / high | [Cline documentation](https://docs.cline.bot) | NDJSON top-level `type`; text appears in events such as `agent_event.event.text`. |
| 17 | `continue` | Continue | `cn` | — | Opt-in | documented / high | [npm metadata](https://registry.npmjs.org/@continuedev/cli) | Evidence is package metadata. Approval flag and API-key environment variable unknown; output field names undocumented. |
| 18 | `openhands` | All-Hands AI | `openhands` | — | Opt-in | documented / high | [OpenHands documentation](https://docs.openhands.dev) | `--json` events expose `type: action` or `observation`; final text requires assembly. The npm package named `openhands` is a placeholder; use the official installation instructions. |
| 19 | `oz` | Warp | `oz` | — | Opt-in | documented / medium | [Warp documentation](https://docs.warp.dev) | Warp has `warp` and `oz` binaries; only `oz` has headless mode. `warp` itself has no one-shot prompt contract. Output format undocumented. |
| 20 | `plandex` | Plandex | `plandex` | — | Opt-in | documented / medium | [Official repository](https://github.com/plandex-ai/plandex) | Research encountered TLS failures at plandex.ai and used GitHub source instead. Output format undocumented. |
| 21 | `kimi` | Moonshot AI | `kimi` | — | Opt-in | documented / high | [Kimi Code documentation](https://moonshotai.github.io/kimi-code) | Recorded wording around `-p` with `--yolo`/`--auto` is ambiguous. Authentication uses `api_key_env` in config.toml; an export alone does not configure that mapping. Stream-JSON session-ID fields are not documented. |
| 22 | `mcode` | MiniMax | `mcode` | — | Opt-in | documented / medium | [npm metadata](https://registry.npmjs.org/@minimax-ai/code) | JSON structure, its own key environment variable, and `--permission` values are all unknown. Output format undocumented. |
| 23 | `codebuddy` | Tencent | `codebuddy` | `cbc` | Opt-in | documented / high | [CLI documentation](https://codebuddy.cn/docs/cli) | Among the recorded contracts, this CLI requires explicit permission bypass even in `-p` mode: `--dangerously-skip-permissions` cannot be omitted from that invocation. Final text is `.response`. |
| 24 | `qoder` | Alibaba | `qoder` | — | Opt-in | documented / high | [CLI documentation](https://docs.qoder.com/cli) | Recorded evidence says Lingma was renamed Qoder CN on 2026-05-20; no separate Lingma CLI is registered. Output fields have not been established; format undocumented. |
| 25 | `trae` | ByteDance | `trae-cli` | — | Opt-in | documented / high | [trae-agent](https://github.com/bytedance/trae-agent) | This is not Trae IDE. Install through pip/uv, not npm; provisioning is the user's responsibility. No JSON output. |
| 26 | `comate` | Baidu | `comatecli` | — | Opt-in | documented / medium | [npm metadata](https://registry.npmjs.org/@comate/comatecli) | Full flags, event names, and authentication unknown; recorded documentation URL returned 404. Output format undocumented. |
| 27 | `spark` | iFLYTEK | `aispark` | — | Opt-in | documented / medium | [spark-ai-cli](https://github.com/iflytek/spark-ai-cli) | Output and resume contracts unknown; output format undocumented. |
| 28 | `codebuff` | Freebuff | `codebuff` | `cb` | Opt-in; unavailable | unknown / unknown | [npm metadata](https://registry.npmjs.org/codebuff), [freebuff.com](https://freebuff.com) | Entire headless contract unknown; preflight fails closed. Recorded `codebuff@1.0.688` was not deprecated, but its README had changed to Freebuff and official packaging to `freebuff@0.2.26`. |

## 2. Enablement and configuration

### Default pool and isolation

Without a nonempty enabled-worker filter, the core selects only `agy` and `claude`, never every installed specification. DSH adds a narrower default: Wolfpack mode off, `agy_enabled=true`, `claude_enabled=false`. Turn on the plugin and select Claude explicitly if needed.

The DSH `workers_enabled` CSV, when nonempty, takes precedence over those two legacy switches. The host trims, lowercases, deduplicates, and checks registered names; unregistered names are ignored and logged. The core currently treats an empty array as absence of a filter, returning to the core pool. Do not rely on an empty or invalid-only list to disable delegation; use `enabled=false`. The UI prevents deselecting the last worker.

An unknown-contract worker stays unavailable even when explicitly selected. A path override does not change its contract. Generic preflight also rejects a stdin-only prompt contract because the current worker spawn path uses `stdin: 'ignore'`.

### Names, binaries, and path overrides

Keys derive from the **registry name**, not the binary:

| Worker | Binary / alias | Config key | Environment variable |
|---|---|---|---|
| `cursor` | `agent` / `cursor-agent` | `cursorPath` | `WOLFPACK_CURSOR` |
| `continue` | `cn` | `continuePath` | `WOLFPACK_CONTINUE` |
| `trae` | `trae-cli` | `traePath` | `WOLFPACK_TRAE` |
| `comate` | `comatecli` | `comatePath` | `WOLFPACK_COMATE` |
| `spark` | `aispark` | `sparkPath` | `WOLFPACK_SPARK` |
| `codebuddy` | `codebuddy` / `cbc` | `codebuddyPath` | `WOLFPACK_CODEBUDDY` |
| `codebuff` | `codebuff` / `cb` | `codebuffPath` | `WOLFPACK_CODEBUFF` |

CLI/MCP `loadConfig()` resolves environment paths before file paths and platform defaults; it searches upward from cwd for `wolfpack.config.json`, or uses `WOLFPACK_CONFIG_FILE`. Aliases are tried when the default primary binary is unresolved; an explicit path is not a general alias search request. Windows PATH resolution uses PATHEXT and can replace a missing `.exe` candidate with a `.cmd` candidate. Claude `.cmd`/`.bat` execution is wrapped in `ComSpec /d /s /c`; paths containing spaces add `call`. These are local-resolution behaviors, not proof of authentication or quota.

### CLI/MCP enabled pool

```powershell
$env:WOLFPACK_WORKERS_ENABLED = 'agy,codex,cursor'
node bin/wolf.mjs workers --json
```

Alternatively, place this in `wolfpack.config.json`:

```json
{
  "workers_enabled": "agy,codex,cursor",
  "cursorPath": "C:/tools/cursor-agent.cmd"
}
```

### DSH enabled pool

Use the plugin's Cordis `workers_enabled` setting, or its dynamic dropdown. **The DSH host does not use `WOLFPACK_WORKERS_ENABLED` or the file's enabled list as its pool control**: `lib/index.js` computes that pool directly from Cordis Config. It does call `loadConfig()` for extension-worker paths and health defaults. Core paths and most host settings come from the host's environment. This distinction matters when a CLI command and a DSH chat appear to choose different workers.

### Dynamic dropdown

The `conversation.input.right` slot has a Wolfpack capsule and a `▾` worker menu. `lib/core/worker/roster.mjs` generates a stable roster at host module load and serializes `{ "version": 1, "workers": [...] }` into the hidden volatile `workers_roster` setting. `lib/client.js` reads that snapshot rather than hardcoding all 28 names. If no usable roster is available, the client retains a legacy two-worker fallback.

Checking a worker writes an ordered CSV to `workers_enabled`, using roster order for stable serialization. The client blocks removal of the final selected worker, retries a rejected write once after rereading the snapshot, and reports remaining rejection. Accepted writes are not a guarantee against later revision conflicts or concurrent changes; rendering follows subscribed snapshots.

The installed badge is a **filesystem/PATH existence probe without spawning any external process**. Extension roster probes currently inspect the primary `spec.bin`, not every configured path or alias. They do not test contracts, login, API keys, quota, version compatibility, or successful invocation. Consequently a badge can differ from execution preflight; an unknown-contract binary can show installed and still be unusable. Restarting the host refreshes the module-load default roster; the client cannot inspect the host filesystem itself.

## 3. Inspect worker availability

Run these from `dsh/`:

```powershell
# Offline table: no external worker execution
node bin/wolf.mjs workers
# Offline machine-readable report
node bin/wolf.mjs workers --json
# Explicit opt-in version probe: executes resolved binaries with --version
node bin/wolf.mjs workers --probe
```

`--probe` is an execution request, not part of offline inspection. Even a successful version probe does not validate a full task, structured output, permissions, or resume.

## 4. Products deliberately not separately registered

These are recorded research conclusions, not fresh assertions about every vendor's current offering.

| Product | Recorded decision | Reason / evidence |
|---|---|---|
| Z.ai / GLM | No agent CLI established | ZCode was a desktop ADE with no CLI/headless documentation; `@z_ai/coding-helper` was a helper library, not an autonomous agent CLI. [ZCode](https://docs.z.ai/devpack/tool/zcode), [package metadata](https://registry.npmjs.org/@z_ai/coding-helper). |
| Roo Code | No official CLI established | Recorded official offering was IDE extensions and Cloud; research found no cli/headless entries in 510 sitemap URLs and no official npm CLI. [Sitemap](https://docs.roocode.com/sitemap.xml). |
| Sourcegraph Cody CLI | Unverified; not registered | IDE and enterprise offerings were primary; evidence did not establish a stable CLI contract. |
| JetBrains Junie | Unverified; not registered | No independently documented headless invocation was established. |
| AWS Kiro | Unverified; not registered | No verified public headless contract was recorded. |
| Google Antigravity CLI | Already represented | Native core worker `agy`; no duplicate extension specification. |
| Windsurf CLI | Unverified; not registered | Recorded IDE offering did not establish a noninteractive agent CLI contract. |
| iFlow CLI | Registered but unavailable | Kept in the table as unknown-contract evidence; recorded README announced closure on 2026-04-17 (UTC+8). |

## 5. Evidence and implementation limits

The recorded research used read-only HTTP GETs against official docs, official GitHub source, and npm registry metadata. It did not download, install, or run the surveyed CLI programs. Unknown details remain unknown; some documented invocation specifications intentionally use text output because no trustworthy JSON schema was established.

The generic adapter can parse JSON or JSONL only through the extractors declared by its spec. Text fallback has no session ID or usage extraction. A resume flag in a vendor contract does not by itself make Wolfpack continuation usable: the adapter must recover an ID. Generic auto-approval follows the spec and defaults to enabled unless the corresponding programmatic setting disables it; vendors without a documented approval flag are not assigned invented flags. Prepare each CLI's own login/configuration and inspect its permission behavior before real work.

For runtime selection, continuation ownership, acceptance limits, and the DSH panel, see [architecture](ARCHITECTURE.en.md) and the [manual](../README.en.md).
