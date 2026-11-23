use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::AiProviderCapability;
use crate::time_log::{TimeLogBatchResult, TimeLogWork};

pub use crate::ai::{DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT, DEFAULT_OPENAI_MODEL};

pub const DEFAULT_DISPLAY_NAME: &str = "Ygor Azambuja";
pub const DEFAULT_EMAIL: &str = "ygor.azambuja@infortechms.com.br";
pub const DEFAULT_ASSIGNED_TO: &str = "Ygor Azambuja <ygor.azambuja@infortechms.com.br>";
pub const DEFAULT_ITEM_CONTRATO: &str = "Item 1";
pub const DEFAULT_AZURE_ORGANIZATION: &str = "https://dev.azure.com/InfortechMS";
pub const DEFAULT_AZURE_PROJECT: &str = "SPF-SIAFIC";
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Openai,
    Codex,
}

impl Default for AiProvider {
    fn default() -> Self {
        crate::ai::DEFAULT_AI_PROVIDER
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSettings {
    pub system_prompt: String,
}

impl Default for PromptSettings {
    fn default() -> Self {
        Self {
            system_prompt: crate::ai::DEFAULT_SYSTEM_PROMPT.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConfig {
    #[serde(default)]
    pub repository_path: String,
    #[serde(default)]
    pub sprint_id: String,
    #[serde(default)]
    pub area_path_id: String,
    #[serde(default = "default_assigned_to")]
    pub assigned_to: String,
    #[serde(default = "default_item_contrato")]
    pub item_contrato: String,
    #[serde(default)]
    pub ai_provider: AiProvider,
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
    #[serde(default = "default_codex_model")]
    pub codex_model: String,
    #[serde(default = "default_codex_reasoning_effort")]
    pub codex_reasoning_effort: String,
    #[serde(default)]
    pub azure_organization: String,
    #[serde(default)]
    pub azure_project: String,
}

impl Default for SavedConfig {
    fn default() -> Self {
        Self {
            repository_path: String::new(),
            sprint_id: String::new(),
            area_path_id: String::new(),
            assigned_to: default_assigned_to(),
            item_contrato: default_item_contrato(),
            ai_provider: AiProvider::default(),
            openai_model: default_openai_model(),
            codex_model: default_codex_model(),
            codex_reasoning_effort: default_codex_reasoning_effort(),
            azure_organization: DEFAULT_AZURE_ORGANIZATION.to_owned(),
            azure_project: DEFAULT_AZURE_PROJECT.to_owned(),
        }
    }
}

fn default_assigned_to() -> String {
    DEFAULT_ASSIGNED_TO.to_owned()
}

fn default_item_contrato() -> String {
    DEFAULT_ITEM_CONTRATO.to_owned()
}

fn default_openai_model() -> String {
    DEFAULT_OPENAI_MODEL.to_owned()
}

fn default_codex_model() -> String {
    DEFAULT_CODEX_MODEL.to_owned()
}

fn default_codex_reasoning_effort() -> String {
    DEFAULT_CODEX_REASONING_EFFORT.to_owned()
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationInput {
    pub repository_path: String,
    pub sprint_id: String,
    pub area_path_id: String,
    pub assigned_to: String,
    pub item_contrato: String,
    pub ai_provider: AiProvider,
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
    #[serde(default = "default_codex_model")]
    pub codex_model: String,
    #[serde(default = "default_codex_reasoning_effort")]
    pub codex_reasoning_effort: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub create_azure_tasks: bool,
    #[serde(default)]
    pub register_time_log: bool,
    #[serde(default)]
    pub time_log_start_date: String,
    #[serde(default)]
    pub time_log_end_date: String,
    #[serde(default)]
    pub parent_work_item_id: Option<u64>,
    #[serde(default)]
    pub azure_organization: String,
    #[serde(default)]
    pub azure_project: String,
}

impl GenerationInput {
    pub fn saved_config(&self, repository_path: String) -> SavedConfig {
        SavedConfig {
            repository_path,
            sprint_id: self.sprint_id.trim().to_owned(),
            area_path_id: self.area_path_id.trim().to_owned(),
            assigned_to: self.assigned_to.trim().to_owned(),
            item_contrato: self.item_contrato.trim().to_owned(),
            ai_provider: self.ai_provider,
            openai_model: self.openai_model.trim().to_owned(),
            codex_model: self.codex_model.trim().to_owned(),
            codex_reasoning_effort: self.codex_reasoning_effort.trim().to_owned(),
            azure_organization: self.azure_organization.trim().to_owned(),
            azure_project: self.azure_project.trim().to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TaskType {
    Backend,
    Frontend,
    Testes,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub title: String,
    pub description: String,
    pub tipo: TaskType,
    pub complexidade: String,
    pub estimate_made: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTask {
    pub title: String,
    pub description: String,
    pub tipo: TaskType,
    pub complexidade: String,
    pub estimate_made: Value,
}

impl From<RawTask> for Task {
    fn from(value: RawTask) -> Self {
        Self {
            title: value.title,
            description: value.description,
            tipo: value.tipo,
            complexidade: normalize_complexity(&value.complexidade),
            estimate_made: normalize_estimate(&value.estimate_made),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAiResponse {
    #[allow(dead_code)]
    pub full_file_path: String,
    pub tasks: Vec<RawTask>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFileSummary {
    pub path: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInspection {
    pub repository_path: String,
    pub files: Vec<ChangedFileSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFile {
    pub full_file_path: String,
    pub relative_path: String,
    pub tasks: Vec<Task>,
    pub staged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFailure {
    pub relative_path: String,
    pub error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationResult {
    pub repository_path: String,
    pub files: Vec<GeneratedFile>,
    pub failures: Vec<FileFailure>,
    pub csv_path: String,
    pub azure_task_ids: Vec<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azure_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_log_result: Option<TimeLogBatchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_log_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_log_retry_input: Option<TimeLogRetryInput>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureDefaults {
    pub organization: String,
    pub project: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialState {
    pub config: SavedConfig,
    pub prompt_settings: PromptSettings,
    pub default_system_prompt: String,
    pub ai_providers: Vec<AiProviderCapability>,
    pub requires_onboarding: bool,
    pub profile: UserProfile,
    pub openai_configured: bool,
    pub codex_available: bool,
    pub codex_authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_version: Option<String>,
    pub time_log_pat_configured: bool,
    pub azure_defaults: AzureDefaults,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub display_name: String,
    pub email: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureUserIdentity {
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAppSettingsInput {
    pub display_name: String,
    pub email: String,
    pub azure_organization: String,
    pub azure_project: String,
    pub ai_provider: AiProvider,
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
    #[serde(default = "default_codex_model")]
    pub codex_model: String,
    #[serde(default = "default_codex_reasoning_effort")]
    pub codex_reasoning_effort: String,
    #[serde(default)]
    pub time_log_pat: Option<String>,
    #[serde(default)]
    pub remove_time_log_pat: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAppSettingsResult {
    pub config: SavedConfig,
    pub profile: UserProfile,
    pub time_log_pat_configured: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GenerationPhase {
    Preparing,
    Generating,
    Staging,
    Exporting,
    Azure,
    TimeLog,
    Completed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationProgress {
    pub phase: GenerationPhase,
    pub message: String,
    /// Unidades concluídas nesta fase, incluindo tentativas que falharam.
    pub current: usize,
    pub total: usize,
    pub active_files: Vec<String>,
}

impl GenerationProgress {
    pub fn new(
        phase: GenerationPhase,
        message: impl Into<String>,
        current: usize,
        total: usize,
    ) -> Self {
        Self {
            phase,
            message: message.into(),
            current,
            total,
            active_files: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeLogCredentialKind {
    Pat,
    Bearer,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogCommandInput {
    pub work_item_id: i32,
    pub start_date: String,
    pub end_date: String,
    pub work: Vec<TimeLogWork>,
    pub organization: String,
    #[serde(default)]
    pub credential: Option<String>,
    #[serde(default)]
    pub credential_kind: Option<TimeLogCredentialKind>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeLogRetryInput {
    pub work_item_id: i32,
    pub start_date: String,
    pub end_date: String,
    pub work: Vec<TimeLogWork>,
    pub organization: String,
}

pub type TimeLogResult = TimeLogBatchResult;

pub fn normalize_complexity(value: &str) -> String {
    let normalized = value.trim().to_uppercase();
    match normalized.as_str() {
        "ALTA" | "MEDIA" | "BAIXA" | "ÚNICA" => normalized,
        _ => "ÚNICA".to_owned(),
    }
}

pub fn normalize_estimate(value: &Value) -> u8 {
    let parsed = value
        .as_u64()
        .or_else(|| {
            value
                .as_f64()
                .filter(|number| number.fract() == 0.0 && *number >= 0.0)
                .map(|number| number as u64)
        })
        .or_else(|| value.as_str().and_then(|number| number.parse().ok()));

    match parsed {
        Some(number @ 1..=8) => number as u8,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_complexities_and_estimates() {
        assert_eq!(normalize_complexity(" alta "), "ALTA");
        assert_eq!(normalize_complexity("invalid"), "ÚNICA");
        assert_eq!(normalize_estimate(&json!(5)), 5);
        assert_eq!(normalize_estimate(&json!("8")), 8);
        assert_eq!(normalize_estimate(&json!(1.5)), 1);
        assert_eq!(normalize_estimate(&json!(9)), 1);
    }

    #[test]
    fn loads_legacy_config_with_desktop_defaults() {
        let config: SavedConfig = serde_json::from_value(json!({
            "sprintId": "Sprint 1",
            "areaPathId": "Projeto",
            "assignedTo": "Pessoa",
            "itemContrato": "Item 2",
            "azureOrganization": "",
            "azureProject": ""
        }))
        .expect("legacy config should deserialize");

        assert_eq!(config.ai_provider, AiProvider::Openai);
        assert_eq!(config.openai_model, DEFAULT_OPENAI_MODEL);
        assert_eq!(config.codex_model, DEFAULT_CODEX_MODEL);
        assert!(config.repository_path.is_empty());
        assert!(config.azure_organization.is_empty());
        assert!(config.azure_project.is_empty());
    }

    #[test]
    fn uses_infortech_defaults_for_a_fresh_configuration() {
        let config = SavedConfig::default();
        assert_eq!(config.assigned_to, DEFAULT_ASSIGNED_TO);
        assert_eq!(config.azure_organization, DEFAULT_AZURE_ORGANIZATION);
        assert_eq!(config.azure_project, DEFAULT_AZURE_PROJECT);
    }

    #[test]
    fn keeps_the_onboarding_contract_camel_case_and_secret_free() {
        let input: SaveAppSettingsInput = serde_json::from_value(json!({
            "displayName": "Ygor Azambuja",
            "email": "ygor.azambuja@infortechms.com.br",
            "azureOrganization": "InfortechMS",
            "azureProject": "SPF-SIAFIC",
            "aiProvider": "codex",
            "removeTimeLogPat": true
        }))
        .expect("deserialize settings input");
        assert_eq!(input.display_name, DEFAULT_DISPLAY_NAME);
        assert_eq!(input.email, DEFAULT_EMAIL);
        assert!(input.time_log_pat.is_none());
        assert!(input.remove_time_log_pat);

        let result = SaveAppSettingsResult {
            config: SavedConfig::default(),
            profile: UserProfile {
                display_name: DEFAULT_DISPLAY_NAME.into(),
                email: DEFAULT_EMAIL.into(),
            },
            time_log_pat_configured: false,
            warnings: Vec::new(),
        };
        let serialized = serde_json::to_value(result).expect("serialize settings result");
        assert_eq!(serialized["profile"]["displayName"], DEFAULT_DISPLAY_NAME);
        assert_eq!(serialized["timeLogPatConfigured"], false);
        assert!(serialized.get("timeLogPat").is_none());
        assert!(!serialized.to_string().contains("segredo"));
    }

    #[test]
    fn keeps_the_time_log_desktop_contract_camel_case() {
        let input: TimeLogCommandInput = serde_json::from_value(json!({
            "workItemId": 201878,
            "startDate": "2026-08-12",
            "endDate": "2026-08-13",
            "work": [{
                "minutes": 150,
                "type": "Frontend",
                "comment": "Implementei a integração"
            }],
            "organization": "https://dev.azure.com/empresa",
            "credential": "segredo",
            "credentialKind": "bearer"
        }))
        .expect("time log input should deserialize");

        assert_eq!(input.work_item_id, 201878);
        assert_eq!(input.work[0].kind, crate::time_log::TimeLogType::Frontend);
        assert!(matches!(
            input.credential_kind,
            Some(TimeLogCredentialKind::Bearer)
        ));

        let result = TimeLogResult::empty(input.work_item_id, input.start_date, input.end_date);
        let serialized = serde_json::to_value(result).expect("serialize time log result");
        assert_eq!(serialized["plan"]["workItemId"], 201878);
        assert_eq!(serialized["postAttempts"], 0);
        assert_eq!(serialized["retryable"], false);
    }

    #[test]
    fn deserializes_the_optional_parent_work_item_id() {
        let input: GenerationInput = serde_json::from_value(json!({
            "repositoryPath": "/repo",
            "sprintId": "Sprint",
            "areaPathId": "Área",
            "assignedTo": "Pessoa",
            "itemContrato": "Item 1",
            "aiProvider": "openai",
            "createAzureTasks": true,
            "parentWorkItemId": 123,
            "azureOrganization": "",
            "azureProject": ""
        }))
        .expect("generation input should deserialize");

        assert_eq!(input.parent_work_item_id, Some(123));
    }
}
