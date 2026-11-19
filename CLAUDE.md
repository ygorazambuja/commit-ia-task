# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Commit IA Task** is an automated task generation system that analyzes Git diffs and uses AI (OpenAI, Codex or Claude) to generate structured task descriptions. It outputs CSV files compatible with Azure DevOps import and can optionally create the work items via Azure CLI.

To _use_ the CLI (not develop it), read the "Uso por agentes de código" section in README.md: it must run inside the target repo, it stages files with `git add`, persists flags to config, and `--createAzureTasks` creates real work items.

The system runs on **Bun** runtime (not Node.js) and uses TypeScript with strict mode enabled.

## Common Commands

### Development

```bash
# Run the application (OpenAI API key)
bun run src/index.ts --sprintId "SPRINT_ID" --areaPathId "AREA_PATH_ID" [--assignedTo "Nome <email>"]

# Run with Codex subscription (requires `codex login`)
bun run src/index.ts --aiProvider codex --sprintId "SPRINT_ID" --areaPathId "AREA_PATH_ID"

# Format code
bun run format

# Type-check and test
bun run typecheck
bun test

# Install dependencies
bun install
```

### Logging Levels

```bash
# Default (info level)
bun run src/index.ts --sprintId "123" --areaPathId "456"

# Debug mode (verbose logging)
LOG_LEVEL=debug bun run src/index.ts --sprintId "123" --areaPathId "456"

# Error only
LOG_LEVEL=error bun run src/index.ts --sprintId "123" --areaPathId "456"
```

## Environment Requirements

- **OPENAI_API_KEY**: Required when using `--aiProvider openai` (default)
- **CODEX_MODEL**: Optional model override when using `--aiProvider codex`
- **CLAUDE_MODEL**: Optional model override when using `--aiProvider claude` (auth via `claude login` or `ANTHROPIC_API_KEY`)
- **LOG_LEVEL**: Optional, controls logging verbosity (debug, info, warn, error)
- **COMMIT_IA_TASK_CONFIG_DIR**: Optional override for the `config.json` directory

## Architecture Overview

### Data Flow

1. **index.ts** → Entry point that validates arguments and orchestrates the process
2. **git.ts** → Discovers modified/new files and retrieves Git diffs
3. **ai.ts** → Routes file diffs to OpenAI, Codex or Claude for task generation (prompt in `ai-prompt.ts`, Zod schema in `ai-schema.ts`)
4. **csv.ts** → Transforms generated tasks into CSV format
5. **azure-devops.ts** → Optionally creates work items with `az boards work-item create` (`--createAzureTasks`, `--noCsv` skips the CSV). Sends `System.State` and the required custom fields (`Custom.ItemContrato`, `Custom.IDSPF`, `Custom.UST`, `Custom.Complexidade`, `Custom.EstimateMade`) via `--fields`; numeric area/iteration go as `System.AreaId`/`System.IterationId`. On Windows, args with accents or cmd.exe special chars are passed as `@tempfile` (`toCmdSafeArgs`), and `az` output is cp1252, decoded as `windows-1252` by `defaultExecutor`
6. **logger.ts** → Provides structured, colored logging throughout

**Skills**: routine scripts live in `scripts/` and are invoked by skills in `.claude/skills/<name>/SKILL.md` (index and how to add one in README.md, "Skills"). `scripts/daily.ts` runs at the end of the workday and creates today's "Daily" task under the sprint's "Institucional" PBI, with an HTML description listing the assignee's tasks changed today; it reuses `config.ts` and `createAzureTasks`, is idempotent per day and supports `--dryRun`. `scripts/timelog.ts` (port of the Rust `timelog-bot`) posts a Time Log Free entry through `az devops invoke` (stored `az devops login` credential, no PAT), with the identity from a `@Me` WIQL; it is not idempotent.

**config.ts** persists `sprintId`, `areaPathId`, `assignedTo`, `itemContrato`, `azureOrganization`, `azureProject` to a per-OS `config.json`. In a TTY, index.ts prompts for each field; without a TTY it uses flags/saved values only.

### Key Components

**index.ts** (src/index.ts)

