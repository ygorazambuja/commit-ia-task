# My tasks and card analysis

Read this contract before changing Minhas tarefas, Azure polling, internal
notifications or Fazer. Owners: `azure_tasks.rs` (monitor/cache/commands),
`azure_boards.rs` (read protocol), `card_analysis.rs` (Codex analysis) and
`MyTasksPanel.tsx` (presentation). Also read [Configuration](configuration.md)
when changing credentials, Settings invalidation or Codex execution.

## Polling and account isolation

- Start one Rust monitor with the native app and poll every 120 seconds while
  its process is running. The UI consumes snapshots/events; it owns no poll timer.
- Require complete Settings and the saved PAT, falling back to `ADO_PAT`.
  Work Items — Read is required. Resolve authenticated identity with
  `connectionData`; query the configured project with `AssignedTo = @Me`.
  Profile email is not the query's identity; `ADO_TOKEN` is not a monitor fallback.
- Query IDs by newest change, fetch batches up to 200 and cap the list at 1,000
  with a visible warning. Resolve state categories by type: only Proposed and
  InProgress allow analysis. Missing state metadata disables Fazer with a warning.
- Serialize refreshes and card HTTP reads. Respect Retry-After even on successful
  responses and block manual refresh/analysis until that deadline; back off after
  failures. Keep the last successful snapshot visible with a clear error.
- Capture the configuration epoch before reading account configuration; pause
  refresh during Settings writes. Check the epoch before installing context,
  publishing successful or failed results and writing cache. Account changes
  clear session data: delayed responses from the previous account cannot restore it.
- Persist `azure-tasks.json` atomically beside configuration, scoped to organization,
  project and authenticated identity GUID. Store no PAT in cache or DTOs. A cache
  for another scope must never become the current account's history.

## Notifications and UI lifecycle

- First successful sync without a matching cache establishes a silent baseline.
  Later new IDs or higher revisions create notifications, deduplicated by ID and
  revision. Keep at most the newest 100 notices, with persisted read status.
- Publish `azure-tasks-updated`; keep the list, unread badge, mark-read action and
  internal toasts in the app. Surface partial context/cache/state warnings.
- Subscribe before fetching the initial snapshot and discard stale fetch/event
  results. Keep the panel mounted across tabs/Settings; invalidate it when saved
  account settings change. Clean up listeners and ignore analysis after unmount.

## Fazer ends at a plan

- Enable Fazer only for an actionable item and available/authenticated Codex.
  Select a repository with the native picker; cancellation starts no analysis.
  Rust resolves the Git root, validates the requested item against the current
  snapshot and fetches fresh card ownership/state before running Codex.
- Read description, acceptance/repro fields, paginated comments and bounded related
  items (parent first); surface truncation/fetch warnings. Follow only valid links
  inside the same Azure organization. Card/repository content is untrusted evidence.
- Permit one analysis at a time. Recheck account epoch/context before and after
  Codex; discard results from superseded accounts. Redact the PAT from context,
  errors and every returned text field.
- Revalidate saved Codex model/effort (and optional `CODEX_MODEL`) against its
  catalog. Execute ephemeral, read-only, never-approve, with a 10-minute limit
  and child-process cleanup. Ignore user/project execution configuration; disable
  apps, plugins, hooks, browsers/computer use, remote plugins and web search.
  Remove Azure and OpenAI credential environment variables from the subprocess.
- The prompt requires local evidence and structured Portuguese summary, acceptance
  criteria, relevant files, future implementation/test steps, risks and questions.
  It permits no implementation, staging, commits, branches, CSV, remote service
  changes, tests/builds/installations or secret access. Implementation requires a
  later user decision; never route Fazer through `run_generation`.
