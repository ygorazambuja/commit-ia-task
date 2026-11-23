pub mod catalog;

use crate::models::{
    AiProvider, GenerationInput, PromptSettings, RawAiResponse, SavedConfig, Task,
};
use crate::process::{command_version, run_process};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;
use std::time::Duration;
use tempfile::NamedTempFile;

const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
pub const DEFAULT_AI_PROVIDER: AiProvider = AiProvider::Openai;
pub const DEFAULT_OPENAI_MODEL: &str = "gpt-6-luna";
pub const DEFAULT_CODEX_MODEL: &str = "gpt-6-luna";
pub const DEFAULT_CODEX_REASONING_EFFORT: &str = "low";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiOption {
    pub value: &'static str,
    pub label: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderCapability {
    pub id: AiProvider,
    pub display_name: &'static str,
    pub description: &'static str,
    pub models: Vec<catalog::AiModel>,
    pub default_model: &'static str,
    pub reasoning_efforts: Vec<AiOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<&'static str>,
    pub allows_api_key_input: bool,
    pub ready: bool,
    pub status_detail: String,
    pub pending_message: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderReadiness {
    pub openai_configured: bool,
    pub codex_available: bool,
    pub codex_authenticated: bool,
    pub codex_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiConfiguration {
    pub openai_model: String,
    pub codex_model: String,
    pub codex_reasoning_effort: String,
}

#[derive(Clone)]
pub struct AiSelection {
    kind: AiSelectionKind,
    pub warnings: Vec<String>,
}

#[derive(Clone)]
enum AiSelectionKind {
    Openai {
        model: String,
        api_key: String,
        client: reqwest::Client,
    },
    Codex {
        model: String,
        reasoning_effort: String,
    },
}

struct ProviderSpec {
    id: AiProvider,
    display_name: &'static str,
    description: &'static str,
    models: &'static [AiOption],
    default_model: &'static str,
    reasoning_efforts: &'static [AiOption],
    default_reasoning_effort: Option<&'static str>,
    allows_api_key_input: bool,
    pending_message: &'static str,
    generation_concurrency: usize,
}

const OPENAI_MODELS: &[AiOption] = &[
    AiOption {
        value: "gpt-6.1-sol",
        label: "GPT-6.1 Sol",
    },
    AiOption {
        value: DEFAULT_OPENAI_MODEL,
        label: "GPT-6 Luna",
    },
    AiOption {
        value: "gpt-6-sol",
        label: "GPT-6 Sol",
    },
    AiOption {
        value: "gpt-6-astra",
        label: "GPT-6 Astra",
    },
    AiOption {
        value: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
    },
    AiOption {
        value: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
    },
    AiOption {
        value: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
    },
    AiOption {
        value: "gpt-5-nano",
        label: "gpt-5-nano",
    },
    AiOption {
        value: "gpt-5-mini",
        label: "gpt-5-mini",
    },
    AiOption {
        value: "gpt-5",
        label: "gpt-5",
    },
];
const CODEX_MODELS: &[AiOption] = &[
    AiOption {
        value: "gpt-6.1-sol",
        label: "GPT-6.1 Sol",
    },
    AiOption {
        value: DEFAULT_CODEX_MODEL,
        label: "GPT-6 Luna",
    },
    AiOption {
        value: "gpt-6-sol",
        label: "GPT-6 Sol",
    },
    AiOption {
        value: "gpt-6-astra",
        label: "GPT-6 Astra",
    },
    AiOption {
        value: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
    },
    AiOption {
        value: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
    },
    AiOption {
        value: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
    },
];
const CODEX_REASONING_EFFORTS: &[AiOption] = &[
    AiOption {
        value: DEFAULT_CODEX_REASONING_EFFORT,
        label: "Baixo",
    },
    AiOption {
        value: "medium",
        label: "Médio",
    },
    AiOption {
        value: "high",
        label: "Alto",
    },
    AiOption {
        value: "xhigh",
        label: "Extra alto",
    },
];
const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: AiProvider::Openai,
        display_name: "OpenAI",
        description: "API rápida com saída estruturada",
        models: OPENAI_MODELS,
        default_model: DEFAULT_OPENAI_MODEL,
        reasoning_efforts: &[],
        default_reasoning_effort: None,
        allows_api_key_input: true,
        pending_message: "Informe uma chave OpenAI para esta execução ou configure OPENAI_API_KEY no ambiente.",
        generation_concurrency: 1,
    },
    ProviderSpec {
        id: AiProvider::Codex,
        display_name: "Codex",
        description: "Usa sua sessão local autenticada",
        models: CODEX_MODELS,
        default_model: DEFAULT_CODEX_MODEL,
        reasoning_efforts: CODEX_REASONING_EFFORTS,
        default_reasoning_effort: Some(DEFAULT_CODEX_REASONING_EFFORT),
        allows_api_key_input: false,
        pending_message: "O Codex CLI não está disponível ou autenticado. Instale e execute codex login antes de continuar.",
        generation_concurrency: 2,
    },
];

fn provider_spec(provider: AiProvider) -> &'static ProviderSpec {
    match provider {
        AiProvider::Openai => &PROVIDERS[0],
        AiProvider::Codex => &PROVIDERS[1],
    }
}

#[cfg(test)]
fn model_is_supported(provider: AiProvider, model: &str) -> bool {
    provider_spec(provider)
        .models
        .iter()
        .any(|option| option.value == model.trim())
}

