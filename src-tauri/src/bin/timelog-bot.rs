use std::{io::ErrorKind, process::ExitCode};

use chrono::NaiveDate;
use clap::Parser;
use commit_ia_task_lib::time_log::{
    DEFAULT_API_VERSION, DEFAULT_TIMEOUT_SECONDS, TimeLogBatchInput, TimeLogCredential,
    TimeLogService, TimeLogType, TimeLogWork,
};

#[derive(Parser)]
#[command(
    version,
    about = "Registra horas na extensão Time Log Free do Azure DevOps",
    long_about = None,
    after_help = "EXEMPLO:\n  timelog-bot 201878 --hours 8 --date 2026-08-12 --end-date 2026-08-13 --type Frontend --comment 'Implementei a cotação'"
)]
struct Cli {
    /// ID positivo da Task ou de outro work item.
    #[arg(value_parser = parse_work_item_id)]
    work_item_id: i32,

    /// Quantidade inteira de horas.
    #[arg(long, short = 'H', default_value_t = 0)]
    hours: u32,

    /// Minutos adicionais, entre 0 e 59.
    #[arg(long, short = 'm', default_value_t = 0, value_parser = parse_minutes)]
    minutes: u8,

    /// Data do trabalho no formato YYYY-MM-DD.
    #[arg(long, short = 'd', value_parser = parse_date)]
    date: String,

    /// Data final inclusiva. Quando omitida, usa a mesma data de --date.
    #[arg(long, value_parser = parse_date)]
    end_date: Option<String>,

    /// Tipo: Backend, Frontend, Teste, Análise ou Reunião; Análise e Reunião aceitam nomes sem acento.
    #[arg(long = "type", short = 't')]
    kind: TimeLogType,

    /// Descrição do trabalho realizado.
    #[arg(long, short = 'c', value_parser = parse_nonempty)]
    comment: String,

    /// Slug ou URL https://dev.azure.com/<org> da organização.
    #[arg(
        long = "org",
        visible_alias = "organization",
        env = "ADO_ORG",
        hide_env_values = true,
        value_parser = parse_nonempty
    )]
    organization: String,

    /// Versão da API de Extension Data.
    #[arg(
        long,
        env = "ADO_EXTENSION_API_VERSION",
        hide_env_values = true,
        default_value = DEFAULT_API_VERSION,
        value_parser = parse_nonempty
    )]
    api_version: String,

    /// Nome a salvar no log; use junto com --user-id para sobrescrever a identidade autenticada.
    #[arg(long, env = "ADO_USER_NAME", hide_env_values = true, value_parser = parse_nonempty)]
    user_name: Option<String>,

    /// GUID a salvar no log; use junto com --user-name.
    #[arg(long, env = "ADO_USER_ID", hide_env_values = true, value_parser = parse_nonempty)]
    user_id: Option<String>,

    /// Consulta as horas existentes e mostra o plano completo sem criar lançamentos.
    #[arg(long)]
    dry_run: bool,

    /// Tempo limite de cada requisição HTTP, em segundos.
    #[arg(
        long,
        env = "ADO_TIMEOUT",
        hide_env_values = true,
        default_value_t = DEFAULT_TIMEOUT_SECONDS
    )]
    timeout: u64,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let dotenv_result = dotenvy::dotenv();
    let cli = Cli::parse();

    if let Err(error) = dotenv_result
        && !matches!(&error, dotenvy::Error::Io(io) if io.kind() == ErrorKind::NotFound)
    {
        eprintln!("erro: não foi possível carregar .env: {error}");
        return ExitCode::FAILURE;
    }

    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("erro: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    let credential = TimeLogCredential::from_environment()?;
    let service =
        TimeLogService::with_options(&cli.organization, credential, &cli.api_version, cli.timeout)?;
    let service = match (cli.user_name, cli.user_id) {
        (Some(name), Some(id)) => service.with_identity(name, id)?,
        (None, None) => service,
        _ => {
            return Err(
                "--user-name/ADO_USER_NAME e --user-id/ADO_USER_ID devem ser usados juntos".into(),
            );
        }
    };
    let total_minutes = cli
        .hours
        .checked_mul(60)
        .and_then(|hours| hours.checked_add(u32::from(cli.minutes)))
        .ok_or_else(|| "a duração informada é grande demais".to_string())?;
    if total_minutes == 0 {
        return Err("informe pelo menos uma hora ou um minuto".into());
    }
    let end_date = cli.end_date.unwrap_or_else(|| cli.date.clone());
    let input = TimeLogBatchInput {
        work_item_id: cli.work_item_id,
        start_date: cli.date,
        end_date,
        work: vec![TimeLogWork {
            minutes: total_minutes,
            kind: cli.kind,
            comment: cli.comment,
        }],
    };

    if cli.dry_run {
        let plan = service.preview_batch(&input).await?;
        println!(
            "{}",
            serde_json::to_string_pretty(&plan)
                .map_err(|error| format!("não foi possível exibir o plano: {error}"))?
        );
        return Ok(());
    }

    let result = service.create_batch(&input).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result)
            .map_err(|error| format!("não foi possível exibir o resultado: {error}"))?
    );
    if result.plan.missing_minutes > 0 {
        return Err(format!(
            "o intervalo não tem capacidade para {} minuto(s); amplie as datas e tente novamente",
            result.plan.missing_minutes
        ));
    }
    if let Some(failure) = result.failure {
        let state = if failure.indeterminate {
            "resultado indeterminado"
        } else {
            "lançamento recusado"
        };
        return Err(format!("{state}: {}", failure.error));
    }
    Ok(())
}

