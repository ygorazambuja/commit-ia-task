use crate::models::{GeneratedFile, TaskType};
use crate::process::run_process;
use anyhow::{Context, Result};
use chrono::{Datelike, Local, Timelike};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const CSV_HEADERS: &[&str] = &[
    "ID",
    "Work Item Type",
    "Title",
    "Assigned To",
    "State",
    "Area ID",
    "Iteration ID",
    "Item Contrato",
    "ID SPF",
    "UST",
    "Complexidade",
    "Activity",
    "Description",
    "Estimate Made",
    "Remaining Work",
    "Original Estimate",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryTask {
    title: String,
    assigned_to: String,
    area_id: String,
    sprint_id: String,
    task_type: TaskType,
    complexity: String,
    description: String,
    estimate: u8,
}

pub fn prepare_tasks(
    files: &[GeneratedFile],
    assigned_to: &str,
    area_id: &str,
    sprint_id: &str,
) -> Vec<DeliveryTask> {
    files
        .iter()
        .flat_map(|file| &file.tasks)
        .map(|task| DeliveryTask {
            title: sanitize_text(&task.title),
            assigned_to: sanitize_text(assigned_to),
            area_id: area_id.to_owned(),
            sprint_id: sprint_id.to_owned(),
            task_type: task.tipo.clone(),
            complexity: task.complexidade.clone(),
            description: sanitize_text(&task.description),
            estimate: match task.estimate_made {
                1..=8 => task.estimate_made,
                _ => 1,
            },
        })
        .collect()
}

pub fn write_csv(
    repository: &Path,
    tasks: &[DeliveryTask],
    item_contrato: &str,
) -> Result<PathBuf> {
    let now = Local::now();
    let base = format!(
        "tasks-{}-{}-{}-{}",
        now.day(),
        now.month(),
        now.hour(),
        now.minute()
    );
    write_csv_with_base(repository, tasks, item_contrato, &base)
}

fn write_csv_with_base(
    repository: &Path,
    tasks: &[DeliveryTask],
    item_contrato: &str,
    base: &str,
) -> Result<PathBuf> {
    let (path, file) = create_new_csv(repository, base)?;
    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(file);
    writer
        .write_record(CSV_HEADERS)
        .context("Não foi possível escrever o cabeçalho do CSV")?;

    let item_contrato = sanitize_text(item_contrato);
    for task in tasks {
        let estimate = task.estimate.to_string();
        let spf_id = match task.task_type {
            TaskType::Backend => "17",
            TaskType::Frontend => "19",
            TaskType::Testes => "22",
        };
        let ust = match task.complexity.as_str() {
            "MEDIA" => "24",
            "ALTA" => "40",
            _ => "8",
        };
        writer
            .write_record([
                "",
                "Task",
                task.title.as_str(),
                task.assigned_to.as_str(),
                "To Do",
                task.area_id.as_str(),
                task.sprint_id.as_str(),
                item_contrato.as_str(),
                spf_id,
                ust,
                task.complexity.as_str(),
                "Development",
                task.description.as_str(),
                estimate.as_str(),
                estimate.as_str(),
                estimate.as_str(),
            ])
            .with_context(|| format!("Não foi possível escrever a tarefa {}", task.title))?;
    }

    writer
        .flush()
        .with_context(|| format!("Não foi possível concluir {}", path.display()))?;
    Ok(path)
}

fn create_new_csv(repository: &Path, base: &str) -> Result<(PathBuf, File)> {
    let mut suffix = 1;

    loop {
        let file_name = if suffix == 1 {
            format!("{base}.csv")
        } else {
            format!("{base}-{}.csv", suffix - 1)
        };
        let path = repository.join(file_name);

        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                anyhow::bail!(
                    "O destino {} é um link simbólico e não será sobrescrito",
                    path.display()
                );
            }
            Ok(_) => {
                suffix += 1;
                continue;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Não foi possível verificar {}", path.display()));
            }
        }

        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                suffix += 1;
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Não foi possível criar {}", path.display()));
            }
        }
    }
}

pub async fn create_azure_tasks(
    tasks: &[DeliveryTask],
    organization: &str,
    project: &str,
    parent_work_item_id: Option<u64>,
    progress: impl FnMut(&str, usize, usize) + Send,
) -> (Vec<u64>, Option<String>) {
    create_azure_tasks_with_program(
        tasks,
        organization,
        project,
        parent_work_item_id,
        "az",
        progress,
    )
    .await
}

