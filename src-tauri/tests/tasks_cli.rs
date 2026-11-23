#![cfg(unix)]

use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Output},
};
use tempfile::{TempDir, tempdir};

struct Fixture {
    directory: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let fixture = Self {
            directory: tempdir().unwrap(),
        };
        for directory in ["repo", "bin", "config"] {
            fs::create_dir(fixture.path().join(directory)).unwrap();
        }
        fixture.git(&["init", "-q"]);
        fixture.git(&["config", "user.email", "teste@infortechms.com.br"]);
        fixture.git(&["config", "user.name", "Teste"]);
        fixture.git(&["commit", "--allow-empty", "-qm", "base"]);
        fs::write(
            fixture.path().join("repo/file.ts"),
            "export const value = 1;",
        )
        .unwrap();
        fs::write(
            fixture.path().join("config/config.json"),
            json!({
                "sprintId": "Projeto\\Sprint 1",
                "areaPathId": "Projeto\\Area",
                "assignedTo": "Teste <teste@infortechms.com.br>",
                "itemContrato": "Item 2",
                "aiProvider": "codex",
                "azureOrganization": "https://dev.azure.com/empresa",
                "azureProject": "Projeto"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            fixture.path().join("config/prompts.json"),
            json!({
                "systemPrompt": "Instruções compartilhadas do teste."
            })
            .to_string(),
        )
        .unwrap();
        fixture.executable("codex", r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli teste"; exit 0; fi
if [ "$1" = "login" ]; then exit 0; fi
if [ "$1" = "app-server" ]; then
  read -r initialize
  printf '%s\n' '{"id":0,"result":{}}'
  read -r initialized
  read -r models
  if [ "$CLI_TEST_MODELS_EMPTY" = "1" ]; then
    printf '%s\n' '{"id":1,"result":{"data":[],"nextCursor":null}}'
  else
    printf '%s\n' '{"id":1,"result":{"data":[{"model":"gpt-6-luna","displayName":"GPT-6 Luna","supportedReasoningEfforts":[{"reasoningEffort":"low"}],"defaultReasoningEffort":"low"},{"model":"gpt-7-new","displayName":"Novo","supportedReasoningEfforts":[{"reasoningEffort":"max"}],"defaultReasoningEffort":"max"}],"nextCursor":null}}'
  fi
  exit 0
fi
printf '%s\n' "$@" > "$CLI_TEST_ROOT/exec.log"
cat > "$CLI_TEST_ROOT/prompt.log"
printf '%s\n' '{"fullFilePath":"file.ts","tasks":[{"title":"Criar funcionalidade","description":"Entrega de teste","tipo":"FRONTEND","complexidade":"MEDIA","estimateMade":2}]}'
"#);
        fixture.executable("az", r#"#!/bin/sh
printf '%s\n' "$@" >> "$CLI_TEST_ROOT/azure.log"
case "$3" in
  show) echo '{"id":123,"fields":{"System.WorkItemType":"User Story","System.TeamProject":"Projeto"}}';;
  create) echo '{"id":701}';;
  relation)
    if [ "$CLI_TEST_FAIL_LINK" = "1" ]; then echo 'Falha simulada ao vincular' >&2; exit 1; fi
    echo '{}';;
  *) exit 1;;
esac
"#);
        fixture
    }

    fn path(&self) -> &Path {
        self.directory.path()
    }

    fn executable(&self, name: &str, script: &str) {
        let path = self.path().join("bin").join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(self.path().join("repo"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_infortech"));
        command
            .current_dir(self.path().join("repo"))
            .env("COMMIT_IA_TASK_CONFIG_DIR", self.path().join("config"))
            .env("CLI_TEST_ROOT", self.path())
            .env(
                "PATH",
                std::env::join_paths(
                    std::iter::once(self.path().join("bin"))
                        .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
                )
                .unwrap(),
            )
            .env_remove("CODEX_MODEL")
            .env_remove("OPENAI_API_KEY")
            .env_remove("CLI_TEST_FAIL_LINK");
        command
    }

    fn json(output: &Output) -> Value {
        serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
            panic!(
                "stdout inválido: {}",
                String::from_utf8_lossy(&output.stdout)
            )
        })
    }
}

#[test]
fn inspect_and_invalid_generation_have_no_side_effects() {
    let fixture = Fixture::new();
    let output = fixture.command().arg("inspect").output().unwrap();
    assert!(output.status.success());
    let result = Fixture::json(&output);
    assert_eq!(result["files"][0]["path"], "file.ts");
    assert!(fixture.git(&["diff", "--cached", "--name-only"]).is_empty());
    assert!(!fixture.path().join("prompt.log").exists());

    let output = fixture
        .command()
        .args(["generate", "--sprint", ""])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        Fixture::json(&output)["error"]
            .as_str()
            .unwrap()
            .contains("Sprint")
    );
    assert!(!fixture.path().join("prompt.log").exists());
    assert_eq!(
        fs::read_dir(fixture.path().join("repo")).unwrap().count(),
        2
    );
}