fn parse_work_item_id(value: &str) -> Result<i32, String> {
    let id = value
        .parse::<i32>()
        .map_err(|_| "o ID deve ser um número inteiro positivo".to_string())?;
    if id > 0 {
        Ok(id)
    } else {
        Err("o ID deve ser maior que zero".into())
    }
}

fn parse_minutes(value: &str) -> Result<u8, String> {
    let minutes = value
        .parse::<u8>()
        .map_err(|_| "os minutos devem ser um inteiro entre 0 e 59".to_string())?;
    if minutes < 60 {
        Ok(minutes)
    } else {
        Err("os minutos devem estar entre 0 e 59".into())
    }
}

fn parse_date(value: &str) -> Result<String, String> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|date| date.format("%Y-%m-%d").to_string())
        .map_err(|_| "a data deve existir e usar o formato YYYY-MM-DD".to_string())
}

fn parse_nonempty(value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        Err("o valor não pode ficar vazio".into())
    } else {
        Ok(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_original_cli_contract_case_insensitively() {
        let cli = Cli::try_parse_from([
            "timelog-bot",
            "201878",
            "--hours",
            "2",
            "--minutes",
            "30",
            "--date",
            "2026-08-12",
            "--type",
            "frontend",
            "--comment",
            "Implementei a cotação",
            "--org",
            "https://dev.azure.com/minha-org",
            "--dry-run",
        ])
        .unwrap();

        assert_eq!(cli.kind, TimeLogType::Frontend);
        assert_eq!(cli.minutes, 30);
        assert!(cli.end_date.is_none());
        assert!(cli.dry_run);
    }

    #[test]
    fn accepts_an_interval_and_test_type() {
        let cli = Cli::try_parse_from([
            "timelog-bot",
            "201878",
            "--hours",
            "8",
            "--date",
            "2026-08-12",
            "--end-date",
            "2026-08-13",
            "--type",
            "teste",
            "--comment",
            "Validei a entrega",
            "--org",
            "empresa",
        ])
        .unwrap();

        assert_eq!(cli.kind, TimeLogType::Teste);
        assert_eq!(cli.end_date.as_deref(), Some("2026-08-13"));
    }

    #[test]
    fn accepts_analysis_and_meeting_with_or_without_accents_case_insensitively() {
        let parse_kind = |kind: &str| {
            Cli::try_parse_from([
                "timelog-bot",
                "201878",
                "--date",
                "2026-08-12",
                "--type",
                kind,
                "--comment",
                "Trabalho realizado",
                "--org",
                "empresa",
            ])
            .unwrap()
            .kind
        };

        assert_eq!(parse_kind("Análise"), TimeLogType::Analise);
        assert_eq!(parse_kind("ANÁLISE"), TimeLogType::Analise);
        assert_eq!(parse_kind("analise"), TimeLogType::Analise);
        assert_eq!(parse_kind("ANALISE"), TimeLogType::Analise);
        assert_eq!(parse_kind("Reunião"), TimeLogType::Reuniao);
        assert_eq!(parse_kind("REUNIÃO"), TimeLogType::Reuniao);
        assert_eq!(parse_kind("reuniao"), TimeLogType::Reuniao);
        assert_eq!(parse_kind("REUNIAO"), TimeLogType::Reuniao);
    }

    #[test]
    fn rejects_invalid_poc_values() {
        assert!(parse_work_item_id("0").is_err());
        assert!(parse_minutes("60").is_err());
        assert!(parse_date("2026-02-29").is_err());
        assert!(parse_nonempty("  ").is_err());
    }
}
