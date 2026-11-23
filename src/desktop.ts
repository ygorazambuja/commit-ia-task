import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
	AiModelCatalog,
	AiProvider,
	AnalyzeAzureTaskInput,
	AzureTasksSnapshot,
	AzureUserIdentity,
	CardAnalysis,
	GenerationInput,
	GenerationProgress,
	GenerationResult,
	IdentifyAzureUserInput,
	InitialState,
	PromptSettings,
	RepositoryInspection,
	SaveAppSettingsInput,
	SaveAppSettingsResult,
	TimeLogBatchResult,
	TimeLogInput,
} from "./types";

export const listAiModels = (provider: AiProvider, apiKey?: string) =>
	invoke<AiModelCatalog>("list_ai_models", {
		provider,
		...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
	});

export const getInitialState = () => invoke<InitialState>("get_initial_state");

export const getAzureTasks = () =>
	invoke<AzureTasksSnapshot>("get_azure_tasks");

export const refreshAzureTasks = () =>
	invoke<AzureTasksSnapshot>("refresh_azure_tasks");

export const markAzureNotificationsRead = () =>
	invoke<AzureTasksSnapshot>("mark_azure_notifications_read");

export const analyzeAzureTask = (input: AnalyzeAzureTaskInput) =>
	invoke<CardAnalysis>("analyze_azure_task", { input });

export const onAzureTasksUpdated = (
	handler: (snapshot: AzureTasksSnapshot) => void,
): Promise<UnlistenFn> =>
	listen<AzureTasksSnapshot>("azure-tasks-updated", ({ payload }) => {
		handler(payload);
	});

export const identifyAzureUser = (input: IdentifyAzureUserInput) =>
	invoke<AzureUserIdentity>("identify_azure_user", {
		organization: input.organization,
		pat: input.pat,
	});

export const saveAppSettings = (input: SaveAppSettingsInput) =>
	invoke<SaveAppSettingsResult>("save_app_settings", { input });

export const savePromptSettings = (input: PromptSettings) =>
	invoke<PromptSettings>("save_prompt_settings", { input });

export const inspectRepository = (repositoryPath: string) =>
	invoke<RepositoryInspection>("inspect_repository", { repositoryPath });

export const runGeneration = (input: GenerationInput) =>
	invoke<GenerationResult>("run_generation", { input });

export const chooseRepository = () =>
	invoke<string | null>("choose_repository");

export const openCsvFile = (csvPath: string) =>
	invoke<void>("reveal_generated_csv", { csvPath });

export const createTimeLog = (input: TimeLogInput) =>
	invoke<TimeLogBatchResult>("create_time_log", { input });

export const onGenerationProgress = (
	handler: (progress: GenerationProgress) => void,
): Promise<UnlistenFn> =>
	listen<GenerationProgress>("generation-progress", ({ payload }) => {
		handler(payload);
	});
