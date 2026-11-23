use crate::azure_boards::{AzureBoardsClient, AzureWorkItem};
use crate::{ai, card_analysis, config, git};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{Mutex, Notify};

const POLL_INTERVAL: Duration = Duration::from_secs(120);
const MAX_NOTIFICATIONS: usize = 100;
const EVENT: &str = "azure-tasks-updated";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureTaskNotification {
    id: String,
    work_item_id: i32,
    title: String,
    message: String,
    created_at: String,
    read: bool,
}

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MonitorStatus {
    #[default]
    Loading,
    Ready,
    Error,
    Unconfigured,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureTasksSnapshot {
    items: Vec<AzureWorkItem>,
    notifications: Vec<AzureTaskNotification>,
    status: MonitorStatus,
    message: Option<String>,
    last_checked_at: Option<String>,
}

// Credentials only live in memory; neither this type nor the monitor is serializable/debuggable.
#[derive(Clone, PartialEq, Eq)]
struct AccountContext {
    organization: String,
    project: String,
    pat: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskCache {
    scope: String,
    items: Vec<AzureWorkItem>,
    notifications: Vec<AzureTaskNotification>,
    last_checked_at: String,
}

struct MonitorData {
    epoch: u64,
    settings_saving: bool,
    context: Option<AccountContext>,
    cache: Option<TaskCache>,
    snapshot: AzureTasksSnapshot,
    failures: u32,
    retry_delay: Duration,
    not_before: Option<Instant>,
}

impl Default for MonitorData {
    fn default() -> Self {
        Self {
            epoch: 0,
            settings_saving: false,
            context: None,
            cache: None,
            snapshot: AzureTasksSnapshot::default(),
            failures: 0,
            retry_delay: POLL_INTERVAL,
            not_before: None,
        }
    }
}

#[derive(Default)]
pub struct AzureTasksMonitor {
    data: Mutex<MonitorData>,
    refresh_lock: Mutex<()>,
    analysis_lock: Mutex<()>,
    wake: Notify,
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let monitor = app.state::<AzureTasksMonitor>();
            refresh(&app, &monitor).await;
            let delay = monitor.data.lock().await.retry_delay;
            tokio::select! {
                _ = tokio::time::sleep(delay) => {},
                _ = monitor.wake.notified() => {},
            }
        }
    });
}

pub async fn configuration_changed<R: Runtime>(app: &AppHandle<R>, settings_saving: bool) {
    let Some(monitor) = app.try_state::<AzureTasksMonitor>() else {
        return;
    };
    let mut data = monitor.data.lock().await;
    let epoch = data.epoch.wrapping_add(1);
    *data = MonitorData {
        epoch,
        settings_saving,
        ..MonitorData::default()
    };
    emit(app, &data.snapshot);
    monitor.wake.notify_one();
}

fn emit<R: Runtime>(app: &AppHandle<R>, snapshot: &AzureTasksSnapshot) {
    let _ = app.emit(EVENT, snapshot);
}

fn context<R: Runtime>(app: &AppHandle<R>) -> Result<AccountContext, String> {
    let initial = config::load_initial(app, ai::DEFAULT_AI_PROVIDER);
    if initial.requires_onboarding {
        return Err("Conclua as Configurações para consultar suas tarefas na Azure.".into());
    }
    let pat = config::load_time_log_pat(app)
        .map_err(|_| "Não foi possível carregar o PAT salvo. Revise as Configurações.")?
        .or_else(|| std::env::var("ADO_PAT").ok())
        .filter(|pat| !pat.trim().is_empty())
        .ok_or("Configure um PAT com permissão Work Items — Read para consultar suas tarefas.")?;
    Ok(AccountContext {
        organization: initial.config.azure_organization,
        project: initial.config.azure_project,
        pat,
    })
}

fn cache_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    config::config_file_path(app)
        .map(|path| path.with_file_name("azure-tasks.json"))
        .map_err(|_| "Não foi possível localizar o histórico de notificações.".into())
}

fn load_cache(path: &Path, scope: &str) -> Result<Option<TaskCache>, String> {
    let contents = match std::fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Não foi possível ler o histórico de notificações.".into()),
    };
    let cache: TaskCache = serde_json::from_slice(&contents)
        .map_err(|_| "O histórico de notificações estava inválido e foi reiniciado.")?;
    Ok((cache.scope == scope).then_some(cache))
}