fn codex_reasoning_effort_is_supported(effort: &str) -> bool {
    catalog::valid_identifier(effort.trim())
}

pub fn validate_configuration(
    openai_model: &str,
    codex_model: &str,
    codex_reasoning_effort: &str,
) -> Result<AiConfiguration> {
    Ok(AiConfiguration {
        openai_model: validate_model(openai_model)?,
        codex_model: validate_model(codex_model)?,
        codex_reasoning_effort: validate_codex_reasoning_effort(codex_reasoning_effort)?,
    })
}

pub fn normalize_configuration(config: &mut SavedConfig) {
    config.openai_model = normalized_model(AiProvider::Openai, &config.openai_model);
    config.codex_model = normalized_model(AiProvider::Codex, &config.codex_model);
    config.codex_reasoning_effort =
        if codex_reasoning_effort_is_supported(&config.codex_reasoning_effort) {
            config.codex_reasoning_effort.trim().to_owned()
        } else {
            DEFAULT_CODEX_REASONING_EFFORT.to_owned()
        };
}

fn normalized_model(provider: AiProvider, model: &str) -> String {
    if validate_model(model).is_ok() {
        model.trim().to_owned()
    } else {
        provider_spec(provider).default_model.to_owned()
    }
}

fn validate_model(model: &str) -> Result<String> {
    let model = model.trim();
    if !catalog::valid_identifier(model) {
        bail!("O ID do modelo selecionado é inválido");
    }
    Ok(model.to_owned())
}

fn validate_codex_reasoning_effort(effort: &str) -> Result<String> {
    let effort = effort.trim();
    if !codex_reasoning_effort_is_supported(effort) {
        bail!("O esforço de raciocínio selecionado não é compatível com o Codex");
    }
    Ok(effort.to_owned())
}

pub const DEFAULT_SYSTEM_PROMPT: &str = r#"Você receberá um arquivo e um diff. Gere poucas tarefas, agrupando alterações relacionadas em uma mesma tarefa sempre que fizer sentido.
Priorize qualidade sobre quantidade: somente separe em múltiplas tarefas quando houver contextos claramente diferentes.
Para cada tarefa, gere: titulo, descrição, tipo, complexidade e estimateMade.
A descrição deve ser completa e didática, explicando: o que mudou, por que mudou, impacto técnico e resultado esperado.
Escreva a descrição de forma direta, sem frases de enquadramento como "olhando o diff", "no template X", "houve uma mudança significativa" ou variações equivalentes.
Não descreva o processo de análise; descreva apenas a mudança objetiva e seus efeitos.
Leve em conta a extensão e o nome do arquivo enviados. Não retorne markdown, apenas texto puro.
Retorne sempre em português brasileiro.
Evite palavras como "Inutil" e "Refatoração"; prefira termos como Reprocessamento ou alternativas mais agradáveis ao cliente.
O tipo deve ser obrigatoriamente um desses valores: BACKEND, FRONTEND ou TESTES.
Classifique como BACKEND alterações em regras de negócio, APIs, banco de dados, integrações ou processamento no servidor; FRONTEND alterações em interfaces, componentes visuais ou interação do usuário; TESTES alterações em testes automatizados e seus arquivos de suporte.
A complexidade deve ser obrigatoriamente um desses valores: ALTA, MEDIA, BAIXA, ÚNICA.
Defina complexidade assim:
ALTA = mudança ampla com várias regras/fluxos, alto risco ou forte impacto.
MEDIA = mudança moderada com impacto controlado e algumas regras relevantes.
BAIXA = ajuste pontual e simples, baixo risco e baixo impacto.
ÚNICA = tarefa isolada e autocontida, sem dependências relevantes com outras mudanças.
O estimateMade deve ser obrigatoriamente um número inteiro entre 1 e 8, coerente com a complexidade."#;

impl ProviderReadiness {
    pub fn capabilities(&self) -> Vec<AiProviderCapability> {
        PROVIDERS
            .iter()
            .map(|provider| AiProviderCapability {
                id: provider.id,
                display_name: provider.display_name,
                description: provider.description,
                models: catalog::local_models(provider.id),
                default_model: provider.default_model,
                reasoning_efforts: provider.reasoning_efforts.to_vec(),
                default_reasoning_effort: provider.default_reasoning_effort,
                allows_api_key_input: provider.allows_api_key_input,
                ready: self.is_ready(provider.id),
                status_detail: self.status_detail(provider.id),
                pending_message: provider.pending_message,
            })
            .collect()
    }

    pub fn preferred_provider(&self) -> AiProvider {
        if self.codex_authenticated {
            AiProvider::Codex
        } else {
            DEFAULT_AI_PROVIDER
        }
    }

    fn is_ready(&self, provider: AiProvider) -> bool {
        match provider {
            AiProvider::Openai => self.openai_configured,
            AiProvider::Codex => self.codex_authenticated,
        }
    }

    fn status_detail(&self, provider: AiProvider) -> String {
        match provider {
            AiProvider::Openai if self.openai_configured => "Ambiente pronto".to_owned(),
            AiProvider::Openai => "Chave necessária".to_owned(),
            AiProvider::Codex if self.codex_authenticated => self
                .codex_version
                .clone()
                .unwrap_or_else(|| "Sessão local autenticada".to_owned()),
            AiProvider::Codex if self.codex_available => "Login necessário".to_owned(),
            AiProvider::Codex => "Indisponível".to_owned(),
        }
    }
}

