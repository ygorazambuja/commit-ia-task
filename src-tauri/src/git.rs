use crate::models::{ChangedFileSummary, RepositoryInspection};
use crate::process::run_process;
use anyhow::{Context, Result, bail};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

const IGNORED_FILES: &[&str] = &["pnpm-lock.yaml", "bun.lockb", "package-lock.json"];

// Repositório, path e estado formam a identidade observada; o `kind` é só apresentação.
// `AnalyzedChange` acrescenta o payload exato e mantém ambos juntos até o stage.
#[derive(Debug, PartialEq, Eq)]
pub struct FileChange {
    repository: PathBuf,
    relative_path: String,
    state: StatusMeta,
}

#[derive(Debug, PartialEq, Eq)]
struct StatusMeta {
    is_new: bool,
    has_staged: bool,
    has_unstaged: bool,
}

impl StatusMeta {
    fn kind(&self) -> &'static str {
        if self.is_new {
            "new"
        } else if self.has_staged && self.has_unstaged {
            "mixed"
        } else if self.has_staged {
            "staged"
        } else {
            "modified"
        }
    }
}

#[derive(Debug)]
pub struct AnalyzedChange {
    change: FileChange,
    payload: String,
}

impl FileChange {
    pub fn relative_path(&self) -> &str {
        &self.relative_path
    }

    pub async fn analyze(self) -> Result<AnalyzedChange> {
        let payload = payload_for(&self).await?;
        Ok(AnalyzedChange {
            change: self,
            payload,
        })
    }
}

impl AnalyzedChange {
    pub fn relative_path(&self) -> &str {
        self.change.relative_path()
    }

    pub fn absolute_path(&self) -> PathBuf {
        self.change.repository.join(&self.change.relative_path)
    }

    pub fn repository(&self) -> &Path {
        &self.change.repository
    }

    pub fn payload(&self) -> &str {
        &self.payload
    }

    pub async fn stage(&self) -> Result<()> {
        let current_file = altered_files(&self.change.repository)
            .await?
            .into_iter()
            .find(|current| current.relative_path == self.change.relative_path)
            .context("O arquivo não possui mais a alteração que foi analisada")?;

        if current_file.state != self.change.state {
            bail!("O arquivo mudou durante a geração e não foi adicionado ao stage");
        }

        let current_payload = payload_for(&current_file).await?;
        if current_payload != self.payload {
            bail!("O arquivo mudou durante a geração e não foi adicionado ao stage");
        }

        run_git(
            &self.change.repository,
            &["add", "--", self.change.relative_path.as_str()],
        )
        .await
        .map(|_| ())
        .context("Não foi possível adicionar o arquivo ao stage")
    }
}

pub async fn resolve_repository(path: &Path) -> Result<PathBuf> {
    if !path.is_dir() {
        bail!("Selecione uma pasta de repositório válida");
    }

    let root = run_process(
        "git",
        &["rev-parse".to_owned(), "--show-toplevel".to_owned()],
        Some(path),
        None,
    )
    .await
    .context("A pasta selecionada não é um repositório Git")?;
    let root = PathBuf::from(root.trim());
    root.canonicalize()
        .with_context(|| format!("Não foi possível acessar {}", root.display()))
}

pub async fn inspect(path: &Path) -> Result<(RepositoryInspection, Vec<FileChange>)> {
    let root = resolve_repository(path).await?;
    let changes = altered_files(&root).await?;
    let inspection = RepositoryInspection {
        repository_path: root.to_string_lossy().into_owned(),
        files: changes
            .iter()
            .map(|file| ChangedFileSummary {
                path: file.relative_path.clone(),
                kind: file.state.kind().to_owned(),
            })
            .collect(),
    };
    Ok((inspection, changes))
}

