//! Adaptador de terminal. A geração usa o mesmo fluxo e validações da interface.
use crate::models::{AiProvider, GenerationInput, GenerationResult, SavedConfig};
use crate::{commands, config};
use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use std::{path::PathBuf, sync::Arc};

#[derive(Parser)]
#[command(
    version,
    about = "Gera tarefas de alterações Git em CSV e, opcionalmente, no Azure DevOps"
)]
pub struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Lista os arquivos alterados em JSON, sem gerar tarefas ou fazer stage.
    Inspect {
        /// Pasta do repositório (ou subpasta). Padrão: diretório atual.
        #[arg(long)]
        repository: Option<PathBuf>,
    },
    /// Gera tarefas, faz stage dos arquivos seguros e sempre escreve um CSV.
    Generate(Box<GenerateArgs>),
}

#[derive(Args, Default)]
struct GenerateArgs {
    /// Pasta do repositório (ou subpasta). Padrão: diretório atual.
    #[arg(long)]
    repository: Option<PathBuf>,
    /// Sprint/Iteration Path ou ID. Usa a configuração salva quando omitido.
    #[arg(long)]
    sprint: Option<String>,
    /// Area Path ou ID. Usa a configuração salva quando omitido.
    #[arg(long)]
    area: Option<String>,
    /// Responsável no formato Nome <email@infortechms.com.br>.
    #[arg(long)]
    assigned_to: Option<String>,
    /// Item de contrato. Usa a configuração salva quando omitido.
    #[arg(long)]
    contract: Option<String>,
    /// Provedor: openai ou codex. Usa a configuração salva quando omitido.
    #[arg(long, value_parser = ["openai", "codex"])]
    provider: Option<String>,
    /// Modelo do provedor selecionado.
    #[arg(long)]
    model: Option<String>,
    /// Esforço do Codex disponível para o modelo, validado no catálogo consultado.
    #[arg(long)]
    reasoning_effort: Option<String>,
    /// Cria e vincula Tasks no Azure após escrever o CSV.
    #[arg(long, requires = "parent")]
    create_azure_tasks: bool,
    /// ID positivo do PBI, User Story ou Requirement pai.
    #[arg(long, requires = "create_azure_tasks", value_parser = clap::value_parser!(u64).range(1..))]
    parent: Option<u64>,
    /// Organização do Azure. Usa a configuração salva quando omitida.
    #[arg(long)]
    organization: Option<String>,
    /// Projeto do Azure. Usa a configuração salva quando omitido.
    #[arg(long)]
    project: Option<String>,
    /// Salva os parâmetros não secretos para uso futuro na CLI e na interface.
    #[arg(long)]
    save_config: bool,
}

