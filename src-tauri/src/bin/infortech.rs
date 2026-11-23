use clap::Parser;
use commit_ia_task_lib::cli::Cli;
use std::{io::ErrorKind, process::ExitCode};

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let dotenv_result = dotenvy::dotenv();
    let cli = Cli::parse();
    if let Err(error) = dotenv_result
        && !matches!(&error, dotenvy::Error::Io(io) if io.kind() == ErrorKind::NotFound)
    {
        return fail(format!("Não foi possível carregar .env: {error}"));
    }
    match cli.run().await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(2),
        Err(error) => fail(format!("{error:#}")),
    }
}

fn fail(error: String) -> ExitCode {
    println!("{}", serde_json::json!({ "error": error }));
    ExitCode::FAILURE
}