async fn create_azure_tasks_with_program(
    tasks: &[DeliveryTask],
    organization: &str,
    project: &str,
    parent_work_item_id: Option<u64>,
    program: &str,
    mut progress: impl FnMut(&str, usize, usize) + Send,
) -> (Vec<u64>, Option<String>) {
    let mut ids = Vec::new();

    if tasks.is_empty() {
        return (ids, None);
    }

    if let Some(parent_id) = parent_work_item_id {
        progress(
            &format!("Validando item pai #{parent_id} no Azure DevOps..."),
            0,
            tasks.len(),
        );
        let args = build_parent_validation_args(parent_id, organization);
        let validation = run_process(program, &args, None, None)
            .await
            .and_then(|output| validate_parent_work_item(&output, parent_id, project));
        if let Err(error) = validation {
            progress(
                "Validação do item pai falhou; nenhuma tarefa foi criada.",
                0,
                tasks.len(),
            );
            return (
                ids,
                Some(format!(
                    "O item pai #{parent_id} não pôde ser validado; nenhuma tarefa foi criada: {error}"
                )),
            );
        }
    }

    progress("Validando Área e Sprint no Azure DevOps...", 0, tasks.len());
    let destinations = match resolve_azure_destinations(tasks, organization, project, program).await
    {
        Ok(destinations) => destinations,
        Err(error) => {
            progress(
                "Validação de Área ou Sprint falhou; nenhuma tarefa foi criada.",
                0,
                tasks.len(),
            );
            return (
                ids,
                Some(format!(
                    "Os destinos do Azure DevOps não puderam ser validados; nenhuma tarefa foi criada: {error}"
                )),
            );
        }
    };

    for (index, (task, (area_path, iteration_path))) in tasks.iter().zip(destinations).enumerate() {
        progress(
            &format!(
                "Criando tarefa {}/{} no Azure DevOps: {}",
                index + 1,
                tasks.len(),
                task.title
            ),
            index,
            tasks.len(),
        );
        let args = build_azure_args(task, organization, project, &area_path, &iteration_path);
        let output = match run_process(program, &args, None, None).await {
            Ok(output) => output,
            Err(error) => {
                progress(
                    &format!(
                        "Falha ao criar a tarefa {}; criação interrompida.",
                        index + 1
                    ),
                    index,
                    tasks.len(),
                );
                return (
                    ids,
                    Some(format!(
                        "Falha ao criar \"{}\" no Azure DevOps: {error}",
                        task.title
                    )),
                );
            }
        };

        let id = match parse_created_work_item_id(&output, &task.title) {
            Ok(id) => id,
            Err(error) => {
                progress(
                    "O Azure não confirmou o ID da tarefa; criação interrompida.",
                    index,
                    tasks.len(),
                );
                return (ids, Some(error.to_string()));
            }
        };
        ids.push(id);

        if let Some(parent_id) = parent_work_item_id {
            progress(
                &format!("Tarefa #{id} criada; vinculando ao item pai #{parent_id}..."),
                index,
                tasks.len(),
            );
            let args = build_parent_relation_args(id, parent_id, organization);
            if let Err(error) = run_process(program, &args, None, None).await {
                progress(
                    &format!("Falha ao vincular a tarefa #{id}; criação interrompida."),
                    index,
                    tasks.len(),
                );
                return (
                    ids,
                    Some(format!(
                        "A tarefa #{} (\"{}\") foi criada, mas não pôde ser vinculada ao item pai #{parent_id}: {error}",
                        id, task.title
                    )),
                );
            }
        }
        progress(
            &format!("Tarefa #{id} concluída no Azure DevOps: {}", task.title),
            index + 1,
            tasks.len(),
        );
    }

    (ids, None)
}

#[derive(Deserialize)]
struct CreatedWorkItem {
    id: Option<u64>,
}

#[derive(Default, Deserialize)]
struct ParentWorkItemFields {
    #[serde(rename = "System.Id")]
    id: Option<u64>,
    #[serde(rename = "System.WorkItemType")]
    work_item_type: Option<String>,
    #[serde(rename = "System.TeamProject")]
    team_project: Option<String>,
}

#[derive(Deserialize)]
struct ParentWorkItem {
    id: Option<u64>,
    #[serde(default)]
    fields: ParentWorkItemFields,
}

#[derive(Deserialize)]
struct ClassificationNode {
    id: Option<u64>,
    path: Option<String>,
    #[serde(rename = "structureType")]
    structure_type: Option<String>,
}

async fn resolve_azure_destinations(
    tasks: &[DeliveryTask],
    organization: &str,
    project: &str,
    program: &str,
) -> Result<Vec<(String, String)>> {
    let mut area_paths = HashMap::new();
    let mut iteration_paths = HashMap::new();
    let mut destinations = Vec::with_capacity(tasks.len());

    for task in tasks {
        let area_path = resolve_destination(
            &task.area_id,
            "area",
            organization,
            project,
            program,
            &mut area_paths,
        )
        .await?;
        let iteration_path = resolve_destination(
            &task.sprint_id,
            "iteration",
            organization,
            project,
            program,
            &mut iteration_paths,
        )
        .await?;
        destinations.push((area_path, iteration_path));
    }

    Ok(destinations)
}

async fn resolve_destination(
    value: &str,
    expected_type: &str,
    organization: &str,
    project: &str,
    program: &str,
    cache: &mut HashMap<u64, String>,
) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|character| character.is_ascii_digit()) {
        return Ok(value.to_owned());
    }

    let id = trimmed.parse::<u64>().with_context(|| {
        format!(
            "O ID de {} \"{trimmed}\" é inválido",
            classification_label(expected_type).to_lowercase()
        )
    })?;
    if let Some(path) = cache.get(&id) {
        return Ok(path.clone());
    }

    let args = build_classification_node_args(expected_type, id, organization, project);
    let output = run_process(program, &args, None, None)
        .await
        .with_context(|| {
            format!(
                "Não foi possível consultar a {} #{id}",
                classification_label(expected_type)
            )
        })?;
    let path = parse_classification_node(&output, id, expected_type)?;
    cache.insert(id, path.clone());
    Ok(path)
}