- CLI argument parsing using `node:util.parseArgs`
- Required parameters: `--sprintId`, `--areaPathId` (unless saved in config)
- Optional parameters: `--assignedTo` (defaults to Ygor Azambuja), `--itemContrato`, `--branch`, `--baseBranch`, `--createAzureTasks`, `--pbi` (parent PBI ID, links each created task via `az boards work-item relation add --relation-type parent`; requires `--createAzureTasks`), `--azureOrganization`, `--azureProject`
- Optional parameter: `--aiProvider` (`openai`, `codex` or `claude`, default: `openai`)
- Validates credentials based on provider (`OPENAI_API_KEY` for openai, Codex CLI for codex; claude fails on first call if not logged in)

**git.ts** (src/git.ts)

- `getDiff()`: Main function that orchestrates file discovery and task generation
- Uses NUL-delimited `git diff` and `git status` output to find modified, staged, renamed, and new files safely
- Automatically excludes lock files: pnpm-lock.yaml, bun.lockb, package-lock.json
- Processes files in parallel with `Promise.allSettled()` for fault tolerance
- Automatically stages successfully processed files with `git add`
- Branch mode (`--branch`, optional `--baseBranch`, default base `develop` case-insensitive, then `origin/HEAD`/`main`/`master`): diffs `merge-base(base, branch)..branch` instead of the working tree; for branches already merged via merge commit it locates that merge and uses `merge-base(merge^1, branch)`; fast-forwarded branches require `--baseBranch`. No `git add` in this mode

**ai.ts** (src/ai.ts)

- Routes task generation to OpenAI (`@ai-sdk/openai` + `ai` SDK) or Codex (`@openai/codex-sdk`)
- `createTasks()`: Main interface for task generation, accepts optional `{ provider }`
- Schema validation with Zod: expects `{ tasks: [{ title, description, tipo, complexidade, estimateMade }], fullFilePath }`
- Prompts are in Portuguese (Brazilian)
- AI instructions emphasize avoiding negative words like "Inutil" or "Refatoração"

**ai-claude.ts** (src/ai-claude.ts)

- Uses `@anthropic-ai/claude-agent-sdk` `query()` with `outputFormat: json_schema`, no tools
- Authenticates via Claude Code session (`claude login`) or `ANTHROPIC_API_KEY`

**ai-codex.ts** (src/ai-codex.ts)

- Uses `@openai/codex-sdk` with structured output via `outputSchema`
- Authenticates via Codex CLI session (`codex login`), not API key
- Runs with `sandboxMode: read-only` and `approvalPolicy: never`

**csv.ts** (src/csv.ts)

- Uses `csv-writer` library
- Generates files with timestamp format `tasks-{day}-{month}-{hour}-{minute}.csv`, adding a numeric suffix when that name already exists
- Values for contract and activity fields:
  - "Item Contrato": configurable, with default "Item 1"
  - "Activity": "Development"
- Derived values:
  - "ID SPF" from `tipo`: BACKEND 17, FRONTEND 19, TESTES 22
  - "UST" from complexity: BAIXA 8, MEDIA 24, ALTA 40, ÚNICA 8
- Dynamic values generated by AI per task:
  - "tipo": `BACKEND | FRONTEND | TESTES`
  - "Complexidade": `ALTA | MEDIA | BAIXA | ÚNICA`
  - "Estimate Made": integer from 1 to 8
  - "Remaining Work": same value as "Estimate Made"
  - "Original Estimate": same value as "Estimate Made"
- Fallback rule:
  - Invalid estimates are normalized to 1
- CSV headers match Azure DevOps import format

**logger.ts** (src/logger.ts)

- Custom logger implementation (not using external library)
- Supports 4 levels: debug, info, warn, error
- Color-coded output with ANSI escape codes
- Includes utility functions: `formatDuration()`, `formatFileSize()`

### Code Style

- **Formatter**: `bun fmt` (Prettier-compatible; tabs via `bunfig.toml`, double quotes). Type-check with `bun check`. No Biome/tsc
- **TypeScript**: Strict mode enabled, ES modules only
- **Module Resolution**: Bundler mode (TypeScript 5.7+)
- All text output (logs, prompts, descriptions) is in **Portuguese (Brazilian)**

## Important Notes

- This is a Bun project, not Node.js - use Bun-specific APIs like `Bun.spawn()`, `Bun.env`, etc.
- All file processing happens in parallel for performance
- Failed file processing doesn't stop the entire pipeline - errors are logged and tracked
- Generated CSV files are designed for Azure DevOps work item import
- The OpenAI provider currently uses `gpt-5-nano`
