use super::{AiOption, provider_spec};
use crate::models::AiProvider;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
};

#[cfg(not(test))]
const MODELS_URL: &str = "https://api.openai.com/v1/models";
// Unit tests that exercise orchestration use an unavailable loopback adapter,
// never the real provider. Protocol tests inject their own local endpoint.
#[cfg(test)]
const MODELS_URL: &str = "http://127.0.0.1:1/v1/models";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEffort {
    pub value: String,
    pub label: String,
}

impl From<&AiOption> for ModelEffort {
    fn from(option: &AiOption) -> Self {
        Self {
            value: option.value.to_owned(),
            label: option.label.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    pub value: String,
    pub label: String,
    pub reasoning_efforts: Vec<ModelEffort>,
    pub default_reasoning_effort: Option<String>,
    pub compatibility_verified: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelCatalog {
    pub models: Vec<AiModel>,
    pub source: CatalogSource,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogSource {
    Local,
    Provider,
}

pub fn valid_identifier(value: &str) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_alphanumeric())
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

pub fn local_models(provider: AiProvider) -> Vec<AiModel> {
    let spec = provider_spec(provider);
    spec.models
        .iter()
        .map(|option| AiModel {
            value: option.value.to_owned(),
            label: option.label.to_owned(),
            reasoning_efforts: spec
                .reasoning_efforts
                .iter()
                .map(ModelEffort::from)
                .collect(),
            default_reasoning_effort: spec.default_reasoning_effort.map(str::to_owned),
            compatibility_verified: true,
        })
        .collect()
}

fn catalog_or_fallback(provider: AiProvider, result: Result<Vec<AiModel>>) -> AiModelCatalog {
    match result {
        Ok(models) => AiModelCatalog {
            models,
            source: CatalogSource::Provider,
            warnings: vec![],
        },
        Err(error) => AiModelCatalog {
            models: local_models(provider),
            source: CatalogSource::Local,
            warnings: vec![format!(
                "Não foi possível atualizar os modelos de {}. A lista anterior ou local foi mantida. {error}",
                provider_spec(provider).display_name
            )],
        },
    }
}

pub fn require_selection(
    catalog: &AiModelCatalog,
    model: &str,
    effort: Option<&str>,
) -> Result<()> {
    let selected = catalog.models.iter().find(|item| item.value == model)
        .with_context(|| format!("O modelo {model} não está disponível no catálogo atual. Escolha outro modelo antes de gerar. {}", catalog.warnings.join(" ")))?;
    if let Some(effort) = effort
        && !selected
            .reasoning_efforts
            .iter()
            .any(|option| option.value == effort)
    {
        bail!(
            "O esforço {effort} não é compatível com o modelo {model}. Escolha um esforço disponível. {}",
            catalog.warnings.join(" ")
        );
    }
    Ok(())
}

pub async fn openai_catalog(key: Option<&str>, selected: Option<&str>) -> AiModelCatalog {
    catalog_or_fallback(
        AiProvider::Openai,
        discover_openai(key, selected, MODELS_URL, Duration::from_secs(10)).await,
    )
}

#[derive(Deserialize)]
struct OpenAiModels {
    data: Vec<OpenAiModel>,
}
#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
    created: u64,
}

fn text_candidate(id: &str) -> bool {
    let Some(version) = id
        .strip_prefix("gpt-")
        .and_then(|id| id.split(['-', '.']).next())
        .and_then(|v| v.parse::<u32>().ok())
    else {
        return false;
    };
    version >= 5
        && valid_identifier(id)
        && ![
            "image",
            "audio",
            "tts",
            "speech",
            "live",
            "translate",
            "translation",
            "realtime",
            "transcribe",
            "transcription",
            "search",
            "chat",
            "codex",
            "pro",
            "research",
            "computer",
            "embedding",
            "moderation",
            "instruct",
            "rosalind",
        ]
        .iter()
        .any(|part| id.split('-').any(|segment| segment == *part))
}

fn snapshot_alias(id: &str) -> Option<&str> {
    let n = id.len();
    if n < 12 {
        return None;
    }
    let suffix = &id.as_bytes()[n - 11..];
    if suffix[0] == b'-'
        && suffix[5] == b'-'
        && suffix[8] == b'-'
        && suffix
            .iter()
            .enumerate()
            .all(|(i, b)| [0, 5, 8].contains(&i) || b.is_ascii_digit())
    {
        Some(&id[..n - 11])
    } else {
        None
    }
}

async fn discover_openai(
    key: Option<&str>,
    selected: Option<&str>,
    endpoint: &str,
    timeout: Duration,
) -> Result<Vec<AiModel>> {
    let key = key.context("Configure OPENAI_API_KEY ou informe a chave temporária.")?;
    let response = reqwest::Client::builder()
        .timeout(timeout)
        .build()?
        .get(endpoint)
        .bearer_auth(key)
        .send()
        .await
        .context("Falha ao consultar a OpenAI.")?;
    if !response.status().is_success() {
        bail!(
            "A OpenAI recusou a consulta de modelos (HTTP {}).",
            response.status().as_u16()
        );
    }
    // Do not include provider bodies or parser details: they may echo credentials.
    let mut data = response
        .json::<OpenAiModels>()
        .await
        .map_err(|_| anyhow::anyhow!("Resposta de modelos inválida da OpenAI."))?
        .data;
    data.retain(|model| text_candidate(&model.id));
    data.sort_by(|a, b| b.created.cmp(&a.created).then(a.id.cmp(&b.id)));
    let ids: HashSet<_> = data.iter().map(|m| m.id.clone()).collect();
    let local = local_models(AiProvider::Openai);
    let mut seen = HashSet::new();
    Ok(data
        .into_iter()
        .filter(|m| {
            seen.insert(m.id.clone())
                && (selected == Some(m.id.as_str())
                    || snapshot_alias(&m.id).is_none_or(|alias| !ids.contains(alias)))
        })
        .map(|m| AiModel {
            label: local
                .iter()
                .find(|item| item.value == m.id)
                .map(|item| item.label.clone())
                .unwrap_or_else(|| m.id.clone()),
            compatibility_verified: local.iter().any(|item| item.value == m.id),
            value: m.id,
            reasoning_efforts: vec![],
            default_reasoning_effort: None,
        })
        .collect())
}

pub async fn codex_catalog(program: &str) -> AiModelCatalog {
    catalog_or_fallback(
        AiProvider::Codex,
        discover_codex(program, Duration::from_secs(15)).await,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexPage {
    data: Vec<CodexModel>,
    next_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexModel {
    model: String,
    display_name: String,
    #[serde(default)]
    hidden: bool,
    supported_reasoning_efforts: Vec<CodexEffort>,
    default_reasoning_effort: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexEffort {
    reasoning_effort: String,
}

async fn rpc_send(stdin: &mut ChildStdin, message: Value) -> Result<()> {
    stdin.write_all(format!("{message}\n").as_bytes()).await?;
    stdin.flush().await?;
    Ok(())
}
async fn rpc_response(stdout: &mut BufReader<ChildStdout>, id: u64) -> Result<Value> {
    loop {
        let mut line = String::new();
        if stdout.read_line(&mut line).await? == 0 {
            bail!("O Codex encerrou a consulta sem responder.");
        }
        let message: Value = serde_json::from_str(&line)
            .map_err(|_| anyhow::anyhow!("Resposta inválida do Codex."))?;
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if message.get("error").is_some() {
            bail!("O Codex recusou a consulta de modelos.");
        }
        return message
            .get("result")
            .filter(|v| v.is_object())
            .cloned()
            .context("Resposta inválida do Codex.");
    }
}

async fn discover_codex(program: &str, timeout: Duration) -> Result<Vec<AiModel>> {
    let mut child = Command::new(program)
        .args(["app-server"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("Não foi possível iniciar a consulta do Codex.")?;
    let result = tokio::time::timeout(timeout, async {
        let mut stdin = child.stdin.take().context("Entrada do Codex indisponível.")?;
        let mut stdout = BufReader::new(child.stdout.take().context("Saída do Codex indisponível.")?);
        rpc_send(&mut stdin, json!({"id":0,"method":"initialize","params":{"clientInfo":{"name":"infortech_automation","title":"Infortech Automation","version":env!("CARGO_PKG_VERSION")}}})).await?;
        rpc_response(&mut stdout, 0).await?;
        rpc_send(&mut stdin, json!({"method":"initialized","params":{}})).await?;
        let mut cursor: Option<String> = None;
        let mut cursors = HashSet::new();
        let mut models = Vec::new();
        let mut seen = HashSet::new();
        for id in 1.. {
            rpc_send(&mut stdin, json!({"id":id,"method":"model/list","params":{"limit":100,"includeHidden":false,"cursor":cursor}})).await?;
            let page: CodexPage = serde_json::from_value(rpc_response(&mut stdout, id).await?).context("Catálogo inválido do Codex.")?;
            for m in page.data.into_iter().filter(|m| !m.hidden) {
                if !valid_identifier(&m.model) || m.display_name.trim().is_empty() || !valid_identifier(&m.default_reasoning_effort) || m.supported_reasoning_efforts.is_empty()
                    || m.supported_reasoning_efforts.iter().any(|e| !valid_identifier(&e.reasoning_effort))
                    || !m.supported_reasoning_efforts.iter().any(|e| e.reasoning_effort == m.default_reasoning_effort) { bail!("Catálogo inválido do Codex."); }
                if !seen.insert(m.model.clone()) { continue; }
                models.push(AiModel { value: m.model, label: m.display_name, compatibility_verified: true,
                    default_reasoning_effort: Some(m.default_reasoning_effort),
                    reasoning_efforts: m.supported_reasoning_efforts.into_iter().map(|e| ModelEffort { label: effort_label(&e.reasoning_effort), value: e.reasoning_effort }).collect(),
                });
            }
            cursor = page.next_cursor;
            match &cursor { None => break, Some(c) if c.is_empty() || !cursors.insert(c.clone()) => bail!("Paginação inválida do Codex."), _ => {} }
        }
        Ok(models)
    }).await.unwrap_or_else(|_| Err(anyhow::anyhow!("A consulta do Codex excedeu o tempo limite de 15 segundos.")));
    // Kill and reap even on errors/timeouts; kill_on_drop also covers cancellation.
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

fn effort_label(effort: &str) -> String {
    match effort {
        "none" => "Nenhum",
        "minimal" => "Mínimo",
        "low" => "Baixo",
        "medium" => "Médio",
        "high" => "Alto",
        "xhigh" => "Extra alto",
        "max" => "Máximo",
        "ultra" => "Ultra",
        other => other,
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn server(
        status: u16,
        body: Value,
        delay: Duration,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/models", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let length = socket.read(&mut request).await.unwrap();
            tokio::time::sleep(delay).await;
            let body = body.to_string();
            let _ = socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            String::from_utf8(request[..length].to_vec()).unwrap()
        });
        (url, handle)
    }

    #[tokio::test]
    async fn openai_auth_filters_orders_and_preserves_saved_snapshots() {
        let data = json!({"data":[
            {"id":"gpt-6-sol-2026-09-20","created":10},
            {"id":"gpt-6-sol","created":2},
            {"id":"gpt-7-new","created":3},
            {"id":"gpt-7-alpha","created":3},
            {"id":"gpt-5-mini-2026-01-01","created":1},
            {"id":"gpt-4.1","created":99},
            {"id":"gpt-image-2","created":99},
            {"id":"gpt-6-audio","created":99},
            {"id":"gpt-6-tts","created":99},
            {"id":"gpt-6-rosalind","created":99},
            {"id":"gpt-6-realtime","created":99},
            {"id":"gpt-6-transcribe","created":99},
            {"id":"gpt-6-search-api","created":99},
            {"id":"gpt-6-chat-latest","created":99},
            {"id":"gpt-6-codex","created":99},
            {"id":"gpt-6-pro","created":99},
            {"id":"gpt-6-computer-use-preview","created":99},
            {"id":"gpt-6-embedding","created":99},
            {"id":"gpt-7-new","created":3}
        ]});
        let (url, request) = server(200, data.clone(), Duration::ZERO).await;
        let models = discover_openai(Some("temporary-secret"), None, &url, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(
            models.iter().map(|m| m.value.as_str()).collect::<Vec<_>>(),
            [
                "gpt-7-alpha",
                "gpt-7-new",
                "gpt-6-sol",
                "gpt-5-mini-2026-01-01"
            ]
        );
        assert!(!models[0].compatibility_verified);
        assert!(models[2].compatibility_verified);
        let request = request.await.unwrap();
        assert!(request.starts_with("GET /v1/models "));
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer temporary-secret")
        );
        let (url, request) = server(200, data, Duration::ZERO).await;
        let models = discover_openai(
            Some("key"),
            Some("gpt-6-sol-2026-09-20"),
            &url,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(models[0].value, "gpt-6-sol-2026-09-20");
        assert!(!models[0].compatibility_verified);
        request.await.unwrap();
        assert!(
            super::super::resolve_openai_api_key(
                Some("temporary-secret"),
                Some("env-secret".into())
            )
            .unwrap()
                == "temporary-secret"
        );
    }

    #[tokio::test]
    async fn openai_failure_falls_back_without_leaking_key_and_empty_catalog_is_authoritative() {
        for (status, body) in [
            (401, json!({"error":{"message":"echo-secret"}})),
            (200, json!({"data":[{"id":"gpt-6"}]})),
            (200, json!({"wrong":[]})),
        ] {
            let (url, request) = server(status, body, Duration::ZERO).await;
            let catalog = catalog_or_fallback(
                AiProvider::Openai,
                discover_openai(Some("echo-secret"), None, &url, Duration::from_secs(1)).await,
            );
            assert_eq!(catalog.source, CatalogSource::Local);
            assert!(!catalog.warnings.is_empty());
            assert!(
                !serde_json::to_string(&catalog)
                    .unwrap()
                    .contains("echo-secret")
            );
            request.await.unwrap();
        }
        let catalog = openai_catalog(None, None).await;
        assert_eq!(catalog.source, CatalogSource::Local);
        assert!(catalog.warnings[0].contains("chave temporária"));
        let (url, request) = server(200, json!({"data":[]}), Duration::ZERO).await;
        let catalog = catalog_or_fallback(
            AiProvider::Openai,
            discover_openai(Some("key"), None, &url, Duration::from_secs(1)).await,
        );
        assert_eq!(catalog.source, CatalogSource::Provider);
        assert!(catalog.models.is_empty());
        assert!(require_selection(&catalog, "gpt-6-luna", None).is_err());
        request.await.unwrap();
    }

    #[tokio::test]
    async fn openai_timeout_is_bounded() {
        let (url, request) = server(200, json!({"data":[]}), Duration::from_secs(1)).await;
        let catalog = catalog_or_fallback(
            AiProvider::Openai,
            discover_openai(Some("key"), None, &url, Duration::from_millis(30)).await,
        );
        assert_eq!(catalog.source, CatalogSource::Local);
        request.abort();
    }

    #[cfg(unix)]
    fn executable(directory: &std::path::Path, script: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("fake-codex");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path.to_str().unwrap().to_owned()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_handshake_pagination_notifications_efforts_and_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let script = format!(
            r#"#!/bin/sh
printf '%s' "$$" > '{}/pid'
printf '%s\n' "$@" > '{}/args'
read -r line
printf '%s\n' "$line" > '{}/requests'
echo '{{"method":"notification","params":{{}}}}'
echo '{{"id":0,"result":{{}}}}'
read -r line
printf '%s\n' "$line" >> '{}/requests'
read -r line
printf '%s\n' "$line" >> '{}/requests'
echo '{{"method":"notification","params":{{}}}}'
echo '{{"id":1,"result":{{"data":[{{"model":"gpt-7-new","displayName":"Novo","hidden":false,"supportedReasoningEfforts":[{{"reasoningEffort":"max"}},{{"reasoningEffort":"low"}}],"defaultReasoningEffort":"max"}},{{"model":"gpt-hidden","displayName":"Oculto","hidden":true,"supportedReasoningEfforts":[],"defaultReasoningEffort":"low"}}],"nextCursor":"page-two"}}}}'
read -r line
printf '%s\n' "$line" >> '{}/requests'
echo '{{"id":2,"result":{{"data":[{{"model":"gpt-6-luna","displayName":"Luna","supportedReasoningEfforts":[{{"reasoningEffort":"low"}}],"defaultReasoningEffort":"low"}}],"nextCursor":null}}}}'
while :; do read -r line || exit 0; done
"#,
            directory.path().display(),
            directory.path().display(),
            directory.path().display(),
            directory.path().display(),
            directory.path().display(),
            directory.path().display()
        );
        let program = executable(directory.path(), &script);
        let catalog = codex_catalog(&program).await;
        assert_eq!(catalog.source, CatalogSource::Provider);
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(
            catalog.models[0].default_reasoning_effort.as_deref(),
            Some("max")
        );
        assert!(require_selection(&catalog, "gpt-7-new", Some("max")).is_ok());
        assert!(require_selection(&catalog, "gpt-7-new", Some("xhigh")).is_err());
        assert!(require_selection(&catalog, "gpt-6-sol", Some("low")).is_err());
        let requests: Vec<Value> = std::fs::read_to_string(directory.path().join("requests"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(requests[0]["method"], "initialize");
        assert_eq!(
            requests[0]["params"]["clientInfo"]["name"],
            "infortech_automation"
        );
        assert_eq!(requests[1]["method"], "initialized");
        assert_eq!(requests[2]["method"], "model/list");
        assert_eq!(requests[2]["params"]["includeHidden"], false);
        assert_eq!(requests[3]["params"]["cursor"], "page-two");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("args")).unwrap(),
            "app-server\n"
        );
        assert_dead(directory.path());
    }

    #[cfg(unix)]
    fn assert_dead(directory: &std::path::Path) {
        let pid = std::fs::read_to_string(directory.join("pid")).unwrap();
        let status = std::process::Command::new("kill")
            .args(["-0", &pid])
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "app-server must be reaped");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_invalid_response_and_timeout_reap_the_process() {
        let directory = tempfile::tempdir().unwrap();
        for response in [
            "not-json",
            r#"{"id":0,"error":{"message":"secret"}}"#,
            r#"{"id":0,"result":{}}"#,
        ] {
            let program = executable(
                directory.path(),
                &format!(
                    "#!/bin/sh\necho $$ > '{}/pid'\nread -r line\necho '{}'\nwhile read -r line; do :; done\n",
                    directory.path().display(),
                    response
                ),
            );
            let result = discover_codex(&program, Duration::from_millis(500)).await;
            assert!(result.is_err());
            let catalog = catalog_or_fallback(AiProvider::Codex, result);
            assert_eq!(catalog.source, CatalogSource::Local);
            assert!(!serde_json::to_string(&catalog).unwrap().contains("secret"));
            assert_dead(directory.path());
        }
        let program = executable(
            directory.path(),
            "#!/bin/sh\nread -r line\necho '{\"id\":0,\"result\":{}}'\nread -r line\nread -r line\necho '{\"id\":1,\"result\":{\"data\":[{\"model\":\"gpt-6\"}],\"nextCursor\":null}}'\n",
        );
        assert_eq!(codex_catalog(&program).await.source, CatalogSource::Local);
    }
}