fn parse_classification_node(
    output: &str,
    expected_id: u64,
    expected_type: &str,
) -> Result<String> {
    let nodes: Vec<ClassificationNode> = serde_json::from_str(output).with_context(|| {
        format!(
            "O Azure DevOps retornou uma resposta inválida para a {} #{expected_id}",
            classification_label(expected_type)
        )
    })?;
    let node = nodes
        .iter()
        .find(|node| node.id == Some(expected_id))
        .with_context(|| {
            format!(
                "O Azure DevOps não retornou a {} #{expected_id}",
                classification_label(expected_type)
            )
        })?;
    let returned_type = node
        .structure_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .with_context(|| {
            format!(
                "O Azure DevOps não informou o tipo da {} #{expected_id}",
                classification_label(expected_type)
            )
        })?;
    if !returned_type.eq_ignore_ascii_case(expected_type) {
        anyhow::bail!(
            "A {} #{expected_id} retornou um nó do tipo \"{returned_type}\"",
            classification_label(expected_type)
        );
    }

    let path = node
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .with_context(|| {
            format!(
                "O Azure DevOps não informou o caminho da {} #{expected_id}",
                classification_label(expected_type)
            )
        })?;
    classification_tree_path(path, expected_type).with_context(|| {
        format!(
            "O caminho retornado para a {} #{expected_id} é inválido",
            classification_label(expected_type)
        )
    })
}

fn classification_tree_path(path: &str, expected_type: &str) -> Result<String> {
    let segments = path
        .split('\\')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let technical_segment = match expected_type {
        "area" => "Area",
        "iteration" => "Iteration",
        _ => anyhow::bail!("Tipo de classificação desconhecido: {expected_type}"),
    };
    if segments.len() < 2 || !segments[1].eq_ignore_ascii_case(technical_segment) {
        anyhow::bail!("segmento técnico {technical_segment} ausente em \"{path}\"");
    }

    Ok(std::iter::once(segments[0])
        .chain(segments.iter().skip(2).copied())
        .collect::<Vec<_>>()
        .join("\\"))
}

fn classification_label(expected_type: &str) -> &'static str {
    match expected_type {
        "area" => "Área",
        "iteration" => "Iteração",
        _ => "classificação",
    }
}

fn parse_created_work_item_id(output: &str, title: &str) -> Result<u64> {
    let item: CreatedWorkItem = serde_json::from_str(output)
        .with_context(|| format!("Resposta inválida do Azure DevOps para \"{title}\""))?;
    item.id.with_context(|| {
        format!(
            "O Azure DevOps não retornou o ID da tarefa \"{title}\"; a criação foi interrompida"
        )
    })
}

fn validate_parent_work_item(output: &str, expected_id: u64, project: &str) -> Result<()> {
    let item: ParentWorkItem = serde_json::from_str(output)
        .context("O Azure DevOps retornou uma resposta inválida para o item pai")?;

    if item.id.is_none() && item.fields.id.is_none() {
        anyhow::bail!("O Azure DevOps não retornou o ID do item pai");
    }
    for returned_id in [item.id, item.fields.id].into_iter().flatten() {
        if returned_id != expected_id {
            anyhow::bail!(
                "O Azure DevOps retornou o item #{returned_id} ao validar o item pai #{expected_id}"
            );
        }
    }

    let work_item_type = item
        .fields
        .work_item_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("O Azure DevOps não informou o tipo do item pai")?;
    if work_item_type.eq_ignore_ascii_case("Task") {
        anyhow::bail!("O item pai #{expected_id} também é uma Task");
    }

    let project = project.trim();
    let mismatched_project =
        item.fields
            .team_project
            .as_deref()
            .map(str::trim)
            .filter(|parent_project| {
                !parent_project.is_empty()
                    && !project.is_empty()
                    && !parent_project.eq_ignore_ascii_case(project)
            });
    if let Some(parent_project) = mismatched_project {
        anyhow::bail!(
            "O item pai #{expected_id} pertence ao projeto \"{parent_project}\", não ao projeto de destino \"{project}\""
        );
    }

    Ok(())
}

fn build_parent_validation_args(parent_id: u64, organization: &str) -> Vec<String> {
    let mut args = vec![
        "boards".to_owned(),
        "work-item".to_owned(),
        "show".to_owned(),
        "--id".to_owned(),
        parent_id.to_string(),
        "--fields".to_owned(),
        "System.Id,System.Title,System.WorkItemType,System.TeamProject".to_owned(),
        "--expand".to_owned(),
        "none".to_owned(),
    ];
    if !organization.trim().is_empty() {
        args.extend(["--org".to_owned(), organization.trim().to_owned()]);
    }
    args.extend(["--output".to_owned(), "json".to_owned()]);
    args
}

