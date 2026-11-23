use crate::ai;
use crate::models::{
    AiProvider, AzureDefaults, DEFAULT_AZURE_ORGANIZATION, DEFAULT_AZURE_PROJECT,
    DEFAULT_DISPLAY_NAME, DEFAULT_EMAIL, PromptSettings, SaveAppSettingsInput,
    SaveAppSettingsResult, SavedConfig, UserProfile,
};
use crate::time_log::canonical_organization_url;
use anyhow::{Context, Result, bail};
use std::future::Future;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_store::StoreExt;

const APP_NAME: &str = "commit-ia-task";
const CONFIG_DIR_ENV: &str = "COMMIT_IA_TASK_CONFIG_DIR";
const CONFIG_STORE_FILE: &str = "config.json";
const TIME_LOG_STORE_FILE: &str = "time-log.json";
const PROMPTS_STORE_FILE: &str = "prompts.json";
const TIME_LOG_PAT_KEY: &str = "adoPat";
const CORPORATE_EMAIL_DOMAIN: &str = "infortechms.com.br";

pub struct InitialConfiguration {
    pub config: SavedConfig,
    pub prompt_settings: PromptSettings,
    pub requires_onboarding: bool,
    pub profile: UserProfile,
    pub time_log_pat_configured: bool,
    pub azure_defaults: AzureDefaults,
    pub warnings: Vec<String>,
}

struct ConfigurationPaths {
    config: PathBuf,
    time_log: PathBuf,
    prompts: PathBuf,
}

impl ConfigurationPaths {
    fn for_app<R: Runtime>(app: &AppHandle<R>) -> Result<Self> {
        let config = config_file_path(app)?;
        let time_log = config.with_file_name(TIME_LOG_STORE_FILE);
        let prompts = config.with_file_name(PROMPTS_STORE_FILE);
        Ok(Self {
            config,
            time_log,
            prompts,
        })
    }
}

struct ValidatedAppSettings {
    profile: UserProfile,
    azure_organization: String,
    azure_project: String,
    ai_configuration: ai::AiConfiguration,
}

pub(crate) fn config_file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = resolve_configuration_directory(
        std::env::var_os(CONFIG_DIR_ENV).map(PathBuf::from),
        || std::env::current_dir().context("Não foi possível localizar a pasta atual"),
        || {
            app.path()
                .config_dir()
                .context("Não foi possível localizar a pasta de configuração")
        },
    )?;

    Ok(directory.join(CONFIG_STORE_FILE))
}

fn resolve_configuration_directory(
    override_directory: Option<PathBuf>,
    current_directory: impl FnOnce() -> Result<PathBuf>,
    default_directory: impl FnOnce() -> Result<PathBuf>,
) -> Result<PathBuf> {
    match override_directory {
        Some(path) => {
            if path.is_absolute() {
                Ok(path)
            } else {
                Ok(current_directory()?.join(path))
            }
        }
        None => Ok(default_directory()?.join(APP_NAME)),
    }
}

pub fn load_initial<R: Runtime>(
    app: &AppHandle<R>,
    preferred_provider: AiProvider,
) -> InitialConfiguration {
    match ConfigurationPaths::for_app(app) {
        Ok(paths) => load_initial_at(app, &paths, preferred_provider),
        Err(error) => {
            let (config, profile) = prepare_initial_config(None, true, preferred_provider);
            InitialConfiguration {
                config,
                prompt_settings: PromptSettings::default(),
                requires_onboarding: true,
                profile,
                time_log_pat_configured: false,
                azure_defaults: azure_defaults(),
                warnings: vec![format!(
                    "A configuração salva não pôde ser carregada e os valores padrão foram usados: {error}"
                )],
            }
        }
    }
}

fn load_initial_at<R: Runtime>(
    app: &AppHandle<R>,
    paths: &ConfigurationPaths,
    preferred_provider: AiProvider,
) -> InitialConfiguration {
    let (saved, configuration_load_failed, mut warnings) = match load_config(app, &paths.config) {
        Ok(saved) => (saved, false, Vec::new()),
        Err(error) => (
            None,
            true,
            vec![format!(
                "A configuração salva não pôde ser carregada e os valores padrão foram usados: {error}"
            )],
        ),
    };
    let requires_onboarding = configuration_load_failed
        || saved
            .as_ref()
            .is_none_or(|config| !configuration_is_complete(config));
    let (config, profile) = prepare_initial_config(saved, requires_onboarding, preferred_provider);
    let (prompt_settings, prompt_warnings) = load_prompt_settings_at(app, &paths.prompts);
    warnings.extend(prompt_warnings);
    let time_log_pat_configured = match read_time_log_pat(app, &paths.time_log) {
        Ok(pat) => pat.is_some(),
        Err(error) => {
            warnings.push(format!(
                "O PAT salvo do Time Log não pôde ser carregado: {error}"
            ));
            false
        }
    };

    InitialConfiguration {
        config,
        prompt_settings,
        requires_onboarding,
        profile,
        time_log_pat_configured,
        azure_defaults: azure_defaults(),
        warnings,
    }
}

pub fn load_prompt_settings<R: Runtime>(app: &AppHandle<R>) -> (PromptSettings, Vec<String>) {
    match ConfigurationPaths::for_app(app) {
        Ok(paths) => load_prompt_settings_at(app, &paths.prompts),
        Err(error) => prompt_load_fallback(error),
    }
}

fn load_prompt_settings_at<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
) -> (PromptSettings, Vec<String>) {
    match read_prompt_settings(app, path) {
        Ok(settings) => (settings.unwrap_or_default(), Vec::new()),
        Err(error) => prompt_load_fallback(error),
    }
}

fn prompt_load_fallback(error: anyhow::Error) -> (PromptSettings, Vec<String>) {
    (
        PromptSettings::default(),
        vec![format!(
            "As instruções de geração salvas não puderam ser carregadas e o prompt padrão foi usado: {error}"
        )],
    )
}

fn read_prompt_settings<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
) -> Result<Option<PromptSettings>> {
    if !path.exists() {
        return Ok(None);
    }

    let store = app
        .store_builder(path)
        .disable_auto_save()
        .build()
        .with_context(|| format!("Não foi possível abrir {}", path.display()))?;
    let result = (|| {
        store
            .reload_ignore_defaults()
            .with_context(|| format!("Não foi possível carregar {}", path.display()))?;
        let settings: PromptSettings = serde_json::from_value(serde_json::Value::Object(
            store.entries().into_iter().collect(),
        ))
        .with_context(|| format!("Prompt inválido em {}", path.display()))?;
        ai::validate_prompt_settings(&settings)?;
        Ok(Some(settings))
    })();
    store.close_resource();
    result
}

