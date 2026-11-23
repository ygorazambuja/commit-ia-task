# AGENTS.md

Canonical engineering guide for **Infortech Automation**, a Tauri 2 desktop app
and Rust CLI for Git-to-task generation, Azure DevOps, and Time Log Free.
`CLAUDE.md` delegates here; the domain contracts below are part of this guide.

## Before changing code

1. Inspect the working tree and preserve unrelated changes.
2. Read the contract for every affected domain before editing:

   | When changing… | Required contract |
   | --- | --- |
   | Settings, onboarding, credentials, prompts, AI models or provider execution | [Configuration and providers](docs/engineering/configuration.md) |
   | Git inspection/staging, task generation, CSV, Azure creation or the task CLI | [Generation and export](docs/engineering/generation.md) |
   | Time Log authentication, capacity, scheduling or combined generation | [Time Log](docs/engineering/time-log.md) |
   | Minhas tarefas, Azure polling, notifications or Fazer/card analysis | [My tasks and analysis](docs/engineering/my-tasks.md) |

3. Use the implementation map below to find the owner. Read command registrations
   in [lib.rs](src-tauri/src/lib.rs) and typed frontend signatures in
   [desktop.ts](src/desktop.ts), rather than maintaining another command catalog.
4. Run focused checks while iterating; finish with the validation policy below.

## Shared boundaries

- Rust owns Git, AI/network requests, filesystem access, subprocesses,
  configuration, CSV and Azure integrations. React owns presentation state.
  Bun installs/builds/tests the frontend; it is not the native runtime.
- [src/desktop.ts](src/desktop.ts) is the only React-to-Tauri invoke/event bridge.
  Keep [src/types.ts](src/types.ts) compatible with the Rust serialized DTOs.
  Prefer small typed commands to arbitrary path/command executors.
- Use argument arrays, explicit stdin and cwd through
  [process.rs](src-tauri/src/process.rs); never interpolate input into shell strings.
- Keep credentials out of saved nonsecret config, command responses, warnings
  and logs. Repeat privileged input, identity and provider checks in Rust.
- User-facing copy, prompts, validation and generated content use Brazilian
  Portuguese unless an external API requires a fixed value.
- Preserve partial successes and their warnings; detailed domain rules below
  define which side effects may follow a failure.

## Implementation map

| Responsibility | Owner |
| --- | --- |
| Native initialization, GUI PATH repair, command registry | [lib.rs](src-tauri/src/lib.rs) |
| Setup and generation orchestration, progress, CSV registry | [commands.rs](src-tauri/src/commands.rs) |
| Git root, payload and safe staging | [git.rs](src-tauri/src/git.rs) |
| Provider execution, prompt/schema and model discovery | [ai.rs](src-tauri/src/ai.rs), [ai/catalog.rs](src-tauri/src/ai/catalog.rs) |
| CSV projection and sequential Azure creation | [export.rs](src-tauri/src/export.rs) |
| Compatible config, PAT and prompt stores | [config.rs](src-tauri/src/config.rs) |
| Shared task CLI adapter | [cli.rs](src-tauri/src/cli.rs), [bin/infortech.rs](src-tauri/src/bin/infortech.rs) |
| Shared Time Log protocol and pure interval planner | [time_log.rs](src-tauri/src/time_log.rs), [time_log/batch.rs](src-tauri/src/time_log/batch.rs) |
| Polling, cache, notifications and account transitions | [azure_tasks.rs](src-tauri/src/azure_tasks.rs) |
| Azure Boards reads and plan-only Codex execution | [azure_boards.rs](src-tauri/src/azure_boards.rs), [card_analysis.rs](src-tauri/src/card_analysis.rs) |
| Desktop workflow and domain panels | [App.tsx](src/App.tsx), [TimeLogPanel.tsx](src/TimeLogPanel.tsx), [PromptPanel.tsx](src/PromptPanel.tsx), [MyTasksPanel.tsx](src/MyTasksPanel.tsx) |

[README.md](README.md) contains setup and operating instructions. The documents
under [docs/architecture](docs/architecture/README.md) are proposed work packets,
not a description of the current implementation or authorization to refactor it.

## Validation and style

- [package.json](package.json) is the source for runnable commands. Use
  `bun run validate:frontend` or `bun run validate:rust` for the affected layer;
  `bun run validate` runs the complete gate. The desktop CI workflow is
  [.github/workflows/build-desktop.yml](.github/workflows/build-desktop.yml).
- In parallel work, each agent runs focused checks for its changes; the main
  agent runs the complete gate once after integration. Repeat only when further
  changes, failures or unresolved concerns justify it.
- Frontend tests use Vitest, Testing Library and jsdom with `src/desktop.ts`
  mocked. Rust tests use temporary repositories, loopback HTTP servers and local
  fake executables with captured arguments/stdin. Tests never call real OpenAI,
  Codex generation or Azure services.
- Rust uses rustfmt and Clippy with warnings as errors; keep process/filesystem
  errors contextual. TypeScript is strict, uses ES modules, tabs, double quotes
  and Biome. Follow the checked-in formatter configuration.
