# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**Commit IA Task** is an automated task generation CLI. It analyzes Git changes, asks an AI provider to generate structured task descriptions in Brazilian Portuguese, writes an Azure DevOps-compatible CSV, and can optionally create Azure DevOps work items directly.

The project runs on **Bun**, not Node.js. TypeScript is strict, ES modules are used throughout, and runtime code should prefer Bun APIs such as `Bun.spawn()`, `Bun.env`, `Bun.file()`, `Bun.write()`, and Bun shell where appropriate.

To *use* the CLI on another repo (not develop it), read the "Uso por agentes de código" section in README.md: it must run inside the target repo, it stages files with `git add`, persists flags to config, and `--createAzureTasks` creates real work items.

## Common Commands

### Development

```bash
# Install dependencies
bun install

# Run with OpenAI API key provider
bun run src/index.ts --aiProvider openai --sprintId "SPRINT_ID" --areaPathId "AREA_PATH_ID"

# Run with Codex subscription provider (requires `codex login`)
bun run src/index.ts --aiProvider codex --sprintId "SPRINT_ID" --areaPathId "AREA_PATH_ID"

# Run and create Azure DevOps tasks after CSV generation
bun run src/index.ts --aiProvider codex --sprintId "PROJECT\\SPRINT" --areaPathId "PROJECT\\AREA" --createAzureTasks

# Format and apply Biome fixes
bun run format

# Run tests
bun test

# Run tests with coverage
bun run test:coverage
```

### Logging Levels

```bash
# Default is info
bun run src/index.ts --sprintId "123" --areaPathId "456"

# Verbose debug logging
LOG_LEVEL=debug bun run src/index.ts --sprintId "123" --areaPathId "456"

# Error-only logging
LOG_LEVEL=error bun run src/index.ts --sprintId "123" --areaPathId "456"
```

## Environment Requirements

- `OPENAI_API_KEY`: required when using `--aiProvider openai` (default).
- `CODEX_MODEL`: optional model override when using `--aiProvider codex`; otherwise the Codex SDK uses its configured default.
- `CLAUDE_MODEL`: optional model override when using `--aiProvider claude` (auth via `claude login` or `ANTHROPIC_API_KEY`).
- `LOG_LEVEL`: optional logging verbosity: `debug`, `info`, `warn`, or `error`.
- `COMMIT_IA_TASK_CONFIG_DIR`: optional directory override for the persisted `config.json`.
- Azure CLI plus the Azure DevOps extension are required only when using `--createAzureTasks`.

## CLI Behavior

`src/index.ts` parses these flags:

- `--sprintId`: iteration path/ID used in CSV and Azure DevOps task creation.
- `--areaPathId`: area path/ID used in CSV and Azure DevOps task creation.
- `--assignedTo`: assignee value; defaults to `Ygor Azambuja <ygor.azambuja@infortechms.com.br>`.
- `--itemContrato`: contract item value; defaults to `Item 1`.
- `--aiProvider`: `openai`, `codex` or `claude`; defaults to `openai`.
- `--branch`: analyze files changed on this branch (from its fork point to its tip) instead of the working tree; no `git add` in this mode.
- `--baseBranch`: base branch or commit for `--branch`; defaults to `origin/develop` or `develop` (case-insensitive), then `origin/HEAD`, `main`, `master`.
- `--createAzureTasks`: when present, creates Azure DevOps work items after generating the CSV.
- `--noCsv`: skip CSV generation; requires `--createAzureTasks`.
- `--pbi`: parent PBI ID; each created task is linked with `az boards work-item relation add --relation-type parent`. Requires `--createAzureTasks`.
- `--azureOrganization`: Azure DevOps organization URL, for example `https://dev.azure.com/org`.
- `--azureProject`: Azure DevOps project name or ID.

Configuration is persisted between runs. The CLI loads saved values, merges them with flags, prompts for editable values in an interactive terminal (no prompts without a TTY), and writes the final config back to disk. Default config file: `%APPDATA%\commit-ia-task\config.json` on Windows, `~/Library/Application Support/commit-ia-task/config.json` on macOS, `$XDG_CONFIG_HOME` or `~/.config/commit-ia-task/config.json` on Linux.

When Azure organization/project are not passed or saved, the app attempts to read defaults from:

```bash
az devops configure -l
```

## Architecture Overview

### Data Flow

1. `src/index.ts` validates provider setup, loads/persists configuration, orchestrates Git analysis, CSV generation, and optional Azure DevOps creation.
2. `src/git.ts` discovers changed files, collects the best payload for each file (new full file, staged diff, unstaged diff, or combined staged/unstaged diff), calls AI generation, and stages successfully processed files with `git add`.
3. `src/ai.ts` routes generation to OpenAI, Codex or Claude and normalizes task output.
4. `src/csv.ts` converts generated tasks into Azure DevOps-compatible task records and writes `tasks-{day}-{month}-{hour}-{minute}.csv`.
5. `src/azure-devops.ts` optionally creates tasks through `az boards work-item create`.

### Key Components

**`src/index.ts`**
- Entry point and top-level workflow.
- Uses `node:util.parseArgs` and `node:readline/promises`.
- Validates `OPENAI_API_KEY` for OpenAI or Codex CLI availability for Codex; Claude fails on the first call if not authenticated.
- Saves effective config on every successful setup pass.

