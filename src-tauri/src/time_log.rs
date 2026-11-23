mod batch;

pub use batch::{
    MAX_DAILY_MINUTES, TimeLogBatchFailure, TimeLogBatchInput, TimeLogBatchResult,
    TimeLogCreatedEntry, TimeLogPlan, TimeLogPlanDay, TimeLogPlanEntry, TimeLogWork,
    plan_time_logs,
};

use std::{collections::BTreeMap, env, fmt, str::FromStr, sync::OnceLock, time::Duration};

use chrono::{Datelike, Local, NaiveDate};
use reqwest::{
    Client, Method, Response, StatusCode, Url,
    header::{ACCEPT, CONTENT_TYPE},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_API_VERSION: &str = "7.1-preview.1";
pub const DEFAULT_TIMEOUT_SECONDS: u64 = 30;
const PUBLIC_ACCESS_ID: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MAX_EXTENSION_DOCUMENTS: usize = 100_000;
static BATCH_CREATION_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum TimeLogType {
    Backend,
    Frontend,
    Teste,
    #[serde(rename = "Análise")]
    Analise,
    #[serde(rename = "Reunião")]
    Reuniao,
}

impl TimeLogType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Backend => "Backend",
            Self::Frontend => "Frontend",
            Self::Teste => "Teste",
            Self::Analise => "Análise",
            Self::Reuniao => "Reunião",
        }
    }
}