#[test]
fn generation_reuses_settings_prompt_and_safe_stage_without_saving_by_default() {
    let fixture = Fixture::new();
    let config_path = fixture.path().join("config/config.json");
    let before = fs::read(&config_path).unwrap();
    let output = fixture
        .command()
        .args(["generate", "--contract", "Item 3"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = Fixture::json(&output);
    assert_eq!(result["files"][0]["tasks"][0]["estimateMade"], 2);
    assert_eq!(result["files"][0]["staged"], true);
    assert_eq!(
        fixture.git(&["diff", "--cached", "--name-only"]).trim(),
        "file.ts"
    );
    let csv = fs::read_to_string(result["csvPath"].as_str().unwrap()).unwrap();
    assert!(csv.contains("Item 3"));
    assert!(csv.contains("Teste <teste@infortechms.com.br>"));
    assert!(
        fs::read_to_string(fixture.path().join("prompt.log"))
            .unwrap()
            .contains("Instruções compartilhadas do teste.")
    );
    assert_eq!(fs::read(config_path).unwrap(), before);
    assert!(!fixture.path().join("azure.log").exists());
}

#[test]
fn azure_creation_links_to_parent_and_saves_only_nonsecret_config_when_requested() {
    let fixture = Fixture::new();
    let output = fixture
        .command()
        .args([
            "generate",
            "--create-azure-tasks",
            "--parent",
            "123",
            "--save-config",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(Fixture::json(&output)["azureTaskIds"], json!([701]));
    let calls = fs::read_to_string(fixture.path().join("azure.log")).unwrap();
    assert!(calls.find("show").unwrap() < calls.find("create").unwrap());
    assert!(calls.find("create").unwrap() < calls.find("relation").unwrap());
    assert!(calls.contains("--relation-type\nParent\n"));
    assert!(calls.contains("--target-id\n123\n"));
    let config: Value =
        serde_json::from_slice(&fs::read(fixture.path().join("config/config.json")).unwrap())
            .unwrap();
    assert_eq!(
        config["repositoryPath"],
        fixture
            .path()
            .join("repo")
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert!(config.get("apiKey").is_none());
    assert!(config.get("createAzureTasks").is_none());
    assert!(config.get("parentWorkItemId").is_none());
}

#[test]
fn partial_azure_failure_returns_json_and_nonzero_exit_preserving_csv_and_ids() {
    let fixture = Fixture::new();
    let output = fixture
        .command()
        .env("CLI_TEST_FAIL_LINK", "1")
        .args(["generate", "--create-azure-tasks", "--parent", "123"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let result = Fixture::json(&output);
    assert_eq!(result["azureTaskIds"], json!([701]));
    assert!(result["azureError"].as_str().unwrap().contains("vinculada"));
    assert!(Path::new(result["csvPath"].as_str().unwrap()).is_file());
    assert_eq!(result["files"][0]["staged"], true);
}

#[test]
fn discovered_model_survives_cli_restart_and_unavailable_model_does_not_mutate_the_repository() {
    let fixture = Fixture::new();
    let output = fixture
        .command()
        .args([
            "generate",
            "--model",
            "gpt-7-new",
            "--reasoning-effort",
            "max",
            "--save-config",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let config_path = fixture.path().join("config/config.json");
    let saved = fs::read(&config_path).unwrap();
    let config: Value = serde_json::from_slice(&saved).unwrap();
    assert_eq!(config["codexModel"], "gpt-7-new");
    assert_eq!(config["codexReasoningEffort"], "max");
    assert!(
        Fixture::json(&output)["warnings"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let output = fixture.command().args(["generate"]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let args = fs::read_to_string(fixture.path().join("exec.log")).unwrap();
    assert!(args.contains("--model\ngpt-7-new\n"));
    assert!(args.contains("model_reasoning_effort=\"max\""));
    let before = fixture.git(&["status", "--short"]);
    let output = fixture
        .command()
        .env("CLI_TEST_MODELS_EMPTY", "1")
        .args(["generate", "--save-config"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        Fixture::json(&output)["error"]
            .as_str()
            .unwrap()
            .contains("gpt-7-new não está disponível")
    );
    assert_eq!(fs::read(&config_path).unwrap(), saved);
    assert_eq!(fixture.git(&["status", "--short"]), before);
}