pub fn save_prompt_settings<R: Runtime>(
    app: &AppHandle<R>,
    settings: &PromptSettings,
) -> Result<PromptSettings> {
    let paths = ConfigurationPaths::for_app(app)?;
    save_prompt_settings_at(app, &paths.prompts, settings)
}

fn save_prompt_settings_at<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    settings: &PromptSettings,
) -> Result<PromptSettings> {
    ai::validate_prompt_settings(settings)?;
    let store = app
        .store_builder(path)
        .disable_auto_save()
        .build()
        .with_context(|| format!("Não foi possível abrir {}", path.display()))?;
    store.clear();
    store.set("systemPrompt", settings.system_prompt.clone());
    let result = store
        .save()
        .with_context(|| format!("Não foi possível salvar {}", path.display()));
    store.close_resource();
    result?;
    Ok(settings.clone())
}

pub async fn save_settings<R, Verify, Verification>(
    app: &AppHandle<R>,
    input: &SaveAppSettingsInput,
    verify_pat: Verify,
) -> Result<SaveAppSettingsResult>
where
    R: Runtime,
    Verify: FnOnce(String, String) -> Verification,
    Verification: Future<Output = std::result::Result<(), String>>,
{
    let paths = ConfigurationPaths::for_app(app)?;
    save_settings_at(app, &paths, input, verify_pat).await
}

async fn save_settings_at<R, Verify, Verification>(
    app: &AppHandle<R>,
    paths: &ConfigurationPaths,
    input: &SaveAppSettingsInput,
    verify_pat: Verify,
) -> Result<SaveAppSettingsResult>
where
    R: Runtime,
    Verify: FnOnce(String, String) -> Verification,
    Verification: Future<Output = std::result::Result<(), String>>,
{
    let validated = validate_app_settings(input)?;
    let mut warnings = Vec::new();
    let mut saved = match load_config(app, &paths.config) {
        Ok(saved) => saved.unwrap_or_default(),
        Err(error) => {
            warnings.push(format!(
                "A configuração anterior não pôde ser carregada e foi substituída: {error}"
            ));
            SavedConfig::default()
        }
    };
    merge_stable_settings(&mut saved, &validated, input.ai_provider);
    save_config(app, &paths.config, &saved)?;

    if let Some(pat) = input.time_log_pat.as_deref() {
        match verify_pat(validated.azure_organization.clone(), pat.to_owned()).await {
            Ok(()) => {
                if let Err(error) = save_time_log_pat(app, &paths.time_log, pat) {
                    warnings.push(format!(
                        "A configuração foi salva, mas o PAT não pôde ser armazenado: {error}"
                    ));
                }
            }
            Err(error) => warnings.push(format!(
                "A configuração foi salva, mas o PAT não pôde ser validado e não foi armazenado: {}",
                redact_secret(error, pat)
            )),
        }
    } else if input.remove_time_log_pat
        && let Err(error) = remove_time_log_pat(&paths.time_log)
    {
        warnings.push(format!(
            "A configuração foi salva, mas o PAT não pôde ser removido: {error}"
        ));
    }

    let time_log_pat_configured = match read_time_log_pat(app, &paths.time_log) {
        Ok(pat) => pat.is_some(),
        Err(error) => {
            warnings.push(format!(
                "Não foi possível confirmar o estado do PAT salvo: {error}"
            ));
            false
        }
    };

    Ok(SaveAppSettingsResult {
        config: saved,
        profile: validated.profile,
        time_log_pat_configured,
        warnings,
    })
}

#[cfg(test)]
pub(crate) async fn save_settings_at_paths<R, Verify, Verification>(
    app: &AppHandle<R>,
    config_path: &Path,
    time_log_path: &Path,
    input: &SaveAppSettingsInput,
    verify_pat: Verify,
) -> Result<SaveAppSettingsResult>
where
    R: Runtime,
    Verify: FnOnce(String, String) -> Verification,
    Verification: Future<Output = std::result::Result<(), String>>,
{
    let paths = ConfigurationPaths {
        config: config_path.to_owned(),
        time_log: time_log_path.to_owned(),
        prompts: config_path.with_file_name(PROMPTS_STORE_FILE),
    };
    save_settings_at(app, &paths, input, verify_pat).await
}

pub fn persist_generation<R: Runtime>(app: &AppHandle<R>, config: SavedConfig) -> Vec<String> {
    match ConfigurationPaths::for_app(app) {
        Ok(paths) => persist_generation_at(app, &paths.config, config),
        Err(error) => generation_save_warning(error),
    }
}

fn persist_generation_at<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    mut config: SavedConfig,
) -> Vec<String> {
    repair_config(&mut config);
    match save_config(app, path, &config) {
        Ok(()) => Vec::new(),
        Err(error) => generation_save_warning(error),
    }
}

fn generation_save_warning(error: anyhow::Error) -> Vec<String> {
    vec![format!(
        "As tarefas serão geradas, mas a configuração não pôde ser salva: {error}"
    )]
}

// ponytail: a CLI lê o JSON da mesma store, sem inicializar uma aplicação Tauri.
pub(crate) fn cli_config_path() -> Result<PathBuf> {
    resolve_configuration_directory(
        std::env::var_os(CONFIG_DIR_ENV).map(PathBuf::from),
        || std::env::current_dir().context("Não foi possível localizar a pasta atual"),
        || dirs::config_dir().context("Não foi possível localizar a pasta de configuração"),
    )
    .map(|directory| directory.join(CONFIG_STORE_FILE))
}

pub(crate) fn load_cli_config(path: &Path) -> Result<SavedConfig> {
    if !path.exists() {
        return Ok(SavedConfig::default());
    }
    let contents =
        std::fs::read(path).with_context(|| format!("Não foi possível ler {}", path.display()))?;
    serde_json::from_slice(&contents)
        .with_context(|| format!("Configuração inválida em {}", path.display()))
}