pub async fn inspect_provider_readiness(api_key: Option<&str>) -> ProviderReadiness {
    inspect_provider_readiness_with(api_key, std::env::var("OPENAI_API_KEY").ok(), "codex").await
}

async fn inspect_provider_readiness_with(
    api_key: Option<&str>,
    environment_api_key: Option<String>,
    codex_program: &str,
) -> ProviderReadiness {
    let openai_configured = resolve_openai_api_key(api_key, environment_api_key).is_some();
    let (codex_version, codex_authenticated) = codex_information(codex_program).await;
    ProviderReadiness {
        openai_configured,
        codex_available: codex_version.is_some(),
        codex_authenticated,
        codex_version,
    }
}

pub(crate) async fn codex_information(program: &str) -> (Option<String>, bool) {
    let version = command_version(program).await;
    let authenticated = version.is_some()
        && run_process(
            program,
            &["login".to_owned(), "status".to_owned()],
            None,
            None,
        )
        .await
        .is_ok();
    (version, authenticated)
}

pub fn validate_prompt_settings(settings: &PromptSettings) -> Result<()> {
    if settings.system_prompt.trim().is_empty() {
        bail!("As instruções de geração não podem ficar vazias");
    }
    Ok(())
}

pub async fn prepare_generation(input: &GenerationInput) -> Result<AiSelection> {
    prepare_generation_with(
        input,
        std::env::var("OPENAI_API_KEY").ok(),
        std::env::var("CODEX_MODEL").ok(),
        "codex",
    )
    .await
}

async fn prepare_generation_with(
    input: &GenerationInput,
    environment_api_key: Option<String>,
    environment_codex_model: Option<String>,
    codex_program: &str,
) -> Result<AiSelection> {
    let (kind, catalog) = match input.ai_provider {
        AiProvider::Openai => {
            let model = validate_model(&input.openai_model)?;
            let api_key = resolve_openai_api_key(input.api_key.as_deref(), environment_api_key)
                .context(provider_spec(AiProvider::Openai).pending_message)?;
            let catalog = catalog::openai_catalog(Some(&api_key), Some(&model)).await;
            catalog::require_selection(&catalog, &model, None)?;
            (
                AiSelectionKind::Openai {
                    model,
                    api_key,
                    client: openai_client()?,
                },
                catalog,
            )
        }
        AiProvider::Codex => {
            let model = environment_codex_model
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&input.codex_model);
            let model = validate_model(model)?;
            let reasoning_effort = validate_codex_reasoning_effort(&input.codex_reasoning_effort)?;
            let (version, authenticated) = codex_information(codex_program).await;
            if version.is_none() || !authenticated {
                bail!(provider_spec(AiProvider::Codex).pending_message);
            }
            let catalog = catalog::codex_catalog(codex_program).await;
            catalog::require_selection(&catalog, &model, Some(&reasoning_effort))?;
            (
                AiSelectionKind::Codex {
                    model,
                    reasoning_effort,
                },
                catalog,
            )
        }
    };
    Ok(AiSelection {
        kind,
        warnings: catalog.warnings,
    })
}

impl AiSelection {
    pub fn concurrency(&self) -> usize {
        provider_spec(self.provider()).generation_concurrency
    }

    pub async fn generate_tasks(
        &self,
        file: &Path,
        diff: &str,
        repository: &Path,
        system_prompt: &str,
    ) -> Result<Vec<Task>> {
        let response = match &self.kind {
            AiSelectionKind::Openai {
                model,
                api_key,
                client,
            } => {
                generate_with_openai_at(
                    client,
                    file,
                    diff,
                    system_prompt,
                    api_key,
                    model,
                    OPENAI_RESPONSES_URL,
                )
                .await?
            }
            AiSelectionKind::Codex {
                model,
                reasoning_effort,
            } => {
                generate_with_codex(
                    file,
                    diff,
                    repository,
                    system_prompt,
                    model,
                    reasoning_effort,
                )
                .await?
            }
        };
        Ok(response.tasks.into_iter().map(Task::from).collect())
    }

    fn provider(&self) -> AiProvider {
        match self.kind {
            AiSelectionKind::Openai { .. } => AiProvider::Openai,
            AiSelectionKind::Codex { .. } => AiProvider::Codex,
        }
    }
}

fn user_prompt(file: &Path, diff: &str) -> String {
    format!("Arquivo:\n{}\n\nDiff:\n{diff}", file.display())
}

fn task_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "description": { "type": "string" },
                        "tipo": {
                            "type": "string",
                            "enum": ["BACKEND", "FRONTEND", "TESTES"]
                        },
                        "complexidade": {
                            "type": "string",
                            "enum": ["ALTA", "MEDIA", "BAIXA", "ÚNICA"]
                        },
                        "estimateMade": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 8
                        }
                    },
                    "required": [
                        "title",
                        "description",
                        "tipo",
                        "complexidade",
                        "estimateMade"
                    ],
                    "additionalProperties": false
                }
            },
            "fullFilePath": { "type": "string" }
        },
        "required": ["tasks", "fullFilePath"],
        "additionalProperties": false
    })
}

fn openai_request(file: &Path, diff: &str, system_prompt: &str, model: &str) -> Value {
    json!({
        "model": model,
        "instructions": system_prompt,
        "input": user_prompt(file, diff),
        "max_output_tokens": 4000,
        "store": false,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "task_generation",
                "strict": true,
                "schema": task_output_schema()
            }
        }
    })
}

