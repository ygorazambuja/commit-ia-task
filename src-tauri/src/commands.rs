use crate::ai;
use crate::config;
use crate::export;
use crate::git;
use crate::models::{
    AiProvider, AzureUserIdentity, FileFailure, GeneratedFile, GenerationInput, GenerationPhase,
    GenerationProgress, GenerationResult, InitialState, PromptSettings, RepositoryInspection,
    SaveAppSettingsInput, SaveAppSettingsResult, SavedConfig, Task, TaskType, TimeLogCommandInput,
    TimeLogCredentialKind as TimeLogCommandCredentialKind, TimeLogResult, TimeLogRetryInput,
};
use crate::time_log::{
    TimeLogBatchInput, TimeLogBatchResult, TimeLogCredential, TimeLogCredentialKind,
    TimeLogService, TimeLogType, TimeLogWork,
};
use anyhow::{Result, bail};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::task::{Id, JoinSet};

#[derive(Default)]
pub struct GeneratedCsvRegistry(Mutex<HashSet<PathBuf>>);

impl GeneratedCsvRegistry {
    fn record(&self, path: &Path) -> Result<()> {
        let path = path.canonicalize()?;
        self.0
            .lock()
            .map_err(|_| anyhow::anyhow!("O registro de arquivos CSV está indisponível"))?
            .insert(path);
        Ok(())
    }

    fn contains(&self, path: &Path) -> Result<bool> {
        Ok(self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("O registro de arquivos CSV está indisponível"))?
            .contains(path))
    }
}

#[tauri::command]
pub async fn get_initial_state(app: AppHandle) -> Result<InitialState, String> {
    let provider_readiness = ai::inspect_provider_readiness(None).await;
    let configuration = config::load_initial(&app, provider_readiness.preferred_provider());
    let ai_providers = provider_readiness.capabilities();
    Ok(InitialState {
        config: configuration.config,
        prompt_settings: configuration.prompt_settings,
        default_system_prompt: ai::DEFAULT_SYSTEM_PROMPT.to_owned(),
        ai_providers,
        requires_onboarding: configuration.requires_onboarding,
        profile: configuration.profile,
        openai_configured: provider_readiness.openai_configured,
        codex_available: provider_readiness.codex_available,
        codex_authenticated: provider_readiness.codex_authenticated,
        codex_version: provider_readiness.codex_version,
        time_log_pat_configured: configuration.time_log_pat_configured,
        azure_defaults: configuration.azure_defaults,
        warnings: configuration.warnings,
    })
}

#[tauri::command]
pub async fn list_ai_models(
    app: AppHandle,
    provider: AiProvider,
    api_key: Option<String>,
) -> ai::catalog::AiModelCatalog {
    match provider {
        AiProvider::Openai => {
            let saved = config::load_initial(&app, ai::DEFAULT_AI_PROVIDER).config;
            let key = ai::resolve_openai_api_key(
                api_key.as_deref(),
                std::env::var("OPENAI_API_KEY").ok(),
            );
            ai::catalog::openai_catalog(key.as_deref(), Some(&saved.openai_model)).await
        }
        AiProvider::Codex => ai::catalog::codex_catalog("codex").await,
    }
}

#[tauri::command]
pub async fn identify_azure_user(
    organization: String,
    pat: String,
) -> Result<AzureUserIdentity, String> {
    identify_azure_user_with_pat(&organization, &pat).await
}

#[tauri::command]
pub async fn save_app_settings(
    app: AppHandle,
    input: SaveAppSettingsInput,
) -> Result<SaveAppSettingsResult, String> {
    crate::azure_tasks::configuration_changed(&app, true).await;
    let result = config::save_settings(&app, &input, |organization, pat| {
        verify_time_log_pat(organization, pat, None)
    })
    .await
    .map_err(display_error);
    crate::azure_tasks::configuration_changed(&app, false).await;
    result
}

#[tauri::command]
pub async fn save_prompt_settings(
    app: AppHandle,
    input: PromptSettings,
) -> Result<PromptSettings, String> {
    config::save_prompt_settings(&app, &input).map_err(display_error)
}

async fn identify_azure_user_with_pat(
    organization: &str,
    pat: &str,
) -> Result<AzureUserIdentity, String> {
    let user = time_log_service_with_pat(organization, pat)?
        .identify_user()
        .await?;
    Ok(AzureUserIdentity {
        display_name: user.display_name,
        email: user.email,
    })
}

fn time_log_service_with_pat(organization: &str, pat: &str) -> Result<TimeLogService, String> {
    TimeLogService::from_credential(organization, TimeLogCredential::pat(pat)?)
}

async fn verify_time_log_pat(
    organization: String,
    pat: String,
    base_url: Option<reqwest::Url>,
) -> Result<(), String> {
    let service = time_log_service_with_pat(&organization, &pat)?;
    let service = match base_url {
        Some(base_url) => service.with_base_url(base_url),
        None => service,
    };
    service.identify_user().await.map(|_| ())
}

#[tauri::command]
pub async fn inspect_repository(repository_path: String) -> Result<RepositoryInspection, String> {
    let (inspection, _) = git::inspect(Path::new(repository_path.trim()))
        .await
        .map_err(display_error)?;
    Ok(inspection)
}

#[tauri::command]
pub async fn create_time_log(
    app: AppHandle,
    input: TimeLogCommandInput,
) -> Result<TimeLogResult, String> {
    let stored_pat = config::load_time_log_pat(&app).map_err(display_error)?;
    create_time_log_with_stored_pat(input, stored_pat.as_deref(), None).await
}

#[cfg(test)]
async fn create_time_log_from_store<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    input: TimeLogCommandInput,
    base_url: Option<reqwest::Url>,
) -> Result<TimeLogResult, String> {
    let stored_pat = config::load_time_log_pat_at(app, path).map_err(display_error)?;
    create_time_log_with_stored_pat(input, stored_pat.as_deref(), base_url).await
}

async fn create_time_log_with_stored_pat(
    input: TimeLogCommandInput,
    stored_pat: Option<&str>,
    base_url: Option<reqwest::Url>,
) -> Result<TimeLogResult, String> {
    let explicit_kind = input.credential_kind.map(|kind| match kind {
        TimeLogCommandCredentialKind::Pat => TimeLogCredentialKind::Pat,
        TimeLogCommandCredentialKind::Bearer => TimeLogCredentialKind::Bearer,
    });
    let credential =
        TimeLogCredential::resolve(input.credential.as_deref(), explicit_kind, stored_pat)?;
    let service = TimeLogService::from_credential(&input.organization, credential)?;
    let service = match base_url {
        Some(base_url) => service.with_base_url(base_url),
        None => service,
    };
    service
        .create_batch(&TimeLogBatchInput {
            work_item_id: input.work_item_id,
            start_date: input.start_date,
            end_date: input.end_date,
            work: input.work,
        })
        .await
}

