mod ai;
mod azure_boards;
mod azure_tasks;
mod card_analysis;
pub mod cli;
mod commands;
mod config;
mod export;
mod git;
mod models;
mod process;
pub mod time_log;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = fix_path_env::fix();
    tauri::Builder::default()
        .manage(commands::GeneratedCsvRegistry::default())
        .manage(azure_tasks::AzureTasksMonitor::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            azure_tasks::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            azure_tasks::get_azure_tasks,
            azure_tasks::refresh_azure_tasks,
            azure_tasks::mark_azure_notifications_read,
            azure_tasks::analyze_azure_task,
            commands::get_initial_state,
            commands::list_ai_models,
            commands::identify_azure_user,
            commands::choose_repository,
            commands::create_time_log,
            commands::inspect_repository,
            commands::reveal_generated_csv,
            commands::run_generation,
            commands::save_app_settings,
            commands::save_prompt_settings,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Infortech Automation");
}