impl fmt::Display for TimeLogType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for TimeLogType {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_lowercase().as_str() {
            "backend" => Ok(Self::Backend),
            "frontend" => Ok(Self::Frontend),
            "teste" => Ok(Self::Teste),
            "análise" | "analise" => Ok(Self::Analise),
            "reunião" | "reuniao" => Ok(Self::Reuniao),
            _ => Err(
                "o tipo deve ser Backend, Frontend, Teste, Análise ou Reunião (Análise e Reunião também aceitam nomes sem acento, sem diferenciar maiúsculas de minúsculas)"
                    .into(),
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TimeLogCredentialKind {
    Pat,
    Bearer,
}

/// Credencial de uso deliberadamente sem `Debug`.
pub struct TimeLogCredential {
    kind: TimeLogCredentialKind,
    secret: String,
}

impl TimeLogCredential {
    pub fn pat(secret: impl Into<String>) -> Result<Self, String> {
        let secret = secret.into();
        Ok(Self {
            kind: TimeLogCredentialKind::Pat,
            secret: required(secret.trim().to_owned(), "o PAT não pode ficar vazio")?,
        })
    }

    pub fn bearer(secret: impl Into<String>) -> Result<Self, String> {
        let secret = secret.into();
        Ok(Self {
            kind: TimeLogCredentialKind::Bearer,
            secret: required(secret.trim().to_owned(), "o token não pode ficar vazio")?,
        })
    }

    pub(crate) fn resolve(
        explicit: Option<&str>,
        explicit_kind: Option<TimeLogCredentialKind>,
        stored_pat: Option<&str>,
    ) -> Result<Self, String> {
        let environment_pat = nonempty_env("ADO_PAT");
        let environment_bearer = nonempty_env("ADO_TOKEN");
        Self::resolve_sources(
            explicit,
            explicit_kind,
            stored_pat,
            environment_pat.as_deref(),
            environment_bearer.as_deref(),
        )
    }

    pub fn from_environment() -> Result<Self, String> {
        Self::resolve(None, None, None)
    }

    fn resolve_sources(
        explicit: Option<&str>,
        explicit_kind: Option<TimeLogCredentialKind>,
        stored_pat: Option<&str>,
        environment_pat: Option<&str>,
        environment_bearer: Option<&str>,
    ) -> Result<Self, String> {
        match (explicit, explicit_kind) {
            (Some(secret), Some(TimeLogCredentialKind::Pat)) => return Self::pat(secret),
            (Some(secret), Some(TimeLogCredentialKind::Bearer)) => return Self::bearer(secret),
            (Some(_), None) => return Err("Informe o tipo da credencial enviada".into()),
            (None, Some(_)) => {
                return Err("Informe a credencial ou remova o tipo selecionado".into());
            }
            (None, None) => {}
        }

        if let Some(secret) = stored_pat {
            return Self::pat(secret);
        }

        match (
            environment_pat.filter(|value| !value.trim().is_empty()),
            environment_bearer.filter(|value| !value.trim().is_empty()),
        ) {
            (Some(_), Some(_)) => Err(
                "ADO_PAT e ADO_TOKEN estão definidos; mantenha somente a credencial desejada"
                    .into(),
            ),
            (Some(secret), None) => Self::pat(secret),
            (None, Some(secret)) => Self::bearer(secret),
            (None, None) => Err(
                "credencial ausente: configure o PAT no aplicativo ou defina ADO_PAT/ADO_TOKEN no ambiente/.env"
                    .into(),
            ),
        }
    }

    pub(crate) fn apply(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self.kind {
            TimeLogCredentialKind::Pat => request.basic_auth("", Some(&self.secret)),
            TimeLogCredentialKind::Bearer => request.bearer_auth(&self.secret),
        }
    }

    pub(crate) fn redact(&self, text: &str) -> String {
        text.replace(&self.secret, "<redacted>")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogDocument {
    pub minutes: u32,
    pub user: String,
    pub user_id: String,
    pub date: String,
    pub date_week: String,
    pub work_item_id: i32,
    #[serde(rename = "type")]
    pub kind: TimeLogType,
    pub comment: String,
}

#[derive(Clone)]
struct Identity {
    name: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExistingTimeLogDocument {
    minutes: u32,
    date: String,
}

struct PostFailure {
    message: String,
    indeterminate: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthenticatedAzureUser {
    pub display_name: String,
    pub email: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionData {
    authenticated_user: AuthenticatedUser,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedUser {
    id: String,
    #[serde(default)]
    descriptor: String,
    #[serde(default)]
    provider_display_name: String,
    #[serde(default)]
    custom_display_name: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    properties: Value,
}

impl AuthenticatedUser {
    fn parse(self) -> Result<(Identity, AuthenticatedAzureUser), String> {
        if self.id.trim().eq_ignore_ascii_case(PUBLIC_ACCESS_ID)
            || self
                .descriptor
                .split(';')
                .next()
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("System:PublicAccess"))
            || self
                .provider_display_name
                .trim()
                .eq_ignore_ascii_case("Anonymous")
            || self
                .custom_display_name
                .trim()
                .eq_ignore_ascii_case("Anonymous")
            || self.display_name.trim().eq_ignore_ascii_case("Anonymous")
        {
            return Err(
                "a credencial informada é inválida ou não foi aceita pela organização do Azure DevOps"
                    .to_string(),
            );
        }

        let email = account_email(&self.properties);
        let name = [
            self.provider_display_name,
            self.custom_display_name,
            self.display_name,
        ]
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "o Azure DevOps não retornou o nome da identidade autenticada".to_string()
        })?;
        let id = required(
            self.id,
            "o Azure DevOps não retornou o ID da identidade autenticada",
        )?;

        Ok((
            Identity {
                name: name.clone(),
                id,
            },
            AuthenticatedAzureUser {
                display_name: name,
                email,
            },
        ))
    }
}

pub(crate) fn authenticated_identity_id(value: Value) -> Result<String, String> {
    let connection: ConnectionData = serde_json::from_value(value)
        .map_err(|_| "o Azure DevOps retornou uma identidade inválida".to_string())?;
    connection
        .authenticated_user
        .parse()
        .map(|(identity, _)| identity.id)
}

pub struct TimeLogService {
    client: Client,
    organization: String,
    api_version: String,
    credential: TimeLogCredential,
    identity: Option<Identity>,
    connection_base_url: Url,
    extension_base_url: Url,
}

impl TimeLogService {
    pub fn from_credential(
        organization: impl AsRef<str>,
        credential: TimeLogCredential,
    ) -> Result<Self, String> {
        Self::with_options(
            organization,
            credential,
            DEFAULT_API_VERSION,
            DEFAULT_TIMEOUT_SECONDS,
        )
    }

    pub fn with_options(
        organization: impl AsRef<str>,
        credential: TimeLogCredential,
        api_version: impl Into<String>,
        timeout_seconds: u64,
    ) -> Result<Self, String> {
        if timeout_seconds == 0 {
            return Err("ADO_TIMEOUT/--timeout deve ser maior que zero".into());
        }

        let organization = normalize_organization(organization.as_ref())?;
        let api_version = required(api_version.into(), "a versão da API não pode ficar vazia")?;
        let client = Client::builder()
            .timeout(Duration::from_secs(timeout_seconds))
            // Impede que Authorization seja encaminhado a outra origem.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!(
                env!("CARGO_PKG_NAME"),
                "/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|error| format!("não foi possível criar o cliente HTTP: {error}"))?;

        Ok(Self {
            client,
            organization,
            api_version,
            credential,
            identity: None,
            connection_base_url: Url::parse("https://dev.azure.com/")
                .map_err(|error| format!("URL base de identidade inválida: {error}"))?,
            extension_base_url: Url::parse("https://extmgmt.dev.azure.com/")
                .map_err(|error| format!("URL base da extensão inválida: {error}"))?,
        })
    }

    /// Sobrescreve a identidade autenticada. Mantido para compatibilidade da CLI.
    pub fn with_identity(
        mut self,
        name: impl Into<String>,
        id: impl Into<String>,
    ) -> Result<Self, String> {
        let name = name.into();
        let id = id.into();
        self.identity = Some(Identity {
            name: required(
                name.trim().to_owned(),
                "o nome do usuário não pode ficar vazio",
            )?,
            id: required(id.trim().to_owned(), "o ID do usuário não pode ficar vazio")?,
        });
        Ok(self)
    }

    pub fn organization(&self) -> &str {
        &self.organization
    }

    pub async fn identify_user(&self) -> Result<AuthenticatedAzureUser, String> {
        self.authenticated_user()
            .await?
            .parse()
            .map(|(_, user)| user)
    }

    /// Consulta o saldo global do usuário e devolve o plano sem criar documentos.
    pub async fn preview_batch(&self, input: &TimeLogBatchInput) -> Result<TimeLogPlan, String> {
        let today = Local::now().date_naive();
        let validation = plan_time_logs(input, &BTreeMap::new(), today)?;
        if validation.requested_minutes == 0 {
            return Ok(validation);
        }

        let identity = self.identity().await?;
        let used = self.existing_minutes(&identity).await?;
        plan_time_logs(input, &used, today)
    }

    /// Planeja e cria um lote sequencialmente, interrompendo na primeira falha.
    pub async fn create_batch(
        &self,
        input: &TimeLogBatchInput,
    ) -> Result<TimeLogBatchResult, String> {
        let today = Local::now().date_naive();
        let validation = plan_time_logs(input, &BTreeMap::new(), today)?;
        if validation.requested_minutes == 0 {
            return Ok(TimeLogBatchResult::without_posts(validation));
        }

        // Evita duas criações concorrentes dentro deste processo entre a leitura
        // do saldo e os POSTs. Outros clientes continuam fora desta coordenação.
        let _creation_guard = BATCH_CREATION_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;

        let identity = self.identity().await?;
        let used = self.existing_minutes(&identity).await?;
        let initial_plan = plan_time_logs(input, &used, today)?;
        if initial_plan.missing_minutes > 0 {
            return Ok(TimeLogBatchResult::without_posts(initial_plan));
        }

        // A segunda leitura reduz a janela entre a consulta de saldo e o primeiro POST.
        // A API não oferece transação nem chave de idempotência, portanto isto continua
        // sendo uma proteção best effort contra concorrência externa.
        let latest_used = self.existing_minutes(&identity).await?;
        let plan = plan_time_logs(input, &latest_used, today)?;
        if plan.missing_minutes > 0 {
            return Ok(TimeLogBatchResult::without_posts(plan));
        }

        let entries = plan.entries();
        let documents = entries
            .iter()
            .map(|entry| build_document(input.work_item_id, entry, identity.clone()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut created = Vec::with_capacity(entries.len());

        for (index, (entry, document)) in entries.iter().zip(documents.iter()).enumerate() {
            match self.post_document(document).await {
                Ok(document_id) => created.push(TimeLogCreatedEntry {
                    entry: entry.clone(),
                    document_id,
                }),
                Err(failure) => {
                    return Ok(TimeLogBatchResult {
                        plan,
                        created,
                        pending: entries.iter().skip(index + 1).cloned().collect(),
                        failure: Some(TimeLogBatchFailure {
                            entry: entry.clone(),
                            error: failure.message,
                            indeterminate: failure.indeterminate,
                        }),
                        post_attempts: index + 1,
                        retryable: false,
                    });
                }
            }
        }

        Ok(TimeLogBatchResult {
            plan,
            post_attempts: created.len(),
            created,
            pending: Vec::new(),
            failure: None,
            retryable: false,
        })
    }

    async fn identity(&self) -> Result<Identity, String> {
        match &self.identity {
            Some(identity) => Ok(identity.clone()),
            None => self.authenticated_identity().await,
        }
    }

    async fn existing_minutes(
        &self,
        identity: &Identity,
    ) -> Result<BTreeMap<NaiveDate, u32>, String> {
        let response = self
            .request(Method::GET, self.time_log_url()?)
            .send()
            .await
            .map_err(|error| format!("falha de rede ao consultar os lançamentos: {error}"))?;

        if response.status() == StatusCode::NOT_FOUND {
            return Ok(BTreeMap::new());
        }
        if !response.status().is_success() {
            return Err(self
                .response_error(response, "não foi possível consultar os lançamentos")
                .await);
        }

        let value = response
            .json::<Value>()
            .await
            .map_err(|error| format!("resposta de lançamentos inválida: {error}"))?;
        let documents = extension_documents(value)?;
        validate_document_count(documents.len())?;

        let mut used = BTreeMap::new();
        for value in documents {
            let user_id = value.get("userId").and_then(Value::as_str).ok_or_else(|| {
                "um documento existente do Time Log não informa um userId válido".to_string()
            })?;
            if !user_id.trim().eq_ignore_ascii_case(identity.id.trim()) {
                continue;
            }
            let document = serde_json::from_value::<ExistingTimeLogDocument>(value)
                .map_err(|error| format!("documento existente do Time Log inválido: {error}"))?;

            let date = NaiveDate::parse_from_str(&document.date, "%Y-%m-%d").map_err(|_| {
                "um lançamento existente do usuário possui uma data inválida".to_string()
            })?;
            let total = used.entry(date).or_insert(0_u32);
            *total = total
                .checked_add(document.minutes)
                .ok_or_else(|| "a soma dos lançamentos existentes é grande demais".to_string())?;
        }
        Ok(used)
    }

    async fn post_document(
        &self,
        document: &TimeLogDocument,
    ) -> Result<Option<String>, PostFailure> {
        let response = self
            .request(Method::POST, self.time_log_url().map_err(|message| PostFailure {
                message,
                indeterminate: false,
            })?)
            .header(CONTENT_TYPE, "application/json")
            .json(document)
            .send()
            .await
            .map_err(|error| PostFailure {
                message: format!(
                    "falha de rede ao criar o lançamento: {error}. O resultado pode ser indeterminado; confira a aba Time Log Free antes de repetir"
                ),
                indeterminate: true,
            })?;

        if !response.status().is_success() {
            return Err(PostFailure {
                message: self
                    .response_error(response, "não foi possível criar o lançamento")
                    .await,
                indeterminate: false,
            });
        }

        // Algumas versões confirmam a criação sem devolver JSON.
        let body = response.text().await.unwrap_or_default();
        Ok(serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|json| json.get("id").cloned())
            .and_then(value_as_string))
    }

    async fn authenticated_identity(&self) -> Result<Identity, String> {
        self.authenticated_user()
            .await?
            .parse()
            .map(|(identity, _)| identity)
    }

    async fn authenticated_user(&self) -> Result<AuthenticatedUser, String> {
        let response = self
            .request(Method::GET, self.connection_url()?)
            .send()
            .await
            .map_err(|error| format!("falha de rede ao consultar a identidade: {error}"))?;

        if !response.status().is_success() {
            return Err(self
                .response_error(response, "não foi possível consultar a identidade")
                .await);
        }

        let data = response
            .json::<ConnectionData>()
            .await
            .map_err(|error| format!("resposta de identidade inválida: {error}"))?;
        Ok(data.authenticated_user)
    }

    fn request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        self.credential.apply(
            self.client
                .request(method, url)
                .header(ACCEPT, "application/json"),
        )
    }

    fn connection_url(&self) -> Result<Url, String> {
        let mut url = self.connection_base_url.clone();
        url.path_segments_mut()
            .map_err(|_| "URL base de identidade não aceita caminhos".to_string())?
            .extend([&self.organization, "_apis", "connectionData"]);
        url.query_pairs_mut()
            .append_pair("connectOptions", "1")
            .append_pair("lastChangeId", "-1")
            .append_pair("lastChangeId64", "-1");
        Ok(url)
    }

    fn time_log_url(&self) -> Result<Url, String> {
        let mut url = self.extension_base_url.clone();
        url.path_segments_mut()
            .map_err(|_| "URL base da extensão não aceita caminhos".to_string())?
            .extend([
                &self.organization,
                "_apis",
                "ExtensionManagement",
                "InstalledExtensions",
                "TimeLog",
                "time-logging-extension",
                "Data",
                "Scopes",
                "Default",
                "Current",
                "Collections",
                "TimeLogData",
                "Documents",
            ]);
        url.query_pairs_mut()
            .append_pair("api-version", &self.api_version);
        Ok(url)
    }

    async fn response_error(&self, response: Response, action: &str) -> String {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|json| json.get("message")?.as_str().map(str::to_owned))
            .unwrap_or(body);
        let detail = self.credential.redact(&detail);
        let detail: String = detail.chars().take(1000).collect();

        if detail.trim().is_empty() {
            format!("{action}: Azure DevOps respondeu {status}")
        } else {
            format!("{action}: Azure DevOps respondeu {status}: {detail}")
        }
    }

    pub(crate) fn with_base_url(mut self, base_url: Url) -> Self {
        self.connection_base_url = base_url.clone();
        self.extension_base_url = base_url;
        self
    }
}

fn build_document(
    work_item_id: i32,
    entry: &TimeLogPlanEntry,
    identity: Identity,
) -> Result<TimeLogDocument, String> {
    let date = NaiveDate::parse_from_str(&entry.date, "%Y-%m-%d")
        .map_err(|_| "a data planejada é inválida".to_string())?;
    let iso_week = date.iso_week();

    Ok(TimeLogDocument {
        minutes: entry.minutes,
        user: identity.name,
        user_id: identity.id,
        date: date.format("%Y-%m-%d").to_string(),
        date_week: format!("{}-W{:02}", iso_week.year(), iso_week.week()),
        work_item_id,
        kind: entry.kind,
        comment: escape_extension_text(&entry.comment),
    })
}

fn extension_documents(value: Value) -> Result<Vec<Value>, String> {
    match value {
        Value::Array(documents) => Ok(documents),
        Value::Object(mut object) => {
            if let Some(count) = object.get("count") {
                let count = count.as_u64().ok_or_else(|| {
                    "a resposta de lançamentos contém uma contagem inválida".to_string()
                })?;
                let count = usize::try_from(count).map_err(|_| {
                    "a resposta de lançamentos contém uma contagem grande demais".to_string()
                })?;
                validate_document_count(count)?;
            }
            match object.remove("value") {
                Some(Value::Array(documents)) => Ok(documents),
                _ => Err("a resposta de lançamentos não contém uma lista de documentos".into()),
            }
        }
        _ => Err("a resposta de lançamentos não contém uma lista de documentos".into()),
    }
}

fn validate_document_count(count: usize) -> Result<(), String> {
    if count >= MAX_EXTENSION_DOCUMENTS {
        Err(format!(
            "a coleção do Time Log atingiu o limite de {MAX_EXTENSION_DOCUMENTS} documentos; não é possível garantir o teto diário automaticamente"
        ))
    } else {
        Ok(())
    }
}

pub fn normalize_organization(value: &str) -> Result<String, String> {
    let value = value.trim();
    let slug = if value.contains("://") {
        let url = Url::parse(value).map_err(|_| {
            "a organização deve ser um slug ou https://dev.azure.com/<org>".to_string()
        })?;
        if url.scheme() != "https"
            || url.host_str() != Some("dev.azure.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("a organização deve usar https://dev.azure.com/<org>".into());
        }
        let segments: Vec<_> = url
            .path_segments()
            .into_iter()
            .flatten()
            .filter(|segment| !segment.is_empty())
            .map(str::to_owned)
            .collect();
        if segments.len() != 1 {
            return Err("a URL da organização deve conter somente o slug da organização".into());
        }
        segments[0].clone()
    } else {
        value.to_string()
    };

    if slug.is_empty()
        || slug.len() > 50
        || !slug
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !slug
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(
            "a organização deve conter apenas letras, números e hífens, começando e terminando com letra ou número"
                .into(),
        );
    }

    Ok(slug)
}

pub fn canonical_organization_url(value: &str) -> Result<String, String> {
    normalize_organization(value).map(|slug| format!("https://dev.azure.com/{slug}"))
}

fn account_email(properties: &Value) -> Option<String> {
    let account = properties
        .as_object()?
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("Account"))?
        .1;
    let value = account
        .as_str()
        .or_else(|| account.get("$value").and_then(Value::as_str))?
        .trim();
    let mut parts = value.split('@');
    let local = parts.next()?;
    let domain = parts.next()?;
    if local.is_empty()
        || domain.is_empty()
        || parts.next().is_some()
        || value.chars().any(char::is_whitespace)
    {
        None
    } else {
        Some(value.to_owned())
    }
}

fn escape_extension_text(value: &str) -> String {
    // Formato usado pelo documento da extensão Time Log Free.
    value.replace('<', "&lt;").replace('>', "&gt")
}

fn required(value: String, message: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        Err(message.into())
    } else {
        Ok(value)
    }
}

fn nonempty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn value_as_string(value: Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::AUTHORIZATION;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn input() -> TimeLogBatchInput {
        TimeLogBatchInput {
            work_item_id: 201878,
            start_date: "2026-08-12".into(),
            end_date: "2026-08-12".into(),
            work: vec![TimeLogWork {
                minutes: 150,
                kind: TimeLogType::Frontend,
                comment: "Implementei A < B > C".into(),
            }],
        }
    }

    #[test]
    fn normalizes_slug_and_azure_url() {
        assert_eq!(normalize_organization(" minha-org ").unwrap(), "minha-org");
        assert_eq!(
            normalize_organization("https://dev.azure.com/minha-org/").unwrap(),
            "minha-org"
        );
        assert!(normalize_organization("http://dev.azure.com/org").is_err());
        assert!(normalize_organization("https://dev.azure.com/org/projeto").is_err());
        assert!(normalize_organization("https://example.com/org").is_err());
        assert!(normalize_organization("org/com/barra").is_err());
        assert_eq!(
            canonical_organization_url("InfortechMS").unwrap(),
            "https://dev.azure.com/InfortechMS"
        );
    }

    #[test]
    fn refuses_a_collection_at_the_extension_document_limit() {
        assert!(validate_document_count(MAX_EXTENSION_DOCUMENTS - 1).is_ok());
        assert!(validate_document_count(MAX_EXTENSION_DOCUMENTS).is_err());
        assert!(
            extension_documents(json!({
                "count": MAX_EXTENSION_DOCUMENTS,
                "value": []
            }))
            .is_err()
        );
    }

    #[test]
    fn reads_only_a_valid_account_email_from_identity_properties() {
        assert_eq!(
            account_email(&json!({"Account": {"$value": "user@example.com"}})).as_deref(),
            Some("user@example.com")
        );
        assert_eq!(
            account_email(&json!({"account": "other@example.com"})).as_deref(),
            Some("other@example.com")
        );
        assert_eq!(
            account_email(&json!({"Account": {"$value": "invalid"}})),
            None
        );
        assert_eq!(account_email(&json!({})), None);
    }

    #[test]
    fn resolves_credential_sources_and_conflicts_in_one_place() {
        struct Case<'a> {
            name: &'a str,
            explicit: Option<&'a str>,
            explicit_kind: Option<TimeLogCredentialKind>,
            stored_pat: Option<&'a str>,
            environment_pat: Option<&'a str>,
            environment_bearer: Option<&'a str>,
            expected: Result<(TimeLogCredentialKind, &'a str), &'a str>,
        }

        let cases = [
            Case {
                name: "PAT explícito vence as demais fontes",
                explicit: Some("pat-explicito"),
                explicit_kind: Some(TimeLogCredentialKind::Pat),
                stored_pat: Some("pat-salvo"),
                environment_pat: Some("pat-ambiente"),
                environment_bearer: Some("token-ambiente"),
                expected: Ok((TimeLogCredentialKind::Pat, "pat-explicito")),
            },
            Case {
                name: "Bearer explícito vence as demais fontes",
                explicit: Some("token-explicito"),
                explicit_kind: Some(TimeLogCredentialKind::Bearer),
                stored_pat: Some("pat-salvo"),
                environment_pat: Some("pat-ambiente"),
                environment_bearer: Some("token-ambiente"),
                expected: Ok((TimeLogCredentialKind::Bearer, "token-explicito")),
            },
            Case {
                name: "PAT salvo vence conflito no ambiente",
                explicit: None,
                explicit_kind: None,
                stored_pat: Some("pat-salvo"),
                environment_pat: Some("pat-ambiente"),
                environment_bearer: Some("token-ambiente"),
                expected: Ok((TimeLogCredentialKind::Pat, "pat-salvo")),
            },
            Case {
                name: "credencial explícita vazia ainda exige tipo",
                explicit: Some("  "),
                explicit_kind: None,
                stored_pat: Some("pat-salvo"),
                environment_pat: None,
                environment_bearer: None,
                expected: Err("Informe o tipo da credencial enviada"),
            },
            Case {
                name: "PAT do ambiente é o último fallback",
                explicit: None,
                explicit_kind: None,
                stored_pat: None,
                environment_pat: Some("pat-ambiente"),
                environment_bearer: None,
                expected: Ok((TimeLogCredentialKind::Pat, "pat-ambiente")),
            },
            Case {
                name: "Bearer do ambiente é o último fallback",
                explicit: None,
                explicit_kind: None,
                stored_pat: None,
                environment_pat: None,
                environment_bearer: Some("token-ambiente"),
                expected: Ok((TimeLogCredentialKind::Bearer, "token-ambiente")),
            },
            Case {
                name: "segredo explícito exige tipo",
                explicit: Some("segredo"),
                explicit_kind: None,
                stored_pat: Some("pat-salvo"),
                environment_pat: None,
                environment_bearer: None,
                expected: Err("Informe o tipo da credencial enviada"),
            },
            Case {
                name: "tipo explícito exige segredo",
                explicit: None,
                explicit_kind: Some(TimeLogCredentialKind::Pat),
                stored_pat: Some("pat-salvo"),
                environment_pat: None,
                environment_bearer: None,
                expected: Err("Informe a credencial ou remova o tipo selecionado"),
            },
            Case {
                name: "segredo explícito vazio não satisfaz o tipo",
                explicit: Some("  "),
                explicit_kind: Some(TimeLogCredentialKind::Bearer),
                stored_pat: Some("pat-salvo"),
                environment_pat: None,
                environment_bearer: None,
                expected: Err("o token não pode ficar vazio"),
            },
            Case {
                name: "PAT salvo vazio é inválido",
                explicit: None,
                explicit_kind: None,
                stored_pat: Some("  "),
                environment_pat: Some("pat-ambiente"),
                environment_bearer: None,
                expected: Err("o PAT não pode ficar vazio"),
            },
            Case {
                name: "duas credenciais de ambiente conflitam",
                explicit: None,
                explicit_kind: None,
                stored_pat: None,
                environment_pat: Some("pat-ambiente"),
                environment_bearer: Some("token-ambiente"),
                expected: Err(
                    "ADO_PAT e ADO_TOKEN estão definidos; mantenha somente a credencial desejada",
                ),
            },
            Case {
                name: "nenhuma fonte disponível falha",
                explicit: None,
                explicit_kind: None,
                stored_pat: None,
                environment_pat: None,
                environment_bearer: None,
                expected: Err(
                    "credencial ausente: configure o PAT no aplicativo ou defina ADO_PAT/ADO_TOKEN no ambiente/.env",
                ),
            },
        ];

        for case in cases {
            let resolved = TimeLogCredential::resolve_sources(
                case.explicit,
                case.explicit_kind,
                case.stored_pat,
                case.environment_pat,
                case.environment_bearer,
            );
            match case.expected {
                Ok((kind, secret)) => {
                    let credential = resolved.expect(case.name);
                    assert_eq!(credential.kind, kind, "{}", case.name);
                    assert_eq!(credential.secret, secret, "{}", case.name);
                    assert_eq!(credential.redact(secret), "<redacted>", "{}", case.name);
                }
                Err(expected) => {
                    assert_eq!(resolved.err().as_deref(), Some(expected), "{}", case.name);
                }
            }
        }
    }

    #[test]
    fn validates_duration_date_id_and_comment() {
        let mut value = input();
        value.work[0].minutes = 0;
        assert!(plan_time_logs(&value, &BTreeMap::new(), Local::now().date_naive()).is_err());
        value.work[0].minutes = 1;
        value.start_date = "2026-02-29".into();
        assert!(plan_time_logs(&value, &BTreeMap::new(), Local::now().date_naive()).is_err());
        value.start_date = "2026-08-12".into();
        value.work_item_id = 0;
        assert!(plan_time_logs(&value, &BTreeMap::new(), Local::now().date_naive()).is_err());
        value.work_item_id = 1;
        value.work[0].comment = "  ".into();
        assert!(plan_time_logs(&value, &BTreeMap::new(), Local::now().date_naive()).is_err());
    }

    #[test]
    fn builds_the_extension_document_and_iso_week() {
        let document = build_document(
            201878,
            &TimeLogPlanEntry {
                date: "2021-01-01".into(),
                minutes: 150,
                kind: TimeLogType::Frontend,
                comment: "Implementei A < B > C".into(),
            },
            Identity {
                name: "Ygor Azambuja".into(),
                id: "user-guid".into(),
            },
        )
        .unwrap();

        assert_eq!(
            serde_json::to_value(document).unwrap(),
            json!({
                "minutes": 150,
                "user": "Ygor Azambuja",
                "userId": "user-guid",
                "date": "2021-01-01",
                "dateWeek": "2020-W53",
                "workItemId": 201878,
                "type": "Frontend",
                "comment": "Implementei A &lt; B &gt C"
            })
        );
    }

    #[tokio::test]
    async fn an_empty_batch_does_not_authenticate_or_write() {
        let service = TimeLogService::from_credential(
            "minha-org",
            TimeLogCredential::pat("segredo").unwrap(),
        )
        .unwrap()
        .with_base_url(Url::parse("http://127.0.0.1:1/").unwrap());
        let mut empty = input();
        empty.work.clear();

        let result = service.create_batch(&empty).await.unwrap();

        assert_eq!(result.plan.requested_minutes, 0);
        assert_eq!(result.post_attempts, 0);
        assert!(!result.retryable);
    }

    #[test]
    fn serializes_types_exactly() {
        assert_eq!(
            serde_json::to_value(TimeLogType::Backend).unwrap(),
            json!("Backend")
        );
        assert_eq!(
            serde_json::from_value::<TimeLogType>(json!("Frontend")).unwrap(),
            TimeLogType::Frontend
        );
        assert_eq!(
            serde_json::from_value::<TimeLogType>(json!("Teste")).unwrap(),
            TimeLogType::Teste
        );
        assert_eq!(
            serde_json::to_value(TimeLogType::Analise).unwrap(),
            json!("Análise")
        );
        assert_eq!(
            serde_json::from_value::<TimeLogType>(json!("Análise")).unwrap(),
            TimeLogType::Analise
        );
        assert_eq!(
            serde_json::to_value(TimeLogType::Reuniao).unwrap(),
            json!("Reunião")
        );
        assert_eq!(
            serde_json::from_value::<TimeLogType>(json!("Reunião")).unwrap(),
            TimeLogType::Reuniao
        );
        assert_eq!(TimeLogType::Analise.as_str(), "Análise");
        assert_eq!(TimeLogType::Reuniao.as_str(), "Reunião");
    }

    #[test]
    fn applies_bearer_auth_and_redacts_the_secret() {
        let credential = TimeLogCredential::bearer("segredo").unwrap();
        assert_eq!(
            credential.redact("Azure recusou segredo"),
            "Azure recusou <redacted>"
        );
        let service = TimeLogService::from_credential("empresa", credential).unwrap();
        let request = service
            .request(
                Method::GET,
                Url::parse("https://dev.azure.com/empresa").unwrap(),
            )
            .build()
            .unwrap();

        assert_eq!(request.headers()[AUTHORIZATION], "Bearer segredo");
    }

    #[test]
    fn normalizes_an_explicit_cli_identity() {
        let service =
            TimeLogService::from_credential("empresa", TimeLogCredential::pat("segredo").unwrap())
                .unwrap()
                .with_identity(" Ygor Azambuja ", " user-guid ")
                .unwrap();
        let identity = service.identity.as_ref().unwrap();

        assert_eq!(identity.name, "Ygor Azambuja");
        assert_eq!(identity.id, "user-guid");
    }

    #[tokio::test]
    async fn gets_identity_then_posts_the_extension_document() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (headers, _) = read_request(stream, identity_response()).await;
            assert!(headers.starts_with("get /minha-org/_apis/connectiondata?"));
            assert!(headers.contains("authorization: basic onnlz3jlzg8="));

            let (stream, _) = listener.accept().await.unwrap();
            let (headers, _) = read_request(stream, json_response("200 OK", "[]")).await;
            assert!(headers.starts_with("get /minha-org/_apis/extensionmanagement/"));

            let (stream, _) = listener.accept().await.unwrap();
            let (headers, _) = read_request(stream, json_response("200 OK", "[]")).await;
            assert!(headers.starts_with("get /minha-org/_apis/extensionmanagement/"));

            let (stream, _) = listener.accept().await.unwrap();
            let (headers, body) = read_request(stream, created_response()).await;
            assert!(headers.starts_with("post /minha-org/_apis/extensionmanagement/"));
            assert!(headers.contains("authorization: basic onnlz3jlzg8="));
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap()["minutes"],
                150
            );
        });
        let base_url = Url::parse(&format!("http://{address}/")).unwrap();
        let service = TimeLogService::from_credential(
            "https://dev.azure.com/minha-org/",
            TimeLogCredential::pat("segredo").unwrap(),
        )
        .unwrap()
        .with_base_url(base_url);

        let created = service.create_batch(&input()).await.unwrap();

        assert_eq!(
            created.created[0].document_id.as_deref(),
            Some("document-1")
        );
        assert_eq!(created.created[0].entry.minutes, 150);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn preview_sums_every_type_and_work_item_only_for_the_authenticated_user() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            read_request(stream, identity_response()).await;

            let documents = json_response(
                "200 OK",
                r#"{"value":[
                    {"minutes":120,"userId":"user-guid","date":"2026-08-12","workItemId":1,"type":"Backend"},
                    {"minutes":180,"userId":"USER-GUID","date":"2026-08-12","workItemId":2,"type":"Frontend"},
                    {"minutes":60,"userId":"other-user","date":"2026-08-12","workItemId":3,"type":"Teste"},
                    {"minutes":"legado","userId":"other-user","date":null}
                ]}"#,
            );
            let (stream, _) = listener.accept().await.unwrap();
            let (headers, _) = read_request(stream, documents).await;
            assert!(headers.starts_with("get /minha-org/_apis/extensionmanagement/"));
        });
        let service = TimeLogService::from_credential(
            "minha-org",
            TimeLogCredential::pat("segredo").unwrap(),
        )
        .unwrap()
        .with_base_url(Url::parse(&format!("http://{address}/")).unwrap());

        let plan = service.preview_batch(&input()).await.unwrap();

        assert_eq!(plan.days[0].existing_minutes, 300);
        assert_eq!(plan.days[0].new_minutes, 120);
        assert_eq!(plan.missing_minutes, 30);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn insufficient_capacity_returns_retryable_without_a_post() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            read_request(stream, identity_response()).await;
            let (stream, _) = listener.accept().await.unwrap();
            let (headers, _) = read_request(
                stream,
                json_response(
                    "200 OK",
                    r#"[{"minutes":360,"userId":"user-guid","date":"2026-08-12"}]"#,
                ),
            )
            .await;
            assert!(headers.starts_with("get /minha-org/_apis/extensionmanagement/"));
        });
        let service = TimeLogService::from_credential(
            "minha-org",
            TimeLogCredential::pat("segredo").unwrap(),
        )
        .unwrap()
        .with_base_url(Url::parse(&format!("http://{address}/")).unwrap());

        let result = service.create_batch(&input()).await.unwrap();

        assert_eq!(result.plan.missing_minutes, 90);
        assert_eq!(result.post_attempts, 0);
        assert!(result.created.is_empty());
        assert!(result.retryable);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn treats_an_absent_extension_collection_as_empty() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (headers, _) = read_request(
                stream,
                json_response("404 Not Found", r#"{"message":"collection not found"}"#),
            )
            .await;
            assert!(headers.starts_with("get /minha-org/_apis/extensionmanagement/"));
        });
        let service = TimeLogService::from_credential(
            "minha-org",
            TimeLogCredential::pat("segredo").unwrap(),
        )
        .unwrap()
        .with_identity("Ygor", "user-guid")
        .unwrap()
        .with_base_url(Url::parse(&format!("http://{address}/")).unwrap());

        let plan = service.preview_batch(&input()).await.unwrap();

        assert_eq!(plan.days[0].existing_minutes, 0);
        assert_eq!(plan.missing_minutes, 0);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rechecks_capacity_immediately_before_the_first_post() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            read_request(stream, identity_response()).await;
            let (stream, _) = listener.accept().await.unwrap();
            read_request(stream, json_response("200 OK", "[]")).await;
            let (stream, _) = listener.accept().await.unwrap();
            read_request(
                stream,
                json_response(
                    "200 OK",
                    r#"[{"minutes":420,"userId":"user-guid","date":"2026-08-12"}]"#,
                ),
            )
            .await;
        });
        let service = TimeLogService::from_credential(
            "minha-org",
            TimeLogCredential::pat("segredo").unwrap(),
        )
        .unwrap()
        .with_base_url(Url::parse(&format!("http://{address}/")).unwrap());

        let result = service.create_batch(&input()).await.unwrap();

        assert_eq!(result.plan.missing_minutes, 150);
        assert_eq!(result.post_attempts, 0);
        assert!(result.retryable);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn stops_after_the_first_post_failure_and_keeps_confirmed_entries() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            read_request(stream, identity_response()).await;
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                read_request(stream, json_response("200 OK", "[]")).await;
            }

            let (stream, _) = listener.accept().await.unwrap();
            let (_, body) = read_request(
                stream,
                json_response("201 Created", r#"{"id":"backend-id"}"#),
            )
            .await;
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap()["type"],
                "Backend"
            );

            let (stream, _) = listener.accept().await.unwrap();
            let (_, body) = read_request(
                stream,
                json_response("500 Internal Server Error", r#"{"message":"falhou"}"#),
            )
            .await;
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap()["type"],
                "Frontend"
            );
        });
        let service = TimeLogService::from_credential(
            "minha-org",
            TimeLogCredential::pat("segredo").unwrap(),
        )
        .unwrap()
        .with_base_url(Url::parse(&format!("http://{address}/")).unwrap());
        let mut batch = input();
        batch.work = vec![
            TimeLogWork {
                minutes: 60,
                kind: TimeLogType::Backend,
                comment: "API".into(),
            },
            TimeLogWork {
                minutes: 60,
                kind: TimeLogType::Frontend,
                comment: "Tela".into(),
            },
            TimeLogWork {
                minutes: 60,
                kind: TimeLogType::Teste,
                comment: "Testes".into(),
            },
        ];

        let result = service.create_batch(&batch).await.unwrap();

        assert_eq!(result.created.len(), 1);
        assert_eq!(result.created[0].document_id.as_deref(), Some("backend-id"));
        assert_eq!(result.post_attempts, 2);
        assert_eq!(result.pending.len(), 1);
        assert_eq!(result.pending[0].kind, TimeLogType::Teste);
        assert!(!result.failure.as_ref().unwrap().indeterminate);
        assert!(!result.retryable);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn marks_a_connection_loss_during_post_as_indeterminate() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            read_request(stream, identity_response()).await;
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                read_request(stream, json_response("200 OK", "[]")).await;
            }
            let (stream, _) = listener.accept().await.unwrap();
            read_request(stream, String::new()).await;
        });
        let service = TimeLogService::from_credential(
            "minha-org",
            TimeLogCredential::pat("segredo").unwrap(),
        )
        .unwrap()
        .with_base_url(Url::parse(&format!("http://{address}/")).unwrap());

        let result = service.create_batch(&input()).await.unwrap();

        let failure = result.failure.unwrap();
        assert!(failure.indeterminate);
        assert!(failure.error.contains("confira a aba Time Log Free"));
        assert!(!failure.error.contains("segredo"));
        assert_eq!(result.post_attempts, 1);
        assert!(!result.retryable);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn identifies_the_azure_user_with_an_optional_account_email() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            read_request(
                stream,
                json_response(
                    "200 OK",
                    r#"{"authenticatedUser":{"id":"user-guid","providerDisplayName":"Ygor Azambuja","properties":{"Account":{"$type":"System.String","$value":"ygor.azambuja@infortechms.com.br"}}}}"#,
                ),
            )
            .await;
        });
        let service = TimeLogService::from_credential(
            "InfortechMS",
            TimeLogCredential::pat("segredo").unwrap(),
        )
        .unwrap()
        .with_base_url(Url::parse(&format!("http://{address}/")).unwrap());

        assert_eq!(
            service.identify_user().await.unwrap(),
            AuthenticatedAzureUser {
                display_name: "Ygor Azambuja".into(),
                email: Some("ygor.azambuja@infortechms.com.br".into()),
            }
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_every_public_access_identity_returned_for_an_invalid_pat() {
        for body in [
            r#"{"authenticatedUser":{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","providerDisplayName":"Anonymous"}}"#,
            r#"{"authenticatedUser":{"id":"different-id","descriptor":"System:PublicAccess;different-id","providerDisplayName":"Anonymous"}}"#,
            r#"{"authenticatedUser":{"id":"different-id","providerDisplayName":"Anonymous"}}"#,
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                read_request(stream, json_response("200 OK", body)).await;
            });
            let service = TimeLogService::from_credential(
                "InfortechMS",
                TimeLogCredential::pat("pat-invalido").unwrap(),
            )
            .unwrap()
            .with_base_url(Url::parse(&format!("http://{address}/")).unwrap());

            let error = service.identify_user().await.unwrap_err();

            assert!(error.contains("credencial informada é inválida"));
            assert!(!error.contains("pat-invalido"));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn ignores_absent_or_malformed_account_emails_from_connection_data() {
        for body in [
            r#"{"authenticatedUser":{"id":"user-guid","providerDisplayName":"Ygor Azambuja"}}"#,
            r#"{"authenticatedUser":{"id":"user-guid","providerDisplayName":"Ygor Azambuja","properties":{"Account":{"$value":"not-an-email"}}}}"#,
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                read_request(stream, json_response("200 OK", body)).await;
            });
            let service = TimeLogService::from_credential(
                "InfortechMS",
                TimeLogCredential::pat("segredo").unwrap(),
            )
            .unwrap()
            .with_base_url(Url::parse(&format!("http://{address}/")).unwrap());

            assert_eq!(service.identify_user().await.unwrap().email, None);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn identity_errors_redact_the_pat_for_unauthorized_responses() {
        for status in ["401 Unauthorized", "403 Forbidden"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                read_request(
                    stream,
                    json_response(status, r#"{"message":"PAT segredo recusado"}"#),
                )
                .await;
            });
            let service = TimeLogService::from_credential(
                "InfortechMS",
                TimeLogCredential::pat("segredo").unwrap(),
            )
            .unwrap()
            .with_base_url(Url::parse(&format!("http://{address}/")).unwrap());

            let error = service.identify_user().await.unwrap_err();
            assert!(!error.contains("segredo"));
            assert!(error.contains("<redacted>"));
            server.await.unwrap();
        }
    }

    async fn read_request(mut stream: TcpStream, response: String) -> (String, Vec<u8>) {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 2048];
        let (headers_end, content_length) = loop {
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(headers_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers_end = headers_end + 4;
                let headers = String::from_utf8_lossy(&bytes[..headers_end]).to_lowercase();
                let content_length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
                break (headers_end, content_length);
            }
        };
        while bytes.len() < headers_end + content_length {
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
        }
        stream.write_all(response.as_bytes()).await.unwrap();

        (
            String::from_utf8_lossy(&bytes[..headers_end]).to_lowercase(),
            bytes[headers_end..headers_end + content_length].to_vec(),
        )
    }

    fn identity_response() -> String {
        json_response(
            "200 OK",
            r#"{"authenticatedUser":{"id":"user-guid","providerDisplayName":"Ygor Azambuja"}}"#,
        )
    }

    fn created_response() -> String {
        json_response("201 Created", r#"{"id":"document-1"}"#)
    }

    fn json_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }
}
