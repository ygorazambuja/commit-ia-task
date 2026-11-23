import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	analyzeAzureTask,
	chooseRepository,
	createTimeLog,
	getAzureTasks,
	getInitialState,
	identifyAzureUser,
	inspectRepository,
	listAiModels,
	markAzureNotificationsRead,
	onAzureTasksUpdated,
	onGenerationProgress,
	openCsvFile,
	refreshAzureTasks,
	runGeneration,
	saveAppSettings,
	savePromptSettings,
} from "./desktop";
import type {
	AzureTasksSnapshot,
	GenerationInput,
	GenerationProgress,
	PromptSettings,
	TimeLogInput,
} from "./types";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(),
}));

const input: GenerationInput = {
	repositoryPath: "/repo",
	sprintId: "Sprint",
	areaPathId: "Área",
	assignedTo: "Pessoa",
	itemContrato: "Item 1",
	aiProvider: "codex",
	openaiModel: "gpt-5-nano",
	codexModel: "gpt-5.6-luna",
	codexReasoningEffort: "low",
	createAzureTasks: false,
	registerTimeLog: false,
	timeLogStartDate: "2026-08-12",
	timeLogEndDate: "2026-08-12",
	azureOrganization: "",
	azureProject: "",
};

const timeLogInput: TimeLogInput = {
	workItemId: 201878,
	startDate: "2026-08-12",
	endDate: "2026-08-14",
	work: [
		{
			minutes: 150,
			type: "Frontend",
			comment: "Implementei a cotação",
		},
		{
			minutes: 60,
			type: "Teste",
			comment: "Validei a cotação",
		},
	],
	organization: "https://dev.azure.com/empresa",
	credential: "session-secret",
	credentialKind: "pat",
};

describe("desktop bridge", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockResolvedValue(undefined);
		vi.mocked(listen).mockResolvedValue(vi.fn());
	});

	test("consulta tarefas e solicita análise sem enviar credenciais pela UI", async () => {
		await getAzureTasks();
		await refreshAzureTasks();
		await markAzureNotificationsRead();
		await analyzeAzureTask({ workItemId: 123, repositoryPath: "/repo" });
		expect(invoke).toHaveBeenNthCalledWith(1, "get_azure_tasks");
		expect(invoke).toHaveBeenNthCalledWith(2, "refresh_azure_tasks");
		expect(invoke).toHaveBeenNthCalledWith(3, "mark_azure_notifications_read");
		expect(invoke).toHaveBeenNthCalledWith(4, "analyze_azure_task", {
			input: { workItemId: 123, repositoryPath: "/repo" },
		});
	});

	test("encaminha snapshots do monitor e retorna a limpeza do listener", async () => {
		const snapshot: AzureTasksSnapshot = {
			items: [],
			notifications: [],
			status: "ready",
			message: null,
			lastCheckedAt: null,
		};
		const stop = vi.fn();
		vi.mocked(listen).mockImplementationOnce(async (_event, listener) => {
			listener({ event: "azure-tasks-updated", id: 1, payload: snapshot });
			return stop;
		});
		const handler = vi.fn();
		expect(await onAzureTasksUpdated(handler)).toBe(stop);
		expect(listen).toHaveBeenCalledWith(
			"azure-tasks-updated",
			expect.any(Function),
		);
		expect(handler).toHaveBeenCalledWith(snapshot);
	});

	test("consulta modelos com chave apenas quando informada", async () => {
		await listAiModels("openai", " temporary-key ");
		expect(invoke).toHaveBeenLastCalledWith("list_ai_models", {
			provider: "openai",
			apiKey: "temporary-key",
		});
		await listAiModels("codex");
		expect(invoke).toHaveBeenLastCalledWith("list_ai_models", {
			provider: "codex",
		});
	});

	test("usa os comandos e argumentos esperados pelo backend Rust", async () => {
		await getInitialState();
		await identifyAzureUser({
			organization: "https://dev.azure.com/InfortechMS",
			pat: "pat-secreto",
		});
		await saveAppSettings({
			displayName: "Ygor Azambuja",
			email: "ygor.azambuja@infortechms.com.br",
			azureOrganization: "https://dev.azure.com/InfortechMS",
			azureProject: "SPF-SIAFIC",
			aiProvider: "codex",
			openaiModel: "gpt-5-nano",
			codexModel: "gpt-5.6-luna",
			codexReasoningEffort: "low",
			timeLogPat: "pat-secreto",
			removeTimeLogPat: false,
		});
		await chooseRepository();
		await inspectRepository("/repo");
		await runGeneration(input);
		await openCsvFile("/repo/tasks-1-1-1-1.csv");
		await createTimeLog(timeLogInput);

		expect(invoke).toHaveBeenNthCalledWith(1, "get_initial_state");
		expect(invoke).toHaveBeenNthCalledWith(2, "identify_azure_user", {
			organization: "https://dev.azure.com/InfortechMS",
			pat: "pat-secreto",
		});
		expect(invoke).toHaveBeenNthCalledWith(3, "save_app_settings", {
			input: {
				displayName: "Ygor Azambuja",
				email: "ygor.azambuja@infortechms.com.br",
				azureOrganization: "https://dev.azure.com/InfortechMS",
				azureProject: "SPF-SIAFIC",
				aiProvider: "codex",
				openaiModel: "gpt-5-nano",
				codexModel: "gpt-5.6-luna",
				codexReasoningEffort: "low",
				timeLogPat: "pat-secreto",
				removeTimeLogPat: false,
			},
		});
		expect(invoke).toHaveBeenNthCalledWith(4, "choose_repository");
		expect(invoke).toHaveBeenNthCalledWith(5, "inspect_repository", {
			repositoryPath: "/repo",
		});
		expect(invoke).toHaveBeenNthCalledWith(6, "run_generation", { input });
		expect(invoke).toHaveBeenNthCalledWith(7, "reveal_generated_csv", {
			csvPath: "/repo/tasks-1-1-1-1.csv",
		});
		expect(invoke).toHaveBeenNthCalledWith(8, "create_time_log", {
			input: timeLogInput,
		});
	});

	test("salva e retorna o prompt pela fronteira tipada sem alterar seu conteúdo", async () => {
		const settings: PromptSettings = {
			systemPrompt: "  Analise as alterações.\nGere tarefas em português.\n",
		};
		vi.mocked(invoke).mockResolvedValueOnce(settings);

		expect(await savePromptSettings(settings)).toEqual(settings);
		expect(invoke).toHaveBeenCalledWith("save_prompt_settings", {
			input: settings,
		});
	});

	test("converte o evento Tauri em callback de progresso", async () => {
		const progress: GenerationProgress = {
			phase: "generating",
			message: "Processando",
			current: 1,
			total: 2,
			activeFiles: ["src/App.tsx", "src/novo.ts"],
		};
		const handler = vi.fn();
		vi.mocked(listen).mockImplementation(async (_event, listener) => {
			listener({
				event: "generation-progress",
				id: 1,
				payload: progress,
			});
			return () => undefined;
		});

		await onGenerationProgress(handler);

		expect(listen).toHaveBeenCalledWith(
			"generation-progress",
			expect.any(Function),
		);
		expect(handler).toHaveBeenCalledWith(progress);
	});
});