fn save_cache(path: &Path, cache: &TaskCache) -> Result<(), String> {
    let save = || -> anyhow::Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Pasta inválida"))?;
        std::fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer(file.as_file_mut(), cache)?;
        file.persist(path)?;
        Ok(())
    };
    save().map_err(|_| {
        "Não foi possível salvar o histórico; avisos podem reaparecer ao reabrir o app.".into()
    })
}

fn apply_items(cache: &mut TaskCache, items: Vec<AzureWorkItem>, now: &str) {
    for item in items.iter().rev() {
        let previous = cache.items.iter().find(|old| old.id == item.id);
        let message = match previous {
            None => Some("Uma nova tarefa apareceu na sua lista.".to_owned()),
            Some(old) if item.revision > old.revision => Some(if item.state != old.state {
                format!("Estado alterado: {} → {}.", old.state, item.state)
            } else {
                "A tarefa recebeu uma atualização.".to_owned()
            }),
            _ => None,
        };
        if let Some(message) = message {
            let id = format!("{}:{}", item.id, item.revision);
            if !cache.notifications.iter().any(|notice| notice.id == id) {
                cache.notifications.insert(
                    0,
                    AzureTaskNotification {
                        id,
                        work_item_id: item.id,
                        title: item.title.clone(),
                        message,
                        created_at: now.to_owned(),
                        read: false,
                    },
                );
            }
        }
    }
    cache.notifications.truncate(MAX_NOTIFICATIONS);
    cache.items = items;
    cache.last_checked_at = now.to_owned();
}

async fn refresh<R: Runtime>(
    app: &AppHandle<R>,
    monitor: &AzureTasksMonitor,
) -> AzureTasksSnapshot {
    refresh_with(
        app,
        monitor,
        || context(app),
        |account| AzureBoardsClient::new(&account.organization, &account.project, &account.pat),
        || cache_path(app),
    )
    .await
}

async fn refresh_with<R: Runtime>(
    app: &AppHandle<R>,
    monitor: &AzureTasksMonitor,
    load_account: impl FnOnce() -> Result<AccountContext, String>,
    create_client: impl FnOnce(&AccountContext) -> Result<AzureBoardsClient, String>,
    resolve_cache_path: impl FnOnce() -> Result<PathBuf, String>,
) -> AzureTasksSnapshot {
    // ponytail: um monitor por desktop; o lock também reúne atualizações manuais concorrentes.
    let Ok(_refresh) = monitor.refresh_lock.try_lock() else {
        return monitor.data.lock().await.snapshot.clone();
    };
    let configuration_epoch = {
        let data = monitor.data.lock().await;
        if data.settings_saving {
            return data.snapshot.clone();
        }
        data.epoch
    };
    let account = match load_account() {
        Ok(account) => account,
        Err(message) => {
            let mut data = monitor.data.lock().await;
            if data.epoch != configuration_epoch {
                return data.snapshot.clone();
            }
            data.epoch = data.epoch.wrapping_add(1);
            data.context = None;
            data.cache = None;
            data.retry_delay = POLL_INTERVAL;
            data.snapshot = AzureTasksSnapshot {
                status: MonitorStatus::Unconfigured,
                message: Some(message),
                ..AzureTasksSnapshot::default()
            };
            emit(app, &data.snapshot);
            return data.snapshot.clone();
        }
    };
    let epoch = {
        let mut data = monitor.data.lock().await;
        if data.epoch != configuration_epoch {
            return data.snapshot.clone();
        }
        if data.context.as_ref() != Some(&account) {
            let epoch = data.epoch.wrapping_add(1);
            *data = MonitorData {
                epoch,
                context: Some(account.clone()),
                ..MonitorData::default()
            };
        }
        if data
            .not_before
            .is_some_and(|deadline| deadline > Instant::now())
        {
            return data.snapshot.clone();
        }
        data.snapshot.status = MonitorStatus::Loading;
        emit(app, &data.snapshot);
        data.epoch
    };
    let client = match create_client(&account) {
        Ok(client) => client,
        Err(error) => return record_error(app, monitor, epoch, error, None).await,
    };
    let identity = match client.identity().await {
        Ok(identity) => identity,
        Err(error) => return record_error(app, monitor, epoch, error, client.retry_after()).await,
    };
    let scope = format!("{}|{}|{}", account.organization, account.project, identity);
    let (items, mut warnings) = match client.list_my_items().await {
        Ok(result) => result,
        Err(error) => return record_error(app, monitor, epoch, error, client.retry_after()).await,
    };
    let mut data = monitor.data.lock().await;
    if data.epoch != epoch {
        return data.snapshot.clone();
    }
    let path = resolve_cache_path();
    if data.cache.as_ref().is_none_or(|cache| cache.scope != scope) {
        data.cache = None;
        match path
            .as_deref()
            .map_err(Clone::clone)
            .and_then(|path| load_cache(path, &scope))
        {
            Ok(cache) => data.cache = cache,
            Err(warning) => warnings.push(warning),
        }
    }
    let now = Utc::now().to_rfc3339();
    if let Some(cache) = data.cache.as_mut() {
        apply_items(cache, items, &now);
    } else {
        // A primeira sincronização apenas estabelece a referência, sem alertar todo o backlog.
        data.cache = Some(TaskCache {
            scope,
            items,
            notifications: Vec::new(),
            last_checked_at: now,
        });
    }
    if let Some(cache) = &data.cache {
        if let Err(warning) = path
            .as_deref()
            .map_err(Clone::clone)
            .and_then(|path| save_cache(path, cache))
        {
            warnings.push(warning);
        }
        data.snapshot = AzureTasksSnapshot {
            items: cache.items.clone(),
            notifications: cache.notifications.clone(),
            status: MonitorStatus::Ready,
            message: (!warnings.is_empty()).then(|| warnings.join(" ")),
            last_checked_at: Some(cache.last_checked_at.clone()),
        };
    }
    data.failures = 0;
    let retry = client.retry_after();
    data.retry_delay = POLL_INTERVAL.max(retry.unwrap_or_default());
    data.not_before = retry.and_then(|delay| Instant::now().checked_add(delay));
    emit(app, &data.snapshot);
    data.snapshot.clone()
}

