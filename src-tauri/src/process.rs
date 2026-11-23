use anyhow::{Context, Result, bail};
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub async fn run_process(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    stdin: Option<&str>,
) -> Result<String> {
    run_process_with_env_removed(program, args, cwd, stdin, &[]).await
}

pub(crate) async fn run_process_with_env_removed(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    stdin: Option<&str>,
    removed_variables: &[&str],
) -> Result<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for variable in removed_variables {
        command.env_remove(variable);
    }

    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("Não foi possível executar `{program}`"))?;

    if let (Some(input), Some(mut child_stdin)) = (stdin, child.stdin.take()) {
        child_stdin
            .write_all(input.as_bytes())
            .await
            .with_context(|| format!("Não foi possível enviar dados para `{program}`"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .with_context(|| format!("Falha ao aguardar `{program}`"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        bail!(
            "{}",
            if detail.is_empty() {
                format!("`{program}` terminou com status {}", output.status)
            } else {
                detail
            }
        );
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub async fn command_version(program: &str) -> Option<String> {
    run_process(program, &["--version".to_owned()], None, None)
        .await
        .ok()
        .map(|version| version.trim().to_owned())
        .filter(|version| !version.is_empty())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    #[tokio::test]
    async fn removes_selected_environment_variables_from_child() {
        run_process_with_env_removed(
            "/bin/sh",
            &["-c".to_owned(), "test -z \"${HOME+x}\"".to_owned()],
            None,
            None,
            &["HOME"],
        )
        .await
        .expect("removed variable must be absent in the child");
    }

    #[tokio::test]
    async fn timeout_terminates_child_instead_of_leaving_it_running() {
        let directory = tempfile::tempdir().unwrap();
        let program = directory.path().join("fake-process");
        std::fs::write(
            &program,
            "#!/bin/sh\nprintf '%s' \"$$\" > \"$0.pid\"\nexec /bin/sleep 20\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            run_process(program.to_str().unwrap(), &[], None, None),
        )
        .await;
        assert!(result.is_err());
        let pid = std::fs::read_to_string(program.with_extension("pid")).unwrap();
        for _ in 0..50 {
            if run_process("/bin/kill", &["-0".to_owned(), pid.clone()], None, None)
                .await
                .is_err()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("process {pid} remained alive after cancellation");
    }
}
