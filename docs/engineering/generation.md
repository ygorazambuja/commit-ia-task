# Generation and export

Read this contract before changing Git inspection/staging, task generation, CSV,
Azure work-item creation or the `infortech` CLI. Owners: `git.rs`, `commands.rs`,
`export.rs`, `models.rs`, `cli.rs` and `App.tsx`.
For providers/configuration also read [Configuration](configuration.md); for
combined registration read [Time Log](time-log.md).

## Workflow and gates

- Native folder selection resolves any selected subdirectory to its Git root.
  Inspection discovers untracked, staged, unstaged and mixed files.
- UI generation is gated while bootstrapping, inspecting or already running and
  requires a repository. Submit requires repository, Sprint, Area and contract
  item; assignee comes from saved Settings as `Name <corporate-email>`.
- OpenAI requires a per-execution key or detected `OPENAI_API_KEY`; Codex requires
  executable plus authenticated session. Rust independently repeats required-field,
  corporate-assignee and provider validation, including Codex at generation time.
- Direct Azure creation requires `createAzureTasks` and a positive parent ID.
  A Task cannot be the parent. Organization/project arguments remain optional
  because Azure CLI defaults may supply them. Direct creation requires Azure CLI
  with the azure-devops extension; CSV-only export does not.
- `run_generation` emits `generation-progress`, saves nonsecret configuration,
  processes files independently, stages safe successes and writes/registers CSV
  before optional Azure creation. Combined Time Log additionally requires
  `registerTimeLog` and an inclusive start/end date interval.
- Display generated tasks, per-file failures, stage state, CSV path, configuration
  warnings, Azure IDs/partial error and any requested Time Log plan/result,
  including missing capacity.
- `reveal_generated_csv` accepts only canonical existing `tasks-*.csv` paths in
  Rust's `GeneratedCsvRegistry`, recorded after generation in this native session.
  Filename and directory checks alone do not authorize arbitrary file access.

## Task CLI

- `cli.rs` / `bin/infortech.rs` expose noninteractive inspect/generate without
  Tauri windows. Reuse `commands.rs` orchestration and the desktop config/prompts;
  do not duplicate Git, AI, CSV or Azure rules in the adapter.
- Persist nonsecret configuration only with `--save-config`. Keep stdout JSON
  and progress on stderr. Exit 2 reports partial generation; preserve CSV and
  Azure IDs. Azure creation needs explicit `--create-azure-tasks` and positive
  `--parent`.

## Git processing

- Ignore lock files by basename: `pnpm-lock.yaml`, `bun.lockb`, and `package-lock.json`.
- Use the full current file for untracked/new files.
- Use cached diff for staged-only files and working-tree diff for unstaged-only files.
- Mixed files must include separate staged and unstaged sections.
- An empty diff may fall back to the full file.
- Reject symlinks that resolve outside the repository.
- Pass pathspecs after `--` and pass subprocess arguments as arrays.
- Failures are per file; one payload or AI failure must not stop other files.
- After successful AI generation, stage the complete file only if its payload is unchanged.
- A stage failure does not discard its tasks; include them in the CSV and report `staged: false`.
- If every changed file fails before producing tasks, fail without creating a CSV.
- A clean repository may produce a header-only CSV.
- Automatic staging is intentional application behavior; tests must verify safety around pre-existing staged content and concurrent edits.

## CSV and Azure

CSV headers, in order:

```text
ID, Work Item Type, Title, Assigned To, State, Area ID, Iteration ID,
Item Contrato, ID SPF, UST, Complexidade, Activity, Description,
Estimate Made, Remaining Work, Original Estimate
```

Fixed values:

- `Work Item Type`: `Task`;
- `State`: `To Do`;
- `Activity`: `Development`;
- normalized estimate: integer 1 through 8, otherwise 1; reuse it for `Estimate Made`, `Remaining Work`, and `Original Estimate`.

SPF mapping:

- Backend → 17;
- Frontend → 19;
- Testes → 22.

UST mapping:

- BAIXA → 8;
- MEDIA → 24;
- ALTA → 40;
- ÚNICA or normalized fallback → 8.

Write the CSV before attempting Azure creation. Use `tasks-{day}-{month}-{hour}-{minute}.csv`, adding numeric suffixes instead of overwriting an existing file.

Direct Azure creation sends title, description, assignee, state, area, iteration, activity, original estimate, and remaining work. It does not send `Item Contrato`, `ID SPF`, `UST`, `Complexidade`, or a separate `Estimate Made`; those remain CSV-only fields.

Direct Azure creation requires the parent work item to be validated before the first Task is created, and every created Task must be linked to it. Create Azure items sequentially. On the first Azure failure, keep the CSV, staging results, and IDs already created, return the error, and skip any requested combined Time Log registration.