fn openai_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .context("Não foi possível preparar a conexão com a OpenAI")
}

async fn generate_with_openai_at(
    client: &reqwest::Client,
    file: &Path,
    diff: &str,
    system_prompt: &str,
    api_key: &str,
    model: &str,
    endpoint: &str,
) -> Result<RawAiResponse> {
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&openai_request(file, diff, system_prompt, model))
        .send()
        .await
        .context("Falha de conexão com a OpenAI")?;
    let status = response.status();
    let body = response
        .text()
        .await
        .context("Não foi possível ler a resposta da OpenAI")?;

    if !status.is_success() {
        bail!(
            "OpenAI retornou {} para o modelo {}: {}",
            status,
            model,
            api_error_message(&body, api_key)
        );
    }

    parse_openai_response(&body).map_err(|error| {
        anyhow::anyhow!(
            "O modelo {} não retornou a saída estruturada esperada: {}",
            model,
            redact_secret(&error.to_string(), api_key)
        )
    })
}

pub(super) fn resolve_openai_api_key(
    explicit: Option<&str>,
    environment: Option<String>,
) -> Option<String> {
    explicit
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            environment
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
}

fn api_error_message(body: &str, api_key: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| truncate(body, 500));
    redact_secret(&message, api_key)
}

fn redact_secret(value: &str, secret: &str) -> String {
    value.replace(secret, "[redigido]")
}

#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    #[serde(default)]
    output: Vec<OpenAiOutput>,
    #[serde(default)]
    error: Option<OpenAiError>,
}

#[derive(Debug, Deserialize)]
struct OpenAiError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiOutput {
    #[serde(default)]
    content: Vec<OpenAiContent>,
}

#[derive(Debug, Deserialize)]
struct OpenAiContent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    refusal: Option<String>,
}

fn parse_openai_response(body: &str) -> Result<RawAiResponse> {
    let response: OpenAiResponse =
        serde_json::from_str(body).context("Resposta inválida da OpenAI")?;
    if let Some(error) = response.error {
        bail!("OpenAI: {}", error.message);
    }

    for content in response.output.iter().flat_map(|output| &output.content) {
        if content.kind == "refusal" {
            bail!(
                "A OpenAI recusou a solicitação: {}",
                content.refusal.as_deref().unwrap_or("sem detalhes")
            );
        }
        if content.kind == "output_text" {
            let text = content
                .text
                .as_deref()
                .context("A resposta da OpenAI não contém texto")?;
            return parse_task_response(text, "OpenAI");
        }
    }

    bail!("A OpenAI não retornou uma resposta estruturada");
}

async fn generate_with_codex(
    file: &Path,
    diff: &str,
    repository: &Path,
    system_prompt: &str,
    model: &str,
    reasoning_effort: &str,
) -> Result<RawAiResponse> {
    generate_with_codex_program(
        file,
        diff,
        repository,
        system_prompt,
        model,
        reasoning_effort,
        "codex",
    )
    .await
}

async fn generate_with_codex_program(
    file: &Path,
    diff: &str,
    repository: &Path,
    system_prompt: &str,
    model: &str,
    reasoning_effort: &str,
    program: &str,
) -> Result<RawAiResponse> {
    let mut schema_file =
        NamedTempFile::new().context("Não foi possível criar o schema temporário")?;
    serde_json::to_writer(schema_file.as_file_mut(), &task_output_schema())
        .context("Não foi possível escrever o schema temporário")?;
    schema_file
        .flush()
        .context("Não foi possível concluir o schema temporário")?;

    let args = codex_args(schema_file.path(), repository, model, reasoning_effort);

    let prompt = format!("{system_prompt}\n\n{}", user_prompt(file, diff));
    let output = run_process(program, &args, Some(repository), Some(&prompt))
        .await
        .context("Falha ao executar o Codex. Confirme a instalação e execute `codex login`")?;
    parse_task_response(output.trim(), "Codex")
}

pub(crate) fn codex_args(
    schema: &Path,
    repository: &Path,
    model: &str,
    reasoning_effort: &str,
) -> Vec<String> {
    let mut args = vec![
        "exec".to_owned(),
        "--ephemeral".to_owned(),
        "--sandbox".to_owned(),
        "read-only".to_owned(),
        "-c".to_owned(),
        "approval_policy=\"never\"".to_owned(),
        "-c".to_owned(),
        format!("model_reasoning_effort=\"{reasoning_effort}\""),
        "--color".to_owned(),
        "never".to_owned(),
        "--output-schema".to_owned(),
        schema.to_string_lossy().into_owned(),
        "-C".to_owned(),
        repository.to_string_lossy().into_owned(),
    ];

    args.extend(["--model".to_owned(), model.to_owned()]);
    args.push("-".to_owned());
    args
}

fn parse_task_response(value: &str, provider: &str) -> Result<RawAiResponse> {
    serde_json::from_str(value).with_context(|| {
        format!(
            "Resposta do {provider} não corresponde ao formato esperado: {}",
            truncate(value, 500)
        )
    })
}