async fn altered_files(root: &Path) -> Result<Vec<FileChange>> {
    let (unstaged_output, staged_output, status_output) = tokio::try_join!(
        run_git(root, &["diff", "--name-only", "-z"]),
        run_git(root, &["diff", "--cached", "--name-only", "-z"]),
        run_git(
            root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )
    )?;

    let unstaged = parse_names(&unstaged_output);
    let staged = parse_names(&staged_output);
    let statuses = parse_status(&status_output);
    let mut names = BTreeSet::new();
    names.extend(unstaged.iter().cloned());
    names.extend(staged.iter().cloned());
    names.extend(
        statuses
            .iter()
            .filter(|(_, status)| status.is_new)
            .map(|(path, _)| path.clone()),
    );

    Ok(names
        .into_iter()
        .filter(|path| !is_ignored(path))
        .map(|relative_path| {
            let status = statuses.get(&relative_path);
            let has_staged = status
                .map(|value| value.has_staged)
                .unwrap_or_else(|| staged.contains(&relative_path));
            let has_unstaged = status
                .map(|value| value.has_unstaged)
                .unwrap_or_else(|| unstaged.contains(&relative_path));
            let is_new = status.is_some_and(|value| value.is_new);
            FileChange {
                repository: root.to_path_buf(),
                relative_path,
                state: StatusMeta {
                    is_new,
                    has_staged,
                    has_unstaged,
                },
            }
        })
        .collect())
}

async fn payload_for(file: &FileChange) -> Result<String> {
    let root = &file.repository;
    let absolute_path = root.join(&file.relative_path);
    let (content, source) = if file.state.is_new {
        (
            read_repository_file(&absolute_path, root)?,
            "arquivo completo",
        )
    } else if file.state.has_staged && file.state.has_unstaged {
        let staged_args = ["diff", "--cached", "--", file.relative_path.as_str()];
        let unstaged_args = ["diff", "--", file.relative_path.as_str()];
        let (staged, unstaged) =
            tokio::try_join!(run_git(root, &staged_args), run_git(root, &unstaged_args),)?;
        (
            format!(
                "=== STAGED CHANGES ===\n{}\n\n=== UNSTAGED CHANGES ===\n{}",
                staged.trim(),
                unstaged.trim()
            ),
            "diff combinado",
        )
    } else if file.state.has_staged {
        (
            run_git(
                root,
                &["diff", "--cached", "--", file.relative_path.as_str()],
            )
            .await?,
            "diff staged",
        )
    } else if file.state.has_unstaged {
        (
            run_git(root, &["diff", "--", file.relative_path.as_str()]).await?,
            "diff unstaged",
        )
    } else {
        (String::new(), "fallback")
    };

    if content.trim().is_empty() {
        let fallback = read_repository_file(&absolute_path, root)
            .with_context(|| format!("Conteúdo vazio em {source} para {}", file.relative_path))?;
        if fallback.trim().is_empty() {
            bail!("Conteúdo vazio para {}", file.relative_path);
        }
        return Ok(fallback);
    }

    Ok(content)
}

async fn run_git(root: &Path, args: &[&str]) -> Result<String> {
    run_process(
        "git",
        &args
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>(),
        Some(root),
        None,
    )
    .await
}

fn parse_names(output: &str) -> BTreeSet<String> {
    output
        .split('\0')
        .filter(|path| !path.is_empty() && !is_ignored(path))
        .map(str::to_owned)
        .collect()
}

fn parse_status(output: &str) -> HashMap<String, StatusMeta> {
    let entries = output.split('\0').collect::<Vec<_>>();
    let mut statuses = HashMap::new();
    let mut index = 0;

    while index < entries.len() {
        let line = entries[index];
        index += 1;
        if line.len() < 3 {
            continue;
        }

        let bytes = line.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = line[3..].to_owned();

        if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            index += 1;
        }

        if path.is_empty() || is_ignored(&path) {
            continue;
        }

        statuses.insert(
            path,
            StatusMeta {
                has_staged: x != ' ' && x != '?',
                has_unstaged: y != ' ' || line.starts_with("??"),
                is_new: x == 'A' || line.starts_with("??"),
            },
        );
    }

    statuses
}