#[tauri::command]
pub async fn choose_repository(app: AppHandle) -> Result<Option<String>, String> {
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected = selected.into_path().map_err(display_error)?;
    let repository = git::resolve_repository(&selected)
        .await
        .map_err(display_error)?;
    Ok(Some(repository.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn reveal_generated_csv(
    app: AppHandle,
    csv_path: String,
    generated_csvs: State<'_, GeneratedCsvRegistry>,
) -> Result<(), String> {
    let csv = validate_generated_csv(Path::new(csv_path.trim()), &generated_csvs)
        .map_err(display_error)?;
    app.opener().reveal_item_in_dir(csv).map_err(display_error)
}

fn validate_generated_csv(csv: &Path, generated_csvs: &GeneratedCsvRegistry) -> Result<PathBuf> {
    let csv = csv.canonicalize()?;
    let valid_name = csv
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("tasks-") && name.ends_with(".csv"));

    if !csv.is_file() || !valid_name || !generated_csvs.contains(&csv)? {
        bail!("O caminho informado não é um CSV gerado nesta sessão");
    }

    Ok(csv)
}

#[tauri::command]
pub async fn run_generation(
    app: AppHandle,
    input: GenerationInput,
    generated_csvs: State<'_, GeneratedCsvRegistry>,
) -> Result<GenerationResult, String> {
    execute_generation(&app, input, &generated_csvs)
        .await
        .map_err(display_error)
}

async fn execute_generation<R: Runtime>(
    app: &AppHandle<R>,
    input: GenerationInput,
    generated_csvs: &GeneratedCsvRegistry,
) -> Result<GenerationResult> {
    let time_log_options = input.clone();
    let config_app = app.clone();
    let (prompt_settings, prompt_warnings) = config::load_prompt_settings(app);
    let system_prompt = Arc::new(prompt_settings.system_prompt);
    let mut result = execute_generation_with(
        input,
        generated_csvs,
        move |saved_config| {
            let mut warnings = prompt_warnings;
            warnings.extend(config::persist_generation(&config_app, saved_config));
            warnings
        },
        move |selection, file, payload, repository| {
            let system_prompt = Arc::clone(&system_prompt);
            async move {
                selection
                    .generate_tasks(&file, &payload, &repository, &system_prompt)
                    .await
            }
        },
        |tasks, organization, project, parent_work_item_id| async move {
            export::create_azure_tasks(
                &tasks,
                &organization,
                &project,
                parent_work_item_id,
                |message, current, total| {
                    emit_progress(
                        app,
                        GenerationProgress::new(GenerationPhase::Azure, message, current, total),
                    );
                },
            )
            .await
        },
        |progress| emit_progress(app, progress),
    )
    .await?;

    if time_log_options.register_time_log {
        attach_generated_time_log(app, &time_log_options, &mut result).await;
        emit_progress(
            app,
            GenerationProgress::new(GenerationPhase::Completed, "Processo concluído.", 1, 1),
        );
    }

    Ok(result)
}

async fn attach_generated_time_log<R: Runtime>(
    app: &AppHandle<R>,
    input: &GenerationInput,
    result: &mut GenerationResult,
) {
    attach_generated_time_log_with(input, result, |command| {
        emit_progress(
            app,
            GenerationProgress::new(
                GenerationPhase::TimeLog,
                "Consultando saldo e registrando horas no Time Log...",
                0,
                0,
            ),
        );
        let stored_pat = config::load_time_log_pat(app).map_err(display_error);
        async move {
            let stored_pat = stored_pat?;
            create_time_log_with_stored_pat(command, stored_pat.as_deref(), None).await
        }
    })
    .await;
}

async fn attach_generated_time_log_with<Create, CreateFuture>(
    input: &GenerationInput,
    result: &mut GenerationResult,
    create_time_log: Create,
) where
    Create: FnOnce(TimeLogCommandInput) -> CreateFuture,
    CreateFuture: Future<Output = Result<TimeLogResult, String>>,
{
    if result.azure_error.is_some() {
        result.time_log_error = Some(
            "O Time Log não foi executado porque a criação das tarefas no Azure DevOps não foi concluída."
                .to_owned(),
        );
        return;
    }

    let Some(parent_id) = input.parent_work_item_id else {
        result.time_log_error = Some("O item pai não foi informado para o Time Log.".to_owned());
        return;
    };
    let Ok(work_item_id) = i32::try_from(parent_id) else {
        result.time_log_error =
            Some("O ID do item pai é grande demais para o Time Log Free.".to_owned());
        return;
    };

    let work = time_log_work_from_generated_files(&result.files);

    let retry_input = TimeLogRetryInput {
        work_item_id,
        start_date: input.time_log_start_date.clone(),
        end_date: input.time_log_end_date.clone(),
        work,
        organization: input.azure_organization.clone(),
    };

    if retry_input.work.is_empty() {
        result
            .warnings
            .push("Nenhuma hora para registrar.".to_owned());
        result.time_log_result = Some(TimeLogBatchResult::empty(
            retry_input.work_item_id,
            retry_input.start_date,
            retry_input.end_date,
        ));
        return;
    }

    result.time_log_retry_input = Some(retry_input.clone());
    let command = TimeLogCommandInput {
        work_item_id: retry_input.work_item_id,
        start_date: retry_input.start_date,
        end_date: retry_input.end_date,
        work: retry_input.work,
        organization: retry_input.organization,
        credential: None,
        credential_kind: None,
    };

    match create_time_log(command).await {
        Ok(time_log_result) => {
            if !time_log_result.retryable {
                result.time_log_retry_input = None;
            }
            result.time_log_result = Some(time_log_result);
        }
        Err(error) => result.time_log_error = Some(error),
    }
}

fn time_log_work_from_generated_files(files: &[GeneratedFile]) -> Vec<TimeLogWork> {
    files
        .iter()
        .flat_map(|file| &file.tasks)
        .map(|task| TimeLogWork {
            minutes: u32::from(match task.estimate_made {
                1..=8 => task.estimate_made,
                _ => 1,
            }) * 60,
            kind: match &task.tipo {
                TaskType::Backend => TimeLogType::Backend,
                TaskType::Frontend => TimeLogType::Frontend,
                TaskType::Testes => TimeLogType::Teste,
            },
            comment: task.title.trim().to_owned(),
        })
        .collect()
}

// ponytail: só efeitos externos são seams; as regras de ordem permanecem neste fluxo único.
pub(crate) async fn execute_generation_with<
    Save,
    Generate,
    GenerateFuture,
    CreateAzure,
    AzureFuture,
    Progress,
>(
    input: GenerationInput,
    generated_csvs: &GeneratedCsvRegistry,
    persist_config: Save,
    generate: Generate,
    create_azure: CreateAzure,
    mut progress: Progress,
) -> Result<GenerationResult>
where
    Save: FnOnce(SavedConfig) -> Vec<String> + Send,
    Generate:
        Fn(ai::AiSelection, PathBuf, String, PathBuf) -> GenerateFuture + Send + Sync + 'static,
    GenerateFuture: Future<Output = Result<Vec<Task>>> + Send + 'static,
    CreateAzure:
        FnOnce(Vec<export::DeliveryTask>, String, String, Option<u64>) -> AzureFuture + Send,
    AzureFuture: Future<Output = (Vec<u64>, Option<String>)> + Send,
    Progress: FnMut(GenerationProgress) + Send,
{
    progress(GenerationProgress::new(
        GenerationPhase::Preparing,
        "Validando configuração e disponibilidade do provedor de IA...",
        0,
        0,
    ));
    validate_input(&input)?;
    let has_time_log_step = input.register_time_log;
    let selection = ai::prepare_generation(&input).await?;
    progress(GenerationProgress::new(
        GenerationPhase::Preparing,
        "Inspecionando alterações do repositório...",
        0,
        0,
    ));
    let (inspection, changes) = git::inspect(Path::new(input.repository_path.trim())).await?;
    let repository = Path::new(&inspection.repository_path);

    let mut warnings = persist_config(input.saved_config(inspection.repository_path.clone()));
    warnings.extend(selection.warnings.clone());

    let total = changes.len();
    let generation_concurrency = selection.concurrency();
    let (files, failures) = process_files(
        changes,
        generation_concurrency,
        move |file, payload, repository| {
            let selection = selection.clone();
            generate(selection, file, payload, repository)
        },
        &mut progress,
    )
    .await;

    if total > 0 && files.is_empty() {
        let detail = failures
            .first()
            .map(|failure| format!(": {}", failure.error))
            .unwrap_or_default();
        bail!("Nenhum dos {total} arquivos alterados pôde ser processado{detail}");
    }

    progress(GenerationProgress::new(
        GenerationPhase::Exporting,
        "Gerando arquivo CSV...",
        0,
        1,
    ));
    let tasks = export::prepare_tasks(
        &files,
        &input.assigned_to,
        &input.area_path_id,
        &input.sprint_id,
    );
    let csv_path = export::write_csv(repository, &tasks, &input.item_contrato)?;
    generated_csvs.record(&csv_path)?;
    progress(GenerationProgress::new(
        GenerationPhase::Exporting,
        "Arquivo CSV salvo.",
        1,
        1,
    ));

    let (azure_task_ids, azure_error) = if input.create_azure_tasks {
        progress(GenerationProgress::new(
            GenerationPhase::Azure,
            "Preparando criação das tarefas no Azure DevOps...",
            0,
            tasks.len(),
        ));
        create_azure(
            tasks,
            input.azure_organization,
            input.azure_project,
            input.parent_work_item_id,
        )
        .await
    } else {
        (Vec::new(), None)
    };

    if !has_time_log_step {
        progress(GenerationProgress::new(
            GenerationPhase::Completed,
            "Processo concluído.",
            1,
            1,
        ));
    }
    Ok(GenerationResult {
        repository_path: inspection.repository_path,
        files,
        failures,
        csv_path: csv_path.to_string_lossy().into_owned(),
        azure_task_ids,
        azure_error,
        time_log_result: None,
        time_log_error: None,
        time_log_retry_input: None,
        warnings,
    })
}

async fn process_files<F, Fut, P>(
    changes: Vec<git::FileChange>,
    max_concurrency: usize,
    generate: F,
    mut progress: P,
) -> (Vec<GeneratedFile>, Vec<FileFailure>)
where
    F: Fn(PathBuf, String, PathBuf) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Vec<Task>>> + Send + 'static,
    P: FnMut(GenerationProgress),
{
    let total = changes.len();
    let generate = Arc::new(generate);
    let mut pending = changes.into_iter().enumerate();
    let mut jobs: JoinSet<Result<(git::AnalyzedChange, Vec<Task>)>> = JoinSet::new();
    let mut active = HashMap::<Id, (usize, String)>::new();
    let mut outcomes = Vec::with_capacity(total);

    loop {
        while jobs.len() < max_concurrency.max(1) {
            let Some((index, file)) = pending.next() else {
                break;
            };

            let relative_path = file.relative_path().to_owned();
            let generate = Arc::clone(&generate);
            let handle = jobs.spawn(async move {
                let analyzed = file.analyze().await?;
                let tasks = generate(
                    analyzed.absolute_path(),
                    analyzed.payload().to_owned(),
                    analyzed.repository().to_path_buf(),
                )
                .await?;
                Ok((analyzed, tasks))
            });
            active.insert(handle.id(), (index, relative_path.clone()));
            progress(generation_file_progress(
                format!("Gerando tarefas para {relative_path}..."),
                outcomes.len(),
                total,
                &active,
            ));
        }

        let Some(joined) = jobs.join_next_with_id().await else {
            break;
        };

        let (index, relative_path, outcome) = match joined {
            Ok((id, outcome)) => {
                let (index, relative_path) = active
                    .remove(&id)
                    .expect("a geração concluída deve estar registrada");
                (index, relative_path, outcome)
            }
            Err(error) => {
                let (index, relative_path) = active
                    .remove(&error.id())
                    .expect("a geração interrompida deve estar registrada");
                (
                    index,
                    relative_path,
                    Err(anyhow::anyhow!("A geração foi interrompida: {error}")),
                )
            }
        };
        let message = match &outcome {
            Ok((_, tasks)) => format!("{} tarefa(s) gerada(s) para {relative_path}.", tasks.len()),
            Err(_) => format!("Falha ao gerar tarefas para {relative_path}."),
        };
        outcomes.push((index, relative_path, outcome));
        progress(generation_file_progress(
            message,
            outcomes.len(),
            total,
            &active,
        ));
    }

    outcomes.sort_by_key(|(index, _, _)| *index);
    let mut files = Vec::new();
    let mut failures = Vec::new();
    let stage_total = outcomes
        .iter()
        .filter(|(_, _, outcome)| outcome.is_ok())
        .count();

    for (_, relative_path, outcome) in outcomes {
        let (analyzed, tasks) = match outcome {
            Ok(generated) => generated,
            Err(error) => {
                failures.push(FileFailure {
                    relative_path,
                    error: display_error(error),
                });
                continue;
            }
        };

        let full_file_path = analyzed.absolute_path().to_string_lossy().into_owned();
        let relative_path = analyzed.relative_path().to_owned();
        let mut stage_progress = GenerationProgress::new(
            GenerationPhase::Staging,
            format!("Conferindo alterações e adicionando {relative_path} ao stage..."),
            files.len(),
            stage_total,
        );
        stage_progress.active_files.push(relative_path.clone());
        progress(stage_progress);
        let stage_result = analyzed.stage().await;
        progress(GenerationProgress::new(
            GenerationPhase::Staging,
            if stage_result.is_ok() {
                format!("{relative_path} adicionado ao stage.")
            } else {
                format!("Stage de {relative_path} não realizado; as tarefas foram preservadas.")
            },
            files.len() + 1,
            stage_total,
        ));
        files.push(GeneratedFile {
            full_file_path,
            relative_path,
            tasks,
            staged: stage_result.is_ok(),
            stage_error: stage_result.err().map(display_error),
        });
    }

    (files, failures)
}

fn generation_file_progress(
    message: String,
    current: usize,
    total: usize,
    active: &HashMap<Id, (usize, String)>,
) -> GenerationProgress {
    let mut files = active.values().collect::<Vec<_>>();
    files.sort_by_key(|(index, _)| *index);
    let mut progress =
        GenerationProgress::new(GenerationPhase::Generating, message, current, total);
    progress.active_files = files.into_iter().map(|(_, path)| path.clone()).collect();
    progress
}

fn validate_input(input: &GenerationInput) -> Result<()> {
    if input.repository_path.trim().is_empty() {
        bail!("Selecione um repositório Git");
    }
    for (label, value) in [
        ("Sprint", input.sprint_id.as_str()),
        ("Área", input.area_path_id.as_str()),
        ("Item de contrato", input.item_contrato.as_str()),
    ] {
        if value.trim().is_empty() {
            bail!("O campo {label} é obrigatório");
        }
    }
    config::validate_assigned_to(&input.assigned_to)?;
    if input.parent_work_item_id == Some(0) {
        bail!("O ID do item pai deve ser maior que zero");
    }
    if input.parent_work_item_id.is_some() && !input.create_azure_tasks {
        bail!("O item pai só pode ser informado ao criar tarefas no Azure DevOps");
    }
    if input.create_azure_tasks && input.parent_work_item_id.is_none() {
        bail!("O ID do item pai é obrigatório ao criar tarefas no Azure DevOps");
    }
    if input.register_time_log && !input.create_azure_tasks {
        bail!("O Time Log só pode ser registrado junto com a criação no Azure DevOps");
    }
    if input.register_time_log {
        let parent_id = input
            .parent_work_item_id
            .expect("o item pai foi validado antes do Time Log");
        let work_item_id = i32::try_from(parent_id).map_err(|_| {
            anyhow::anyhow!("O ID do item pai é grande demais para o Time Log Free")
        })?;
        crate::time_log::canonical_organization_url(&input.azure_organization)
            .map_err(anyhow::Error::msg)?;
        crate::time_log::plan_time_logs(
            &TimeLogBatchInput {
                work_item_id,
                start_date: input.time_log_start_date.clone(),
                end_date: input.time_log_end_date.clone(),
                work: Vec::new(),
            },
            &BTreeMap::new(),
            chrono::Local::now().date_naive(),
        )
        .map_err(anyhow::Error::msg)?;
    }
    Ok(())
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, progress: GenerationProgress) {
    let _ = app.emit("generation-progress", progress);
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AiProvider, DEFAULT_ASSIGNED_TO, Task, TaskType};
    use reqwest::{Url, header::AUTHORIZATION};
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
    use tempfile::tempdir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    const TEST_GENERATION_CONCURRENCY: usize = 2;

    fn valid_input() -> GenerationInput {
        GenerationInput {
            repository_path: "/repo".to_owned(),
            sprint_id: "Sprint".to_owned(),
            area_path_id: "Área".to_owned(),
            assigned_to: DEFAULT_ASSIGNED_TO.to_owned(),
            item_contrato: "Item 1".to_owned(),
            ai_provider: AiProvider::Openai,
            openai_model: "gpt-5-nano".to_owned(),
            codex_model: "gpt-5.6-luna".to_owned(),
            codex_reasoning_effort: "low".to_owned(),
            api_key: Some("secret".to_owned()),
            create_azure_tasks: false,
            register_time_log: false,
            time_log_start_date: String::new(),
            time_log_end_date: String::new(),
            parent_work_item_id: None,
            azure_organization: String::new(),
            azure_project: String::new(),
        }
    }

    fn valid_time_log_input() -> TimeLogCommandInput {
        TimeLogCommandInput {
            work_item_id: 201878,
            start_date: "2026-08-12".to_owned(),
            end_date: "2026-08-12".to_owned(),
            work: vec![TimeLogWork {
                minutes: 150,
                kind: crate::time_log::TimeLogType::Frontend,
                comment: "Implementei a integração".to_owned(),
            }],
            organization: "https://dev.azure.com/empresa".to_owned(),
            credential: Some("segredo".to_owned()),
            credential_kind: Some(TimeLogCommandCredentialKind::Pat),
        }
    }

    fn combined_generation_input() -> GenerationInput {
        let mut input = valid_input();
        input.create_azure_tasks = true;
        input.register_time_log = true;
        input.parent_work_item_id = Some(201878);
        input.azure_organization = "https://dev.azure.com/empresa".into();
        input.time_log_start_date = "2026-08-12".into();
        input.time_log_end_date = "2026-08-12".into();
        input
    }

    fn generation_result_with_tasks(tasks: Vec<Task>) -> GenerationResult {
        GenerationResult {
            repository_path: "/repo".into(),
            files: if tasks.is_empty() {
                Vec::new()
            } else {
                vec![GeneratedFile {
                    full_file_path: "/repo/file.ts".into(),
                    relative_path: "file.ts".into(),
                    tasks,
                    staged: true,
                    stage_error: None,
                }]
            },
            failures: Vec::new(),
            csv_path: "/repo/tasks.csv".into(),
            azure_task_ids: vec![701],
            azure_error: None,
            time_log_result: None,
            time_log_error: None,
            time_log_retry_input: None,
            warnings: Vec::new(),
        }
    }

    fn backend_task(hours: u8) -> Task {
        Task {
            title: "Implementar API".into(),
            description: "Descrição".into(),
            tipo: TaskType::Backend,
            complexidade: "BAIXA".into(),
            estimate_made: hours,
        }
    }

    fn test_app() -> tauri::App<MockRuntime> {
        mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(mock_context(noop_assets()))
            .expect("test app")
    }

    fn seed_time_log_pat(path: &Path, pat: &str) {
        fs::write(
            path,
            serde_json::to_vec(&serde_json::json!({ "adoPat": pat })).unwrap(),
        )
        .unwrap();
    }

    struct ExpectedRequest {
        prefix: String,
        authorization: String,
        response: String,
        expected_store: Option<(PathBuf, Option<Vec<u8>>)>,
    }

    fn expected_pat_request(prefix: &str, pat: &str, response: String) -> ExpectedRequest {
        let request = reqwest::Client::new()
            .get("http://localhost")
            .basic_auth("", Some(pat))
            .build()
            .unwrap();
        let authorization = request
            .headers()
            .get(AUTHORIZATION)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        ExpectedRequest {
            prefix: prefix.to_owned(),
            authorization,
            response,
            expected_store: None,
        }
    }

    fn expected_bearer_request(prefix: &str, token: &str, response: String) -> ExpectedRequest {
        ExpectedRequest {
            prefix: prefix.to_owned(),
            authorization: format!("Bearer {token}"),
            response,
            expected_store: None,
        }
    }

    impl ExpectedRequest {
        fn with_store(mut self, path: &Path, expected: Option<&[u8]>) -> Self {
            self.expected_store = Some((path.to_path_buf(), expected.map(<[u8]>::to_vec)));
            self
        }
    }

    async fn local_server(responses: Vec<ExpectedRequest>) -> (Url, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for expected in responses {
                let (stream, _) = listener.accept().await.unwrap();
                respond(stream, expected).await;
            }
        });
        (Url::parse(&format!("http://{address}/")).unwrap(), server)
    }

    async fn respond(mut stream: TcpStream, expected: ExpectedRequest) {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 2048];
        let (headers_end, content_length, headers) = loop {
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(headers_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers_end = headers_end + 4;
                let headers = String::from_utf8_lossy(&bytes[..headers_end]).into_owned();
                let content_length = headers
                    .to_lowercase()
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
                break (headers_end, content_length, headers);
            }
        };
        while bytes.len() < headers_end + content_length {
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
        }
        assert!(
            headers.starts_with(&expected.prefix),
            "requisição inesperada: {headers}"
        );
        let authorization = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("authorization")
                    .then(|| value.trim())
            })
            .expect("authorization header");
        assert_eq!(authorization, expected.authorization);
        if let Some((path, expected_contents)) = expected.expected_store {
            assert_eq!(fs::read(path).ok(), expected_contents);
        }
        stream
            .write_all(expected.response.as_bytes())
            .await
            .unwrap();
    }

    fn json_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn identity_response() -> String {
        json_response(
            "200 OK",
            r#"{"authenticatedUser":{"id":"user-guid","providerDisplayName":"Ygor Azambuja"}}"#,
        )
    }

    #[test]
    fn validates_required_desktop_fields() {
        assert!(validate_input(&valid_input()).is_ok());
        let mut invalid = valid_input();
        invalid.sprint_id = " ".to_owned();
        assert_eq!(
            validate_input(&invalid)
                .expect_err("empty sprint should fail")
                .to_string(),
            "O campo Sprint é obrigatório"
        );
    }

    #[test]
    fn validates_parent_work_item_configuration() {
        let mut invalid = valid_input();
        invalid.parent_work_item_id = Some(0);
        assert_eq!(
            validate_input(&invalid)
                .expect_err("zero parent id should fail")
                .to_string(),
            "O ID do item pai deve ser maior que zero"
        );

        invalid.parent_work_item_id = Some(123);
        assert_eq!(
            validate_input(&invalid)
                .expect_err("parent id without Azure creation should fail")
                .to_string(),
            "O item pai só pode ser informado ao criar tarefas no Azure DevOps"
        );

        invalid.create_azure_tasks = true;
        assert!(validate_input(&invalid).is_ok());

        let mut missing = valid_input();
        missing.create_azure_tasks = true;
        assert_eq!(
            validate_input(&missing)
                .expect_err("Azure creation requires a parent")
                .to_string(),
            "O ID do item pai é obrigatório ao criar tarefas no Azure DevOps"
        );
    }

    #[test]
    fn validates_the_combined_time_log_configuration() {
        let mut input = valid_input();
        input.register_time_log = true;
        assert_eq!(
            validate_input(&input)
                .expect_err("Time Log without Azure should fail")
                .to_string(),
            "O Time Log só pode ser registrado junto com a criação no Azure DevOps"
        );

        input.create_azure_tasks = true;
        input.parent_work_item_id = Some(123);
        input.register_time_log = true;
        input.time_log_start_date = "2026-08-12".into();
        input.time_log_end_date = "2026-08-13".into();
        input.azure_organization = "https://dev.azure.com/InfortechMS".into();
        input.time_log_start_date = "2026-08-12".into();
        input.time_log_end_date = "2026-08-13".into();
        assert!(validate_input(&input).is_ok());

        input.time_log_end_date = "2999-01-01".into();
        assert!(
            validate_input(&input)
                .expect_err("future dates should fail")
                .to_string()
                .contains("datas futuras")
        );
    }

    #[test]
    fn maps_generated_tasks_to_time_log_work_in_csv_order() {
        let files = vec![GeneratedFile {
            full_file_path: "/repo/file.ts".into(),
            relative_path: "file.ts".into(),
            tasks: vec![
                Task {
                    title: " API ".into(),
                    description: "Backend".into(),
                    tipo: TaskType::Backend,
                    complexidade: "BAIXA".into(),
                    estimate_made: 7,
                },
                Task {
                    title: "Tela".into(),
                    description: "Frontend".into(),
                    tipo: TaskType::Frontend,
                    complexidade: "MEDIA".into(),
                    estimate_made: 2,
                },
                Task {
                    title: "Cenários".into(),
                    description: "Testes".into(),
                    tipo: TaskType::Testes,
                    complexidade: "ALTA".into(),
                    estimate_made: 1,
                },
            ],
            staged: true,
            stage_error: None,
        }];

        let work = time_log_work_from_generated_files(&files);

        assert_eq!(
            work.iter().map(|item| item.kind).collect::<Vec<_>>(),
            [
                TimeLogType::Backend,
                TimeLogType::Frontend,
                TimeLogType::Teste
            ]
        );
        assert_eq!(
            work.iter().map(|item| item.minutes).collect::<Vec<_>>(),
            [420, 120, 60]
        );
        assert_eq!(work[0].comment, "API");
    }

    #[tokio::test]
    async fn combined_generation_skips_time_log_after_an_azure_failure() {
        let input = combined_generation_input();
        let mut result = generation_result_with_tasks(vec![backend_task(1)]);
        result.azure_error = Some("Falha parcial no Azure".into());
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_adapter = Arc::clone(&calls);

        attach_generated_time_log_with(&input, &mut result, move |_| {
            calls_for_adapter.fetch_add(1, Ordering::SeqCst);
            async { unreachable!("Time Log must not run after an Azure failure") }
        })
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(result.time_log_error.as_deref().unwrap().contains("Azure"));
        assert!(result.time_log_retry_input.is_none());
        assert!(result.time_log_result.is_none());
    }

    #[tokio::test]
    async fn combined_generation_keeps_tasks_and_retry_input_after_preflight_failure() {
        let input = combined_generation_input();
        let mut result = generation_result_with_tasks(vec![backend_task(2)]);

        attach_generated_time_log_with(&input, &mut result, |command| async move {
            assert_eq!(command.work_item_id, 201878);
            assert_eq!(command.work[0].minutes, 120);
            assert_eq!(command.work[0].comment, "Implementar API");
            Err("PAT sem acesso à Extension Data".into())
        })
        .await;

        assert_eq!(result.files[0].tasks.len(), 1);
        assert_eq!(
            result.time_log_error.as_deref(),
            Some("PAT sem acesso à Extension Data")
        );
        assert!(result.time_log_retry_input.is_some());
        assert!(result.time_log_result.is_none());
    }

    #[tokio::test]
    async fn combined_generation_offers_retry_for_capacity_but_not_after_a_post() {
        let input = combined_generation_input();
        let mut insufficient = generation_result_with_tasks(vec![backend_task(2)]);
        attach_generated_time_log_with(&input, &mut insufficient, |command| async move {
            let plan = crate::time_log::plan_time_logs(
                &TimeLogBatchInput {
                    work_item_id: command.work_item_id,
                    start_date: command.start_date,
                    end_date: command.end_date,
                    work: command.work,
                },
                &BTreeMap::from([(chrono::NaiveDate::from_ymd_opt(2026, 8, 12).unwrap(), 360)]),
                chrono::NaiveDate::from_ymd_opt(2026, 8, 12).unwrap(),
            )
            .unwrap();
            Ok(TimeLogBatchResult::without_posts(plan))
        })
        .await;

        assert_eq!(
            insufficient
                .time_log_result
                .as_ref()
                .unwrap()
                .plan
                .missing_minutes,
            60
        );
        assert!(insufficient.time_log_retry_input.is_some());

        let mut attempted = generation_result_with_tasks(vec![backend_task(1)]);
        attach_generated_time_log_with(&input, &mut attempted, |command| async move {
            let entry = crate::time_log::TimeLogPlanEntry {
                date: command.start_date,
                minutes: 60,
                kind: TimeLogType::Backend,
                comment: "Implementar API".into(),
            };
            Ok(TimeLogBatchResult {
                plan: crate::time_log::TimeLogPlan {
                    work_item_id: command.work_item_id,
                    requested_minutes: 60,
                    scheduled_minutes: 60,
                    missing_minutes: 0,
                    days: Vec::new(),
                },
                created: Vec::new(),
                pending: Vec::new(),
                failure: Some(crate::time_log::TimeLogBatchFailure {
                    entry,
                    error: "resultado indeterminado".into(),
                    indeterminate: true,
                }),
                post_attempts: 1,
                retryable: false,
            })
        })
        .await;

        assert!(
            attempted
                .time_log_result
                .as_ref()
                .unwrap()
                .failure
                .is_some()
        );
        assert!(attempted.time_log_retry_input.is_none());
    }

    #[tokio::test]
    async fn combined_generation_with_no_tasks_does_not_touch_time_log() {
        let input = combined_generation_input();
        let mut result = generation_result_with_tasks(Vec::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_adapter = Arc::clone(&calls);

        attach_generated_time_log_with(&input, &mut result, move |_| {
            calls_for_adapter.fetch_add(1, Ordering::SeqCst);
            async { unreachable!("an empty generation must not authenticate") }
        })
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(result.warnings, ["Nenhuma hora para registrar."]);
        assert_eq!(
            result
                .time_log_result
                .as_ref()
                .unwrap()
                .plan
                .requested_minutes,
            0
        );
        assert!(result.time_log_retry_input.is_none());
    }

    #[tokio::test]
    async fn create_time_log_never_creates_the_pat_store() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let path = directory.path().join("time-log.json");
        let input = valid_time_log_input();
        let (base_url, server) = local_server(vec![
            expected_pat_request(
                "GET /empresa/_apis/connectionData?",
                "segredo",
                identity_response(),
            )
            .with_store(&path, None),
            expected_pat_request(
                "GET /empresa/_apis/ExtensionManagement/",
                "segredo",
                json_response("200 OK", "[]"),
            )
            .with_store(&path, None),
            expected_pat_request(
                "GET /empresa/_apis/ExtensionManagement/",
                "segredo",
                json_response("200 OK", "[]"),
            )
            .with_store(&path, None),
            expected_pat_request(
                "POST /empresa/_apis/ExtensionManagement/",
                "segredo",
                json_response("201 Created", r#"{"id":"document-1"}"#),
            )
            .with_store(&path, None),
        ])
        .await;

        let result = create_time_log_from_store(app.handle(), &path, input, Some(base_url))
            .await
            .unwrap();

        assert_eq!(result.created[0].document_id.as_deref(), Some("document-1"));
        assert!(!path.exists());
        server.await.unwrap();

        let mut input = valid_time_log_input();
        input.credential = Some("segredo-post".to_owned());
        let (base_url, server) = local_server(vec![
            expected_pat_request(
                "GET /empresa/_apis/connectionData?",
                "segredo-post",
                identity_response(),
            )
            .with_store(&path, None),
            expected_pat_request(
                "GET /empresa/_apis/ExtensionManagement/",
                "segredo-post",
                json_response("200 OK", "[]"),
            )
            .with_store(&path, None),
            expected_pat_request(
                "GET /empresa/_apis/ExtensionManagement/",
                "segredo-post",
                json_response("200 OK", "[]"),
            )
            .with_store(&path, None),
            expected_pat_request(
                "POST /empresa/_apis/ExtensionManagement/",
                "segredo-post",
                json_response(
                    "500 Internal Server Error",
                    r#"{"message":"PAT segredo-post recusado"}"#,
                ),
            )
            .with_store(&path, None),
        ])
        .await;

        let result = create_time_log_from_store(app.handle(), &path, input, Some(base_url))
            .await
            .unwrap();
        let failure = result.failure.expect("POST failure must be structured");

        assert!(!failure.error.contains("segredo-post"));
        assert!(failure.error.contains("<redacted>"));
        assert!(!failure.indeterminate);
        assert!(!result.retryable);
        assert!(!path.exists());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn create_time_log_preserves_the_previous_pat_on_success_and_error() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let path = directory.path().join("time-log.json");
        seed_time_log_pat(&path, "pat-anterior");
        let previous = fs::read(&path).unwrap();

        let mut input = valid_time_log_input();
        input.credential = Some("pat-novo-valido".to_owned());
        let (base_url, server) = local_server(vec![
            expected_pat_request(
                "GET /empresa/_apis/connectionData?",
                "pat-novo-valido",
                identity_response(),
            )
            .with_store(&path, Some(&previous)),
            expected_pat_request(
                "GET /empresa/_apis/ExtensionManagement/",
                "pat-novo-valido",
                json_response("200 OK", "[]"),
            )
            .with_store(&path, Some(&previous)),
            expected_pat_request(
                "GET /empresa/_apis/ExtensionManagement/",
                "pat-novo-valido",
                json_response("200 OK", "[]"),
            )
            .with_store(&path, Some(&previous)),
            expected_pat_request(
                "POST /empresa/_apis/ExtensionManagement/",
                "pat-novo-valido",
                json_response("201 Created", r#"{"id":"document-2"}"#),
            )
            .with_store(&path, Some(&previous)),
        ])
        .await;

        let result = create_time_log_from_store(app.handle(), &path, input, Some(base_url))
            .await
            .unwrap();

        assert_eq!(result.created[0].document_id.as_deref(), Some("document-2"));
        assert_eq!(fs::read(&path).unwrap(), previous);
        server.await.unwrap();

        let mut input = valid_time_log_input();
        input.credential = Some("pat-novo-invalido".to_owned());
        let (base_url, server) = local_server(vec![
            expected_pat_request(
                "GET /empresa/_apis/connectionData?",
                "pat-novo-invalido",
                json_response(
                    "401 Unauthorized",
                    r#"{"message":"PAT pat-novo-invalido recusado"}"#,
                ),
            )
            .with_store(&path, Some(&previous)),
        ])
        .await;

        let error = create_time_log_from_store(app.handle(), &path, input, Some(base_url))
            .await
            .unwrap_err();

        assert!(!error.contains("pat-novo-invalido"));
        assert!(!error.contains("pat-anterior"));
        assert!(error.contains("<redacted>"));
        assert_eq!(fs::read(&path).unwrap(), previous);
        server.await.unwrap();

        let mut input = valid_time_log_input();
        input.credential = Some("token-explicito".to_owned());
        input.credential_kind = Some(TimeLogCommandCredentialKind::Bearer);
        let (base_url, server) = local_server(vec![
            expected_bearer_request(
                "GET /empresa/_apis/connectionData?",
                "token-explicito",
                identity_response(),
            )
            .with_store(&path, Some(&previous)),
            expected_bearer_request(
                "GET /empresa/_apis/ExtensionManagement/",
                "token-explicito",
                json_response("200 OK", "[]"),
            )
            .with_store(&path, Some(&previous)),
            expected_bearer_request(
                "GET /empresa/_apis/ExtensionManagement/",
                "token-explicito",
                json_response("200 OK", "[]"),
            )
            .with_store(&path, Some(&previous)),
            expected_bearer_request(
                "POST /empresa/_apis/ExtensionManagement/",
                "token-explicito",
                json_response("201 Created", r#"{"id":"document-bearer"}"#),
            )
            .with_store(&path, Some(&previous)),
        ])
        .await;

        let result = create_time_log_from_store(app.handle(), &path, input, Some(base_url))
            .await
            .unwrap();

        assert_eq!(
            result.created[0].document_id.as_deref(),
            Some("document-bearer")
        );
        assert_eq!(fs::read(&path).unwrap(), previous);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn create_time_log_uses_the_saved_pat_without_changing_it() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let path = directory.path().join("time-log.json");
        seed_time_log_pat(&path, "pat-salvo");
        let previous = fs::read(&path).unwrap();
        let mut input = valid_time_log_input();
        input.credential = None;
        input.credential_kind = None;
        let (base_url, server) = local_server(vec![
            expected_pat_request(
                "GET /empresa/_apis/connectionData?",
                "pat-salvo",
                identity_response(),
            )
            .with_store(&path, Some(&previous)),
            expected_pat_request(
                "GET /empresa/_apis/ExtensionManagement/",
                "pat-salvo",
                json_response("200 OK", "[]"),
            )
            .with_store(&path, Some(&previous)),
            expected_pat_request(
                "GET /empresa/_apis/ExtensionManagement/",
                "pat-salvo",
                json_response("200 OK", "[]"),
            )
            .with_store(&path, Some(&previous)),
            expected_pat_request(
                "POST /empresa/_apis/ExtensionManagement/",
                "pat-salvo",
                json_response("201 Created", r#"{"id":"document-3"}"#),
            )
            .with_store(&path, Some(&previous)),
        ])
        .await;

        let result = create_time_log_from_store(app.handle(), &path, input, Some(base_url))
            .await
            .unwrap();

        assert_eq!(result.created[0].document_id.as_deref(), Some("document-3"));
        assert_eq!(fs::read(&path).unwrap(), previous);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn settings_pat_is_persisted_only_after_successful_http_verification() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let config_path = directory.path().join("config.json");
        let path = directory.path().join("time-log.json");
        seed_time_log_pat(&path, "pat-anterior");
        let mut input = SaveAppSettingsInput {
            display_name: "Ygor Azambuja".to_owned(),
            email: "ygor.azambuja@infortechms.com.br".to_owned(),
            azure_organization: "https://dev.azure.com/empresa".to_owned(),
            azure_project: "SPF-SIAFIC".to_owned(),
            ai_provider: AiProvider::Openai,
            openai_model: "gpt-5-nano".to_owned(),
            codex_model: "gpt-5.6-luna".to_owned(),
            codex_reasoning_effort: "low".to_owned(),
            time_log_pat: Some("pat-novo-invalido".to_owned()),
            remove_time_log_pat: false,
        };

        for (status, body) in [
            (
                "401 Unauthorized",
                r#"{"message":"PAT pat-novo-invalido recusado"}"#,
            ),
            (
                "403 Forbidden",
                r#"{"message":"PAT pat-novo-invalido recusado"}"#,
            ),
            (
                "200 OK",
                r#"{"authenticatedUser":{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","providerDisplayName":"Anonymous"}}"#,
            ),
        ] {
            let previous = fs::read(&path).unwrap();
            let (base_url, server) = local_server(vec![
                expected_pat_request(
                    "GET /empresa/_apis/connectionData?",
                    "pat-novo-invalido",
                    json_response(status, body),
                )
                .with_store(&path, Some(&previous)),
            ])
            .await;
            let result = config::save_settings_at_paths(
                app.handle(),
                &config_path,
                &path,
                &input,
                |organization, pat| verify_time_log_pat(organization, pat, Some(base_url)),
            )
            .await
            .expect("main configuration remains successful");

            assert!(result.time_log_pat_configured);
            assert_eq!(fs::read(&path).unwrap(), previous);
            assert!(
                result
                    .warnings
                    .iter()
                    .any(|warning| warning.contains("não pôde ser validado"))
            );
            assert!(
                result
                    .warnings
                    .iter()
                    .all(|warning| !warning.contains("pat-novo-invalido"))
            );
            assert!(
                result
                    .warnings
                    .iter()
                    .all(|warning| !warning.contains("pat-anterior"))
            );
            server.await.unwrap();
        }

        let previous = fs::read(&path).unwrap();
        input.time_log_pat = Some(" pat-novo-valido ".to_owned());
        let (base_url, server) = local_server(vec![
            expected_pat_request(
                "GET /empresa/_apis/connectionData?",
                "pat-novo-valido",
                identity_response(),
            )
            .with_store(&path, Some(&previous)),
        ])
        .await;
        let result = config::save_settings_at_paths(
            app.handle(),
            &config_path,
            &path,
            &input,
            |organization, pat| verify_time_log_pat(organization, pat, Some(base_url)),
        )
        .await
        .expect("valid PAT and configuration");

        assert!(result.time_log_pat_configured);
        assert!(result.warnings.is_empty());
        assert_eq!(
            config::load_time_log_pat_at(app.handle(), &path).unwrap(),
            Some("pat-novo-valido".to_owned())
        );
        server.await.unwrap();
    }

    #[test]
    fn saved_config_never_contains_the_api_key() {
        let mut input = valid_input();
        input.create_azure_tasks = true;
        input.parent_work_item_id = Some(123);
        let serialized = serde_json::to_string(&input.saved_config("/repo".to_owned()))
            .expect("serialize config");
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("apiKey"));
        assert!(!serialized.contains("createAzureTasks"));
        assert!(!serialized.contains("parentWorkItemId"));
        assert!(!serialized.contains("registerTimeLog"));
        assert!(!serialized.contains("timeLogStartDate"));
        assert!(!serialized.contains("timeLogEndDate"));
    }

    #[test]
    fn reveal_validation_requires_a_csv_registered_in_the_current_session() {
        let directory = tempfile::tempdir().expect("temp directory");
        let csv = directory.path().join("tasks-1-1-1-1.csv");
        std::fs::write(&csv, "header").expect("write csv");
        let registry = GeneratedCsvRegistry::default();
        let wrong_name = directory.path().join("report.csv");
        std::fs::write(&wrong_name, "header").expect("write wrong csv");

        assert!(validate_generated_csv(&csv, &registry).is_err());
        registry.record(&csv).expect("register generated csv");
        assert_eq!(
            validate_generated_csv(&csv, &registry).expect("valid csv"),
            csv.canonicalize().expect("canonical csv")
        );
        assert!(validate_generated_csv(&wrong_name, &registry).is_err());
    }

    #[tokio::test]
    async fn generation_execution_preserves_partial_results_and_effect_order() {
        let directory = tempdir().expect("temp directory");
        let root = directory.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        fs::write(root.join("1-success.ts"), "initial\n").expect("write success");
        fs::write(root.join("2-failure.ts"), "initial\n").expect("write failure");
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "initial"]);

        fs::write(root.join("1-success.ts"), "approved\n").expect("modify success");
        fs::write(root.join("2-failure.ts"), "pre-staged\n").expect("stage failure");
        git(&["add", "2-failure.ts"]);
        let failure_index_before = git(&["show", ":2-failure.ts"]);
        fs::write(root.join("2-failure.ts"), "not approved\n").expect("modify failure again");

        let canonical_repository = root.canonicalize().unwrap().to_string_lossy().into_owned();
        let canonical_repository_for_save = canonical_repository.clone();
        let mut input = valid_input();
        input.repository_path = root.to_string_lossy().into_owned();
        input.create_azure_tasks = true;
        input.parent_work_item_id = Some(123);
        input.azure_organization = "https://dev.azure.com/InfortechMS".to_owned();
        input.azure_project = "SPF-SIAFIC".to_owned();
        let registry = GeneratedCsvRegistry::default();
        let persisted = Arc::new(AtomicUsize::new(0));
        let persisted_for_save = Arc::clone(&persisted);
        let persisted_for_generation = Arc::clone(&persisted);
        let azure_calls = Arc::new(AtomicUsize::new(0));
        let azure_calls_for_adapter = Arc::clone(&azure_calls);
        let root_for_azure = root.to_path_buf();
        let registry_for_azure = &registry;
        let mut progress = Vec::new();

        let result = execute_generation_with(
            input,
            &registry,
            move |saved| {
                assert_eq!(saved.repository_path, canonical_repository_for_save);
                persisted_for_save.store(1, Ordering::SeqCst);
                vec!["Aviso controlado de configuração".to_owned()]
            },
            move |_selection, file, _payload, _repository| {
                assert_eq!(persisted_for_generation.load(Ordering::SeqCst), 1);
                async move {
                    if file.ends_with("2-failure.ts") {
                        bail!("Falha simulada do provider");
                    }
                    Ok(vec![Task {
                        title: "Tarefa aprovada".to_owned(),
                        description: "Processada pelo adapter falso".to_owned(),
                        tipo: TaskType::Backend,
                        complexidade: "BAIXA".to_owned(),
                        estimate_made: 1,
                    }])
                }
            },
            move |tasks, organization, project, parent_work_item_id| {
                azure_calls_for_adapter.fetch_add(1, Ordering::SeqCst);
                assert_eq!(tasks.len(), 1);
                assert_eq!(organization, "https://dev.azure.com/InfortechMS");
                assert_eq!(project, "SPF-SIAFIC");
                assert_eq!(parent_work_item_id, Some(123));
                let csv_path = fs::read_dir(&root_for_azure)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .find(|path| {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| {
                                name.starts_with("tasks-") && name.ends_with(".csv")
                            })
                    })
                    .expect("CSV must exist before Azure");
                assert!(
                    registry_for_azure
                        .contains(&csv_path.canonicalize().unwrap())
                        .unwrap()
                );
                let staged = Command::new("git")
                    .args(["show", ":1-success.ts"])
                    .current_dir(&root_for_azure)
                    .output()
                    .expect("read staged success before Azure");
                assert!(staged.status.success());
                assert_eq!(String::from_utf8_lossy(&staged.stdout), "approved\n");
                async {
                    (
                        vec![701],
                        Some("Falha parcial simulada no Azure".to_owned()),
                    )
                }
            },
            |event| progress.push(event),
        )
        .await
        .expect("partial generation remains successful");

        assert_eq!(result.repository_path, canonical_repository);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].relative_path, "1-success.ts");
        assert!(result.files[0].staged);
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].relative_path, "2-failure.ts");
        assert_eq!(result.azure_task_ids, [701]);
        assert_eq!(
            result.azure_error.as_deref(),
            Some("Falha parcial simulada no Azure")
        );
        assert_eq!(result.warnings[0], "Aviso controlado de configuração");
        assert!(result.warnings[1].contains("Não foi possível atualizar os modelos de OpenAI"));
        assert_eq!(persisted.load(Ordering::SeqCst), 1);
        assert_eq!(azure_calls.load(Ordering::SeqCst), 1);
        assert!(Path::new(&result.csv_path).is_file());
        assert!(registry.contains(Path::new(&result.csv_path)).unwrap());
        assert!(
            fs::read_to_string(&result.csv_path)
                .unwrap()
                .contains("Tarefa aprovada")
        );
        assert_eq!(git(&["show", ":1-success.ts"]), "approved\n");
        assert_eq!(git(&["show", ":2-failure.ts"]), failure_index_before);
        assert_eq!(
            progress
                .iter()
                .map(|event| (event.phase, event.current, event.total))
                .collect::<Vec<_>>(),
            [
                (GenerationPhase::Preparing, 0, 0),
                (GenerationPhase::Preparing, 0, 0),
                (GenerationPhase::Generating, 0, 2),
                (GenerationPhase::Generating, 1, 2),
                (GenerationPhase::Generating, 1, 2),
                (GenerationPhase::Generating, 2, 2),
                (GenerationPhase::Staging, 0, 1),
                (GenerationPhase::Staging, 1, 1),
                (GenerationPhase::Exporting, 0, 1),
                (GenerationPhase::Exporting, 1, 1),
                (GenerationPhase::Azure, 0, 1),
                (GenerationPhase::Completed, 1, 1),
            ]
        );
        assert_eq!(progress[2].active_files, ["1-success.ts"]);
        assert!(progress[3].active_files.is_empty());
        assert_eq!(progress[4].active_files, ["2-failure.ts"]);
        assert!(progress[5].active_files.is_empty());
        assert!(progress.iter().any(|event| {
            event
                .message
                .contains("Falha ao gerar tarefas para 2-failure.ts")
        }));
    }

    #[tokio::test]
    async fn generation_execution_rejects_total_failure_without_creating_csv() {
        let directory = tempdir().expect("temp directory");
        let root = directory.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .expect("run git");
            assert!(output.status.success());
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        fs::write(root.join("failure.ts"), "initial\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "initial"]);
        fs::write(root.join("failure.ts"), "changed\n").unwrap();

        let mut input = valid_input();
        input.repository_path = root.to_string_lossy().into_owned();
        let registry = GeneratedCsvRegistry::default();
        let azure_calls = Arc::new(AtomicUsize::new(0));
        let azure_calls_for_adapter = Arc::clone(&azure_calls);
        let mut progress = Vec::new();

        let error = execute_generation_with(
            input,
            &registry,
            |_| Vec::new(),
            |_selection, _file, _payload, _repository| async {
                Err(anyhow::anyhow!("Falha total simulada"))
            },
            move |_, _, _, _| {
                azure_calls_for_adapter.fetch_add(1, Ordering::SeqCst);
                async { (Vec::new(), None) }
            },
            |event| progress.push(event),
        )
        .await
        .expect_err("all changed files failed");

        assert!(error.to_string().contains("Nenhum dos 1 arquivos"));
        assert!(error.to_string().contains("Falha total simulada"));
        assert_eq!(azure_calls.load(Ordering::SeqCst), 0);
        assert!(registry.0.lock().unwrap().is_empty());
        assert!(!fs::read_dir(root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("tasks-") && name.ends_with(".csv"))
        }));
        assert_eq!(
            progress
                .iter()
                .map(|event| (event.phase, event.current, event.total))
                .collect::<Vec<_>>(),
            [
                (GenerationPhase::Preparing, 0, 0),
                (GenerationPhase::Preparing, 0, 0),
                (GenerationPhase::Generating, 0, 1),
                (GenerationPhase::Generating, 1, 1),
            ]
        );
        assert!(
            progress
                .last()
                .unwrap()
                .message
                .contains("Falha ao gerar tarefas")
        );
        assert!(progress.last().unwrap().active_files.is_empty());
    }

    #[tokio::test]
    async fn generation_execution_writes_and_registers_header_only_csv_for_clean_repository() {
        let directory = tempdir().expect("temp directory");
        let root = directory.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .expect("run git");
            assert!(output.status.success());
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        fs::write(root.join("clean.ts"), "clean\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "initial"]);

        let mut input = valid_input();
        input.repository_path = root.to_string_lossy().into_owned();
        let registry = GeneratedCsvRegistry::default();
        let generation_calls = Arc::new(AtomicUsize::new(0));
        let generation_calls_for_adapter = Arc::clone(&generation_calls);
        let azure_calls = Arc::new(AtomicUsize::new(0));
        let azure_calls_for_adapter = Arc::clone(&azure_calls);
        let mut progress = Vec::new();

        let result = execute_generation_with(
            input,
            &registry,
            |_| Vec::new(),
            move |_selection, _file, _payload, _repository| {
                generation_calls_for_adapter.fetch_add(1, Ordering::SeqCst);
                async { Ok(Vec::new()) }
            },
            move |_, _, _, _| {
                azure_calls_for_adapter.fetch_add(1, Ordering::SeqCst);
                async { (Vec::new(), None) }
            },
            |event| progress.push(event),
        )
        .await
        .expect("clean repository can generate an empty CSV");

        assert!(result.files.is_empty());
        assert!(result.failures.is_empty());
        assert!(result.azure_task_ids.is_empty());
        assert!(result.azure_error.is_none());
        assert_eq!(generation_calls.load(Ordering::SeqCst), 0);
        assert_eq!(azure_calls.load(Ordering::SeqCst), 0);
        assert!(registry.contains(Path::new(&result.csv_path)).unwrap());
        assert_eq!(
            fs::read_to_string(&result.csv_path)
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(
            progress
                .iter()
                .map(|event| (event.phase, event.current, event.total))
                .collect::<Vec<_>>(),
            [
                (GenerationPhase::Preparing, 0, 0),
                (GenerationPhase::Preparing, 0, 0),
                (GenerationPhase::Exporting, 0, 1),
                (GenerationPhase::Exporting, 1, 1),
                (GenerationPhase::Completed, 1, 1),
            ]
        );
    }

    #[tokio::test]
    async fn pipeline_isolates_payload_failures_before_calling_the_provider() {
        let directory = tempdir().expect("temp directory");
        let root = directory.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        fs::write(root.join("success.ts"), "initial\n").expect("write success");
        git(&["add", "success.ts"]);
        git(&["commit", "--quiet", "-m", "initial"]);
        fs::write(root.join("success.ts"), "approved\n").expect("modify success");
        fs::write(root.join("empty.ts"), "").expect("write empty file");

        let (_, changes) = git::inspect(root).await.expect("inspect repository");
        let provider_calls = Arc::new(AtomicUsize::new(0));
        let (files, failures) = process_files(
            changes,
            TEST_GENERATION_CONCURRENCY,
            {
                let provider_calls = Arc::clone(&provider_calls);
                move |_file, _payload, _repository| {
                    provider_calls.fetch_add(1, Ordering::SeqCst);
                    async {
                        Ok(vec![Task {
                            title: "Tarefa aprovada".to_owned(),
                            description: "Somente o payload válido chegou ao provider".to_owned(),
                            tipo: TaskType::Backend,
                            complexidade: "BAIXA".to_owned(),
                            estimate_made: 1,
                        }])
                    }
                }
            },
            |_| {},
        )
        .await;

        assert_eq!(provider_calls.load(Ordering::SeqCst), 1);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative_path, "success.ts");
        assert!(files[0].staged);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].relative_path, "empty.ts");
        assert!(failures[0].error.contains("Conteúdo vazio"));
        assert!(git(&["status", "--short", "--", "empty.ts"]).starts_with("??"));
    }

    #[tokio::test]
    async fn generation_execution_keeps_tasks_when_safe_stage_rejects_a_concurrent_edit() {
        let directory = tempdir().expect("temp directory");
        let root = directory.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        fs::write(root.join("race.ts"), "initial\n").expect("write file");
        git(&["add", "race.ts"]);
        git(&["commit", "--quiet", "-m", "initial"]);
        fs::write(root.join("race.ts"), "pre-staged\n").expect("write staged content");
        git(&["add", "race.ts"]);
        fs::write(root.join("race.ts"), "analyzed\n").expect("write analyzed content");
        let index_before = git(&["show", ":race.ts"]);

        let mut input = valid_input();
        input.repository_path = root.to_string_lossy().into_owned();
        let registry = GeneratedCsvRegistry::default();
        let azure_calls = Arc::new(AtomicUsize::new(0));
        let azure_calls_for_adapter = Arc::clone(&azure_calls);

        let result = execute_generation_with(
            input,
            &registry,
            |_| Vec::new(),
            |_selection, file, _payload, _repository| async move {
                fs::write(file, "changed during generation\n").expect("write concurrent edit");
                Ok(vec![Task {
                    title: "Tarefa preservada".to_owned(),
                    description: "O stage seguro pode falhar sem perder a tarefa".to_owned(),
                    tipo: TaskType::Backend,
                    complexidade: "BAIXA".to_owned(),
                    estimate_made: 1,
                }])
            },
            move |_tasks, _organization, _project, _parent_work_item_id| {
                azure_calls_for_adapter.fetch_add(1, Ordering::SeqCst);
                async { (Vec::new(), None) }
            },
            |_| {},
        )
        .await
        .expect("generation remains successful when safe staging is rejected");

        assert!(result.failures.is_empty());
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].tasks[0].title, "Tarefa preservada");
        assert!(!result.files[0].staged);
        assert!(
            result.files[0]
                .stage_error
                .as_deref()
                .is_some_and(|error| error.contains("mudou durante a geração"))
        );
        assert_eq!(azure_calls.load(Ordering::SeqCst), 0);
        assert!(Path::new(&result.csv_path).is_file());
        assert!(registry.contains(Path::new(&result.csv_path)).unwrap());
        assert!(
            fs::read_to_string(&result.csv_path)
                .unwrap()
                .contains("Tarefa preservada")
        );
        assert_eq!(git(&["show", ":race.ts"]), index_before);
        assert_eq!(
            fs::read_to_string(root.join("race.ts")).expect("read concurrent edit"),
            "changed during generation\n"
        );
    }

    #[tokio::test]
    async fn pipeline_limits_concurrency_and_preserves_file_order() {
        let directory = tempdir().expect("temp directory");
        let root = directory.path();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root)
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        git(&["init", "--quiet"]);
        for (name, content) in [
            ("1-first.ts", "first\n"),
            ("2-second.ts", "second\n"),
            ("3-third.ts", "third\n"),
            ("4-fourth.ts", "fourth\n"),
        ] {
            fs::write(root.join(name), content).expect("write changed file");
        }

        let (_, changes) = git::inspect(root).await.expect("inspect repository");
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let completion_order = Arc::new(Mutex::new(Vec::new()));
        let (first_started_tx, first_started_rx) = mpsc::channel();
        let first_started_rx = Arc::new(Mutex::new(Some(first_started_rx)));
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let release_first_rx = Arc::new(Mutex::new(Some(release_first_rx)));
        let mut progress = Vec::new();
        let (files, failures) = process_files(
            changes,
            TEST_GENERATION_CONCURRENCY,
            {
                let active = Arc::clone(&active);
                let max_active = Arc::clone(&max_active);
                let completion_order = Arc::clone(&completion_order);
                let first_started_rx = Arc::clone(&first_started_rx);
                let release_first_rx = Arc::clone(&release_first_rx);
                move |file, _payload, _repository| {
                    let active = Arc::clone(&active);
                    let max_active = Arc::clone(&max_active);
                    let completion_order = Arc::clone(&completion_order);
                    let first_started_tx = first_started_tx.clone();
                    let first_started_rx = Arc::clone(&first_started_rx);
                    let release_first_tx = release_first_tx.clone();
                    let release_first_rx = Arc::clone(&release_first_rx);
                    async move {
                        let file_name = file
                            .file_name()
                            .and_then(|name| name.to_str())
                            .expect("file name")
                            .to_owned();
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        max_active.fetch_max(current, Ordering::SeqCst);

                        if file_name == "1-first.ts" {
                            let release_first_rx = release_first_rx
                                .lock()
                                .expect("release receiver")
                                .take()
                                .expect("release receiver only used once");
                            tokio::task::spawn_blocking(move || {
                                first_started_tx.send(()).expect("signal first start");
                                release_first_rx
                                    .recv_timeout(Duration::from_secs(1))
                                    .expect("release first generation");
                            })
                            .await
                            .expect("first coordination task");
                        } else if file_name == "2-second.ts" {
                            let first_started_rx = first_started_rx
                                .lock()
                                .expect("start receiver")
                                .take()
                                .expect("start receiver only used once");
                            tokio::task::spawn_blocking(move || {
                                first_started_rx
                                    .recv_timeout(Duration::from_secs(1))
                                    .expect("wait for first generation");
                            })
                            .await
                            .expect("second coordination task");
                        }

                        completion_order
                            .lock()
                            .expect("completion order")
                            .push(file_name.clone());
                        active.fetch_sub(1, Ordering::SeqCst);
                        if file_name == "2-second.ts" {
                            release_first_tx.send(()).expect("release first generation");
                        }
                        Ok(Vec::new())
                    }
                }
            },
            |event| progress.push(event),
        )
        .await;

        let generation_events = progress
            .iter()
            .filter(|event| event.phase == GenerationPhase::Generating)
            .collect::<Vec<_>>();
        assert_eq!(generation_events.len(), 8);
        assert_eq!(generation_events[0].current, 0);
        assert_eq!(generation_events[1].current, 0);
        assert_eq!(
            generation_events[1].active_files,
            ["1-first.ts", "2-second.ts"]
        );
        assert_eq!(generation_events[2].current, 1);
        assert_eq!(generation_events[2].active_files, ["1-first.ts"]);
        assert!(
            generation_events
                .windows(2)
                .all(|events| events[0].current <= events[1].current)
        );
        assert!(
            generation_events
                .iter()
                .all(|event| event.total == 4 && event.active_files.len() <= 2)
        );
        assert_eq!(generation_events.last().unwrap().current, 4);
        assert!(generation_events.last().unwrap().active_files.is_empty());
        assert_eq!(
            files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["1-first.ts", "2-second.ts", "3-third.ts", "4-fourth.ts"]
        );
        assert!(failures.is_empty());
        assert_eq!(TEST_GENERATION_CONCURRENCY, 2);
        assert_eq!(max_active.load(Ordering::SeqCst), 2);
        assert_ne!(
            completion_order.lock().expect("completion order")[0],
            "1-first.ts",
            "the test must exercise out-of-order completion"
        );
        assert!(files.iter().all(|file| file.staged));
        assert_eq!(
            git(&["diff", "--cached", "--name-only"])
                .lines()
                .collect::<Vec<_>>(),
            ["1-first.ts", "2-second.ts", "3-third.ts", "4-fourth.ts"]
        );
    }
}
