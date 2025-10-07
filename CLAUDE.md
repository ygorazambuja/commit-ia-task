# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Commit IA Task** is an automated task generation system that analyzes Git diffs and uses OpenAI to generate structured task descriptions for project management tools. It outputs CSV files compatible with Azure DevOps or similar tools.

The system runs on **Bun** runtime (not Node.js) and uses TypeScript with strict mode enabled.

## Common Commands

### Development
```bash
# Run the application
bun run src/index.ts --sprintId "SPRINT_ID" --areaPathId "AREA_PATH_ID" [--assignedTo "Nome <email>"]

# Format code
bun run format

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

- **OPENAI_API_KEY**: Required environment variable for OpenAI API access
- **LOG_LEVEL**: Optional, controls logging verbosity (debug, info, warn, error)

## Architecture Overview

### Data Flow
1. **index.ts** → Entry point that validates arguments and orchestrates the process
2. **git.ts** → Discovers modified/new files and retrieves Git diffs
3. **ai.ts** → Sends file diffs to OpenAI API for task generation
4. **csv.ts** → Transforms generated tasks into CSV format
5. **logger.ts** → Provides structured, colored logging throughout

### Key Components

**index.ts** (src/index.ts)
- CLI argument parsing using `node:util.parseArgs`
- Required parameters: `--sprintId`, `--areaPathId`
- Optional parameter: `--assignedTo` (defaults to Ygor Azambuja)
- Validates OPENAI_API_KEY environment variable

**git.ts** (src/git.ts)
- `getDiff()`: Main function that orchestrates file discovery and task generation
- `getAlteredFileNames()`: Uses `git diff --name-only` and `git ls-files --others --exclude-standard` to find modified and new files
- Automatically excludes lock files: pnpm-lock.yaml, bun.lockb, package-lock.json
- Processes files in parallel with `Promise.allSettled()` for fault tolerance
- Automatically stages successfully processed files with `git add`

**ai.ts** (src/ai.ts)
- Uses `@ai-sdk/openai` and `ai` SDK (not the raw OpenAI client)
- Model: `gpt-5-nano` (Note: likely should be `gpt-4o-mini-2024-07-18` based on comments)
- `createTasks()`: Main interface for task generation
- Schema validation with Zod: expects `{ tasks: [{ title, description }], fullFilePath }`
- Prompts are in Portuguese (Brazilian)
- AI instructions emphasize avoiding negative words like "Inutil" or "Refatoração"

**csv.ts** (src/csv.ts)
- Uses `csv-writer` library
- Generates files with timestamp format: `tasks-{day}-{month}-{hour}-{minute}.csv`
- Fixed hardcoded values:
  - "Item Contrato": "Item 1"
  - "ID SPF": 19
  - "UST": 4
  - "Complexidade": "ÚNICA"
  - "Activity": "Development"
  - All estimates set to 1
- CSV headers match Azure DevOps import format

**logger.ts** (src/logger.ts)
- Custom logger implementation (not using external library)
- Supports 4 levels: debug, info, warn, error
- Color-coded output with ANSI escape codes
- Includes utility functions: `formatDuration()`, `formatFileSize()`

### Code Style

- **Formatter**: Biome with tab indentation and double quotes
- **TypeScript**: Strict mode enabled, ES modules only
- **Module Resolution**: Bundler mode (TypeScript 5.7+)
- All text output (logs, prompts, descriptions) is in **Portuguese (Brazilian)**

## Important Notes

- This is a Bun project, not Node.js - use Bun-specific APIs like `Bun.spawn()`, `Bun.env`, etc.
- All file processing happens in parallel for performance
- Failed file processing doesn't stop the entire pipeline - errors are logged and tracked
- Generated CSV files are designed for Azure DevOps work item import
- The AI model reference in the code (`gpt-5-nano`) may need updating to match the actual model being used