fn read_repository_file(path: &Path, root: &Path) -> Result<String> {
    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("Não foi possível acessar {}", root.display()))?;
    let canonical_path = path
        .canonicalize()
        .with_context(|| format!("Não foi possível acessar {}", path.display()))?;

    if !canonical_path.starts_with(&canonical_root) {
        bail!(
            "O arquivo {} aponta para fora do repositório e foi ignorado",
            path.display()
        );
    }

    let bytes = fs::read(&canonical_path)
        .with_context(|| format!("Não foi possível ler {}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn is_ignored(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| IGNORED_FILES.contains(&name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn repository() -> tempfile::TempDir {
        let directory = tempdir().expect("temp directory");
        git(directory.path(), &["init", "--quiet"]);
        git(
            directory.path(),
            &["config", "user.email", "test@example.com"],
        );
        git(directory.path(), &["config", "user.name", "Test"]);
        fs::write(directory.path().join("README.md"), "initial\n").expect("write file");
        git(directory.path(), &["add", "README.md"]);
        git(directory.path(), &["commit", "--quiet", "-m", "initial"]);
        directory
    }

    #[tokio::test]
    async fn detects_new_modified_mixed_and_ignores_lockfiles() {
        let directory = repository();
        let root = directory.path();
        fs::write(root.join("README.md"), "staged\n").expect("write staged");
        git(root, &["add", "README.md"]);
        fs::write(root.join("README.md"), "unstaged too\n").expect("write unstaged");
        fs::write(root.join("ação com espaço.ts"), "export {};\n").expect("write new");
        fs::create_dir(root.join("nested")).expect("create nested directory");
        for lockfile in [
            "bun.lockb",
            "nested/pnpm-lock.yaml",
            "nested/package-lock.json",
        ] {
            fs::write(root.join(lockfile), "lock").expect("write lockfile");
        }

        let (inspection, changes) = inspect(root).await.expect("inspect changes");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].relative_path, "README.md");
        assert_eq!(changes[1].relative_path, "ação com espaço.ts");
        assert_eq!(
            inspection
                .files
                .iter()
                .map(|file| (file.path.as_str(), file.kind.as_str()))
                .collect::<Vec<_>>(),
            [("README.md", "mixed"), ("ação com espaço.ts", "new")]
        );
    }

    #[tokio::test]
    async fn clean_repository_has_no_analyzed_changes() {
        let directory = repository();
        let (inspection, changes) = inspect(directory.path()).await.expect("inspect clean repo");

        assert!(inspection.files.is_empty());
        assert!(changes.is_empty());
    }

    #[tokio::test]
    async fn builds_combined_payload_and_stages_only_the_analyzed_version() {
        let directory = repository();
        let root = directory.path();
        fs::write(root.join("README.md"), "staged\n").expect("write staged");
        git(root, &["add", "README.md"]);
        fs::write(root.join("README.md"), "unstaged\n").expect("write unstaged");
        let file = altered_files(root).await.expect("changes").remove(0);
        let analyzed = file.analyze().await.expect("analyzed change");
        assert!(analyzed.payload().contains("=== STAGED CHANGES ==="));
        assert!(analyzed.payload().contains("=== UNSTAGED CHANGES ==="));

        fs::write(root.join("README.md"), "changed while waiting\n").expect("write race");
        assert!(analyzed.stage().await.is_err());
        assert_eq!(
            git(root, &["show", ":README.md"]),
            "staged\n",
            "pre-existing staged content must remain untouched"
        );
    }

    #[tokio::test]
    async fn does_not_stage_new_unstaged_content_after_a_staged_only_analysis() {
        let directory = repository();
        let root = directory.path();
        fs::write(root.join("README.md"), "staged\n").expect("write staged");
        git(root, &["add", "README.md"]);
        let file = altered_files(root).await.expect("changes").remove(0);
        assert_eq!(file.state.kind(), "staged");
        let analyzed = file.analyze().await.expect("analyzed change");
        assert!(analyzed.payload().contains("+staged"));

        fs::write(root.join("README.md"), "not analyzed\n").expect("write unstaged race");

        assert!(analyzed.stage().await.is_err());
        assert_eq!(
            git(root, &["show", ":README.md"]),
            "staged\n",
            "new unstaged content must not replace the analyzed index version"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlinks_that_escape_the_repository() {
        use std::os::unix::fs::symlink;

        let directory = repository();
        let outside = tempdir().expect("outside directory");
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "secret").expect("write secret");
        symlink(&secret, directory.path().join("linked.txt")).expect("create symlink");
        let file = altered_files(directory.path())
            .await
            .expect("changes")
            .remove(0);

        let error = file
            .analyze()
            .await
            .expect_err("escaping symlink should fail");
        assert!(error.to_string().contains("fora do repositório"));
    }

    #[tokio::test]
    async fn handles_deleted_files_and_stages_the_deletion() {
        let directory = repository();
        let root = directory.path();
        fs::remove_file(root.join("README.md")).expect("delete tracked file");
        let file = altered_files(root).await.expect("changes").remove(0);
        let analyzed = file.analyze().await.expect("deletion diff");

        assert!(analyzed.payload().contains("-initial"));
        analyzed.stage().await.expect("stage deletion");
        assert!(git(root, &["diff", "--cached", "--name-status"]).contains("D\tREADME.md"));
    }

    #[tokio::test]
    async fn stages_a_modified_file_through_the_analyzed_change() {
        let directory = repository();
        let root = directory.path();
        fs::write(root.join("README.md"), "modified\n").expect("modify tracked file");
        let file = altered_files(root).await.expect("changes").remove(0);
        let analyzed = file.analyze().await.expect("analyzed change");

        assert!(analyzed.payload().contains("+modified"));
        analyzed.stage().await.expect("stage modified file");
        assert_eq!(git(root, &["show", ":README.md"]), "modified\n");
    }

    #[tokio::test]
    async fn handles_real_staged_renames_with_spaces() {
        let directory = repository();
        let root = directory.path();
        git(root, &["mv", "README.md", "novo nome.md"]);
        let mut changes = altered_files(root).await.expect("rename changes");

        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].relative_path, "novo nome.md");
        assert_eq!(changes[0].state.kind(), "staged");
        let analyzed = changes.remove(0).analyze().await.expect("rename diff");
        assert!(analyzed.payload().contains("novo nome.md"));
        analyzed.stage().await.expect("stage rename");
        assert!(
            git(
                root,
                &["diff", "--cached", "--name-status", "--find-renames"]
            )
            .contains("R100\tREADME.md\tnovo nome.md")
        );
    }

    #[tokio::test]
    async fn stages_new_paths_starting_with_a_hyphen_without_option_injection() {
        let directory = repository();
        let root = directory.path();
        let path = "-ação com espaço.ts";
        fs::write(root.join(path), "export const seguro = true;\n").expect("write hostile path");
        let file = altered_files(root).await.expect("changes").remove(0);
        let analyzed = file.analyze().await.expect("new file content");

        assert_eq!(analyzed.payload(), "export const seguro = true;\n");
        analyzed.stage().await.expect("stage hostile path");
        assert_eq!(
            git(root, &["ls-files", "-z", "--", path]),
            format!("{path}\0")
        );
    }

    #[tokio::test]
    async fn falls_back_to_the_full_file_and_rejects_empty_content() {
        let directory = repository();
        let root = directory.path();
        let fallback = FileChange {
            repository: root.to_path_buf(),
            relative_path: "README.md".to_owned(),
            state: StatusMeta {
                is_new: false,
                has_staged: false,
                has_unstaged: false,
            },
        };

        assert_eq!(
            fallback
                .analyze()
                .await
                .expect("fallback payload")
                .payload(),
            "initial\n"
        );

        fs::write(root.join("empty.txt"), "").expect("write empty file");
        let empty = FileChange {
            repository: root.to_path_buf(),
            relative_path: "empty.txt".to_owned(),
            state: StatusMeta {
                is_new: true,
                has_staged: false,
                has_unstaged: true,
            },
        };
        assert!(
            empty
                .analyze()
                .await
                .expect_err("empty payload must fail")
                .to_string()
                .contains("Conteúdo vazio")
        );
    }

    #[test]
    fn parses_rename_destination_from_porcelain_z() {
        let statuses = parse_status("R  novo nome.md\0README.md\0");
        assert!(statuses.contains_key("novo nome.md"));
        assert!(!statuses.contains_key("README.md"));
    }
}