pub(crate) fn load_cli_prompt(path: &Path) -> (PromptSettings, Vec<String>) {
    let path = path.with_file_name(PROMPTS_STORE_FILE);
    let loaded = (|| -> Result<PromptSettings> {
        if !path.exists() {
            return Ok(PromptSettings::default());
        }
        let contents = std::fs::read(&path)
            .with_context(|| format!("Não foi possível ler {}", path.display()))?;
        let settings = serde_json::from_slice(&contents)
            .with_context(|| format!("Prompt inválido em {}", path.display()))?;
        ai::validate_prompt_settings(&settings)?;
        Ok(settings)
    })();
    match loaded {
        Ok(settings) => (settings, Vec::new()),
        Err(error) => prompt_load_fallback(error),
    }
}

pub(crate) fn persist_cli_generation(path: &Path, mut config: SavedConfig) -> Vec<String> {
    repair_config(&mut config);
    let saved = (|| -> Result<()> {
        let directory = path
            .parent()
            .context("A configuração não possui diretório")?;
        std::fs::create_dir_all(directory)?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer_pretty(temporary.as_file_mut(), &config)?;
        temporary
            .persist(path)
            .with_context(|| format!("Não foi possível salvar {}", path.display()))?;
        Ok(())
    })();
    match saved {
        Ok(()) => Vec::new(),
        Err(error) => generation_save_warning(error),
    }
}

pub fn validate_assigned_to(value: &str) -> Result<()> {
    parse_assigned_to(value).map(|_| ())
}

fn load_config<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<Option<SavedConfig>> {
    if !path.exists() {
        return Ok(None);
    }

    let store = app
        .store_builder(path)
        .disable_auto_save()
        .build()
        .with_context(|| format!("Não foi possível abrir {}", path.display()))?;
    let result = (|| {
        // O carregamento inicial do Store ignora erros; esta recarga mantém o aviso ao usuário.
        store
            .reload_ignore_defaults()
            .with_context(|| format!("Não foi possível carregar {}", path.display()))?;
        serde_json::from_value(serde_json::Value::Object(
            store.entries().into_iter().collect(),
        ))
        .map(Some)
        .with_context(|| format!("Configuração inválida em {}", path.display()))
    })();
    // Evita que o handler de saída do plugin regrave uma configuração que falhou ao carregar.
    store.close_resource();
    result
}

fn save_config<R: Runtime>(app: &AppHandle<R>, path: &Path, config: &SavedConfig) -> Result<()> {
    let serde_json::Value::Object(values) =
        serde_json::to_value(config).context("Não foi possível serializar a configuração")?
    else {
        anyhow::bail!("A configuração serializada não é um objeto");
    };
    let store = app
        .store_builder(path)
        .disable_auto_save()
        .build()
        .with_context(|| format!("Não foi possível abrir {}", path.display()))?;
    store.clear();
    for (key, value) in values {
        store.set(key, value);
    }
    let result = store
        .save()
        .with_context(|| format!("Não foi possível salvar {}", path.display()));
    store.close_resource();
    result
}

pub fn load_time_log_pat<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>> {
    let paths = ConfigurationPaths::for_app(app)?;
    read_time_log_pat(app, &paths.time_log)
}

fn read_time_log_pat<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }

    let store = app
        .store_builder(path)
        .disable_auto_save()
        .build()
        .with_context(|| format!("Não foi possível abrir {}", path.display()))?;
    let result = (|| {
        store
            .reload_ignore_defaults()
            .with_context(|| format!("Não foi possível carregar {}", path.display()))?;
        match store.get(TIME_LOG_PAT_KEY) {
            None => Ok(None),
            Some(serde_json::Value::String(pat)) if !pat.trim().is_empty() => Ok(Some(pat)),
            Some(_) => anyhow::bail!("PAT inválido em {}", path.display()),
        }
    })();
    store.close_resource();
    result
}

#[cfg(test)]
pub(crate) fn load_time_log_pat_at<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
) -> Result<Option<String>> {
    read_time_log_pat(app, path)
}

fn save_time_log_pat<R: Runtime>(app: &AppHandle<R>, path: &Path, pat: &str) -> Result<()> {
    let pat = pat.trim();
    if pat.is_empty() {
        anyhow::bail!("O PAT não pode ficar vazio");
    }

    #[cfg(unix)]
    prepare_private_pat_file(path)?;

    let store = app
        .store_builder(path)
        .disable_auto_save()
        .build()
        .with_context(|| format!("Não foi possível abrir {}", path.display()))?;
    store.clear();
    store.set(TIME_LOG_PAT_KEY, pat);
    let result = store
        .save()
        .with_context(|| format!("Não foi possível salvar {}", path.display()));
    store.close_resource();
    result
}

#[cfg(unix)]
fn prepare_private_pat_file(path: &Path) -> Result<()> {
    use std::fs::OpenOptions;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let parent = path
        .parent()
        .context("O arquivo do PAT não possui uma pasta válida")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("Não foi possível criar {}", parent.display()))?;

    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = std::fs::symlink_metadata(path)
                .with_context(|| format!("Não foi possível inspecionar {}", path.display()))?;
            if !metadata.file_type().is_file() {
                bail!(
                    "O caminho do PAT não é um arquivo regular: {}",
                    path.display()
                );
            }
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .with_context(|| format!("Não foi possível proteger {}", path.display()))
        }
        Err(error) => {
            Err(error).with_context(|| format!("Não foi possível preparar {}", path.display()))
        }
    }
}

fn remove_time_log_pat(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("Não foi possível remover {}", path.display()))
        }
    }
}

fn validate_app_settings(input: &SaveAppSettingsInput) -> Result<ValidatedAppSettings> {
    if input.time_log_pat.is_some() && input.remove_time_log_pat {
        bail!("Não é possível substituir e remover o PAT ao mesmo tempo");
    }
    if input
        .time_log_pat
        .as_deref()
        .is_some_and(|pat| pat.trim().is_empty())
    {
        bail!("O PAT não pode ficar vazio");
    }

    Ok(ValidatedAppSettings {
        profile: validate_profile(&input.display_name, &input.email)?,
        azure_organization: canonical_organization_url(&input.azure_organization)
            .map_err(anyhow::Error::msg)?,
        azure_project: required_value(&input.azure_project, "O projeto Azure é obrigatório")?,
        ai_configuration: ai::validate_configuration(
            &input.openai_model,
            &input.codex_model,
            &input.codex_reasoning_effort,
        )?,
    })
}