fn build_classification_node_args(
    node_type: &str,
    id: u64,
    organization: &str,
    project: &str,
) -> Vec<String> {
    let mut args = vec![
        "boards".to_owned(),
        node_type.to_owned(),
        "project".to_owned(),
        "show".to_owned(),
        "--id".to_owned(),
        id.to_string(),
    ];
    if !organization.trim().is_empty() {
        args.extend(["--org".to_owned(), organization.trim().to_owned()]);
    }
    if !project.trim().is_empty() {
        args.extend(["--project".to_owned(), project.trim().to_owned()]);
    }
    args.extend(["--output".to_owned(), "json".to_owned()]);
    args
}

fn build_parent_relation_args(child_id: u64, parent_id: u64, organization: &str) -> Vec<String> {
    let mut args = vec![
        "boards".to_owned(),
        "work-item".to_owned(),
        "relation".to_owned(),
        "add".to_owned(),
        "--id".to_owned(),
        child_id.to_string(),
        "--relation-type".to_owned(),
        "Parent".to_owned(),
        "--target-id".to_owned(),
        parent_id.to_string(),
    ];
    if !organization.trim().is_empty() {
        args.extend(["--org".to_owned(), organization.trim().to_owned()]);
    }
    args.extend(["--output".to_owned(), "json".to_owned()]);
    args
}

fn build_azure_args(
    task: &DeliveryTask,
    organization: &str,
    project: &str,
    area_path: &str,
    iteration_path: &str,
) -> Vec<String> {
    let mut args = vec![
        "boards".to_owned(),
        "work-item".to_owned(),
        "create".to_owned(),
        "--type".to_owned(),
        "Task".to_owned(),
        "--title".to_owned(),
        task.title.clone(),
        "--description".to_owned(),
        task.description.clone(),
        "--assigned-to".to_owned(),
        task.assigned_to.clone(),
        "--area".to_owned(),
        area_path.to_owned(),
        "--iteration".to_owned(),
        iteration_path.to_owned(),
        "--fields".to_owned(),
        "System.State=To Do".to_owned(),
        "Microsoft.VSTS.Common.Activity=Development".to_owned(),
        format!(
            "Microsoft.VSTS.Scheduling.OriginalEstimate={}",
            task.estimate
        ),
        format!("Microsoft.VSTS.Scheduling.RemainingWork={}", task.estimate),
    ];

    if !organization.trim().is_empty() {
        args.extend(["--org".to_owned(), organization.trim().to_owned()]);
    }
    if !project.trim().is_empty() {
        args.extend(["--project".to_owned(), project.trim().to_owned()]);
    }
    args.extend(["--output".to_owned(), "json".to_owned()]);
    args
}