fn truncate(value: &str, max_length: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_length).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn valid_tasks() -> Value {
        json!({
            "fullFilePath": "/repo/src/main.rs",
            "tasks": [{
                "title": "Criar aplicação",
                "description": "Migra a interface",
                "tipo": "FRONTEND",
                "complexidade": "MEDIA",
                "estimateMade": 3
            }]
        })
    }

    fn valid_generation_input(provider: AiProvider) -> GenerationInput {
        GenerationInput {
            repository_path: "/repo".to_owned(),
            sprint_id: "Sprint".to_owned(),
            area_path_id: "Área".to_owned(),
            assigned_to: "Pessoa <pessoa@infortechms.com.br>".to_owned(),
            item_contrato: "Item 1".to_owned(),
            ai_provider: provider,
            openai_model: DEFAULT_OPENAI_MODEL.to_owned(),
            codex_model: DEFAULT_CODEX_MODEL.to_owned(),
            codex_reasoning_effort: DEFAULT_CODEX_REASONING_EFFORT.to_owned(),
            api_key: None,
            create_azure_tasks: false,
            register_time_log: false,
            time_log_start_date: String::new(),
            time_log_end_date: String::new(),
            parent_work_item_id: None,
            azure_organization: String::new(),
            azure_project: String::new(),
        }
    }

    #[test]
    fn exposes_the_provider_catalog_and_execution_policy_from_one_source() {
        let readiness = ProviderReadiness {
            openai_configured: true,
            codex_available: true,
            codex_authenticated: false,
            codex_version: Some("codex-cli 1.0".to_owned()),
        };
        let capabilities = readiness.capabilities();

        assert_eq!(
            capabilities
                .iter()
                .map(|provider| provider.id)
                .collect::<Vec<_>>(),
            [AiProvider::Openai, AiProvider::Codex]
        );
        assert_eq!(capabilities[0].default_model, "gpt-6-luna");
        assert_eq!(
            capabilities[0]
                .models
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            [
                "gpt-6.1-sol",
                "gpt-6-luna",
                "gpt-6-sol",
                "gpt-6-astra",
                "gpt-5.6-luna",
                "gpt-5.6-terra",
                "gpt-5.6-sol",
                "gpt-5-nano",
                "gpt-5-mini",
                "gpt-5",
            ]
        );
        assert!(capabilities[0].allows_api_key_input);
        assert!(capabilities[0].ready);
        assert_eq!(capabilities[0].status_detail, "Ambiente pronto");
        assert_eq!(capabilities[1].default_model, "gpt-6-luna");
        assert_eq!(
            capabilities[1]
                .models
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            [
                "gpt-6.1-sol",
                "gpt-6-luna",
                "gpt-6-sol",
                "gpt-6-astra",
                "gpt-5.6-luna",
                "gpt-5.6-terra",
                "gpt-5.6-sol",
            ]
        );
        assert_eq!(
            capabilities[1]
                .reasoning_efforts
                .iter()
                .map(|option| option.value)
                .collect::<Vec<_>>(),
            ["low", "medium", "high", "xhigh"]
        );
        assert!(!capabilities[1].ready);
        assert_eq!(capabilities[1].status_detail, "Login necessário");
        assert_eq!(provider_spec(AiProvider::Openai).generation_concurrency, 1);
        assert_eq!(provider_spec(AiProvider::Codex).generation_concurrency, 2);

        let serialized = serde_json::to_value(&capabilities).expect("serialize capabilities");
        assert_eq!(serialized[0]["displayName"], "OpenAI");
        assert_eq!(serialized[0]["allowsApiKeyInput"], true);
        assert_eq!(serialized[1]["defaultReasoningEffort"], "low");
        assert!(
            serialized
                .as_array()
                .expect("provider list")
                .iter()
                .all(|provider| provider.get("apiKey").is_none())
        );
    }

    #[test]
    fn validates_and_repairs_provider_configuration_from_the_catalog() {
        let configuration = validate_configuration(" gpt-5-mini ", " gpt-5.6-sol ", " high ")
            .expect("valid provider configuration");
        assert_eq!(configuration.openai_model, "gpt-5-mini");
        assert_eq!(configuration.codex_model, "gpt-5.6-sol");
        assert_eq!(configuration.codex_reasoning_effort, "high");

        let mut legacy_config = SavedConfig {
            openai_model: "gpt-5-nano".to_owned(),
            codex_model: "gpt-5.6-luna".to_owned(),
            ..SavedConfig::default()
        };
        normalize_configuration(&mut legacy_config);
        assert_eq!(legacy_config.openai_model, "gpt-5-nano");
        assert_eq!(legacy_config.codex_model, "gpt-5.6-luna");

        assert!(validate_configuration("gpt-5.6-sol", DEFAULT_CODEX_MODEL, "low").is_ok());
        assert!(validate_configuration(DEFAULT_OPENAI_MODEL, "gpt-5", "low").is_ok());
        assert!(validate_configuration("gpt-7-new", "custom-model", "max").is_ok());
        assert!(validate_configuration("--unsafe", DEFAULT_CODEX_MODEL, "low").is_err());
        assert!(
            validate_configuration(DEFAULT_OPENAI_MODEL, DEFAULT_CODEX_MODEL, "bad effort")
                .is_err()
        );

        let mut config = SavedConfig {
            openai_model: "invalid model".to_owned(),
            codex_model: " ".to_owned(),
            codex_reasoning_effort: "bad effort".to_owned(),
            ..SavedConfig::default()
        };
        normalize_configuration(&mut config);
        assert_eq!(config.openai_model, DEFAULT_OPENAI_MODEL);
        assert_eq!(config.codex_model, DEFAULT_CODEX_MODEL);
        assert_eq!(
            config.codex_reasoning_effort,
            DEFAULT_CODEX_REASONING_EFFORT
        );
    }

    #[test]
    fn prefers_codex_only_when_its_local_session_is_ready() {
        let readiness = |openai_configured, codex_authenticated| ProviderReadiness {
            openai_configured,
            codex_available: true,
            codex_authenticated,
            codex_version: None,
        };
        assert_eq!(
            readiness(true, true).preferred_provider(),
            AiProvider::Codex
        );
        assert_eq!(
            readiness(true, false).preferred_provider(),
            AiProvider::Openai
        );
        assert_eq!(
            readiness(false, false).preferred_provider(),
            AiProvider::Openai
        );
    }

    #[tokio::test]
    async fn readiness_accepts_explicit_or_environment_openai_credentials() {
        let unavailable_codex = "/definitely/missing/codex-for-ai-test";
        let explicit = inspect_provider_readiness_with(
            Some(" form-key "),
            Some("env-key".to_owned()),
            unavailable_codex,
        )
        .await;
        assert!(explicit.openai_configured);
        assert!(!explicit.codex_available);

        let environment = inspect_provider_readiness_with(
            Some(" "),
            Some(" env-key ".to_owned()),
            unavailable_codex,
        )
        .await;
        assert!(environment.openai_configured);

        let missing =
            inspect_provider_readiness_with(Some(" "), Some("\n".to_owned()), unavailable_codex)
                .await;
        assert!(!missing.openai_configured);
    }

    #[test]
    fn builds_a_private_structured_openai_request() {
        let request = openai_request(
            Path::new("/repo/src/main.rs"),
            "+change",
            DEFAULT_SYSTEM_PROMPT,
            DEFAULT_OPENAI_MODEL,
        );
        assert_eq!(request["model"], "gpt-6-luna");
        assert_eq!(request["instructions"], DEFAULT_SYSTEM_PROMPT);
        assert_eq!(request["store"], false);
        assert_eq!(
            request["text"]["format"]["schema"]["additionalProperties"],
            false
        );
        assert!(
            request["input"]
                .as_str()
                .expect("input")
                .contains("+change")
        );
    }

    #[test]
    fn ignores_blank_openai_credentials() {
        assert_eq!(
            resolve_openai_api_key(Some("  "), Some("\n\t".to_owned())),
            None
        );
        assert_eq!(
            resolve_openai_api_key(None, Some(" env-key ".to_owned())),
            Some("env-key".to_owned())
        );
        assert_eq!(
            resolve_openai_api_key(Some(" form-key "), Some("env-key".to_owned())),
            Some("form-key".to_owned())
        );
    }

    #[tokio::test]
    async fn sends_authorization_and_structured_body_to_openai_adapter() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local server");
        let address = listener.local_addr().expect("local address");
        let response_body = json!({
            "output": [{
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": valid_tasks().to_string()
                }]
            }]
        })
        .to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept request");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let expected_length = loop {
                let read = stream.read(&mut buffer).await.expect("read request");
                assert!(read > 0, "request ended before headers");
                request.extend_from_slice(&buffer[..read]);
                if let Some(headers_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..headers_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .expect("content length");
                    break headers_end + 4 + content_length;
                }
            };
            while request.len() < expected_length {
                let read = stream.read(&mut buffer).await.expect("read request body");
                assert!(read > 0, "request ended before body");
                request.extend_from_slice(&buffer[..read]);
            }

            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write response");
            String::from_utf8(request).expect("utf-8 request")
        });

        let endpoint = format!("http://{address}/v1/responses");
        let parsed = generate_with_openai_at(
            &openai_client().unwrap(),
            Path::new("/repo/src/main.rs"),
            "+change",
            "  Minhas instruções de geração.\nPreserve o contexto.  ",
            "sk-local-test",
            DEFAULT_OPENAI_MODEL,
            &endpoint,
        )
        .await
        .expect("OpenAI adapter response");
        let request = server.await.expect("server task");
        let lower_request = request.to_ascii_lowercase();

        assert_eq!(parsed.tasks.len(), 1);
        assert!(lower_request.contains("authorization: bearer sk-local-test"));
        assert!(request.contains("\"model\":\"gpt-6-luna\""));
        assert!(request.contains("\"store\":false"));
        assert!(request.contains("\"type\":\"json_schema\""));
        assert!(request.contains("+change"));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body["instructions"],
            "  Minhas instruções de geração.\nPreserve o contexto.  "
        );
    }

    #[tokio::test]
    async fn openai_selection_clones_reuse_one_connection_with_per_request_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let body = json!({
            "output": [{"type": "message", "content": [{
                "type": "output_text", "text": valid_tasks().to_string()
            }]}]
        })
        .to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut requests = Vec::new();
            for _ in 0..2 {
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let read =
                        tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer))
                            .await
                            .expect("a segunda requisição deve reutilizar a conexão")
                            .unwrap();
                    assert!(read > 0, "a conexão deve continuar aberta entre arquivos");
                    request.extend_from_slice(&buffer[..read]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap();
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(request).unwrap());
                stream.write_all(format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                ).as_bytes()).await.unwrap();
            }
            requests
        });
        let selection = AiSelection {
            kind: AiSelectionKind::Openai {
                model: DEFAULT_OPENAI_MODEL.into(),
                api_key: "sk-first".into(),
                client: openai_client().unwrap(),
            },
            warnings: Vec::new(),
        };
        for (index, key) in ["sk-first", "sk-second"].into_iter().enumerate() {
            let AiSelectionKind::Openai { client, model, .. } = selection.clone().kind else {
                panic!("expected OpenAI selection");
            };
            generate_with_openai_at(
                &client,
                Path::new("/repo/file.rs"),
                &format!("+arquivo {index}"),
                DEFAULT_SYSTEM_PROMPT,
                key,
                &model,
                &endpoint,
            )
            .await
            .unwrap();
        }
        let requests = server.await.unwrap();
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("authorization: bearer sk-first")
        );
        assert!(
            requests[1]
                .to_ascii_lowercase()
                .contains("authorization: bearer sk-second")
        );
        assert!(!requests[1].contains("sk-first"));
    }

    #[test]
    fn parses_openai_output_text() {
        let body = json!({
            "output": [{
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": valid_tasks().to_string()
                }]
            }]
        });

        let parsed = parse_openai_response(&body.to_string()).expect("parse response");
        assert_eq!(parsed.tasks.len(), 1);
        assert_eq!(parsed.tasks[0].title, "Criar aplicação");
    }

    #[test]
    fn surfaces_openai_refusals() {
        let body = json!({
            "output": [{
                "type": "message",
                "content": [{
                    "type": "refusal",
                    "refusal": "Não posso processar"
                }]
            }]
        });

        assert!(
            parse_openai_response(&body.to_string())
                .expect_err("refusal should fail")
                .to_string()
                .contains("recusou")
        );
    }

    #[test]
    fn parses_and_normalizes_task_response() {
        let mut value = valid_tasks();
        value["tasks"][0]["complexidade"] = json!("invalid");
        value["tasks"][0]["estimateMade"] = json!(12);
        let response = parse_task_response(&value.to_string(), "Teste").expect("parse tasks");
        let task = Task::from(response.tasks.into_iter().next().expect("task"));
        assert_eq!(task.complexidade, "ÚNICA");
        assert_eq!(task.estimate_made, 1);
    }

    #[test]
    fn extracts_api_error_without_exposing_the_whole_body() {
        assert_eq!(
            api_error_message(r#"{"error":{"message":"Chave inválida"}}"#, "sk-test"),
            "Chave inválida"
        );
        assert_eq!(reqwest::StatusCode::UNAUTHORIZED.as_u16(), 401);
    }

    #[tokio::test]
    async fn redacts_api_key_and_names_model_in_http_and_structured_output_errors() {
        for status in [401, 200] {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind local server");
            let address = listener.local_addr().expect("local address");
            let api_key = "sk-secret-test";
            let response_body = json!({
                "error": { "message": format!("A chave {api_key} foi rejeitada") }
            })
            .to_string();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.expect("accept request");
                let mut request = [0_u8; 4096];
                let _bytes_read = stream.read(&mut request).await.expect("read request");
                let response = format!(
                    "HTTP/1.1 {status} Test\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("write response");
            });

            let endpoint = format!("http://{address}/v1/responses");
            let error = generate_with_openai_at(
                &openai_client().unwrap(),
                Path::new("/repo/src/main.rs"),
                "+change",
                DEFAULT_SYSTEM_PROMPT,
                api_key,
                DEFAULT_OPENAI_MODEL,
                &endpoint,
            )
            .await
            .expect_err("OpenAI error should fail");
            server.await.expect("server task");

            let message = error.to_string();
            assert!(!message.contains(api_key));
            assert!(message.contains("[redigido]"));
            assert!(message.contains(DEFAULT_OPENAI_MODEL));
            if status == 200 {
                assert!(message.contains("saída estruturada esperada"));
            }
        }
    }

    #[test]
    fn codex_runs_ephemerally_with_read_only_schema_output() {
        let args = codex_args(
            Path::new("/tmp/schema.json"),
            Path::new("/repo"),
            "gpt-test",
            "low",
        );
        assert_eq!(args[0], "exec");
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--sandbox", "read-only"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-c", "approval_policy=\"never\""])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--output-schema", "/tmp/schema.json"])
        );
        assert!(args.windows(2).any(|pair| pair == ["--model", "gpt-test"]));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn codex_args_include_the_selected_model_and_effort() {
        let args = codex_args(
            Path::new("/tmp/schema.json"),
            Path::new("/repo"),
            DEFAULT_CODEX_MODEL,
            "medium",
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--model", "gpt-6-luna"])
        );
        assert!(
            args.iter()
                .any(|argument| argument == "model_reasoning_effort=\"medium\"")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_adapter_executes_with_stdin_and_parses_stdout() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temp directory");
        let script = directory.path().join("fake-codex");
        let args_log = directory.path().join("args.log");
        let stdin_log = directory.path().join("stdin.log");
        let response = valid_tasks().to_string();
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\ncat > '{}'\nprintf '%s' '{}'\n",
                args_log.display(),
                stdin_log.display(),
                response
            ),
        )
        .expect("write fake Codex");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("make fake executable");

        let parsed = generate_with_codex_program(
            Path::new("/repo/src/main.rs"),
            "+codex-change",
            directory.path(),
            "  Minhas instruções de geração.\nPreserve o contexto.  ",
            DEFAULT_CODEX_MODEL,
            "low",
            script.to_str().expect("script path"),
        )
        .await
        .expect("Codex adapter response");

        let args = fs::read_to_string(args_log).expect("read args");
        let stdin = fs::read_to_string(stdin_log).expect("read stdin");
        assert_eq!(parsed.tasks.len(), 1);
        assert!(args.lines().any(|arg| arg == "exec"));
        assert!(args.lines().any(|arg| arg == "--output-schema"));
        assert!(args.lines().any(|arg| arg == "gpt-6-luna"));
        assert!(stdin.contains("+codex-change"));
        assert_eq!(
            stdin,
            "  Minhas instruções de geração.\nPreserve o contexto.  \n\nArquivo:\n/repo/src/main.rs\n\nDiff:\n+codex-change"
        );
    }

    #[tokio::test]
    async fn prepares_only_the_selected_openai_options_and_resolves_key_precedence() {
        let mut input = valid_generation_input(AiProvider::Openai);
        input.api_key = Some(" form-key ".to_owned());
        input.codex_model = "inactive-model".to_owned();
        input.codex_reasoning_effort = "inactive-effort".to_owned();

        let selection = prepare_generation_with(
            &input,
            Some("env-key".to_owned()),
            None,
            "/this/program/must-not-run-for-openai",
        )
        .await
        .expect("valid OpenAI selection");
        assert_eq!(selection.concurrency(), 1);
        match selection.kind {
            AiSelectionKind::Openai { model, api_key, .. } => {
                assert_eq!(model, DEFAULT_OPENAI_MODEL);
                assert_eq!(api_key, "form-key");
            }
            AiSelectionKind::Codex { .. } => panic!("expected OpenAI selection"),
        }

        input.api_key = None;
        let environment_selection = prepare_generation_with(
            &input,
            Some(" env-only-key ".to_owned()),
            None,
            "/this/program/must-not-run-for-openai",
        )
        .await
        .expect("environment OpenAI selection");
        match environment_selection.kind {
            AiSelectionKind::Openai { api_key, .. } => assert_eq!(api_key, "env-only-key"),
            AiSelectionKind::Codex { .. } => panic!("expected OpenAI selection"),
        }

        let error =
            prepare_generation_with(&input, None, None, "/this/program/must-not-run-for-openai")
                .await
                .err()
                .expect("missing OpenAI key should fail");
        assert!(error.to_string().contains("Informe uma chave OpenAI"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn revalidates_codex_login_and_applies_a_supported_environment_model() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temp directory");
        let authenticated = directory.path().join("codex-authenticated");
        fs::write(
            &authenticated,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-cli 1.0'; exit 0; fi\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi\nexit 1\n",
        )
        .expect("write authenticated fake Codex");
        fs::set_permissions(&authenticated, fs::Permissions::from_mode(0o700))
            .expect("make authenticated fake executable");

        let readiness = inspect_provider_readiness_with(
            None,
            None,
            authenticated.to_str().expect("script path"),
        )
        .await;
        assert!(readiness.codex_available);
        assert!(readiness.codex_authenticated);
        assert_eq!(readiness.codex_version.as_deref(), Some("codex-cli 1.0"));

        let input = valid_generation_input(AiProvider::Codex);
        let selection = prepare_generation_with(
            &input,
            None,
            Some(" gpt-6-sol ".to_owned()),
            authenticated.to_str().expect("script path"),
        )
        .await
        .expect("authenticated Codex selection");
        assert_eq!(selection.concurrency(), 2);
        match selection.kind {
            AiSelectionKind::Codex {
                model,
                reasoning_effort,
            } => {
                assert_eq!(model, "gpt-6-sol");
                assert_eq!(reasoning_effort, DEFAULT_CODEX_REASONING_EFFORT);
            }
            AiSelectionKind::Openai { .. } => panic!("expected Codex selection"),
        }

        let error = prepare_generation_with(
            &input,
            None,
            Some("gpt-5".to_owned()),
            authenticated.to_str().expect("script path"),
        )
        .await
        .err()
        .expect("cross-provider CODEX_MODEL should fail");
        assert!(error.to_string().contains("não está disponível"));

        let unauthenticated = directory.path().join("codex-unauthenticated");
        fs::write(
            &unauthenticated,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-cli 1.0'; exit 0; fi\nexit 1\n",
        )
        .expect("write unauthenticated fake Codex");
        fs::set_permissions(&unauthenticated, fs::Permissions::from_mode(0o700))
            .expect("make unauthenticated fake executable");
        let readiness = inspect_provider_readiness_with(
            None,
            None,
            unauthenticated.to_str().expect("script path"),
        )
        .await;
        assert!(readiness.codex_available);
        assert!(!readiness.codex_authenticated);
        assert_eq!(
            readiness.capabilities()[1].status_detail,
            "Login necessário"
        );
        let error = prepare_generation_with(
            &input,
            None,
            None,
            unauthenticated.to_str().expect("script path"),
        )
        .await
        .err()
        .expect("unauthenticated Codex should fail");
        assert!(error.to_string().contains("codex login"));
    }

    #[test]
    fn accepts_only_the_supported_models_for_each_provider() {
        for model in ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"] {
            assert!(validate_configuration(model, model, "low").is_ok());
        }
        assert!(model_is_supported(AiProvider::Openai, "gpt-5-mini"));
        assert!(model_is_supported(AiProvider::Codex, "gpt-5.6-luna"));
        assert!(codex_reasoning_effort_is_supported("xhigh"));
        assert!(codex_reasoning_effort_is_supported("max"));
        assert!(!model_is_supported(AiProvider::Openai, "gpt-5.2-codex"));
        assert!(!model_is_supported(AiProvider::Codex, "gpt-5"));
    }
}
