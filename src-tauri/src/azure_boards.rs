use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::time_log::{TimeLogCredential, authenticated_identity_id, normalize_organization};

const MAX_ITEMS: usize = 1_000;
const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const MAX_COMMENTS: usize = 100;
const MAX_RELATED_ITEMS: usize = 8;
const ITEM_FIELDS: &[&str] = &[
    "System.Id",
    "System.Rev",
    "System.Title",
    "System.WorkItemType",
    "System.State",
    "System.AssignedTo",
    "System.ChangedDate",
    "Microsoft.VSTS.Common.Priority",
    "System.IterationPath",
    "System.AreaPath",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureWorkItem {
    pub id: i32,
    pub revision: i32,
    pub title: String,
    pub work_item_type: String,
    pub state: String,
    pub assigned_to: String,
    pub changed_date: String,
    pub priority: Option<i32>,
    pub iteration_path: String,
    pub area_path: String,
    pub url: String,
    pub can_analyze: bool,
}

#[derive(Deserialize)]
struct WorkItemRecord {
    id: i32,
    rev: i32,
    fields: Value,
    #[serde(default)]
    relations: Vec<Relation>,
}

#[derive(Deserialize)]
struct Relation {
    rel: String,
    url: String,
}

#[derive(Deserialize)]
struct WorkItemBatch {
    value: Vec<WorkItemRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryResult {
    work_items: Vec<WorkItemReference>,
}

#[derive(Deserialize)]
struct WorkItemReference {
    id: i32,
}

// Deliberadamente sem Debug: a credencial só existe na camada nativa.
pub struct AzureBoardsClient {
    client: Client,
    organization: String,
    project: String,
    credential: TimeLogCredential,
    base_url: Url,
    retry_after_seconds: AtomicU64,
}

impl AzureBoardsClient {
    #[cfg(test)]
    pub(crate) fn for_test(
        organization: &str,
        project: &str,
        pat: &str,
        address: std::net::SocketAddr,
    ) -> Self {
        assert!(address.ip().is_loopback());
        let mut client = Self::new(organization, project, pat).unwrap();
        client.base_url = Url::parse(&format!("http://{address}/")).unwrap();
        client
    }

    pub fn new(organization: &str, project: &str, pat: &str) -> Result<Self, String> {
        let organization = normalize_organization(organization)?;
        let project = project.trim();
        if project.is_empty() {
            return Err(
                "Configure o projeto Azure em Configurações para consultar suas tarefas".into(),
            );
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!(
                env!("CARGO_PKG_NAME"),
                "/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|_| "Não foi possível preparar a conexão com o Azure DevOps".to_string())?;
        Ok(Self {
            client,
            organization,
            project: project.into(),
            credential: TimeLogCredential::pat(pat)?,
            base_url: Url::parse("https://dev.azure.com/")
                .map_err(|_| "URL interna do Azure DevOps inválida".to_string())?,
            retry_after_seconds: AtomicU64::new(0),
        })
    }

    pub fn retry_after(&self) -> Option<Duration> {
        let seconds = self.retry_after_seconds.load(Ordering::Relaxed);
        (seconds > 0).then(|| Duration::from_secs(seconds))
    }

    pub async fn identity(&self) -> Result<String, String> {
        let url = self.url(false, &["_apis", "connectionData"], "7.1-preview.1")?;
        let response = self.request(Method::GET, url, None).await?;
        authenticated_identity_id(response).map_err(|error| self.credential.redact(&error))
    }

    pub async fn list_my_items(&self) -> Result<(Vec<AzureWorkItem>, Vec<String>), String> {
        let mut url = self.url(true, &["_apis", "wit", "wiql"], "7.1")?;
        url.query_pairs_mut().append_pair("$top", "1001");
        let query: QueryResult = serde_json::from_value(
            self.request(
                Method::POST,
                url,
                Some(json!({"query": "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @Project AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC, [System.Id] DESC"})),
            )
            .await?,
        )
        .map_err(|_| "O Azure DevOps retornou uma consulta de tarefas inválida".to_string())?;
        let mut warnings = Vec::new();
        if query.work_items.len() > MAX_ITEMS {
            warnings.push("Exibindo as 1.000 tarefas atribuídas a você com alterações mais recentes. Consulte o Azure para o histórico completo.".into());
        }
        let ids: Vec<_> = query
            .work_items
            .iter()
            .take(MAX_ITEMS)
            .map(|item| item.id)
            .collect();
        let mut records = Vec::new();
        for batch in ids.chunks(200) {
            let url = self.url(true, &["_apis", "wit", "workitemsbatch"], "7.1")?;
            let response: WorkItemBatch = serde_json::from_value(
                self.request(
                    Method::POST,
                    url,
                    Some(json!({"ids": batch, "fields": ITEM_FIELDS, "errorPolicy": "Omit"})),
                )
                .await?,
            )
            .map_err(|_| "O Azure DevOps retornou detalhes de tarefas inválidos".to_string())?;
            if response.value.len() != batch.len() {
                warnings.push("Algumas tarefas não puderam ser lidas; elas podem ter sido removidas ou ter acesso restrito.".into());
            }
            records.extend(response.value);
        }

        let types: BTreeSet<_> = records
            .iter()
            .map(|item| field(&item.fields, "System.WorkItemType"))
            .collect();
        let mut actionable = BTreeSet::new();
        for item_type in types {
            match self.actionable_states(item_type).await {
                Ok(states) => actionable.extend(
                    states
                        .into_iter()
                        .map(|state| (item_type.to_owned(), state)),
                ),
                Err(error) => warnings.push(format!(
                    "Não foi possível identificar os estados de {item_type}: {error}"
                )),
            }
        }
        let mut items = Vec::with_capacity(records.len());
        for record in records {
            let item_type = field(&record.fields, "System.WorkItemType").to_owned();
            let state = field(&record.fields, "System.State").to_owned();
            let can_analyze = actionable.contains(&(item_type.clone(), state.clone()));
            let url = self.item_url(record.id)?;
            let assigned_to = record.fields.get("System.AssignedTo").map_or("", |value| {
                value
                    .as_str()
                    .unwrap_or_else(|| field(value, "displayName"))
            });
            items.push(AzureWorkItem {
                id: record.id,
                revision: record.rev,
                title: field(&record.fields, "System.Title").to_owned(),
                work_item_type: item_type,
                state,
                assigned_to: assigned_to.into(),
                changed_date: field(&record.fields, "System.ChangedDate").to_owned(),
                priority: record
                    .fields
                    .get("Microsoft.VSTS.Common.Priority")
                    .and_then(Value::as_i64)
                    .and_then(|value| i32::try_from(value).ok()),
                iteration_path: field(&record.fields, "System.IterationPath").to_owned(),
                area_path: field(&record.fields, "System.AreaPath").to_owned(),
                url,
                can_analyze,
            });
        }
        items.sort_by(|left, right| {
            right
                .changed_date
                .cmp(&left.changed_date)
                .then_with(|| right.id.cmp(&left.id))
        });
        warnings.sort();
        warnings.dedup();
        Ok((items, warnings))
    }

    pub async fn card_context(&self, id: i32) -> Result<String, String> {
        if id <= 0 {
            return Err("O identificador do card deve ser positivo".into());
        }
        let identity = self.identity().await?;
        let card = self.get_card(id).await?;
        if !field(&card.fields["System.AssignedTo"], "id").eq_ignore_ascii_case(&identity) {
            return Err(
                "O card não está mais atribuído ao usuário deste PAT. Atualize Minhas tarefas."
                    .into(),
            );
        }
        let states = self
            .actionable_states(field(&card.fields, "System.WorkItemType"))
            .await?;
        if !states.contains(field(&card.fields, "System.State")) {
            return Err("O card não está mais em um estado a fazer ou em andamento. Atualize Minhas tarefas.".into());
        }
        let mut warnings = Vec::new();
        let mut related = Vec::new();
        let mut relations = Vec::new();
        let mut related_ids = Vec::new();
        let mut seen_ids = BTreeSet::new();
        let parents_first = card
            .relations
            .iter()
            .filter(|relation| relation.rel == "System.LinkTypes.Hierarchy-Reverse")
            .chain(
                card.relations
                    .iter()
                    .filter(|relation| relation.rel != "System.LinkTypes.Hierarchy-Reverse"),
            );
        for relation in parents_first {
            if !matches!(
                relation.rel.as_str(),
                "System.LinkTypes.Hierarchy-Reverse"
                    | "System.LinkTypes.Dependency-Reverse"
                    | "System.LinkTypes.Dependency-Forward"
                    | "System.LinkTypes.Related"
            ) {
                continue;
            }
            if let Some(related_id) = self.related_id(&relation.url) {
                relations.push(json!({"relation": relation.rel, "id": related_id}));
                if related_id != id && seen_ids.insert(related_id) {
                    related_ids.push(related_id);
                }
            }
        }
        if related_ids.len() > MAX_RELATED_ITEMS {
            warnings.push(format!("Contexto limitado a {MAX_RELATED_ITEMS} cards relacionados. As demais relações estão listadas por ID."));
        }
        for related_id in related_ids.into_iter().take(MAX_RELATED_ITEMS) {
            match self.get_card(related_id).await {
                Ok(record) => related.push(card_details(&record, &mut warnings)),
                Err(error) => warnings.push(format!(
                    "Não foi possível ler o card relacionado #{related_id}: {error}"
                )),
            }
        }
        let comments = self.comments(id, &mut warnings).await;
        let details = card_details(&card, &mut warnings);
        Ok(json!({
            "card": details,
            "comments": comments,
            "relations": relations,
            "relatedCards": related,
            "warnings": warnings,
        })
        .to_string())
    }

    async fn get_card(&self, id: i32) -> Result<WorkItemRecord, String> {
        let mut url = self.url(true, &["_apis", "wit", "workitems", &id.to_string()], "7.1")?;
        url.query_pairs_mut().append_pair("$expand", "relations");
        serde_json::from_value(self.request(Method::GET, url, None).await?)
            .map_err(|_| "O Azure DevOps retornou um card inválido".to_string())
    }

    async fn actionable_states(&self, item_type: &str) -> Result<BTreeSet<String>, String> {
        let url = self.url(
            true,
            &["_apis", "wit", "workitemtypes", item_type, "states"],
            "7.1",
        )?;
        let response = self.request(Method::GET, url, None).await?;
        let states = response.get("value").and_then(Value::as_array).ok_or_else(|| {
            "O Azure DevOps retornou estados inválidos; não foi possível verificar se o card pode ser analisado".to_string()
        })?;
        Ok(states
            .iter()
            .filter(|state| matches!(field(state, "category"), "Proposed" | "InProgress"))
            .map(|state| field(state, "name").to_owned())
            .collect())
    }

    async fn comments(&self, id: i32, warnings: &mut Vec<String>) -> Vec<Value> {
        let mut comments = Vec::new();
        let mut continuation = None::<String>;
        let mut seen_tokens = BTreeSet::new();
        // ponytail: até 100 comentários em dez páginas; ampliar quando um card real exigir mais contexto.
        for _ in 0..10 {
            let response = async {
                let mut url = self.url(
                    true,
                    &["_apis", "wit", "workitems", &id.to_string(), "comments"],
                    "7.1-preview.4",
                )?;
                url.query_pairs_mut()
                    .append_pair("$top", "50")
                    .append_pair("order", "desc");
                if let Some(token) = &continuation {
                    url.query_pairs_mut()
                        .append_pair("continuationToken", token);
                }
                self.request(Method::GET, url, None).await
            }
            .await;
            let value = match response {
                Ok(value) => value,
                Err(error) => {
                    warnings.push(format!(
                        "Os comentários do card foram carregados parcialmente: {error}"
                    ));
                    return comments;
                }
            };
            let Some(page) = value.get("comments").and_then(Value::as_array) else {
                warnings.push(
                    "O Azure retornou comentários em formato inválido; contexto parcial.".into(),
                );
                return comments;
            };
            for comment in page.iter().take(MAX_COMMENTS - comments.len()) {
                comments.push(json!({
                    "id": comment.get("id").or_else(|| comment.get("commentId")),
                    "author": field(&comment["createdBy"], "displayName"),
                    "date": field(comment, "createdDate"),
                    "text": limited_text(field(comment, "text"), 4_000, warnings),
                }));
            }
            continuation = value
                .get("continuationToken")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            if continuation.is_none() {
                return comments;
            }
            if comments.len() >= MAX_COMMENTS || !seen_tokens.insert(continuation.clone()) {
                break;
            }
        }
        warnings.push(format!("Comentários limitados aos {MAX_COMMENTS} mais recentes ou dez páginas; consulte o card para o histórico completo."));
        comments
    }

    fn url(&self, project: bool, segments: &[&str], version: &str) -> Result<Url, String> {
        let mut url = self.base_url.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| "URL do Azure DevOps inválida".to_string())?;
            path.pop_if_empty().push(&self.organization);
            if project {
                path.push(&self.project);
            }
            path.extend(segments);
        }
        url.query_pairs_mut().append_pair("api-version", version);
        Ok(url)
    }

    fn item_url(&self, id: i32) -> Result<String, String> {
        let mut url = self.url(true, &["_workitems", "edit", &id.to_string()], "7.1")?;
        url.set_query(None);
        Ok(url.into())
    }

    fn related_id(&self, value: &str) -> Option<i32> {
        let url = Url::parse(value).ok()?;
        if url.origin() != self.base_url.origin() {
            return None;
        }
        let segments: Vec<_> = url.path_segments()?.collect();
        if segments
            .first()
            .is_none_or(|value| !value.eq_ignore_ascii_case(&self.organization))
            || segments.len() < 5
            || !segments[segments.len() - 2].eq_ignore_ascii_case("workitems")
            || !segments[segments.len() - 3].eq_ignore_ascii_case("wit")
            || segments[segments.len() - 4] != "_apis"
        {
            return None;
        }
        segments
            .last()?
            .parse::<i32>()
            .ok()
            .filter(|value| *value > 0)
    }

    async fn request(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
    ) -> Result<Value, String> {
        if self.retry_after().is_some() {
            return Err("As demais consultas foram adiadas para respeitar o prazo solicitado pelo Azure DevOps (Retry-After).".into());
        }
        let mut request = self
            .credential
            .apply(self.client.request(method, url))
            .header("Accept", "application/json");
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                "O Azure DevOps não respondeu em 20 segundos. A consulta será repetida no próximo ciclo.".to_string()
            } else {
                "Não foi possível conectar ao Azure DevOps. Verifique a conexão e tente novamente.".into()
            }
        })?;
        let status = response.status();
        if let Some(seconds) = response
            .headers()
            .get("Retry-After")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| {
                value.parse::<u64>().ok().or_else(|| {
                    chrono::DateTime::parse_from_rfc2822(value)
                        .ok()
                        .map(|date| {
                            (date.timestamp() - chrono::Utc::now().timestamp()).max(0) as u64
                        })
                })
            })
        {
            self.retry_after_seconds
                .fetch_max(seconds.max(1), Ordering::Relaxed);
        } else if status == StatusCode::TOO_MANY_REQUESTS {
            self.retry_after_seconds.store(120, Ordering::Relaxed);
        }
        if !status.is_success() {
            // Não propaga corpo, URL ou cabeçalhos de erro que possam ecoar a credencial.
            return Err(match status {
                StatusCode::UNAUTHORIZED => "PAT inválido ou expirado. Atualize-o em Configurações.".into(),
                StatusCode::FORBIDDEN => "O PAT não tem acesso aos cards deste projeto. Verifique Work Items — Read e as permissões do usuário.".into(),
                StatusCode::TOO_MANY_REQUESTS => "O Azure limitou as consultas (429). Aguarde o próximo ciclo de atualização.".into(),
                _ => format!("A consulta ao Azure DevOps falhou (HTTP {}).", status.as_u16()),
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Não foi possível ler a resposta do Azure DevOps".to_string())?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("A resposta do Azure DevOps excedeu o limite de 5 MB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| "O Azure DevOps retornou uma resposta inválida".to_string())
    }
}