**`src/config.ts`**
- Owns persisted configuration loading/saving.
- Uses OS-specific config directories, with `COMMIT_IA_TASK_CONFIG_DIR` as an override.
- Logs config failures as warnings and continues with defaults/flags.

**`src/git.ts`**
- Detects unstaged, staged, mixed, and new files.
- Ignores lock files: `pnpm-lock.yaml`, `bun.lockb`, and `package-lock.json`.
- Sends file work to AI in parallel with `Promise.allSettled()` so one failed file does not stop all processing.
- Stages only successfully processed files.
- Branch mode diffs `merge-base(base, branch)..branch`; for branches already merged via merge commit it finds that merge and uses `merge-base(merge^1, branch)`; fast-forwarded branches require `--baseBranch`.

**`src/ai-provider.ts`**
- Defines provider values: `openai`, `codex` and `claude`.
- Resolves CLI input, stores the configured provider, and validates provider prerequisites.

**`src/ai.ts`**
- Main task generation facade.
- Uses `@ai-sdk/openai` + `ai` for OpenAI generation, `src/ai-codex.ts` for Codex and `src/ai-claude.ts` for Claude.
- The current OpenAI model call uses `gpt-5-nano`.

**`src/ai-codex.ts`**
- Uses `@openai/codex-sdk`.
- Authenticates via the local Codex CLI session (`codex login`), not an API key.
- Runs Codex with `sandboxMode: "read-only"` and `approvalPolicy: "never"`.
- Requests structured JSON with `outputSchema`.

**`src/ai-claude.ts`**
- Uses `@anthropic-ai/claude-agent-sdk` `query()` with `outputFormat: json_schema` and no tools.
- Authenticates via the Claude Code session (`claude login`) or `ANTHROPIC_API_KEY`.

**`src/ai-prompt.ts`**
- Centralizes the Brazilian Portuguese task-generation prompt.
- Instructs the model to generate few, grouped, client-friendly tasks without markdown.

**`src/ai-schema.ts`**
- Defines the Zod schema for AI output.
- Normalizes `complexidade` to `ALTA`, `MEDIA`, `BAIXA`, or `ÚNICA`.
- Normalizes invalid `estimateMade` values to `1`.

**`src/csv.ts`**
- Uses `csv-writer`.
- Fixed values include:
  - `Work Item Type`: `Task`
  - `State`: `To Do`
  - `Activity`: `Development`
- Derived values:
  - `ID SPF` from `tipo`: BACKEND `17`, FRONTEND `19`, TESTES `22`
  - `UST` from `complexidade`: BAIXA `8`, MEDIA `24`, ALTA `40`, ÚNICA `8`
- `Remaining Work` and `Original Estimate` mirror `Estimate Made`.
- Sanitizes generated text into single-line CSV-safe strings.

**`src/azure-devops.ts`**
- Wraps Azure CLI calls.
- Reads defaults from `az devops configure -l`.
- Creates work items with title, description, assignee, area, iteration and `--fields` for `System.State`, activity, original estimate, remaining work and the custom fields `Custom.ItemContrato`, `Custom.IDSPF`, `Custom.UST`, `Custom.Complexidade`, `Custom.EstimateMade` (all required by the SPF-SIAFIC process).
- Numeric area/iteration values are sent as `System.AreaId`/`System.IterationId` (`--area`/`--iteration` accept paths only). `az work-item create` has no `--state` flag.
- On Windows `az` is a `.cmd`: Bun rejects cmd.exe special chars in args and the codepage can corrupt accents, so `toCmdSafeArgs` passes those args as `@tempfile`. `az` output on Windows is cp1252, not UTF-8.

**`src/logger.ts`**
- Custom logger with `debug`, `info`, `warn`, and `error`.
- Uses colored output and structured metadata.
- Exposes helpers such as `formatDuration()` and `formatFileSize()`.

## Tests

Tests live under `tests/` and use Bun's test runner.

Prefer focused tests for behavior changes in:

- `tests/ai.test.ts`
- `tests/azure-devops.test.ts`
- `tests/config.test.ts`
- `tests/csv.test.ts`
- `tests/logger.test.ts`

Run the relevant test file when possible, then run the full suite for shared behavior changes:

```bash
bun test tests/csv.test.ts
bun test
```

## Code Style

- Formatter/linter: Biome 2.x.
- Indentation: tabs.
- Quotes: double quotes.
- TypeScript: strict mode, `moduleResolution: "bundler"`, no emit.
- Keep runtime implementation Bun-first.
- Keep user-facing logs, prompts, generated descriptions, and CLI text in **Brazilian Portuguese** unless a third-party API requires otherwise.
- Prefer structured APIs/parsers over ad hoc string handling when available.

## Important Notes

- Do not treat this as a Node.js CLI. Avoid adding Node-only runtime assumptions when Bun already provides the needed API.
- AI task output must remain schema-valid and sanitized before CSV/Azure DevOps use.
- File processing is intentionally fault-tolerant: failed files are logged, successful files still produce tasks.
- The app stages files after successful task generation; be careful when changing `src/git.ts` because it affects the user's working tree.
- Generated CSV files are intended for Azure DevOps import, and direct Azure creation uses the same generated task records.