impl Cli {
    pub async fn run(self) -> Result<bool> {
        match self.command {
            Command::Inspect { repository } => {
                let (inspection, _) = crate::git::inspect(&repository_path(repository)?).await?;
                print_json(&inspection)?;
                Ok(true)
            }
            Command::Generate(args) => {
                let path = config::cli_config_path()?;
                let (saved, mut warnings) = match config::load_cli_config(&path) {
                    Ok(saved) => (saved, Vec::new()),
                    Err(error) => (
                        SavedConfig::default(),
                        vec![format!(
                            "A configuração salva não pôde ser carregada e os valores padrão foram usados: {error:#}"
                        )],
                    ),
                };
                let (prompt, prompt_warnings) = config::load_cli_prompt(&path);
                warnings.extend(prompt_warnings);
                let save_config = args.save_config;
                let input = args.into_input(saved)?;
                let system_prompt = Arc::new(prompt.system_prompt);
                let result = commands::execute_generation_with(
                    input,
                    &commands::GeneratedCsvRegistry::default(),
                    move |saved| {
                        if save_config {
                            warnings.extend(config::persist_cli_generation(&path, saved));
                        }
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
                    |tasks, organization, project, parent| async move {
                        crate::export::create_azure_tasks(
                            &tasks,
                            &organization,
                            &project,
                            parent,
                            |message, _, _| eprintln!("{message}"),
                        )
                        .await
                    },
                    |progress| eprintln!("{}", progress.message),
                )
                .await?;
                let complete = generation_complete(&result);
                print_json(&result)?;
                Ok(complete)
            }
        }
    }
}

impl GenerateArgs {
    fn into_input(self, mut saved: SavedConfig) -> Result<GenerationInput> {
        if let Some(provider) = self.provider {
            saved.ai_provider = match provider.as_str() {
                "codex" => AiProvider::Codex,
                _ => AiProvider::Openai,
            };
        }
        if let Some(model) = self.model {
            match saved.ai_provider {
                AiProvider::Openai => saved.openai_model = model,
                AiProvider::Codex => saved.codex_model = model,
            }
        }
        Ok(GenerationInput {
            repository_path: repository_path(self.repository)?
                .to_string_lossy()
                .into_owned(),
            sprint_id: self.sprint.unwrap_or(saved.sprint_id),
            area_path_id: self.area.unwrap_or(saved.area_path_id),
            assigned_to: self.assigned_to.unwrap_or(saved.assigned_to),
            item_contrato: self.contract.unwrap_or(saved.item_contrato),
            ai_provider: saved.ai_provider,
            openai_model: saved.openai_model,
            codex_model: saved.codex_model,
            codex_reasoning_effort: self
                .reasoning_effort
                .unwrap_or(saved.codex_reasoning_effort),
            api_key: None,
            create_azure_tasks: self.create_azure_tasks,
            parent_work_item_id: self.parent,
            azure_organization: self.organization.unwrap_or(saved.azure_organization),
            azure_project: self.project.unwrap_or(saved.azure_project),
            register_time_log: false,
            time_log_start_date: String::new(),
            time_log_end_date: String::new(),
        })
    }
}

fn repository_path(repository: Option<PathBuf>) -> Result<PathBuf> {
    repository.map_or_else(
        || std::env::current_dir().context("Não foi possível localizar a pasta atual"),
        Ok,
    )
}

fn generation_complete(result: &GenerationResult) -> bool {
    result.failures.is_empty()
        && result.azure_error.is_none()
        && result.files.iter().all(|file| file.staged)
}

fn print_json(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn azure_creation_requires_explicit_parent_and_opt_in() {
        for arguments in [
            vec!["infortech", "generate", "--create-azure-tasks"],
            vec!["infortech", "generate", "--parent", "1"],
            vec![
                "infortech",
                "generate",
                "--create-azure-tasks",
                "--parent",
                "0",
            ],
        ] {
            assert!(Cli::try_parse_from(arguments).is_err());
        }
        assert!(
            Cli::try_parse_from([
                "infortech",
                "generate",
                "--create-azure-tasks",
                "--parent",
                "123"
            ])
            .is_ok()
        );
    }

    #[test]
    fn arguments_override_saved_settings_without_exposing_credentials() {
        let cli = Cli::try_parse_from([
            "infortech",
            "generate",
            "--repository",
            "/repo",
            "--provider",
            "codex",
            "--model",
            "gpt-6-sol",
            "--sprint",
            "nova sprint",
        ])
        .unwrap();
        let Command::Generate(args) = cli.command else {
            panic!("generate")
        };
        let input = args
            .into_input(SavedConfig {
                sprint_id: "antiga".into(),
                area_path_id: "area salva".into(),
                ..SavedConfig::default()
            })
            .unwrap();
        assert_eq!(input.repository_path, "/repo");
        assert_eq!(input.sprint_id, "nova sprint");
        assert_eq!(input.area_path_id, "area salva");
        assert_eq!(input.ai_provider, AiProvider::Codex);
        assert_eq!(input.codex_model, "gpt-6-sol");
        assert!(!input.create_azure_tasks);
        assert!(!input.register_time_log);
        assert!(input.api_key.is_none());
        assert!(Cli::try_parse_from(["infortech", "generate", "--api-key", "segredo"]).is_err());
    }
}