async fn record_error<R: Runtime>(
    app: &AppHandle<R>,
    monitor: &AzureTasksMonitor,
    epoch: u64,
    error: String,
    retry_after: Option<Duration>,
) -> AzureTasksSnapshot {
    let mut data = monitor.data.lock().await;
    if data.epoch == epoch {
        data.failures = data.failures.saturating_add(1);
        data.retry_delay = Duration::from_secs((120 * (1_u64 << data.failures.min(3))).min(900))
            .max(retry_after.unwrap_or_default());
        data.not_before = retry_after.and_then(|delay| Instant::now().checked_add(delay));
        data.snapshot.status = MonitorStatus::Error;
        data.snapshot.message = Some(error);
        emit(app, &data.snapshot);
    }
    data.snapshot.clone()
}

#[tauri::command]
pub async fn get_azure_tasks(
    monitor: State<'_, AzureTasksMonitor>,
) -> Result<AzureTasksSnapshot, String> {
    Ok(monitor.data.lock().await.snapshot.clone())
}

#[tauri::command]
pub async fn refresh_azure_tasks(
    app: AppHandle,
    monitor: State<'_, AzureTasksMonitor>,
) -> Result<AzureTasksSnapshot, String> {
    Ok(refresh(&app, &monitor).await)
}

#[tauri::command]
pub async fn mark_azure_notifications_read(
    app: AppHandle,
    monitor: State<'_, AzureTasksMonitor>,
) -> Result<AzureTasksSnapshot, String> {
    let mut data = monitor.data.lock().await;
    if let Some(cache) = data.cache.as_mut() {
        for notice in &mut cache.notifications {
            notice.read = true;
        }
        let saved = cache_path(&app).and_then(|path| save_cache(&path, cache));
        data.snapshot.notifications = cache.notifications.clone();
        if let Err(warning) = saved {
            data.snapshot.message = Some(warning);
        }
        emit(&app, &data.snapshot);
    }
    Ok(data.snapshot.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeAzureTaskInput {
    work_item_id: i32,
    repository_path: String,
}

#[tauri::command]
pub async fn analyze_azure_task(
    app: AppHandle,
    monitor: State<'_, AzureTasksMonitor>,
    input: AnalyzeAzureTaskInput,
) -> Result<card_analysis::CardAnalysis, String> {
    let _analysis = monitor
        .analysis_lock
        .try_lock()
        .map_err(|_| "Já existe uma análise em andamento. Aguarde sua conclusão.")?;
    let account = context(&app)?;
    let epoch = {
        let data = monitor.data.lock().await;
        if data.context.as_ref() != Some(&account)
            || !data
                .snapshot
                .items
                .iter()
                .any(|item| item.id == input.work_item_id && item.can_analyze)
        {
            return Err(
                "Atualize Minhas tarefas e selecione um card disponível para análise.".into(),
            );
        }
        data.epoch
    };
    if input.repository_path.trim().is_empty() {
        return Err("Escolha um repositório para analisar o card.".into());
    }
    let repository = git::resolve_repository(Path::new(input.repository_path.trim()))
        .await
        .map_err(|error| error.to_string())?;
    let client = AzureBoardsClient::new(&account.organization, &account.project, &account.pat)?;
    let card = {
        let _reading = monitor.refresh_lock.lock().await;
        {
            let data = monitor.data.lock().await;
            if data.epoch != epoch {
                return Err("As configurações Azure mudaram. Selecione a tarefa novamente.".into());
            }
            if data
                .not_before
                .is_some_and(|deadline| deadline > Instant::now())
            {
                return Err(
                    "O Azure solicitou uma pausa nas consultas. Aguarde antes de analisar o card."
                        .into(),
                );
            }
        }
        let result = client.card_context(input.work_item_id).await;
        if let Some(delay) = client.retry_after() {
            let mut data = monitor.data.lock().await;
            if data.epoch == epoch {
                data.not_before = Instant::now().checked_add(delay);
                data.retry_delay = data.retry_delay.max(delay);
            }
        }
        result?
    }
    .replace(account.pat.trim(), "<redacted>");
    let context_warnings: Vec<String> = serde_json::from_str::<serde_json::Value>(&card)
        .ok()
        .and_then(|value| value.get("warnings").cloned())
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    if monitor.data.lock().await.epoch != epoch || context(&app)? != account {
        return Err("As configurações Azure mudaram. Selecione a tarefa novamente.".into());
    }
    let saved = config::load_initial(&app, ai::DEFAULT_AI_PROVIDER).config;
    let mut result = card_analysis::analyze_card(
        &repository,
        &card,
        &saved.codex_model,
        &saved.codex_reasoning_effort,
    )
    .await
    .map_err(|error| error.replace(&account.pat, "<redacted>"))?;
    if monitor.data.lock().await.epoch != epoch || context(&app)? != account {
        return Err(
            "As configurações Azure mudaram durante a análise. Selecione a tarefa novamente."
                .into(),
        );
    }
    result.warnings.extend(context_warnings);
    result.summary = result.summary.replace(account.pat.trim(), "<redacted>");
    for section in [
        &mut result.acceptance_criteria,
        &mut result.relevant_files,
        &mut result.implementation_plan,
        &mut result.test_plan,
        &mut result.risks,
        &mut result.open_questions,
        &mut result.warnings,
    ] {
        for text in section {
            *text = text.replace(account.pat.trim(), "<redacted>");
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex as StdMutex};
    use tauri::Listener;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    async fn serve_refresh(
        listener: &TcpListener,
        id: i32,
        identity: &str,
        authorization: &str,
        delay_success: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
    ) {
        let replies = [
            (
                "GET /org/_apis/connectionData?",
                json!({"authenticatedUser": {"id": identity, "providerDisplayName": "Pessoa"}}),
            ),
            (
                "POST /org/project/_apis/wit/wiql?",
                json!({"workItems": [{"id": id}]}),
            ),
            (
                "POST /org/project/_apis/wit/workitemsbatch?",
                json!({"value": [{"id": id, "rev": 1, "fields": {
                    "System.Title": format!("Card {id}"),
                    "System.WorkItemType": "Task",
                    "System.State": "To Do",
                    "System.AssignedTo": {"id": identity, "displayName": "Pessoa"},
                    "System.ChangedDate": "2026-10-01T00:00:00Z"
                }}]}),
            ),
            (
                "GET /org/project/_apis/wit/workitemtypes/Task/states?",
                json!({"value": [{"name": "To Do", "category": "Proposed"}]}),
            ),
        ];
        let mut delay_success = delay_success;
        for (index, (expected_path, body)) in replies.into_iter().enumerate() {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 2048];
            let headers = loop {
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(count > 0, "Requisição local terminou antes do corpo");
                request.extend_from_slice(&buffer[..count]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8(request[..end].to_vec()).unwrap();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|value| value.parse::<usize>().unwrap())
                        })
                        .unwrap_or_default();
                    if request.len() >= end + 4 + length {
                        break headers;
                    }
                }
            };
            assert!(
                headers.starts_with(expected_path),
                "Endpoint inesperado: {headers}"
            );
            assert!(
                headers.contains(authorization),
                "PAT incorreto na consulta local"
            );
            if index == 3
                && let Some((received, release)) = delay_success.take()
            {
                received.send(()).unwrap();
                release.await.unwrap();
            }
            let body = body.to_string();
            stream.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            ).as_bytes()).await.unwrap();
        }
    }

    fn item(id: i32, revision: i32, state: &str) -> AzureWorkItem {
        AzureWorkItem {
            id,
            revision,
            title: format!("Card {id}"),
            work_item_type: "Task".into(),
            state: state.into(),
            assigned_to: "Pessoa".into(),
            changed_date: "2026-10-01T00:00:00Z".into(),
            priority: Some(2),
            iteration_path: "Projeto/Sprint".into(),
            area_path: "Projeto".into(),
            url: format!("https://dev.azure.com/org/projeto/_workitems/edit/{id}"),
            can_analyze: state == "To Do",
        }
    }

    fn cache() -> TaskCache {
        TaskCache {
            scope: "org|project|user".into(),
            items: vec![item(1, 1, "To Do")],
            notifications: vec![],
            last_checked_at: "antes".into(),
        }
    }

    #[test]
    fn unchanged_items_do_not_repeat_notifications_and_completion_is_reported() {
        let mut cache = cache();
        apply_items(&mut cache, vec![item(1, 1, "To Do")], "agora");
        assert!(cache.notifications.is_empty());
        apply_items(
            &mut cache,
            vec![item(1, 2, "Done"), item(2, 1, "To Do")],
            "depois",
        );
        assert_eq!(cache.notifications.len(), 2);
        assert!(
            cache
                .notifications
                .iter()
                .any(|n| n.message.contains("To Do → Done"))
        );
        apply_items(
            &mut cache,
            vec![item(1, 2, "Done"), item(2, 1, "To Do")],
            "fim",
        );
        assert_eq!(cache.notifications.len(), 2);
    }

    #[test]
    fn cache_is_scoped_and_preserves_seen_revisions_and_read_notices() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("azure-tasks.json");
        let mut original = cache();
        apply_items(&mut original, vec![item(1, 2, "Doing")], "agora");
        original.notifications[0].read = true;
        save_cache(&path, &original).unwrap();
        let mut restored = load_cache(&path, &original.scope).unwrap().unwrap();
        apply_items(&mut restored, vec![item(1, 2, "Doing")], "depois");
        assert_eq!(restored.notifications.len(), 1);
        assert!(restored.notifications[0].read);
        assert!(
            load_cache(&path, "org|project|other-user")
                .unwrap()
                .is_none()
        );
        save_cache(&path, &restored).unwrap();
        assert_eq!(
            load_cache(&path, &original.scope)
                .unwrap()
                .unwrap()
                .last_checked_at,
            "depois"
        );
    }

    #[test]
    fn broken_cache_is_reported_and_notification_history_is_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("azure-tasks.json");
        std::fs::write(&path, "{").unwrap();
        assert!(load_cache(&path, "scope").unwrap_err().contains("inválido"));
        let mut cache = cache();
        apply_items(
            &mut cache,
            (1..=150).rev().map(|id| item(id, 2, "To Do")).collect(),
            "agora",
        );
        assert_eq!(cache.notifications.len(), MAX_NOTIFICATIONS);
        assert_eq!(cache.notifications.first().unwrap().work_item_id, 150);
        assert_eq!(cache.notifications.last().unwrap().work_item_id, 51);
    }

    #[tokio::test]
    async fn settings_change_clears_previous_account_and_ignores_late_failures() {
        let app = tauri::test::mock_builder()
            .manage(AzureTasksMonitor::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let monitor = app.state::<AzureTasksMonitor>();
        {
            let mut data = monitor.data.lock().await;
            data.cache = Some(cache());
            data.snapshot.items = vec![item(1, 1, "To Do")];
            data.context = Some(AccountContext {
                organization: "org".into(),
                project: "project".into(),
                pat: "secret".into(),
            });
        }
        configuration_changed(app.handle(), true).await;
        let during_save = refresh(app.handle(), &monitor).await;
        assert!(during_save.items.is_empty());
        assert!(during_save.message.is_none());
        assert!(monitor.data.lock().await.settings_saving);
        configuration_changed(app.handle(), false).await;
        let snapshot = record_error(
            app.handle(),
            &monitor,
            0,
            "erro da conta antiga".into(),
            None,
        )
        .await;
        assert!(snapshot.items.is_empty());
        assert!(snapshot.message.is_none());
        let data = monitor.data.lock().await;
        assert!(data.context.is_none());
        assert!(data.cache.is_none());
        assert_eq!(data.epoch, 2);
        assert!(!data.settings_saving);
    }

    #[tokio::test]
    async fn account_change_discards_late_http_success_without_publishing_or_caching_old_items() {
        let app = tauri::test::mock_builder()
            .manage(AzureTasksMonitor::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let monitor = app.state::<AzureTasksMonitor>();
        let events = Arc::new(StdMutex::new(Vec::<Value>::new()));
        let captured_events = Arc::clone(&events);
        app.listen(EVENT, move |event| {
            captured_events
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
        let account = StdMutex::new(AccountContext {
            organization: "https://dev.azure.com/org".into(),
            project: "project".into(),
            pat: "pat-a".into(),
        });
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("azure-tasks.json");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (received, pending_success) = oneshot::channel();
        let (release, may_reply) = oneshot::channel();
        let server = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(10), async {
                serve_refresh(
                    &listener,
                    1,
                    "user-a",
                    "authorization: Basic OnBhdC1h",
                    Some((received, may_reply)),
                )
                .await;
                serve_refresh(
                    &listener,
                    2,
                    "user-b",
                    "authorization: Basic OnBhdC1i",
                    None,
                )
                .await;
            })
            .await
            .expect("O servidor local deve concluir as duas consultas");
        });
        let load_account = || Ok(account.lock().unwrap().clone());
        let create_client = |account: &AccountContext| {
            Ok(AzureBoardsClient::for_test(
                &account.organization,
                &account.project,
                &account.pat,
                address,
            ))
        };
        let resolve_path = || Ok(path.clone());

        let old_refresh = refresh_with(
            app.handle(),
            &monitor,
            load_account,
            create_client,
            resolve_path,
        );
        tokio::pin!(old_refresh);
        tokio::select! {
            _ = &mut old_refresh => panic!("A resposta HTTP deveria permanecer em voo"),
            result = pending_success => result.expect("A consulta deve chegar à última resposta HTTP"),
        }
        configuration_changed(app.handle(), true).await;
        account.lock().unwrap().pat = "pat-b".into();
        configuration_changed(app.handle(), false).await;
        release.send(()).unwrap();
        let stale_result = tokio::time::timeout(Duration::from_secs(5), old_refresh)
            .await
            .unwrap();

        assert!(stale_result.items.is_empty());
        assert!(stale_result.notifications.is_empty());
        assert!(monitor.data.lock().await.cache.is_none());
        assert!(
            !path.exists(),
            "Uma resposta de outra conta não pode criar o cache"
        );

        let current = tokio::time::timeout(
            Duration::from_secs(5),
            refresh_with(
                app.handle(),
                &monitor,
                load_account,
                create_client,
                resolve_path,
            ),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert!(matches!(current.status, MonitorStatus::Ready));
        assert_eq!(
            current.items.iter().map(|item| item.id).collect::<Vec<_>>(),
            [2]
        );
        assert!(
            current.notifications.is_empty(),
            "A nova conta estabelece sua própria referência"
        );
        let persisted = load_cache(&path, "https://dev.azure.com/org|project|user-b")
            .unwrap()
            .unwrap();
        assert_eq!(
            persisted
                .items
                .iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            [2]
        );
        assert!(
            load_cache(&path, "https://dev.azure.com/org|project|user-a")
                .unwrap()
                .is_none()
        );
        let emitted = events.lock().unwrap();
        assert!(
            emitted
                .iter()
                .any(|snapshot| snapshot["items"][0]["id"] == 2)
        );
        assert!(
            emitted.iter().all(|snapshot| {
                snapshot["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|item| item["id"] != 1)
                    && snapshot["notifications"].as_array().unwrap().is_empty()
            }),
            "Nenhum evento pode publicar cards ou alertas da conta anterior"
        );
    }

    #[tokio::test]
    async fn retry_after_and_progressive_backoff_preserve_last_successful_items() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let monitor = AzureTasksMonitor::default();
        monitor.data.lock().await.snapshot.items = vec![item(1, 1, "To Do")];
        let snapshot = record_error(
            app.handle(),
            &monitor,
            0,
            "limite Azure".into(),
            Some(Duration::from_secs(1000)),
        )
        .await;
        assert_eq!(snapshot.items.len(), 1);
        let data = monitor.data.lock().await;
        assert_eq!(data.retry_delay, Duration::from_secs(1000));
        assert!(
            data.not_before
                .is_some_and(|deadline| deadline > Instant::now())
        );
    }
}