fn merge_stable_settings(
    config: &mut SavedConfig,
    settings: &ValidatedAppSettings,
    ai_provider: AiProvider,
) {
    config.assigned_to = format_assigned_to(&settings.profile);
    config
        .azure_organization
        .clone_from(&settings.azure_organization);
    config.azure_project.clone_from(&settings.azure_project);
    config.ai_provider = ai_provider;
    config
        .openai_model
        .clone_from(&settings.ai_configuration.openai_model);
    config
        .codex_model
        .clone_from(&settings.ai_configuration.codex_model);
    config
        .codex_reasoning_effort
        .clone_from(&settings.ai_configuration.codex_reasoning_effort);
}

fn prepare_initial_config(
    saved: Option<SavedConfig>,
    requires_onboarding: bool,
    preferred_provider: AiProvider,
) -> (SavedConfig, UserProfile) {
    let mut config = saved.unwrap_or_default();
    let profile = repair_config(&mut config);
    if requires_onboarding {
        config.ai_provider = preferred_provider;
    }
    (config, profile)
}

fn repair_config(config: &mut SavedConfig) -> UserProfile {
    let profile = parse_assigned_to(&config.assigned_to).unwrap_or_else(|_| default_profile());
    config.assigned_to = format_assigned_to(&profile);
    config.azure_organization = canonical_organization_url(&config.azure_organization)
        .unwrap_or_else(|_| DEFAULT_AZURE_ORGANIZATION.to_owned());
    config.azure_project = if config.azure_project.trim().is_empty() {
        DEFAULT_AZURE_PROJECT.to_owned()
    } else {
        config.azure_project.trim().to_owned()
    };
    ai::normalize_configuration(config);
    profile
}

fn configuration_is_complete(config: &SavedConfig) -> bool {
    parse_assigned_to(&config.assigned_to).is_ok()
        && canonical_organization_url(&config.azure_organization).is_ok()
        && !config.azure_project.trim().is_empty()
}

fn azure_defaults() -> AzureDefaults {
    AzureDefaults {
        organization: DEFAULT_AZURE_ORGANIZATION.to_owned(),
        project: DEFAULT_AZURE_PROJECT.to_owned(),
    }
}

fn default_profile() -> UserProfile {
    UserProfile {
        display_name: DEFAULT_DISPLAY_NAME.to_owned(),
        email: DEFAULT_EMAIL.to_owned(),
    }
}

fn parse_assigned_to(value: &str) -> Result<UserProfile> {
    let value = value.trim();
    let without_suffix = value
        .strip_suffix('>')
        .context("O responsável deve usar o formato Nome <email>")?;
    let (display_name, email) = without_suffix
        .rsplit_once('<')
        .context("O responsável deve usar o formato Nome <email>")?;
    validate_profile(display_name, email)
}

fn validate_profile(display_name: &str, email: &str) -> Result<UserProfile> {
    let display_name = required_value(display_name, "O nome é obrigatório")?;
    if display_name
        .chars()
        .any(|character| character.is_control() || matches!(character, '<' | '>'))
    {
        bail!("O nome contém caracteres inválidos");
    }

    Ok(UserProfile {
        display_name,
        email: validate_corporate_email(email)?,
    })
}

fn validate_corporate_email(value: &str) -> Result<String> {
    let email = value.trim();
    let Some((local, domain)) = email.rsplit_once('@') else {
        bail!("Informe um e-mail Infortech válido");
    };
    let valid_local = !local.is_empty()
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && !local.contains('@')
        && local.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'%' | b'+' | b'-')
        });
    if !valid_local || !domain.eq_ignore_ascii_case(CORPORATE_EMAIL_DOMAIN) {
        bail!("O e-mail deve pertencer ao domínio @infortechms.com.br");
    }
    Ok(format!("{local}@{CORPORATE_EMAIL_DOMAIN}"))
}

fn format_assigned_to(profile: &UserProfile) -> String {
    format!("{} <{}>", profile.display_name, profile.email)
}

fn required_value(value: &str, message: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        bail!(message.to_owned());
    }
    Ok(value.to_owned())
}