fn sanitize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Task;
    use std::fs;
    use tempfile::tempdir;

    fn generated_files() -> Vec<GeneratedFile> {
        vec![GeneratedFile {
            full_file_path: "/repo/src/main.rs".to_owned(),
            relative_path: "src/main.rs".to_owned(),
            tasks: vec![
                Task {
                    title: " Backend\nseguro ".to_owned(),
                    description: "Linha 1\r\nLinha 2".to_owned(),
                    tipo: TaskType::Backend,
                    complexidade: "MEDIA".to_owned(),
                    estimate_made: 5,
                },
                Task {
                    title: "Interface".to_owned(),
                    description: "Tela".to_owned(),
                    tipo: TaskType::Frontend,
                    complexidade: "ALTA".to_owned(),
                    estimate_made: 8,
                },
                Task {
                    title: "Testes".to_owned(),
                    description: "Cobertura".to_owned(),
                    tipo: TaskType::Testes,
                    complexidade: "ÚNICA".to_owned(),
                    estimate_made: 1,
                },
            ],
            staged: true,
            stage_error: None,
        }]
    }

    #[test]
    fn maps_task_types_complexities_and_sanitizes_text() {
        let mut tasks = prepare_tasks(
            &generated_files(),
            " Pessoa\nResponsável ",
            "Projeto\\Área",
            "Projeto\\Sprint",
        );
        let mut fallback = tasks[0].clone();
        fallback.complexity = "DESCONHECIDA".to_owned();
        tasks.push(fallback);

        assert_eq!(tasks[0].title, "Backend seguro");
        assert_eq!(tasks[0].description, "Linha 1 Linha 2");

        let directory = tempdir().expect("temp directory");
        let path = write_csv_with_base(directory.path(), &tasks, " Item 1 ", "tasks-mappings")
            .expect("csv projection");
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .from_path(path)
            .expect("open csv");
        let rows = reader
            .records()
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("parse csv");
        assert_eq!(
            rows.iter()
                .skip(1)
                .map(|row| (&row[8], &row[9]))
                .collect::<Vec<_>>(),
            [("17", "24"), ("19", "40"), ("22", "8"), ("17", "8")]
        );
        assert_eq!(&rows[1][7], "Item 1");
    }

    #[test]
    fn writes_header_and_uses_a_suffix_without_overwriting() {
        let directory = tempdir().expect("temp directory");
        let first =
            write_csv_with_base(directory.path(), &[], "", "tasks-collision").expect("first csv");
        let second =
            write_csv_with_base(directory.path(), &[], "", "tasks-collision").expect("second csv");
        assert_eq!(
            first.file_name().and_then(|name| name.to_str()),
            Some("tasks-collision.csv")
        );
        assert_eq!(
            second.file_name().and_then(|name| name.to_str()),
            Some("tasks-collision-1.csv")
        );
        let csv = fs::read_to_string(first).expect("read csv");
        assert_eq!(csv.lines().count(), 1);
        assert!(csv.contains("Original Estimate"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_broken_symlink_instead_of_writing_outside_the_repository() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().expect("temp directory");
        let outside = tempdir().expect("outside directory");
        let outside_target = outside.path().join("created-outside.csv");
        let link = directory.path().join("tasks-symlink.csv");
        symlink(&outside_target, &link).expect("create broken symlink");

        let error = write_csv_with_base(directory.path(), &[], "", "tasks-symlink")
            .expect_err("symlink destination must be rejected");

        assert!(error.to_string().contains("link simbólico"));
        assert!(!outside_target.exists());
    }

    #[test]
    fn writes_azure_compatible_csv() {
        let directory = tempdir().expect("temp directory");
        let tasks = prepare_tasks(
            &generated_files(),
            "Pessoa <dev@example.com>",
            "Área",
            "Sprint",
        );
        let path = write_csv(directory.path(), &tasks, "Item 1").expect("csv");
        let csv = fs::read_to_string(path).expect("read csv");
        assert!(csv.contains("Item 1,17,24,MEDIA"));
        assert!(csv.contains("Linha 1 Linha 2,5,5,5"));
    }

    #[test]
    fn writes_exact_headers_and_quotes_special_characters() {
        let directory = tempdir().expect("temp directory");
        let task = DeliveryTask {
            title: "Título, com \"aspas\"".to_owned(),
            assigned_to: "Pessoa <dev@example.com>".to_owned(),
            area_id: "Área".to_owned(),
            sprint_id: "Sprint".to_owned(),
            task_type: TaskType::Backend,
            complexity: "BAIXA".to_owned(),
            description: "Descrição, segura".to_owned(),
            estimate: 2,
        };
        let path = write_csv_with_base(directory.path(), &[task], "Item 1", "tasks-golden")
            .expect("write golden csv");
        let csv = fs::read_to_string(path).expect("read golden csv");

        assert_eq!(
            csv,
            concat!(
                "ID,Work Item Type,Title,Assigned To,State,Area ID,Iteration ID,Item Contrato,ID SPF,UST,Complexidade,Activity,Description,Estimate Made,Remaining Work,Original Estimate\n",
                ",Task,\"Título, com \"\"aspas\"\"\",Pessoa <dev@example.com>,To Do,Área,Sprint,Item 1,17,8,BAIXA,Development,\"Descrição, segura\",2,2,2\n"
            )
        );
    }

    #[test]
    fn builds_only_the_authorized_azure_projection() {
        let task = prepare_tasks(&generated_files(), "Pessoa", "Área", "Sprint").remove(0);
        let args = build_azure_args(
            &task,
            "https://dev.azure.com/org",
            "Projeto",
            &task.area_id,
            &task.sprint_id,
        );
        assert_eq!(
            args.iter().map(String::as_str).collect::<Vec<_>>(),
            [
                "boards",
                "work-item",
                "create",
                "--type",
                "Task",
                "--title",
                "Backend seguro",
                "--description",
                "Linha 1 Linha 2",
                "--assigned-to",
                "Pessoa",
                "--area",
                "Área",
                "--iteration",
                "Sprint",
                "--fields",
                "System.State=To Do",
                "Microsoft.VSTS.Common.Activity=Development",
                "Microsoft.VSTS.Scheduling.OriginalEstimate=5",
                "Microsoft.VSTS.Scheduling.RemainingWork=5",
                "--org",
                "https://dev.azure.com/org",
                "--project",
                "Projeto",
                "--output",
                "json",
            ]
        );
        for forbidden in [
            "Custom.ItemContrato=",
            "Custom.IDSPF=",
            "Custom.UST=",
            "Custom.Complexidade=",
            "Custom.EstimateMade=",
        ] {
            assert!(!args.iter().any(|argument| argument.starts_with(forbidden)));
        }

        let without_cli_defaults = build_azure_args(&task, "", "", &task.area_id, &task.sprint_id);
        assert!(!without_cli_defaults.contains(&"--org".to_owned()));
        assert!(!without_cli_defaults.contains(&"--project".to_owned()));
    }

    #[test]
    fn normalizes_invalid_estimates_for_both_projections() {
        let mut files = generated_files();
        files[0].tasks[0].estimate_made = 0;
        files[0].tasks[1].estimate_made = 9;
        let tasks = prepare_tasks(&files, "Pessoa", "Área", "Sprint");
        assert_eq!(
            tasks
                .iter()
                .take(2)
                .map(|task| task.estimate)
                .collect::<Vec<_>>(),
            [1, 1]
        );

        let directory = tempdir().expect("temp directory");
        let path = write_csv_with_base(directory.path(), &tasks[..2], "Item 1", "tasks-estimate")
            .expect("csv projection");
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(false)
            .from_path(path)
            .expect("open csv");
        let rows = reader
            .records()
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("parse csv");
        for row in &rows[1..] {
            assert_eq!(row.iter().skip(13).collect::<Vec<_>>(), ["1", "1", "1"]);
        }

        for task in &tasks[..2] {
            let args = build_azure_args(task, "", "", &task.area_id, &task.sprint_id);
            assert!(args.contains(&"Microsoft.VSTS.Scheduling.OriginalEstimate=1".to_owned()));
            assert!(args.contains(&"Microsoft.VSTS.Scheduling.RemainingWork=1".to_owned()));
        }
    }

    #[test]
    fn builds_parent_commands_without_incompatible_arguments() {
        let validation = build_parent_validation_args(900, " https://dev.azure.com/org ");
        assert_eq!(&validation[..3], ["boards", "work-item", "show"]);
        assert!(validation.windows(2).any(|args| args == ["--id", "900"]));
        assert!(validation.windows(2).any(|args| {
            args == [
                "--fields",
                "System.Id,System.Title,System.WorkItemType,System.TeamProject",
            ]
        }));
        assert!(
            validation
                .windows(2)
                .any(|args| args == ["--expand", "none"])
        );
        assert!(!validation.contains(&"--project".to_owned()));

        let relation = build_parent_relation_args(101, 900, "https://dev.azure.com/org");
        assert_eq!(&relation[..4], ["boards", "work-item", "relation", "add"]);
        assert!(
            relation
                .windows(2)
                .any(|args| args == ["--relation-type", "Parent"])
        );
        assert!(
            relation
                .windows(2)
                .any(|args| args == ["--target-id", "900"])
        );
        assert!(!relation.contains(&"--project".to_owned()));
    }

    #[test]
    fn rejects_a_parent_from_another_project() {
        let error = validate_parent_work_item(
            r#"{"id":900,"fields":{"System.Id":900,"System.WorkItemType":"Product Backlog Item","System.TeamProject":"Outro"}}"#,
            900,
            "Projeto",
        )
        .expect_err("parent from another project should fail");

        assert!(error.to_string().contains("pertence ao projeto \"Outro\""));
    }

    #[test]
    fn rejects_an_azure_response_without_an_id() {
        let error = parse_created_work_item_id("{}", "Tarefa sem ID")
            .expect_err("missing id must not be a success");
        assert!(error.to_string().contains("não retornou o ID"));
        assert!(error.to_string().contains("Tarefa sem ID"));
    }

    #[tokio::test]
    async fn empty_task_list_does_not_validate_the_parent() {
        let (ids, error) = create_azure_tasks_with_program(
            &[],
            "https://dev.azure.com/org",
            "Projeto",
            Some(900),
            "program-that-must-not-run",
            |_, _, _| {},
        )
        .await;

        assert!(ids.is_empty());
        assert!(error.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn azure_adapter_prevalidates_once_and_links_each_task_in_order() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temp directory");
        let script = directory.path().join("fake-az");
        let create_counter = directory.path().join("create-counter");
        let args_log = directory.path().join("args.log");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf 'CALL' >> '{args_log}'\nprintf ' <%s>' \"$@\" >> '{args_log}'\nprintf '\\n' >> '{args_log}'\ncase \"$3\" in\n  show) printf '%s' '{{\"id\":900,\"fields\":{{\"System.Id\":900,\"System.Title\":\"PBI\",\"System.WorkItemType\":\"Product Backlog Item\",\"System.TeamProject\":\"Projeto\"}}}}' ;;\n  create) count=0; [ -f '{create_counter}' ] && count=$(cat '{create_counter}'); count=$((count + 1)); printf '%s' \"$count\" > '{create_counter}'; printf '{{\"id\":%s}}' \"$((100 + count))\" ;;\n  relation) printf '%s' '{{}}' ;;\n  *) exit 64 ;;\nesac\n",
                args_log = args_log.display(),
                create_counter = create_counter.display(),
            ),
        )
        .expect("write fake Azure CLI");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("make fake executable");

        let tasks = prepare_tasks(&generated_files(), "Pessoa", "Área", "Sprint");
        let mut progress = Vec::new();
        let (ids, error) = create_azure_tasks_with_program(
            &tasks[..2],
            "https://dev.azure.com/org",
            "Projeto",
            Some(900),
            script.to_str().expect("script path"),
            |message, current, total| progress.push((message.to_owned(), current, total)),
        )
        .await;

        assert_eq!(ids, vec![101, 102]);
        assert!(error.is_none());
        assert_eq!(
            progress
                .iter()
                .map(|(_, current, total)| (*current, *total))
                .collect::<Vec<_>>(),
            [
                (0, 2),
                (0, 2),
                (0, 2),
                (0, 2),
                (1, 2),
                (1, 2),
                (1, 2),
                (2, 2)
            ]
        );
        assert!(progress[0].0.contains("Validando item pai #900"));
        assert!(progress[3].0.contains("Tarefa #101 criada; vinculando"));
        assert!(progress[4].0.contains("Tarefa #101 concluída"));
        assert!(progress[6].0.contains("Tarefa #102 criada; vinculando"));
        let calls = fs::read_to_string(args_log).expect("read args log");
        let calls = calls.lines().collect::<Vec<_>>();
        assert_eq!(calls.len(), 5);
        assert!(calls[0].starts_with("CALL <boards> <work-item> <show>"));
        assert!(calls[0].contains("<--fields>"));
        assert!(calls[0].contains("<--expand> <none>"));
        assert!(calls[1].starts_with("CALL <boards> <work-item> <create>"));
        assert!(calls[2].starts_with("CALL <boards> <work-item> <relation> <add>"));
        assert!(calls[2].contains("<--id> <101>"));
        assert!(calls[2].contains("<--target-id> <900>"));
        assert!(!calls[2].contains("<--project>"));
        assert!(calls[3].starts_with("CALL <boards> <work-item> <create>"));
        assert!(calls[4].starts_with("CALL <boards> <work-item> <relation> <add>"));
        assert!(calls[4].contains("<--id> <102>"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn azure_adapter_rejects_a_task_parent_before_creating_children() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temp directory");
        let script = directory.path().join("fake-az");
        let args_log = directory.path().join("args.log");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf 'CALL' >> '{args_log}'\nprintf ' <%s>' \"$@\" >> '{args_log}'\nprintf '\\n' >> '{args_log}'\nprintf '%s' '{{\"id\":900,\"fields\":{{\"System.Id\":900,\"System.Title\":\"Task existente\",\"System.WorkItemType\":\"Task\",\"System.TeamProject\":\"Projeto\"}}}}'\n",
                args_log = args_log.display(),
            ),
        )
        .expect("write fake Azure CLI");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("make fake executable");

        let tasks = prepare_tasks(&generated_files(), "Pessoa", "Área", "Sprint");
        let (ids, error) = create_azure_tasks_with_program(
            &tasks,
            "https://dev.azure.com/org",
            "Projeto",
            Some(900),
            script.to_str().expect("script path"),
            |_, _, _| {},
        )
        .await;

        assert!(ids.is_empty());
        let error = error.expect("parent validation should fail");
        assert!(error.contains("nenhuma tarefa foi criada"));
        assert!(error.contains("também é uma Task"));
        let calls = fs::read_to_string(args_log).expect("read args log");
        assert_eq!(calls.lines().count(), 1);
        assert!(calls.starts_with("CALL <boards> <work-item> <show>"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn azure_adapter_preserves_the_created_id_when_parent_linking_fails() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temp directory");
        let script = directory.path().join("fake-az");
        let args_log = directory.path().join("args.log");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf 'CALL' >> '{args_log}'\nprintf ' <%s>' \"$@\" >> '{args_log}'\nprintf '\\n' >> '{args_log}'\ncase \"$3\" in\n  show) printf '%s' '{{\"id\":900,\"fields\":{{\"System.Id\":900,\"System.WorkItemType\":\"Product Backlog Item\",\"System.TeamProject\":\"Projeto\"}}}}' ;;\n  create) printf '%s' '{{\"id\":201}}' ;;\n  relation) printf '%s' 'vínculo negado' >&2; exit 42 ;;\n  *) exit 64 ;;\nesac\n",
                args_log = args_log.display(),
            ),
        )
        .expect("write fake Azure CLI");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("make fake executable");

        let mut tasks = prepare_tasks(&generated_files(), "Pessoa", "Área", "Sprint");
        tasks[1].title = "Segunda não chamada".to_owned();
        let mut progress = Vec::new();
        let (ids, error) = create_azure_tasks_with_program(
            &tasks[..2],
            "https://dev.azure.com/org",
            "Projeto",
            Some(900),
            script.to_str().expect("script path"),
            |message, current, total| progress.push((message.to_owned(), current, total)),
        )
        .await;

        assert_eq!(ids, vec![201]);
        assert!(
            progress
                .iter()
                .all(|(_, current, total)| *current == 0 && *total == 2)
        );
        assert!(
            progress
                .last()
                .unwrap()
                .0
                .contains("Falha ao vincular a tarefa #201")
        );
        let error = error.expect("link error should be reported");
        assert!(error.contains("#201"));
        assert!(error.contains("foi criada, mas não pôde ser vinculada"));
        assert!(error.contains("vínculo negado"));
        let calls = fs::read_to_string(args_log).expect("read args log");
        assert_eq!(calls.lines().count(), 3);
        assert!(!calls.contains("Segunda não chamada"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn azure_adapter_resolves_numeric_destinations_once_before_creating_tasks() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temp directory");
        let script = directory.path().join("fake-az");
        let create_counter = directory.path().join("create-counter");
        let args_log = directory.path().join("args.log");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf 'CALL' >> '{args_log}'\nprintf ' <%s>' \"$@\" >> '{args_log}'\nprintf '\\n' >> '{args_log}'\ncase \"$2:$3:$4\" in\n  area:project:show) printf '%s' '[{{\"id\":1333,\"name\":\"Dívida\",\"path\":\"\\\\\\\\Projeto\\\\Area\\\\Dívida\",\"structureType\":\"area\"}}]' ;;\n  iteration:project:show) printf '%s' '[{{\"id\":1371,\"name\":\"Sprint 1\",\"path\":\"\\\\\\\\Projeto\\\\Iteration\\\\Dívida\\\\Sprint 1\",\"structureType\":\"iteration\"}}]' ;;\n  work-item:create:*) count=0; [ -f '{create_counter}' ] && count=$(cat '{create_counter}'); count=$((count + 1)); printf '%s' \"$count\" > '{create_counter}'; printf '{{\"id\":%s}}' \"$((100 + count))\" ;;\n  *) exit 64 ;;\nesac\n",
                args_log = args_log.display(),
                create_counter = create_counter.display(),
            ),
        )
        .expect("write fake Azure CLI");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("make fake executable");

        let tasks = prepare_tasks(&generated_files(), "Pessoa", "1333", "1371");
        let (ids, error) = create_azure_tasks_with_program(
            &tasks[..2],
            "https://dev.azure.com/org",
            "Projeto",
            None,
            script.to_str().expect("script path"),
            |_, _, _| {},
        )
        .await;

        assert_eq!(ids, vec![101, 102]);
        assert!(error.is_none());
        assert_eq!(tasks[0].area_id, "1333", "delivery task must not change");
        assert_eq!(tasks[0].sprint_id, "1371", "delivery task must not change");

        let calls = fs::read_to_string(args_log).expect("read args log");
        let calls = calls.lines().collect::<Vec<_>>();
        assert_eq!(calls.len(), 4);
        assert!(calls[0].starts_with("CALL <boards> <area> <project> <show>"));
        assert!(calls[1].starts_with("CALL <boards> <iteration> <project> <show>"));
        assert!(calls[2].starts_with("CALL <boards> <work-item> <create>"));
        assert!(calls[2].contains("<--area> <Projeto\\Dívida>"));
        assert!(calls[2].contains("<--iteration> <Projeto\\Dívida\\Sprint 1>"));
        assert!(calls[3].starts_with("CALL <boards> <work-item> <create>"));
        assert!(calls[3].contains("<--area> <Projeto\\Dívida>"));
        assert!(calls[3].contains("<--iteration> <Projeto\\Dívida\\Sprint 1>"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn azure_adapter_rejects_a_wrong_classification_type_before_creating_tasks() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temp directory");
        let script = directory.path().join("fake-az");
        let args_log = directory.path().join("args.log");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf 'CALL' >> '{args_log}'\nprintf ' <%s>' \"$@\" >> '{args_log}'\nprintf '\\n' >> '{args_log}'\nprintf '%s' '[{{\"id\":1333,\"name\":\"Sprint errada\",\"path\":\"\\\\\\\\Projeto\\\\Iteration\\\\Sprint errada\",\"structureType\":\"iteration\"}}]'\n",
                args_log = args_log.display(),
            ),
        )
        .expect("write fake Azure CLI");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("make fake executable");

        let tasks = prepare_tasks(&generated_files(), "Pessoa", "1333", "1371");
        let (ids, error) = create_azure_tasks_with_program(
            &tasks,
            "https://dev.azure.com/org",
            "Projeto",
            None,
            script.to_str().expect("script path"),
            |_, _, _| {},
        )
        .await;

        assert!(ids.is_empty());
        let error = error.expect("classification type error should be reported");
        assert!(error.contains("nenhuma tarefa foi criada"));
        assert!(error.contains("Área #1333"));
        assert!(error.contains("iteration"));
        let calls = fs::read_to_string(args_log).expect("read args log");
        assert_eq!(calls.lines().count(), 1);
        assert!(calls.starts_with("CALL <boards> <area> <project> <show>"));
        assert!(!calls.contains("<work-item> <create>"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn azure_adapter_preserves_partial_ids_and_never_evaluates_arguments() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temp directory");
        let script = directory.path().join("fake-az");
        let counter = directory.path().join("counter");
        let args_log = directory.path().join("args.log");
        let sentinel = directory.path().join("must-not-exist");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\ncount=0\n[ -f '{counter}' ] && count=$(cat '{counter}')\ncount=$((count + 1))\nprintf '%s' \"$count\" > '{counter}'\nprintf '%s\\n' \"$@\" >> '{args_log}'\nif [ \"$count\" -eq 1 ]; then printf '%s' '{{\"id\":101}}'; else printf '%s' '{{}}'; fi\n",
                counter = counter.display(),
                args_log = args_log.display(),
            ),
        )
        .expect("write fake Azure CLI");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("make fake executable");

        let mut tasks = prepare_tasks(&generated_files(), "Pessoa", "Área", "Sprint");
        tasks[0].title = format!("Primeira $(touch {})", sentinel.display());
        tasks[1].title = "Segunda sem ID".to_owned();
        tasks[2].title = "Terceira não chamada".to_owned();

        let (ids, error) = create_azure_tasks_with_program(
            &tasks,
            "https://dev.azure.com/org",
            "Projeto",
            None,
            script.to_str().expect("script path"),
            |_, _, _| {},
        )
        .await;

        assert_eq!(ids, vec![101]);
        assert!(
            error
                .expect("partial Azure error")
                .contains("Segunda sem ID")
        );
        assert_eq!(fs::read_to_string(counter).expect("read call count"), "2");
        assert!(
            !sentinel.exists(),
            "arguments must never be evaluated by a shell"
        );
        let args = fs::read_to_string(args_log).expect("read args log");
        assert!(args.contains("Primeira $(touch"));
        assert!(!args.contains("Terceira não chamada"));
    }
}