fn field<'a>(fields: &'a Value, name: &str) -> &'a str {
    fields.get(name).and_then(Value::as_str).unwrap_or_default()
}

fn limited_text(value: &str, max_chars: usize, warnings: &mut Vec<String>) -> String {
    let mut chars = value.chars();
    let text: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some()
        && !warnings
            .iter()
            .any(|warning| warning.starts_with("Textos extensos"))
    {
        warnings.push("Textos extensos foram truncados no contexto da análise; consulte o card para o conteúdo integral.".into());
    }
    text
}

fn card_details(card: &WorkItemRecord, warnings: &mut Vec<String>) -> Value {
    let fields = [
        "System.Title",
        "System.WorkItemType",
        "System.State",
        "System.TeamProject",
        "System.IterationPath",
        "System.AreaPath",
        "System.Description",
        "Microsoft.VSTS.Common.AcceptanceCriteria",
        "Microsoft.VSTS.TCM.ReproSteps",
    ];
    let mut selected = serde_json::Map::new();
    for name in fields {
        selected.insert(
            name.into(),
            Value::String(limited_text(field(&card.fields, name), 12_000, warnings)),
        );
    }
    json!({"id": card.id, "revision": card.rev, "fields": selected})
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };

    async fn client_and_server() -> (AzureBoardsClient, TcpListener) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = AzureBoardsClient::for_test(
            "organization",
            "Projeto com espaço",
            "segredo",
            listener.local_addr().unwrap(),
        );
        (client, listener)
    }

    async fn reply(
        listener: &TcpListener,
        status: &str,
        headers: &str,
        body: Value,
    ) -> (String, Value) {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let (request, data) = read_request(&mut stream).await;
        let body = body.to_string();
        stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len()).as_bytes()).await.unwrap();
        (
            request,
            serde_json::from_slice(&data).unwrap_or(Value::Null),
        )
    }

    async fn read_request(stream: &mut TcpStream) -> (String, Vec<u8>) {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 2048];
        let (end, size) = loop {
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let end = end + 4;
                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let size = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                break (end, size);
            }
        };
        while bytes.len() < end + size {
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
        }
        (
            String::from_utf8_lossy(&bytes[..end]).into(),
            bytes[end..end + size].to_vec(),
        )
    }

    fn identity() -> Value {
        json!({"authenticatedUser": {"id": "user-guid", "providerDisplayName": "Pessoa do PAT"}})
    }

    fn custom_states() -> Value {
        json!({"value": [
            {"name": "Aguardando equipe", "category": "Proposed"},
            {"name": "Finalizada", "category": "Completed"}
        ]})
    }

    fn record(id: i32) -> Value {
        json!({"id": id, "rev": 3, "fields": {
            "System.Title": format!("Tarefa {id}"),
            "System.WorkItemType": "Custom Task",
            "System.State": if id == 1 {"Finalizada"} else {"Aguardando equipe"},
            "System.AssignedTo": {"displayName": "Pessoa do PAT", "id": "user-guid"},
            "System.ChangedDate": "2026-10-09T12:00:00Z",
            "System.IterationPath": "Projeto\\Sprint 1",
            "System.AreaPath": "Projeto\\Backend",
            "Microsoft.VSTS.Common.Priority": 2,
            "System.Description": "Descrição do requisito",
            "Microsoft.VSTS.Common.AcceptanceCriteria": "Critério verificável",
            "Microsoft.VSTS.TCM.ReproSteps": "Passos de reprodução"
        }})
    }

    #[tokio::test]
    async fn uses_the_pat_identity_and_rejects_public_access() {
        for user in [
            json!({"id": "user-guid", "providerDisplayName": "Pessoa"}),
            json!({"id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "providerDisplayName": "Pessoa"}),
            json!({"id": "user-guid", "descriptor": "System:PublicAccess;user-guid", "providerDisplayName": "Pessoa"}),
            json!({"id": "user-guid", "providerDisplayName": "Anonymous"}),
        ] {
            let valid = user.get("descriptor").is_none()
                && user["providerDisplayName"] == "Pessoa"
                && user["id"] == "user-guid";
            let (client, listener) = client_and_server().await;
            let server = tokio::spawn(async move {
                let (request, _) =
                    reply(&listener, "200 OK", "", json!({"authenticatedUser": user})).await;
                assert!(request.starts_with("GET /organization/_apis/connectionData?"));
                assert!(
                    request
                        .to_lowercase()
                        .contains("authorization: basic onnlz3jlzg8=")
                );
            });
            let result = client.identity().await;
            if valid {
                assert_eq!(result.unwrap(), "user-guid");
            } else {
                assert!(
                    result
                        .unwrap_err()
                        .contains("credencial informada é inválida")
                );
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn scopes_to_me_batches_200_caps_1000_and_uses_custom_state_categories() {
        let (client, listener) = client_and_server().await;
        let server = tokio::spawn(async move {
            let ids: Vec<_> = (1..=1001).map(|id| json!({"id": id})).collect();
            let (request, body) = reply(&listener, "200 OK", "", json!({"workItems": ids})).await;
            assert!(
                request
                    .starts_with("POST /organization/Projeto%20com%20espa%C3%A7o/_apis/wit/wiql?")
            );
            assert!(request.contains("%24top=1001"));
            assert!(
                body["query"]
                    .as_str()
                    .unwrap()
                    .contains("[System.AssignedTo] = @Me")
            );
            assert!(
                body["query"]
                    .as_str()
                    .unwrap()
                    .contains("[System.TeamProject] = @Project")
            );
            for index in 0..5 {
                let records: Vec<_> = (index * 200 + 1..=index * 200 + 200).map(record).collect();
                let (request, body) =
                    reply(&listener, "200 OK", "", json!({"value": records})).await;
                assert!(request.contains("/workitemsbatch?"));
                assert_eq!(body["ids"].as_array().unwrap().len(), 200);
                assert_eq!(body["ids"][0], index * 200 + 1);
            }
            let (request, _) = reply(
                &listener,
                "200 OK",
                "",
                json!({"value": [
                    {"name": "Aguardando equipe", "category": "Proposed"},
                    {"name": "Finalizada", "category": "Completed"}
                ]}),
            )
            .await;
            assert!(request.contains("/workitemtypes/Custom%20Task/states?"));
        });
        let (items, warnings) = client.list_my_items().await.unwrap();
        assert_eq!(items.len(), 1000);
        assert!(warnings.iter().any(|value| value.contains("1.000 tarefas")));
        assert!(items.iter().find(|item| item.id == 2).unwrap().can_analyze);
        assert!(!items.iter().find(|item| item.id == 1).unwrap().can_analyze);
        assert_eq!(items[0].priority, Some(2));
        assert!(items[0].url.ends_with("/_workitems/edit/1000"));
        assert_eq!(items[0].assigned_to, "Pessoa do PAT");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn returns_metadata_failure_as_a_warning_without_guessing_states() {
        let (client, listener) = client_and_server().await;
        let server = tokio::spawn(async move {
            reply(&listener, "200 OK", "", json!({"workItems": [{"id": 2}]})).await;
            reply(&listener, "200 OK", "", json!({"value": [record(2)]})).await;
            reply(
                &listener,
                "403 Forbidden",
                "",
                json!({"message": "segredo"}),
            )
            .await;
        });
        let (items, warnings) = client.list_my_items().await.unwrap();
        assert!(!items[0].can_analyze);
        assert_eq!(warnings.len(), 1);
        assert!(!warnings[0].contains("segredo"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn loads_card_parent_and_paginated_comments_without_following_external_urls() {
        let (client, listener) = client_and_server().await;
        let base = client.base_url.clone();
        let server = tokio::spawn(async move {
            reply(&listener, "200 OK", "", identity()).await;
            let mut card = record(2);
            card["relations"] = json!([
                {"rel": "System.LinkTypes.Hierarchy-Reverse", "url": format!("{base}organization/_apis/wit/workItems/4")},
                {"rel": "System.LinkTypes.Related", "url": "https://evil.example/_apis/wit/workItems/5"}
            ]);
            let (request, _) = reply(&listener, "200 OK", "", card).await;
            assert!(request.contains("/workitems/2?api-version=7.1&%24expand=relations"));
            reply(&listener, "200 OK", "", custom_states()).await;
            reply(&listener, "200 OK", "", record(4)).await;
            reply(&listener, "200 OK", "", json!({"comments": [{"id": 20, "text": "Mais recente", "createdBy": {"displayName": "Autor"}}], "continuationToken": "opaque+/token", "nextPage": "https://evil.example/steal"})).await;
            let (request, _) = reply(
                &listener,
                "200 OK",
                "",
                json!({"comments": [{"id": 19, "text": "Anterior"}]}),
            )
            .await;
            assert!(request.contains("continuationToken=opaque%2B%2Ftoken"));
        });
        let context: Value = serde_json::from_str(&client.card_context(2).await.unwrap()).unwrap();
        assert_eq!(
            context["card"]["fields"]["Microsoft.VSTS.Common.AcceptanceCriteria"],
            "Critério verificável"
        );
        assert_eq!(
            context["card"]["fields"]["Microsoft.VSTS.TCM.ReproSteps"],
            "Passos de reprodução"
        );
        assert_eq!(context["relatedCards"][0]["id"], 4);
        assert_eq!(context["relations"].as_array().unwrap().len(), 1);
        assert_eq!(context["comments"].as_array().unwrap().len(), 2);
        assert!(context["warnings"].as_array().unwrap().is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_a_card_reassigned_since_the_snapshot() {
        let (client, listener) = client_and_server().await;
        let server = tokio::spawn(async move {
            reply(&listener, "200 OK", "", identity()).await;
            let mut card = record(2);
            card["fields"]["System.AssignedTo"]["id"] = json!("other-person");
            reply(&listener, "200 OK", "", card).await;
        });
        assert!(
            client
                .card_context(2)
                .await
                .unwrap_err()
                .contains("não está mais atribuído")
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_a_card_completed_since_the_snapshot() {
        let (client, listener) = client_and_server().await;
        let server = tokio::spawn(async move {
            reply(&listener, "200 OK", "", identity()).await;
            reply(&listener, "200 OK", "", record(1)).await;
            reply(&listener, "200 OK", "", custom_states()).await;
        });
        assert!(
            client
                .card_context(1)
                .await
                .unwrap_err()
                .contains("não está mais em um estado")
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn limits_paginated_comments_with_a_visible_context_warning() {
        let (client, listener) = client_and_server().await;
        let server = tokio::spawn(async move {
            reply(&listener, "200 OK", "", identity()).await;
            reply(&listener, "200 OK", "", record(2)).await;
            reply(&listener, "200 OK", "", custom_states()).await;
            for index in 0..2 {
                let comments: Vec<_> = (0..50)
                    .map(|id| json!({"id": index * 50 + id, "text": "Comentário"}))
                    .collect();
                reply(
                    &listener,
                    "200 OK",
                    "",
                    json!({"comments": comments, "continuationToken": format!("next-{index}")}),
                )
                .await;
            }
        });
        let context: Value = serde_json::from_str(&client.card_context(2).await.unwrap()).unwrap();
        assert_eq!(context["comments"].as_array().unwrap().len(), 100);
        assert!(
            context["warnings"][0]
                .as_str()
                .unwrap()
                .contains("Comentários limitados")
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn reports_partial_comments_and_truncation_in_context() {
        let (client, listener) = client_and_server().await;
        let server = tokio::spawn(async move {
            reply(&listener, "200 OK", "", identity()).await;
            let mut card = record(2);
            card["fields"]["System.Description"] = json!("á".repeat(13_000));
            reply(&listener, "200 OK", "", card).await;
            reply(&listener, "200 OK", "", custom_states()).await;
            reply(
                &listener,
                "500 Internal Server Error",
                "",
                json!({"message": "segredo"}),
            )
            .await;
        });
        let context: Value = serde_json::from_str(&client.card_context(2).await.unwrap()).unwrap();
        assert_eq!(
            context["card"]["fields"]["System.Description"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            12_000
        );
        assert_eq!(context["warnings"].as_array().unwrap().len(), 2);
        assert!(!context.to_string().contains("segredo"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn redacts_http_failures_refuses_redirects_and_exposes_retry_after() {
        for (status, expected) in [
            ("401 Unauthorized", "PAT inválido"),
            ("403 Forbidden", "Work Items — Read"),
            ("429 Too Many Requests", "429"),
            ("302 Found", "302"),
        ] {
            let (client, listener) = client_and_server().await;
            let server = tokio::spawn(async move {
                reply(
                    &listener,
                    status,
                    "Retry-After: 600\r\nLocation: https://evil.example\r\n",
                    json!({"message": "segredo", "encoded": "OnNlZ3JlZG8="}),
                )
                .await;
            });
            let error = client.identity().await.unwrap_err();
            assert!(error.contains(expected));
            assert!(!error.contains("segredo"));
            assert!(!error.contains("OnNlZ3JlZG8="));
            assert_eq!(client.retry_after(), Some(Duration::from_secs(600)));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn stops_the_cycle_after_retry_after_on_a_successful_response() {
        let (client, listener) = client_and_server().await;
        let server = tokio::spawn(async move {
            reply(&listener, "200 OK", "Retry-After: 300\r\n", identity()).await;
        });
        assert_eq!(client.identity().await.unwrap(), "user-guid");
        assert!(
            client
                .list_my_items()
                .await
                .unwrap_err()
                .contains("consultas foram adiadas")
        );
        assert_eq!(client.retry_after(), Some(Duration::from_secs(300)));
        server.await.unwrap();
    }
}