fn redact_secret(message: String, secret: &str) -> String {
    message.replace(secret.trim(), "<redacted>")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AiProvider, DEFAULT_ASSIGNED_TO};
    use std::fs;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
    use tempfile::tempdir;

    fn test_app() -> tauri::App<MockRuntime> {
        mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(mock_context(noop_assets()))
            .expect("test app")
    }

    fn test_paths(directory: &Path) -> ConfigurationPaths {
        ConfigurationPaths {
            config: directory.join(CONFIG_STORE_FILE),
            time_log: directory.join(TIME_LOG_STORE_FILE),
            prompts: directory.join(PROMPTS_STORE_FILE),
        }
    }

    fn valid_settings_input() -> SaveAppSettingsInput {
        SaveAppSettingsInput {
            display_name: "Ygor Azambuja".to_owned(),
            email: "ygor.azambuja@infortechms.com.br".to_owned(),
            azure_organization: "InfortechMS".to_owned(),
            azure_project: "SPF-SIAFIC".to_owned(),
            ai_provider: AiProvider::Codex,
            openai_model: "gpt-5-nano".to_owned(),
            codex_model: "gpt-5.6-luna".to_owned(),
            codex_reasoning_effort: "low".to_owned(),
            time_log_pat: None,
            remove_time_log_pat: false,
        }
    }

    #[test]
    fn resolves_default_and_override_directories_without_global_environment_changes() {
        let root = tempdir().unwrap();
        let current = root.path().join("workspace");
        let default = root.path().join("system-config");
        let absolute = root.path().join("custom-config");

        assert_eq!(
            resolve_configuration_directory(
                Some(absolute.clone()),
                || bail!("current directory must not be read"),
                || bail!("default directory must not be read"),
            )
            .unwrap(),
            absolute
        );
        assert_eq!(
            resolve_configuration_directory(
                Some(PathBuf::from("relative/config")),
                || Ok(current.clone()),
                || bail!("default directory must not be read"),
            )
            .unwrap(),
            current.join("relative/config")
        );
        assert_eq!(
            resolve_configuration_directory(
                None,
                || bail!("current directory must not be read"),
                || Ok(default.clone()),
            )
            .unwrap(),
            default.join(APP_NAME)
        );
    }

    #[test]
    fn prepares_missing_incomplete_and_complete_configuration_without_rewriting_on_read() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());

        let missing = load_initial_at(app.handle(), &paths, AiProvider::Codex);
        assert!(missing.requires_onboarding);
        assert_eq!(missing.config.ai_provider, AiProvider::Codex);
        assert_eq!(missing.profile, default_profile());
        assert!(missing.warnings.is_empty());
        assert!(!paths.config.exists());

        let incomplete = SavedConfig {
            repository_path: "/repo".to_owned(),
            sprint_id: "Sprint 8".to_owned(),
            area_path_id: "Área".to_owned(),
            assigned_to: "Pessoa".to_owned(),
            item_contrato: "Item 7".to_owned(),
            ai_provider: AiProvider::Codex,
            azure_organization: String::new(),
            azure_project: String::new(),
            ..SavedConfig::default()
        };
        save_config(app.handle(), &paths.config, &incomplete).unwrap();
        let bytes = fs::read(&paths.config).unwrap();
        let repaired = load_initial_at(app.handle(), &paths, AiProvider::Openai);
        assert!(repaired.requires_onboarding);
        assert_eq!(repaired.config.repository_path, "/repo");
        assert_eq!(repaired.config.sprint_id, "Sprint 8");
        assert_eq!(repaired.config.area_path_id, "Área");
        assert_eq!(repaired.config.item_contrato, "Item 7");
        assert_eq!(repaired.config.assigned_to, DEFAULT_ASSIGNED_TO);
        assert_eq!(
            repaired.config.azure_organization,
            DEFAULT_AZURE_ORGANIZATION
        );
        assert_eq!(repaired.config.azure_project, DEFAULT_AZURE_PROJECT);
        assert_eq!(repaired.config.ai_provider, AiProvider::Openai);
        assert_eq!(fs::read(&paths.config).unwrap(), bytes);

        let complete = SavedConfig {
            ai_provider: AiProvider::Codex,
            ..SavedConfig::default()
        };
        save_config(app.handle(), &paths.config, &complete).unwrap();
        let loaded = load_initial_at(app.handle(), &paths, AiProvider::Openai);
        assert!(!loaded.requires_onboarding);
        assert_eq!(loaded.config.ai_provider, AiProvider::Codex);
    }

    #[test]
    fn corrupt_configuration_warns_and_remains_byte_for_byte_unchanged() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());

        for contents in ["{invalid", r#"{"assignedTo":42}"#] {
            fs::write(&paths.config, contents).unwrap();
            let loaded = load_initial_at(app.handle(), &paths, AiProvider::Openai);

            assert!(loaded.requires_onboarding);
            assert_eq!(loaded.config.assigned_to, DEFAULT_ASSIGNED_TO);
            assert_eq!(loaded.warnings.len(), 1);
            assert_eq!(fs::read_to_string(&paths.config).unwrap(), contents);
            assert!(app.handle().get_store(&paths.config).is_none());
        }
    }

    #[test]
    fn initial_configuration_exposes_pat_status_without_the_secret() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        save_config(app.handle(), &paths.config, &SavedConfig::default()).unwrap();
        save_time_log_pat(app.handle(), &paths.time_log, "pat-secreto").unwrap();

        let configured = load_initial_at(app.handle(), &paths, AiProvider::Openai);
        assert!(configured.time_log_pat_configured);
        assert!(configured.warnings.is_empty());

        fs::write(&paths.time_log, r#"{"adoPat":42}"#).unwrap();
        let invalid = load_initial_at(app.handle(), &paths, AiProvider::Openai);
        assert!(!invalid.time_log_pat_configured);
        assert_eq!(invalid.warnings.len(), 1);
        assert!(!invalid.warnings[0].contains("pat-secreto"));
        assert!(app.handle().get_store(&paths.time_log).is_none());
    }

    #[test]
    fn missing_prompts_use_defaults_without_writing_or_requiring_onboarding() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        save_config(app.handle(), &paths.config, &SavedConfig::default()).unwrap();

        let initial = load_initial_at(app.handle(), &paths, AiProvider::Openai);

        assert_eq!(initial.prompt_settings, PromptSettings::default());
        assert!(initial.warnings.is_empty());
        assert!(!initial.requires_onboarding);
        assert!(!paths.prompts.exists());
    }

    #[test]
    fn cli_and_desktop_share_config_and_prompt_files() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        let mut saved = SavedConfig {
            sprint_id: "Sprint compartilhada".into(),
            ..SavedConfig::default()
        };
        save_config(app.handle(), &paths.config, &saved).unwrap();
        assert_eq!(load_cli_config(&paths.config).unwrap(), saved);
        let prompt = PromptSettings {
            system_prompt: "  Instruções compartilhadas.\n".into(),
        };
        save_prompt_settings_at(app.handle(), &paths.prompts, &prompt).unwrap();
        assert_eq!(load_cli_prompt(&paths.config), (prompt.clone(), Vec::new()));

        saved.area_path_id = "Área da CLI".into();
        assert!(persist_cli_generation(&paths.config, saved.clone()).is_empty());
        assert_eq!(
            load_config(app.handle(), &paths.config).unwrap(),
            Some(saved)
        );
        assert_eq!(load_cli_prompt(&paths.config), (prompt, Vec::new()));
    }

    #[test]
    fn cli_reports_invalid_prompts_and_write_failures_without_overwriting_files() {
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        assert_eq!(
            load_cli_config(&paths.config).unwrap(),
            SavedConfig::default()
        );
        assert_eq!(
            load_cli_prompt(&paths.config),
            (PromptSettings::default(), Vec::new())
        );
        for contents in ["{invalid", r#"{"systemPrompt":"  "}"#] {
            fs::write(&paths.prompts, contents).unwrap();
            let (prompt, warnings) = load_cli_prompt(&paths.config);
            assert_eq!(prompt, PromptSettings::default());
            assert_eq!(warnings.len(), 1);
            assert_eq!(fs::read_to_string(&paths.prompts).unwrap(), contents);
        }
        fs::write(&paths.config, "{invalid").unwrap();
        assert!(load_cli_config(&paths.config).is_err());
        assert_eq!(fs::read_to_string(&paths.config).unwrap(), "{invalid");
        fs::remove_file(&paths.config).unwrap();
        fs::create_dir(&paths.config).unwrap();
        assert_eq!(
            persist_cli_generation(&paths.config, SavedConfig::default()).len(),
            1
        );
        assert!(paths.config.is_dir());
    }

    #[test]
    fn prompt_save_preserves_exact_text_and_rejects_blank_replacements() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let path = directory.path().join(PROMPTS_STORE_FILE);
        let settings = PromptSettings {
            system_prompt: "  Gere tarefas concisas.\nPreserve contexto.  ".to_owned(),
        };

        assert_eq!(
            save_prompt_settings_at(app.handle(), &path, &settings).unwrap(),
            settings
        );
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            load_prompt_settings_at(app.handle(), &path),
            (settings, Vec::new())
        );
        for text in ["", " \n\t "] {
            assert!(
                save_prompt_settings_at(
                    app.handle(),
                    &path,
                    &PromptSettings {
                        system_prompt: text.to_owned(),
                    },
                )
                .is_err()
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        assert!(app.handle().get_store(&path).is_none());
    }

    #[test]
    fn corrupt_prompts_warn_without_rewriting_or_requiring_onboarding() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        save_config(app.handle(), &paths.config, &SavedConfig::default()).unwrap();

        for contents in [
            "{invalid",
            r#"{"systemPrompt":42}"#,
            r#"{"systemPrompt":" \n\t "}"#,
            "{}",
        ] {
            fs::write(&paths.prompts, contents).unwrap();
            let initial = load_initial_at(app.handle(), &paths, AiProvider::Openai);

            assert_eq!(initial.prompt_settings, PromptSettings::default());
            assert_eq!(initial.warnings.len(), 1);
            assert!(initial.warnings[0].contains("prompt padrão"));
            assert!(!initial.requires_onboarding);
            assert_eq!(fs::read_to_string(&paths.prompts).unwrap(), contents);
            assert!(app.handle().get_store(&paths.prompts).is_none());
        }
    }

    #[test]
    fn prompt_write_and_read_failures_close_the_store_and_report_the_error() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let path = directory.path().join(PROMPTS_STORE_FILE);
        fs::create_dir(&path).unwrap();

        let error = save_prompt_settings_at(app.handle(), &path, &PromptSettings::default())
            .expect_err("a directory cannot be saved as a prompt file");
        assert!(error.to_string().contains("Não foi possível salvar"));
        let (settings, warnings) = load_prompt_settings_at(app.handle(), &path);
        assert_eq!(settings, PromptSettings::default());
        assert_eq!(warnings.len(), 1);
        assert!(app.handle().get_store(&path).is_none());
        assert!(path.is_dir());
    }

    #[tokio::test]
    async fn prompt_store_is_independent_of_settings_generation_and_the_pat() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        save_config(app.handle(), &paths.config, &SavedConfig::default()).unwrap();
        save_time_log_pat(app.handle(), &paths.time_log, "pat-secreto").unwrap();
        let config_bytes = fs::read(&paths.config).unwrap();
        let pat_bytes = fs::read(&paths.time_log).unwrap();
        let settings = PromptSettings {
            system_prompt: "Minhas instruções".to_owned(),
        };

        save_prompt_settings_at(app.handle(), &paths.prompts, &settings).unwrap();
        let prompt_bytes = fs::read(&paths.prompts).unwrap();
        assert_eq!(fs::read(&paths.config).unwrap(), config_bytes);
        assert_eq!(fs::read(&paths.time_log).unwrap(), pat_bytes);
        save_settings_at(
            app.handle(),
            &paths,
            &valid_settings_input(),
            |_, _| async { Ok(()) },
        )
        .await
        .unwrap();
        assert!(
            persist_generation_at(app.handle(), &paths.config, SavedConfig::default()).is_empty()
        );
        assert_eq!(fs::read(&paths.prompts).unwrap(), prompt_bytes);
        assert_eq!(fs::read(&paths.time_log).unwrap(), pat_bytes);
        let initial = load_initial_at(app.handle(), &paths, AiProvider::Openai);
        assert_eq!(initial.prompt_settings, settings);
        assert!(!initial.requires_onboarding);
        assert!(initial.warnings.is_empty());
    }

    #[test]
    fn dynamic_models_and_retired_spark_survive_configuration_reload() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let config = SavedConfig {
            openai_model: "gpt-7-new-2026-09-29".to_owned(),
            codex_model: "gpt-5.3-codex-spark".to_owned(),
            codex_reasoning_effort: "max".to_owned(),
            ..SavedConfig::default()
        };
        save_config(app.handle(), &path, &config).unwrap();
        let loaded = load_config(app.handle(), &path).unwrap().unwrap();
        assert_eq!(loaded.openai_model, config.openai_model);
        assert_eq!(loaded.codex_model, config.codex_model);
        assert_eq!(loaded.codex_reasoning_effort, "max");
    }

    #[test]
    fn validates_and_normalizes_settings_and_profile() {
        let profile = validate_profile(" Ygor Azambuja ", " YGOR.AZAMBUJA@INFORTECHMS.COM.BR ")
            .expect("valid corporate profile");
        assert_eq!(
            format_assigned_to(&profile),
            "Ygor Azambuja <YGOR.AZAMBUJA@infortechms.com.br>"
        );
        assert!(validate_profile("Ygor", "ygor@example.com").is_err());
        assert!(validate_assigned_to("Ygor Azambuja").is_err());

        let mut input = valid_settings_input();
        input.azure_organization = " https://dev.azure.com/InfortechMS/ ".to_owned();
        input.azure_project = " SPF-SIAFIC ".to_owned();
        let validated = validate_app_settings(&input).unwrap();
        assert_eq!(
            validated.azure_organization,
            "https://dev.azure.com/InfortechMS"
        );
        assert_eq!(validated.azure_project, "SPF-SIAFIC");

        input.time_log_pat = Some("pat".to_owned());
        input.remove_time_log_pat = true;
        assert!(validate_app_settings(&input).is_err());
        input.remove_time_log_pat = false;
        input.time_log_pat = Some(" ".to_owned());
        assert!(validate_app_settings(&input).is_err());
        input.time_log_pat = None;
        input.openai_model = "gpt-unsafe model".to_owned();
        assert!(validate_app_settings(&input).is_err());
    }

    #[tokio::test]
    async fn settings_save_preserves_operational_configuration() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        let existing = SavedConfig {
            repository_path: "/repo".to_owned(),
            sprint_id: "Sprint 8".to_owned(),
            area_path_id: "Área".to_owned(),
            item_contrato: "Item 7".to_owned(),
            ..SavedConfig::default()
        };
        save_config(app.handle(), &paths.config, &existing).unwrap();

        let result = save_settings_at(
            app.handle(),
            &paths,
            &valid_settings_input(),
            |_, _| async { Ok(()) },
        )
        .await
        .unwrap();

        assert_eq!(result.config.repository_path, "/repo");
        assert_eq!(result.config.sprint_id, "Sprint 8");
        assert_eq!(result.config.area_path_id, "Área");
        assert_eq!(result.config.item_contrato, "Item 7");
        assert_eq!(result.config.assigned_to, DEFAULT_ASSIGNED_TO);
        assert_eq!(result.config.ai_provider, AiProvider::Codex);
        let serialized = fs::read_to_string(&paths.config).unwrap();
        assert!(!serialized.contains("timeLogPat"));
        assert!(!serialized.contains("apiKey"));
        assert!(!serialized.contains("createAzureTasks"));
    }

    #[tokio::test]
    async fn settings_save_repairs_a_corrupt_configuration_with_a_warning() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        fs::write(&paths.config, "{invalid").unwrap();

        let result = save_settings_at(
            app.handle(),
            &paths,
            &valid_settings_input(),
            |_, _| async { Ok(()) },
        )
        .await
        .unwrap();

        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("foi substituída"));
        assert_eq!(
            load_config(app.handle(), &paths.config).unwrap(),
            Some(result.config)
        );
    }

    #[tokio::test]
    async fn failed_main_save_never_verifies_or_mutates_the_pat() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        fs::create_dir(&paths.config).unwrap();
        save_time_log_pat(app.handle(), &paths.time_log, "pat-anterior").unwrap();
        let previous = fs::read(&paths.time_log).unwrap();
        let verified = Arc::new(AtomicBool::new(false));
        let mut input = valid_settings_input();
        input.time_log_pat = Some("pat-novo".to_owned());

        let result = save_settings_at(app.handle(), &paths, &input, {
            let verified = Arc::clone(&verified);
            move |_, _| async move {
                verified.store(true, Ordering::SeqCst);
                Ok(())
            }
        })
        .await;

        assert!(result.is_err());
        assert!(!verified.load(Ordering::SeqCst));
        assert_eq!(fs::read(&paths.time_log).unwrap(), previous);
        assert!(app.handle().get_store(&paths.config).is_none());
        assert!(app.handle().get_store(&paths.time_log).is_none());
    }

    #[tokio::test]
    async fn rejected_pat_is_a_redacted_warning_and_preserves_the_previous_pat() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        save_time_log_pat(app.handle(), &paths.time_log, "pat-anterior").unwrap();
        let previous = fs::read(&paths.time_log).unwrap();
        let mut input = valid_settings_input();
        input.time_log_pat = Some("pat-novo-rejeitado".to_owned());

        let result = save_settings_at(app.handle(), &paths, &input, |_, pat| async move {
            Err(format!("credencial {pat} recusada"))
        })
        .await
        .unwrap();

        assert!(result.time_log_pat_configured);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("<redacted>"));
        assert!(!result.warnings[0].contains("pat-novo-rejeitado"));
        assert!(!result.warnings[0].contains("pat-anterior"));
        assert_eq!(fs::read(&paths.time_log).unwrap(), previous);
        assert!(paths.config.is_file());
    }

    #[tokio::test]
    async fn verified_pat_is_saved_after_the_main_configuration_and_can_be_removed() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        let mut input = valid_settings_input();
        input.time_log_pat = Some(" pat-verificado ".to_owned());

        let result = save_settings_at(app.handle(), &paths, &input, {
            let config_path = paths.config.clone();
            move |_, _| async move {
                assert!(config_path.is_file());
                Ok(())
            }
        })
        .await
        .unwrap();

        assert!(result.time_log_pat_configured);
        assert!(result.warnings.is_empty());
        assert_eq!(
            read_time_log_pat(app.handle(), &paths.time_log).unwrap(),
            Some("pat-verificado".to_owned())
        );

        input.time_log_pat = None;
        input.remove_time_log_pat = true;
        let removed = save_settings_at(app.handle(), &paths, &input, |_, _| async { Ok(()) })
            .await
            .unwrap();
        assert!(!removed.time_log_pat_configured);
        assert!(!paths.time_log.exists());
    }

    #[tokio::test]
    async fn failed_pat_save_is_nonfatal_and_reports_the_observed_status() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        fs::create_dir(&paths.time_log).unwrap();
        let mut input = valid_settings_input();
        input.time_log_pat = Some("pat-nao-exposto".to_owned());

        let result = save_settings_at(app.handle(), &paths, &input, |_, _| async { Ok(()) })
            .await
            .unwrap();

        assert!(paths.config.is_file());
        assert!(!result.time_log_pat_configured);
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("armazenado"))
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("confirmar"))
        );
        assert!(
            result
                .warnings
                .iter()
                .all(|warning| !warning.contains("pat-nao-exposto"))
        );
        assert!(app.handle().get_store(&paths.time_log).is_none());
    }

    #[tokio::test]
    async fn failed_pat_removal_is_nonfatal_after_the_main_save() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        fs::create_dir(&paths.time_log).unwrap();
        let mut input = valid_settings_input();
        input.remove_time_log_pat = true;

        let result = save_settings_at(app.handle(), &paths, &input, |_, _| async { Ok(()) })
            .await
            .unwrap();

        assert!(paths.config.is_file());
        assert!(!result.time_log_pat_configured);
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("PAT não pôde ser removido"))
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("confirmar o estado"))
        );
        assert!(paths.time_log.is_dir());
        assert!(app.handle().get_store(&paths.time_log).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pat_save_rejects_a_symlink_before_replacing_the_previous_secret() {
        use std::os::unix::fs::symlink;

        let app = test_app();
        let directory = tempdir().unwrap();
        let paths = test_paths(directory.path());
        let target = directory.path().join("outside-time-log.json");
        fs::write(&target, r#"{"adoPat":"pat-anterior"}"#).unwrap();
        let previous = fs::read(&target).unwrap();
        symlink(&target, &paths.time_log).unwrap();
        let mut input = valid_settings_input();
        input.time_log_pat = Some("pat-novo".to_owned());

        let result = save_settings_at(app.handle(), &paths, &input, |_, _| async { Ok(()) })
            .await
            .unwrap();

        assert!(result.time_log_pat_configured);
        assert!(result.warnings.iter().any(|warning| {
            warning.contains("PAT não pôde ser armazenado") && !warning.contains("pat-novo")
        }));
        assert_eq!(fs::read(&target).unwrap(), previous);
        assert!(paths.time_log.is_symlink());
        assert!(app.handle().get_store(&paths.time_log).is_none());
    }

    #[test]
    fn generation_save_repairs_values_and_turns_write_failure_into_a_warning() {
        let app = test_app();
        let directory = tempdir().unwrap();
        let valid_path = directory.path().join("saved.json");
        let invalid = SavedConfig {
            assigned_to: "Pessoa".to_owned(),
            openai_model: "invalid model".to_owned(),
            azure_organization: String::new(),
            azure_project: String::new(),
            ai_provider: AiProvider::Codex,
            ..SavedConfig::default()
        };

        assert!(persist_generation_at(app.handle(), &valid_path, invalid.clone()).is_empty());
        let saved = load_config(app.handle(), &valid_path).unwrap().unwrap();
        assert_eq!(saved.assigned_to, DEFAULT_ASSIGNED_TO);
        assert_eq!(saved.azure_organization, DEFAULT_AZURE_ORGANIZATION);
        assert_eq!(saved.azure_project, DEFAULT_AZURE_PROJECT);
        assert_eq!(saved.openai_model, crate::ai::DEFAULT_OPENAI_MODEL);
        assert_eq!(saved.ai_provider, AiProvider::Codex);

        let blocked_path = directory.path().join("blocked.json");
        fs::create_dir(&blocked_path).unwrap();
        let warnings = persist_generation_at(app.handle(), &blocked_path, invalid);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("As tarefas serão geradas"));
        assert!(app.handle().get_store(&blocked_path).is_none());
    }

    #[test]
    fn saves_and_loads_config() {
        let app = test_app();
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("config.json");
        let config = SavedConfig {
            repository_path: "/repo".to_owned(),
            sprint_id: "Sprint 1".to_owned(),
            area_path_id: "Projeto".to_owned(),
            assigned_to: "Pessoa".to_owned(),
            item_contrato: "Item 1".to_owned(),
            ai_provider: AiProvider::Codex,
            openai_model: "gpt-5-nano".to_owned(),
            codex_model: "gpt-5.6-luna".to_owned(),
            codex_reasoning_effort: "low".to_owned(),
            azure_organization: String::new(),
            azure_project: String::new(),
        };

        save_config(app.handle(), &path, &config).expect("save config");
        assert!(app.handle().get_store(&path).is_none());
        assert_eq!(
            load_config(app.handle(), &path).expect("load config"),
            Some(config)
        );
        assert!(app.handle().get_store(&path).is_none());

        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read config file"))
                .expect("parse config file");
        assert_eq!(saved["repositoryPath"], "/repo");
        assert!(saved.get("config").is_none());
        assert!(saved.get("apiKey").is_none());
        assert!(saved.get("createAzureTasks").is_none());
    }

    #[test]
    fn saves_and_loads_the_time_log_pat_from_its_own_store() {
        let app = test_app();
        let directory = tempdir().expect("temp directory");
        let config_path = directory.path().join("config.json");
        let pat_path = directory.path().join(TIME_LOG_STORE_FILE);

        save_time_log_pat(app.handle(), &pat_path, "  pat-secreto  ").expect("save PAT");
        save_time_log_pat(app.handle(), &pat_path, "pat-substituto").expect("replace PAT");
        save_config(app.handle(), &config_path, &SavedConfig::default()).expect("save config");

        assert_eq!(
            read_time_log_pat(app.handle(), &pat_path).expect("load PAT"),
            Some("pat-substituto".to_owned())
        );
        assert!(app.handle().get_store(&pat_path).is_none());

        let saved_pat: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&pat_path).expect("read PAT store"))
                .expect("parse PAT store");
        assert_eq!(saved_pat[TIME_LOG_PAT_KEY], "pat-substituto");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&pat_path)
                    .expect("PAT store metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let saved_config = fs::read_to_string(config_path).expect("read config store");
        assert!(!saved_config.contains("pat-secreto"));
        assert!(!saved_config.contains("pat-substituto"));
        assert!(!saved_config.contains(TIME_LOG_PAT_KEY));
    }

    #[test]
    fn removes_the_saved_time_log_pat_idempotently() {
        let app = test_app();
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join(TIME_LOG_STORE_FILE);
        save_time_log_pat(app.handle(), &path, "pat-secreto").expect("save PAT");

        remove_time_log_pat(&path).expect("remove PAT");
        remove_time_log_pat(&path).expect("remove missing PAT");

        assert!(!path.exists());
        assert_eq!(read_time_log_pat(app.handle(), &path).unwrap(), None);
    }

    #[test]
    fn returns_none_when_config_does_not_exist() {
        let app = test_app();
        let directory = tempdir().expect("temp directory");
        assert_eq!(
            load_config(app.handle(), &directory.path().join("missing.json"))
                .expect("load missing"),
            None
        );
    }

    #[test]
    fn rejects_invalid_config() {
        let app = test_app();
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("config.json");
        fs::write(&path, "{invalid").expect("write invalid config");
        assert!(load_config(app.handle(), &path).is_err());
        assert!(app.handle().get_store(&path).is_none());
        drop(app);
        assert_eq!(
            fs::read_to_string(path).expect("invalid config is preserved"),
            "{invalid"
        );
    }

    #[test]
    fn rejects_invalid_config_fields_and_closes_the_store() {
        let app = test_app();
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("config.json");
        fs::write(&path, r#"{"assignedTo": 42}"#).expect("write invalid config field");

        assert!(load_config(app.handle(), &path).is_err());
        assert!(app.handle().get_store(&path).is_none());
    }

    #[test]
    fn loads_legacy_top_level_config_with_defaults() {
        let app = test_app();
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join("config.json");
        fs::write(
            &path,
            r#"{
                "sprintId": "Sprint 1",
                "areaPathId": "Projeto",
                "assignedTo": "Pessoa",
                "itemContrato": "Item 2"
            }"#,
        )
        .expect("write legacy config");

        let config = load_config(app.handle(), &path)
            .expect("load legacy config")
            .expect("saved config");
        assert_eq!(config.sprint_id, "Sprint 1");
        assert_eq!(config.ai_provider, AiProvider::Openai);
        assert!(config.repository_path.is_empty());
    }
}
