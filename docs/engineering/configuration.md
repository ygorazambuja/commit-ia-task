# Configuration and providers

Read this contract before changing setup, persisted state, credentials, prompts,
model discovery or AI execution. Owners: `config.rs`, `commands.rs`, `ai.rs`,
`ai/catalog.rs`, `App.tsx`, `SettingsPanel.tsx` and `PromptPanel.tsx`.

## Persistence and startup

- `OPENAI_API_KEY`: fallback OpenAI credential when the user does not enter an in-memory session key.
- `CODEX_MODEL`: optional Codex CLI model override.
- `COMMIT_IA_TASK_CONFIG_DIR`: alternate directory for `config.json`.
- `ADO_PAT` / `ADO_TOKEN`: mutually exclusive Time Log Free credentials.
- `ADO_ORG`: default Time Log organization for the CLI; accepts a slug or Azure DevOps URL.
- `ADO_USER_NAME` / `ADO_USER_ID`: optional explicit Time Log identity; use both together.
- `ADO_EXTENSION_API_VERSION` and `ADO_TIMEOUT`: optional Time Log API version and request timeout.

The OpenAI key entered in the UI must remain in memory only and be cleared from the form when submitted. A Time Log PAT is optional, is entered only in Settings, persisted only by Rust, and cleared from the UI after verification, saving, cancellation, or skipping setup.

The default configuration file intentionally reuses the legacy location:

- macOS: `~/Library/Application Support/commit-ia-task/config.json`;
- Windows: `%APPDATA%\commit-ia-task\config.json`;
- Linux: `$XDG_CONFIG_HOME/commit-ia-task/config.json` or `~/.config/commit-ia-task/config.json`.

When `COMMIT_IA_TASK_CONFIG_DIR` is set, append `config.json` to that directory. Serde defaults keep legacy configuration compatible. Persist repository, Sprint, Area, assignee, contract item, provider, and Azure organization/project. Persist the Time Log PAT separately in `time-log.json` in the same directory; do not expose it through `SavedConfig`, command responses, warnings, or logs. Do not persist the API key or direct-Azure toggle.

Persist the shared generation instructions as `{ systemPrompt }` in `prompts.json`
in the same directory. Missing prompts use the Rust default; invalid or unreadable
prompts use that default with visible warnings and do not require onboarding.
Load one prompt snapshot per generation. Saving prompts must not alter SavedConfig,
the automatic file/diff payload, the structured schema, or provider execution restrictions.

The first-run and repair defaults are `Ygor Azambuja`,
`ygor.azambuja@infortechms.com.br`, `https://dev.azure.com/InfortechMS`, and
`SPF-SIAFIC`. A complete saved configuration takes precedence over these fixed
defaults. Missing, incomplete, or corrupt configuration requires onboarding;
there is no onboarding-version marker. Do not import or overwrite organization
or project from `az devops configure -l` during startup.

Keep `SavedConfig` compatible and store the assignee as `Name <email>`. Setup
and generation must validate a nonempty name, a syntactically valid email ending
case-insensitively in `@infortechms.com.br`, a nonempty project, and an Azure
organization slug or `https://dev.azure.com/<org>` normalized to its canonical
URL. `InitialState` exposes `requiresOnboarding`,
`profile: { displayName, email }`, `timeLogPatConfigured`, and
`codexAuthenticated` in addition to the existing fields.

Configuration read/deserialize failures fall back to the fixed defaults, require repair onboarding, and are returned in `InitialState.warnings` for visible display. Configuration save failures are nonfatal to generation and are returned in `GenerationResult.warnings`. Preserve both warning paths in the UI.

On fresh or repair setup, prefer Codex only when the executable exists and
`codex login status` succeeds, then OpenAI when configured. If neither is ready,
select OpenAI and show the pending requirement without blocking settings save.

## Settings and frontend state

- Reuse one non-modal screen for onboarding and later Settings edits. Keep the
  workspace and prompt drafts mounted across Settings and tab switches.
- Skip for now writes nothing, opens the workspace with a reminder and requires
  onboarding on the next launch unless a later generation saves valid settings.
- Saving Settings merges only stable profile, Azure and provider fields,
  preserving repository, Sprint, Area and contract item.
- Reject a new PAT combined with `removeTimeLogPat`. Reverify a new PAT in Rust
  before persisting it. Save main configuration first: its failure keeps Settings
  open; a later PAT save/removal failure completes onboarding with a visible warning.
- Changing PAT or organization invalidates UI verification. Expose only whether
  an existing PAT is configured and its replace/remove actions.
- Verify PATs via Azure `connectionData`; reject `System:PublicAccess`, all-`a`
  identities and `Anonymous`, including HTTP 200 responses. Email is best effort;
  do not add Graph/Profile scopes for onboarding. Fill only empty/invalid profile
  fields from the verified identity, preserving each valid manually entered value.
  Missing/noncorporate email still requires manual corporate email.
- Prompt saving rejects blank instructions and preserves exact nonblank text.
  Initial state returns saved instructions and the Rust default. Restore defaults
  changes the draft until saved; saved changes apply to the next generation.
- Settings changes invalidate the task monitor before and after saving. Follow
  [the account-transition rules](my-tasks.md) when changing this lifecycle.

## AI models and execution

- `ai.rs` owns the shared Portuguese task prompt/schema; `ai/catalog.rs` owns
  discovery. OpenAI uses `GET /v1/models` with a 10-second HTTP timeout; Codex uses
  paginated app-server `model/list` with a 15-second total timeout and guaranteed
  process cleanup. Task generation still uses Codex exec.
- Keep `gpt-6-luna` as the initial default. The local fallback includes GPT-5.6
  Luna/Terra/Sol and GPT-6.1 Sol. Codex Spark is absent from fallback options while
  saved IDs remain readable.
- Preserve syntactically valid model/effort IDs on load/save. Before generation
  or card analysis, requery the current credential's catalog and require the
  selected model/effort. Discovery failure validates against the local fallback
  with visible warnings. Never silently substitute a model or retry with another.
- Catalog results own their model descriptors, source and warnings. Persist
  neither credentials nor catalogs. A temporary OpenAI key takes precedence over
  the environment. UI refreshes on startup/Settings, debounces key edits by 800 ms,
  discards stale responses and preserves the last session catalog on failure.
  Codex effort options come from each model; new OpenAI candidates are marked
  compatibility unverified.
- OpenAI Responses uses the configured model, `store: false` and structured output.
  Codex executes ephemeral, read-only and never-approve. Require both its
  executable and authenticated session at startup, and check again at execution.
- Card analysis has additional execution restrictions in [My tasks](my-tasks.md).
