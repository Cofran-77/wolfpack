# Contributing

[简体中文](CONTRIBUTING.md) | [Project introduction](README.en.md)

Reproducible reports, documentation, worker adapters, and tests are welcome. Identify the edition first: dsh/, codex/, and universal/ are maintained independently. Historical archives are not current installation entries.

Reports should include edition/commit, OS, Node, host/worker CLI versions, configuration source, minimal steps, expected behavior, and actual results. Remove secrets and private task content; a complete real conversation is unnecessary. For verification bugs, include each check's ran/exit_code and the overall verdict.

For new workers, provide public CLI-contract sources, headless arguments, output format, continuation, path/environment settings, permission/cancellation behavior, and simulated-worker regression coverage. A directory declaration, an existing binary, and a verified authenticated run are different evidence. Unknown contracts should fail closed rather than guess arguments.

Run root npm test for Codex/Universal. DSH changes require node tests/run.mjs with host peer dependencies as explained in dsh/README.en.md. Do not describe simulated tests as real-account validation. Update relevant Chinese/English docs with behavior, validation, and limits; preserve detailed and historical material.

Keep changes focused and describe the concrete problem and resulting behavior. Shared-workspace concurrency, cancellation, verification verdicts, and output-protocol changes need regression evidence. Tiny reversible documentation changes do not need tests that merely mirror the text.
