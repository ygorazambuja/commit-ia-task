# Time Log

Read this contract before changing manual/combined Time Log registration, its
credentials, scheduling or CLI. Owners: `time_log.rs`, the pure side-effect-free
planner `time_log/batch.rs`, `commands.rs`, `bin/timelog-bot.rs` and `TimeLogPanel.tsx`.
For PAT storage/verification also read [Configuration](configuration.md).

## Service boundary and credentials

- Reuse the shared Rust protocol for validation, organization normalization,
  authentication, identity, balance lookup, planning and sequential document
  creation from desktop and CLI. React owns only the visual form and submit state.
- The desktop form exposes entry-specific fields only; organization comes from
  Settings. Rust resolves the saved PAT first, then mutually exclusive `ADO_PAT`
  or Microsoft Entra `ADO_TOKEN`. PATs need Extension Data read/write scope.
- Keep optional in-memory credential DTO fields for CLI/backend compatibility,
  but do not send them from the desktop form. Persist only PATs separately from
  `SavedConfig`; return no credential value to React or in errors/logs.
- Do not retry failed/indeterminate POSTs automatically: the extension has no
  idempotency key. Time Log changes only extension data and must not update
  `CompletedWork` or `RemainingWork`.

## Scheduling

- Supported entry types are `Backend`, `Frontend`, and `Teste`. Generated task types map from Backend, Frontend, and Testes respectively.
- In combined generation, convert every normalized generated estimate to minutes, use the task title as its comment, and register all entries on the required parent work item rather than on the newly created Tasks.
- The start and end dates are inclusive, the start must not follow the end, and neither endpoint may be in the future.
- Allocate only Monday through Friday. Do not add a holiday calendar: a holiday that falls on a weekday is treated as available capacity.
- The daily ceiling is 420 minutes globally for the PAT-authenticated user, across every work item and entry type. Query and subtract all existing Time Log documents for that user on each date before planning new entries.
- Preserve every requested minute. Never truncate work to fit: if the inclusive interval lacks capacity, return the plan and missing minutes with zero POST attempts.
- Query existing usage again immediately before the first POST as a best-effort concurrency guard. If the second plan no longer fits, make no POST.
- Combined generation may run Time Log only after every requested Azure Task has been created and linked. Any partial Azure creation skips Time Log while preserving the CSV, staging results, and Azure IDs already created.
- Create planned Time Log documents sequentially. On the first rejected, failed, or indeterminate POST, stop; preserve the confirmed documents, report the failed and pending entries, and never retry automatically.
- The CLI keeps `--date` as the required start date and accepts optional inclusive `--end-date`, defaulting it to `--date`. `--dry-run` must authenticate, query the existing global usage, and print the resulting plan without any POST.
