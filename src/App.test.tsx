import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import App from "./App";
import * as desktop from "./desktop";
import TimeLogPanel from "./TimeLogPanel";
import type {
	AiModelCatalog,
	AzureTasksSnapshot,
	GenerationProgress,
	GenerationResult,
	InitialState,
	PromptSettings,
	RepositoryInspection,
	TimeLogBatchResult,
} from "./types";

vi.mock("./desktop", () => ({
	analyzeAzureTask: vi.fn(),
	getAzureTasks: vi.fn(),
	refreshAzureTasks: vi.fn(),
	markAzureNotificationsRead: vi.fn(),
	onAzureTasksUpdated: vi.fn(),
	chooseRepository: vi.fn(),
	createTimeLog: vi.fn(),
	getInitialState: vi.fn(),
	identifyAzureUser: vi.fn(),
	inspectRepository: vi.fn(),
	listAiModels: vi.fn(),
	onGenerationProgress: vi.fn(),
	openCsvFile: vi.fn(),
	runGeneration: vi.fn(),
	saveAppSettings: vi.fn(),
	savePromptSettings: vi.fn(),
}));

const openaiPendingMessage =
	"Informe uma chave OpenAI para esta execução ou configure OPENAI_API_KEY no ambiente.";
const codexPendingMessage =
	"O Codex CLI não está disponível ou autenticado. Instale e execute codex login antes de continuar.";

const aiProviders = [
	{
		id: "openai",
		displayName: "OpenAI",
		description: "Descrição OpenAI vinda do backend",
		models: [
			{ value: "gpt-6-luna", label: "Luna 6 do catálogo" },
			{ value: "gpt-6-sol", label: "Sol 6 do catálogo" },
			{ value: "gpt-6-astra", label: "Astra 6 do catálogo" },
			{ value: "gpt-5-nano", label: "Nano do catálogo" },
			{ value: "gpt-5-mini", label: "Mini do catálogo" },
			{ value: "gpt-5", label: "Completo do catálogo" },
		],
		defaultModel: "gpt-6-luna",
		reasoningEfforts: [],
		allowsApiKeyInput: true,
		ready: true,
		statusDetail: "Ambiente pronto pelo backend",
		pendingMessage: openaiPendingMessage,
	},
	{
		id: "codex",
		displayName: "Codex",
		description: "Descrição Codex vinda do backend",
		models: [
			{ value: "gpt-6-luna", label: "Luna 6 do catálogo" },
			{ value: "gpt-6-sol", label: "Sol 6 do catálogo" },
			{ value: "gpt-6-astra", label: "Astra 6 do catálogo" },
			{ value: "gpt-5.6-luna", label: "Luna do catálogo" },
			{ value: "gpt-5.6-terra", label: "Terra do catálogo" },
			{ value: "gpt-5.6-sol", label: "Sol do catálogo" },
		],
		defaultModel: "gpt-6-luna",
		reasoningEfforts: [
			{ value: "low", label: "Baixo do catálogo" },
			{ value: "medium", label: "Médio do catálogo" },
			{ value: "high", label: "Alto do catálogo" },
			{ value: "xhigh", label: "Extra alto do catálogo" },
		],
		defaultReasoningEffort: "low",
		allowsApiKeyInput: false,
		ready: true,
		statusDetail: "codex backend 1.0",
		pendingMessage: codexPendingMessage,
	},
] as InitialState["aiProviders"];

for (const provider of aiProviders) {
	provider.models = provider.models.map((model) => ({
		...model,
		reasoningEfforts: provider.reasoningEfforts,
		defaultReasoningEffort: provider.defaultReasoningEffort ?? null,
		compatibilityVerified: true,
	}));
}

const configuredState: InitialState = {
	config: {
		repositoryPath: "/workspace/projeto",
		sprintId: "Projeto\\Sprint 1",
		areaPathId: "Projeto\\Produto",
		assignedTo: "Pessoa <pessoa@infortechms.com.br>",
		itemContrato: "Item 1",
		aiProvider: "openai",
		openaiModel: "gpt-5-nano",
		codexModel: "gpt-5.6-luna",
		codexReasoningEffort: "low",
		azureOrganization: "",
		azureProject: "",
	},
	aiProviders,
	openaiConfigured: true,
	codexAvailable: true,
	codexAuthenticated: true,
	codexVersion: "codex 1.0",
	azureDefaults: {
		organization: "https://dev.azure.com/empresa",
		project: "Projeto",
	},
	requiresOnboarding: false,
	profile: {
		displayName: "Pessoa",
		email: "pessoa@infortechms.com.br",
	},
	timeLogPatConfigured: false,
	promptSettings: {
		systemPrompt: "Instruções salvas para gerar tarefas em português.",
	},
	defaultSystemPrompt: "Instruções padrão para analisar as alterações Git.",
	warnings: [],
};

const onboardingState: InitialState = {
	...configuredState,
	config: {
		...configuredState.config,
		assignedTo: "Ygor Azambuja <ygor.azambuja@infortechms.com.br>",
		aiProvider: "codex",
		azureOrganization: "",
		azureProject: "",
	},
	azureDefaults: {
		organization: "https://dev.azure.com/InfortechMS",
		project: "SPF-SIAFIC",
	},
	requiresOnboarding: true,
	profile: {
		displayName: "Ygor Azambuja",
		email: "ygor.azambuja@infortechms.com.br",
	},
};

const inspection: RepositoryInspection = {
	repositoryPath: "/workspace/projeto",
	files: [
		{ path: "src/App.tsx", kind: "modified" },
		{ path: "src/novo.ts", kind: "new" },
	],
};

const generationResult: GenerationResult = {
	repositoryPath: "/workspace/projeto",
	files: [
		{
			fullFilePath: "/workspace/projeto/src/App.tsx",
			relativePath: "src/App.tsx",
			staged: true,
			tasks: [
				{
					title: "Criar interface desktop",
					description: "Implementa o fluxo visual da aplicação.",
					tipo: "FRONTEND",
					complexidade: "MEDIA",
					estimateMade: 3,
				},
			],
		},
	],
	failures: [],
	csvPath: "/workspace/projeto/tasks-27-7-10-30.csv",
	azureTaskIds: [321],
	warnings: [],
};

const timeLogBatchResult: TimeLogBatchResult = {
	plan: {
		workItemId: 201878,
		requestedMinutes: 150,
		scheduledMinutes: 150,
		missingMinutes: 0,
		days: [
			{
				date: "2026-08-12",
				existingMinutes: 60,
				newMinutes: 150,
				totalMinutes: 210,
				entries: [
					{
						date: "2026-08-12",
						minutes: 150,
						type: "Reunião",
						comment: "Implementei a integração visual",
					},
				],
			},
		],
	},
	created: [
		{
			entry: {
				date: "2026-08-12",
				minutes: 150,
				type: "Reunião",
				comment: "Implementei a integração visual",
			},
			documentId: "documento-1",
		},
	],
	pending: [],
	postAttempts: 1,
	retryable: false,
};

beforeEach(() => {
	vi.mocked(desktop.getAzureTasks).mockResolvedValue({
		items: [],
		notifications: [],
		status: "unconfigured",
		message: null,
		lastCheckedAt: null,
	});
	vi.mocked(desktop.onAzureTasksUpdated).mockResolvedValue(() => undefined);
	vi.mocked(desktop.listAiModels).mockImplementation(async (provider) => ({
		models: aiProviders.find((p) => p.id === provider)?.models ?? [],
		source: "provider",
		warnings: [],
	}));
	vi.mocked(desktop.getInitialState).mockResolvedValue(configuredState);
	vi.mocked(desktop.inspectRepository).mockResolvedValue(inspection);
	vi.mocked(desktop.chooseRepository).mockResolvedValue(null);
	vi.mocked(desktop.createTimeLog).mockResolvedValue(timeLogBatchResult);
	vi.mocked(desktop.identifyAzureUser).mockResolvedValue({
		displayName: "Pessoa",
		email: "pessoa@infortechms.com.br",
	});
	vi.mocked(desktop.runGeneration).mockResolvedValue(generationResult);
	vi.mocked(desktop.openCsvFile).mockResolvedValue(undefined);
	vi.mocked(desktop.onGenerationProgress).mockResolvedValue(() => undefined);
	vi.mocked(desktop.saveAppSettings).mockResolvedValue({
		config: configuredState.config,
		profile: configuredState.profile,
		timeLogPatConfigured: false,
		warnings: [],
	});
	vi.mocked(desktop.savePromptSettings).mockImplementation(
		async (input) => input,
	);
});

describe("App", () => {
	test("recebe avisos fora de Minhas tarefas e preserva o plano ao alternar abas e configurações", async () => {
		const user = userEvent.setup();
		let publish: ((snapshot: AzureTasksSnapshot) => void) | undefined;
		vi.mocked(desktop.onAzureTasksUpdated).mockImplementationOnce(
			async (handler) => {
				publish = handler;
				return () => undefined;
			},
		);
		vi.mocked(desktop.chooseRepository).mockResolvedValueOnce(
			"/workspace/receitas",
		);
		vi.mocked(desktop.analyzeAzureTask).mockResolvedValueOnce({
			summary: "Plano para validar receitas.",
			acceptanceCriteria: [],
			relevantFiles: [],
			implementationPlan: [],
			testPlan: [],
			risks: [],
			openQuestions: [],
			warnings: [],
		});
		render(<App />);
		await screen.findByText("src/novo.ts");
		const myTasksTab = screen.getByRole("tab", { name: "Minhas tarefas" });
		act(() =>
			publish?.({
				status: "ready",
				message: null,
				lastCheckedAt: "2026-10-09T16:00:00Z",
				items: [
					{
						id: 123,
						revision: 1,
						title: "Validar receitas",
						workItemType: "Task",
						state: "To Do",
						assignedTo: "Pessoa",
						changedDate: "2026-10-09T16:00:00Z",
						iterationPath: "Sprint 1",
						areaPath: "Produto",
						url: "https://dev.azure.com/empresa/Projeto/_workitems/edit/123",
						priority: 1,
						canAnalyze: true,
					},
				],
				notifications: [
					{
						id: "123-1",
						workItemId: 123,
						title: "Validar receitas",
						message: "Nova atribuição",
						createdAt: "2026-10-09T16:00:00Z",
						read: false,
					},
				],
			}),
		);
		expect(myTasksTab).toHaveAccessibleDescription("1 notificações não lidas");
		await user.click(myTasksTab);
		await user.click(
			screen.getByRole("button", { name: "Fazer análise do card #123" }),
		);
		await screen.findByText("Plano para validar receitas.");
		await user.click(screen.getByRole("tab", { name: "Prompts" }));
		await user.click(myTasksTab);
		expect(screen.getByText("Plano para validar receitas.")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Configurações" }));
		await user.click(screen.getByRole("button", { name: "Cancelar" }));
		expect(screen.getByText("Plano para validar receitas.")).toBeVisible();
		expect(desktop.onAzureTasksUpdated).toHaveBeenCalledOnce();
	});
	test("mostra spinners enquanto verifica os provedores", async () => {
		let finishBootstrap: ((state: InitialState) => void) | undefined;
		vi.mocked(desktop.getInitialState).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishBootstrap = resolve;
				}),
		);

		render(<App />);

		const providerStatus = screen.getByTitle("Provedores: Verificando…");
		expect(
			screen.queryByLabelText("Instruções de geração"),
		).not.toBeInTheDocument();
		expect(
			providerStatus.querySelector('[data-slot="spinner"]'),
		).toBeInTheDocument();

		await act(async () => finishBootstrap?.(configuredState));
		await screen.findByText("src/novo.ts");
		expect(
			screen.getByTitle("OpenAI: Ambiente pronto pelo backend"),
		).toBeVisible();
		expect(screen.getByTitle("Codex: codex backend 1.0")).toBeVisible();
		expect(screen.getByText("Descrição OpenAI vinda do backend")).toBeVisible();
		expect(screen.getByText("Descrição Codex vinda do backend")).toBeVisible();
	});

	test("expõe abas e painéis relacionados e preserva o formulário ao alternar por clique", async () => {
		const user = userEvent.setup();
		render(<App />);

		await screen.findByText("src/novo.ts");
		expect(
			screen.getByRole("tablist", { name: "Funcionalidades" }),
		).toBeVisible();
		const taskTab = screen.getByRole("tab", { name: "Gerar tarefas" });
		const timeLogTab = screen.getByRole("tab", { name: "Registrar horas" });
		const promptsTab = screen.getByRole("tab", { name: "Prompts" });
		const helpTab = screen.getByRole("tab", { name: "Ajuda" });
		const myTasksTab = screen.getByRole("tab", { name: "Minhas tarefas" });
		expect(screen.getAllByRole("tab")).toEqual([
			taskTab,
			timeLogTab,
			promptsTab,
			myTasksTab,
			helpTab,
		]);
		const panels = screen.getAllByRole("tabpanel", { hidden: true });
		expect(panels).toHaveLength(5);
		const taskPanel = panels.find(
			(panel) => panel.id === "task-generation-panel",
		);
		const timeLogPanel = panels.find(
			(panel) => panel.id === "time-log-feature-panel",
		);
		const promptsPanel = panels.find(
			(panel) => panel.id === "prompts-feature-panel",
		);
		const helpPanel = panels.find((panel) => panel.id === "help-feature-panel");

		expect(taskPanel).toBeDefined();
		expect(timeLogPanel).toBeDefined();
		expect(promptsPanel).toBeDefined();
		expect(helpPanel).toBeDefined();
		expect(taskTab).toHaveAttribute("aria-controls", taskPanel?.id);
		expect(taskPanel).toHaveAttribute("aria-labelledby", taskTab.id);
		expect(timeLogTab).toHaveAttribute("aria-controls", timeLogPanel?.id);
		expect(timeLogPanel).toHaveAttribute("aria-labelledby", timeLogTab.id);
		expect(promptsTab).toHaveAttribute("aria-controls", promptsPanel?.id);
		expect(promptsTab).toHaveAttribute("id", "prompts-tab");
		expect(promptsPanel).toHaveAttribute("aria-labelledby", promptsTab.id);
		expect(helpTab).toHaveAttribute("aria-controls", helpPanel?.id);
		expect(helpPanel).toHaveAttribute("aria-labelledby", helpTab.id);

		expect(taskTab).toHaveAttribute("aria-selected", "true");
		expect(taskTab).toHaveAttribute("tabindex", "0");
		expect(timeLogTab).toHaveAttribute("aria-selected", "false");
		expect(timeLogTab).toHaveAttribute("tabindex", "-1");
		expect(promptsTab).toHaveAttribute("aria-selected", "false");
		expect(promptsTab).toHaveAttribute("tabindex", "-1");
		expect(helpTab).toHaveAttribute("aria-selected", "false");
		expect(helpTab).toHaveAttribute("tabindex", "-1");
		expect(taskPanel).toBeVisible();
		expect(taskPanel).not.toHaveAttribute("hidden");
		expect(timeLogPanel).not.toBeVisible();
		expect(timeLogPanel).toHaveAttribute("hidden");
		expect(promptsPanel).not.toBeVisible();
		expect(promptsPanel).toHaveAttribute("hidden");
		expect(helpPanel).not.toBeVisible();
		expect(helpPanel).toHaveAttribute("hidden");

		await user.click(timeLogTab);
		expect(timeLogTab).toHaveAttribute("aria-selected", "true");
		expect(timeLogTab).toHaveAttribute("tabindex", "0");
		expect(taskTab).toHaveAttribute("tabindex", "-1");
		expect(taskPanel).not.toBeVisible();
		expect(taskPanel).toHaveAttribute("hidden");
		expect(timeLogPanel).toBeVisible();
		expect(timeLogPanel).not.toHaveAttribute("hidden");

		const workItemId = within(timeLogPanel as HTMLElement).getByLabelText(
			"ID do work item",
		);
		await user.type(workItemId, "201878");
		await user.click(taskTab);

		expect(taskTab).toHaveAttribute("aria-selected", "true");
		expect(taskPanel).toBeVisible();
		expect(timeLogPanel).not.toBeVisible();

		await user.click(timeLogTab);
		expect(timeLogPanel).toBeVisible();
		expect(workItemId).toHaveValue("201878");

		await user.click(helpTab);
		expect(helpTab).toHaveAttribute("aria-selected", "true");
		expect(helpTab).toHaveAttribute("tabindex", "0");
		expect(timeLogTab).toHaveAttribute("tabindex", "-1");
		expect(timeLogPanel).not.toBeVisible();
		expect(helpPanel).toBeVisible();
	});

	test("navega pelas abas com setas, wrap, Home e End", async () => {
		const user = userEvent.setup();
		render(<App />);

		await screen.findByText("src/novo.ts");
		const taskTab = screen.getByRole("tab", { name: "Gerar tarefas" });
		const timeLogTab = screen.getByRole("tab", { name: "Registrar horas" });
		const promptsTab = screen.getByRole("tab", { name: "Prompts" });
		const helpTab = screen.getByRole("tab", { name: "Ajuda" });

		taskTab.focus();
		await user.keyboard("{ArrowLeft}");
		expect(helpTab).toHaveFocus();
		expect(helpTab).toHaveAttribute("aria-selected", "true");
		expect(helpTab).toHaveAttribute("tabindex", "0");
		expect(taskTab).toHaveAttribute("tabindex", "-1");

		await user.keyboard("{ArrowRight}");
		expect(taskTab).toHaveFocus();
		expect(taskTab).toHaveAttribute("aria-selected", "true");

		await user.keyboard("{End}");
		expect(helpTab).toHaveFocus();
		expect(helpTab).toHaveAttribute("aria-selected", "true");

		await user.keyboard("{Home}");
		expect(taskTab).toHaveFocus();
		expect(taskTab).toHaveAttribute("aria-selected", "true");
		expect(timeLogTab).toHaveAttribute("aria-selected", "false");

		await user.keyboard("{ArrowRight}");
		expect(timeLogTab).toHaveFocus();
		await user.keyboard("{ArrowRight}");
		expect(promptsTab).toHaveFocus();
		expect(promptsTab).toHaveAttribute("aria-selected", "true");
		await user.keyboard("{ArrowRight}");
		expect(screen.getByRole("tab", { name: "Minhas tarefas" })).toHaveFocus();
		await user.keyboard("{ArrowRight}");
		expect(helpTab).toHaveFocus();
	});

	test("edita e salva as instruções preservando espaços e quebras de linha", async () => {
		const user = userEvent.setup();
		render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("tab", { name: "Prompts" }));

		const editor = screen.getByLabelText("Instruções de geração");
		const save = screen.getByRole("button", { name: "Salvar" });
		expect(editor).toHaveValue(configuredState.promptSettings.systemPrompt);
		expect(screen.getByText("Salvo", { exact: true })).toBeVisible();
		expect(save).toBeDisabled();

		const systemPrompt =
			"  Gere tarefas objetivas.\nMantenha o texto em português.\n";
		await user.clear(editor);
		await user.paste(systemPrompt);
		expect(screen.getByText("Alterações não salvas")).toBeVisible();
		expect(save).toBeEnabled();
		expect(desktop.savePromptSettings).not.toHaveBeenCalled();
		await user.click(save);

		await waitFor(() =>
			expect(desktop.savePromptSettings).toHaveBeenCalledWith({ systemPrompt }),
		);
		expect(await screen.findByText("Salvo", { exact: true })).toBeVisible();
		expect(editor).toHaveValue(systemPrompt);
		expect(save).toBeDisabled();
	});

	test("preserva as instruções salvas recebidas após reiniciar", async () => {
		const user = userEvent.setup();
		const savedPrompt = "Instruções personalizadas salvas no backend.";
		const firstRender = render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("tab", { name: "Prompts" }));
		await user.clear(screen.getByLabelText("Instruções de geração"));
		await user.paste(savedPrompt);
		await user.click(screen.getByRole("button", { name: "Salvar" }));
		await screen.findByText("Salvo", { exact: true });
		firstRender.unmount();
		vi.mocked(desktop.getInitialState).mockResolvedValueOnce({
			...configuredState,
			promptSettings: { systemPrompt: savedPrompt },
		});

		render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("tab", { name: "Prompts" }));
		expect(screen.getByLabelText("Instruções de geração")).toHaveValue(
			savedPrompt,
		);
		expect(screen.getByText("Salvo", { exact: true })).toBeVisible();
	});

	test("restaura somente o rascunho e descarta para a última versão salva", async () => {
		const user = userEvent.setup();
		render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("tab", { name: "Prompts" }));

		const editor = screen.getByLabelText("Instruções de geração");
		const restore = screen.getByRole("button", { name: "Restaurar padrão" });
		const discard = screen.getByRole("button", {
			name: "Descartar alterações",
		});
		expect(discard).toBeDisabled();
		await user.click(restore);
		expect(editor).toHaveValue(configuredState.defaultSystemPrompt);
		expect(screen.getByText("Alterações não salvas")).toBeVisible();
		expect(desktop.savePromptSettings).not.toHaveBeenCalled();

		await user.click(discard);
		expect(editor).toHaveValue(configuredState.promptSettings.systemPrompt);
		expect(screen.getByText("Salvo", { exact: true })).toBeVisible();
		await user.click(restore);
		await user.click(screen.getByRole("button", { name: "Salvar" }));
		await waitFor(() =>
			expect(desktop.savePromptSettings).toHaveBeenCalledWith({
				systemPrompt: configuredState.defaultSystemPrompt,
			}),
		);
		await screen.findByText("Salvo", { exact: true });
		await user.type(editor, " Rascunho novo.");
		await user.click(discard);
		expect(editor).toHaveValue(configuredState.defaultSystemPrompt);
	});

	test("desabilita os controles enquanto salva e preserva o rascunho se houver erro", async () => {
		const user = userEvent.setup();
		let rejectSave: ((error: string) => void) | undefined;
		vi.mocked(desktop.savePromptSettings).mockImplementationOnce(
			() =>
				new Promise<PromptSettings>((_resolve, reject) => {
					rejectSave = reject;
				}),
		);
		render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("tab", { name: "Prompts" }));

		const editor = screen.getByLabelText("Instruções de geração");
		const systemPrompt = "Não perder este rascunho.";
		await user.clear(editor);
		await user.type(editor, systemPrompt);
		await user.click(screen.getByRole("button", { name: "Salvar" }));

		const saving = screen.getByRole("button", { name: "Salvando…" });
		expect(saving).toBeDisabled();
		expect(editor).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Descartar alterações" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Restaurar padrão" }),
		).toBeDisabled();
		await user.click(saving);
		expect(desktop.savePromptSettings).toHaveBeenCalledOnce();
		await act(async () =>
			rejectSave?.("Não foi possível gravar prompts.json."),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Não foi possível gravar prompts.json.",
		);
		expect(editor).toHaveValue(systemPrompt);
		expect(editor).toBeEnabled();
		expect(screen.getByText("Alterações não salvas")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Salvar" }));
		await screen.findByText("Salvo", { exact: true });
		expect(desktop.savePromptSettings).toHaveBeenCalledTimes(2);
		expect(editor).toHaveValue(systemPrompt);
	});

	test("impede salvar instruções vazias ou contendo somente espaços", async () => {
		const user = userEvent.setup();
		render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("tab", { name: "Prompts" }));
		const editor = screen.getByLabelText("Instruções de geração");
		const save = screen.getByRole("button", { name: "Salvar" });

		await user.clear(editor);
		await user.click(save);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"As instruções não podem ficar vazias.",
		);
		expect(editor).toHaveAttribute("aria-invalid", "true");
		await user.type(editor, "  \n  ");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		await user.click(save);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"As instruções não podem ficar vazias.",
		);
		expect(desktop.savePromptSettings).not.toHaveBeenCalled();
	});

	test("preserva o rascunho ao alternar abas, editar configurações e gerar tarefas", async () => {
		const user = userEvent.setup();
		render(<App />);
		await screen.findByText("src/novo.ts");
		const promptsTab = screen.getByRole("tab", { name: "Prompts" });
		await user.click(promptsTab);
		const editor = screen.getByLabelText("Instruções de geração");
		const draft = "Rascunho pendente para a próxima geração.";
		await user.clear(editor);
		await user.paste(draft);

		await user.click(screen.getByRole("tab", { name: "Ajuda" }));
		expect(editor).not.toBeVisible();
		await user.click(promptsTab);
		expect(editor).toBeVisible();
		expect(editor).toHaveValue(draft);
		await user.click(screen.getByRole("button", { name: "Configurações" }));
		await user.click(screen.getByRole("button", { name: "Cancelar" }));
		expect(editor).toHaveValue(draft);

		await user.click(screen.getByRole("button", { name: "Configurações" }));
		await user.click(
			screen.getByRole("button", { name: "Salvar configurações" }),
		);
		await waitFor(() => expect(editor).toBeVisible());
		expect(editor).toHaveValue(draft);
		await user.click(screen.getByRole("tab", { name: "Gerar tarefas" }));
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));
		await screen.findByText("1 tarefa pronta");
		await user.click(promptsTab);
		expect(editor).toHaveValue(draft);
		expect(screen.getByText("Alterações não salvas")).toBeVisible();
		expect(desktop.savePromptSettings).not.toHaveBeenCalled();
	});

	test("exibe o aviso de recuperação dos prompts e permite editar o padrão recebido", async () => {
		const user = userEvent.setup();
		const warning =
			"Não foi possível carregar prompts.json. Usando o prompt padrão.";
		vi.mocked(desktop.getInitialState).mockResolvedValueOnce({
			...configuredState,
			promptSettings: { systemPrompt: configuredState.defaultSystemPrompt },
			warnings: [warning],
		});
		render(<App />);

		expect(await screen.findByRole("alert")).toHaveTextContent(warning);
		await user.click(screen.getByRole("tab", { name: "Prompts" }));
		expect(screen.getByLabelText("Instruções de geração")).toHaveValue(
			configuredState.defaultSystemPrompt,
		);
		expect(screen.getByText("Salvo", { exact: true })).toBeVisible();
	});

	test("explica quando o Azure CLI é necessário na ajuda", async () => {
		const user = userEvent.setup();
		render(<App />);

		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("tab", { name: "Ajuda" }));

		const helpPanel = document.getElementById("help-feature-panel");
		expect(helpPanel).toBeVisible();
		const azureCliQuestion = within(helpPanel as HTMLElement).getByRole(
			"button",
			{ name: "Preciso instalar o Azure CLI?" },
		);
		expect(azureCliQuestion).toHaveAttribute("aria-expanded", "true");
		expect(
			within(helpPanel as HTMLElement).getByText(
				/Não para gerar o CSV nem para registrar horas no Time Log Free/,
			),
		).toBeVisible();

		const directCreationQuestion = within(helpPanel as HTMLElement).getByRole(
			"button",
			{ name: "Como habilito a criação direta de tarefas?" },
		);
		expect(directCreationQuestion).toHaveAttribute("aria-expanded", "false");
		await user.click(directCreationQuestion);
		expect(directCreationQuestion).toHaveAttribute("aria-expanded", "true");
		expect(
			within(helpPanel as HTMLElement).getByText(
				"az extension add --name azure-devops",
			),
		).toBeVisible();
	});

	test("seleciona e inspeciona um repositório pela ponte desktop", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue({
			...configuredState,
			config: {
				...configuredState.config,
				repositoryPath: "",
			},
		});
		vi.mocked(desktop.chooseRepository).mockResolvedValue(
			"/workspace/selecionado",
		);
		vi.mocked(desktop.inspectRepository).mockResolvedValue({
			repositoryPath: "/workspace/selecionado",
			files: [{ path: "src/tarefa.ts", kind: "mixed" }],
		});

		render(<App />);

		await screen.findByText("Nenhum repositório selecionado");
		await user.click(screen.getByRole("button", { name: "Escolher pasta" }));

		expect(desktop.chooseRepository).toHaveBeenCalledOnce();
		expect(desktop.inspectRepository).toHaveBeenCalledWith(
			"/workspace/selecionado",
		);
		expect(await screen.findByText("/workspace/selecionado")).toBeVisible();
		expect(screen.getByText("src/tarefa.ts")).toBeVisible();
		expect(screen.getByText("Misto")).toBeVisible();
	});

	test("mostra toast quando o seletor de pastas falha", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue({
			...configuredState,
			config: { ...configuredState.config, repositoryPath: "" },
		});
		vi.mocked(desktop.chooseRepository).mockRejectedValueOnce(
			"Seletor nativo indisponível",
		);

		render(<App />);

		await screen.findByText("Nenhum repositório selecionado");
		await user.click(screen.getByRole("button", { name: "Escolher pasta" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Não foi possível escolher a pastaSeletor nativo indisponível",
		);
	});

	test("mostra spinner ao atualizar a inspeção do repositório", async () => {
		const user = userEvent.setup();
		let finishInspection: ((value: RepositoryInspection) => void) | undefined;
		vi.mocked(desktop.inspectRepository)
			.mockResolvedValueOnce(inspection)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishInspection = resolve;
					}),
			);

		render(<App />);

		await screen.findByText("src/novo.ts");
		const refresh = screen.getByRole("button", {
			name: "Atualizar inspeção do repositório",
		});
		await user.click(refresh);

		await waitFor(() =>
			expect(desktop.inspectRepository).toHaveBeenCalledTimes(2),
		);
		expect(refresh).toBeDisabled();
		expect(refresh).toHaveAttribute("aria-busy", "true");
		expect(refresh.querySelector('[data-slot="spinner"]')).toBeInTheDocument();

		await act(async () => finishInspection?.(inspection));
		await waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
	});

	test("descarta o acompanhamento após falha e começa uma nova execução sem eventos antigos", async () => {
		const user = userEvent.setup();
		let progressHandler: ((progress: GenerationProgress) => void) | undefined;
		let failGeneration: ((error: Error) => void) | undefined;
		let finishGeneration: ((result: GenerationResult) => void) | undefined;
		const stopListening = vi.fn();
		vi.mocked(desktop.onGenerationProgress).mockImplementation(
			async (handler) => {
				progressHandler = handler;
				return stopListening;
			},
		);
		vi.mocked(desktop.runGeneration)
			.mockImplementationOnce(
				() =>
					new Promise((_resolve, reject) => {
						failGeneration = reject;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishGeneration = resolve;
					}),
			);
		const { unmount } = render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));
		act(() => {
			progressHandler?.({
				phase: "generating",
				message: "Analisando src/App.tsx na primeira execução",
				current: 0,
				total: 2,
				activeFiles: ["src/App.tsx"],
			});
		});
		expect(
			within(
				screen.getByRole("region", { name: "Geração em andamento" }),
			).getByRole("status"),
		).toHaveTextContent("Analisando src/App.tsx na primeira execução");
		await act(async () =>
			failGeneration?.(new Error("Falha simulada do provedor")),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Falha simulada do provedor",
		);
		expect(screen.queryByRole("timer")).not.toBeInTheDocument();
		act(() => {
			progressHandler?.({
				phase: "completed",
				message: "Evento fora de uma execução ativa",
				current: 1,
				total: 1,
				activeFiles: [],
			});
		});
		expect(
			screen.queryByRole("region", { name: "Geração em andamento" }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));
		const feedback = screen.getByRole("region", {
			name: "Geração em andamento",
		});
		expect(within(feedback).getByRole("status")).toHaveTextContent(
			"Preparando a geração…",
		);
		expect(within(feedback).getByRole("timer")).toHaveTextContent("00:00");
		expect(
			within(feedback).queryByText(/primeira execução|Evento fora/),
		).not.toBeInTheDocument();
		expect(within(feedback).getByRole("progressbar")).not.toHaveAttribute(
			"aria-valuenow",
		);
		await act(async () => finishGeneration?.(generationResult));
		expect(await screen.findByText("1 tarefa pronta")).toBeVisible();
		expect(screen.queryByRole("timer")).not.toBeInTheDocument();
		unmount();
		expect(stopListening).toHaveBeenCalledOnce();
	});

	test("acompanha o progresso, mostra o resultado e revela o CSV", async () => {
		const user = userEvent.setup();
		let progressHandler: ((progress: GenerationProgress) => void) | undefined;
		let finishGeneration: ((result: GenerationResult) => void) | undefined;
		let finishOpeningCsv: (() => void) | undefined;

		vi.mocked(desktop.onGenerationProgress).mockImplementation(
			async (handler) => {
				progressHandler = handler;
				return () => undefined;
			},
		);
		vi.mocked(desktop.runGeneration).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishGeneration = resolve;
				}),
		);
		vi.mocked(desktop.openCsvFile).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishOpeningCsv = resolve;
				}),
		);

		render(<App />);

		await screen.findByText("src/novo.ts");
		expect(screen.queryByLabelText("Responsável")).not.toBeInTheDocument();
		const submit = screen.getByRole("button", { name: "Gerar tarefas" });
		await user.click(submit);
		await waitFor(() => expect(desktop.runGeneration).toHaveBeenCalledOnce());
		const feedback = screen.getByRole("region", {
			name: "Geração em andamento",
		});
		expect(within(feedback).getByRole("status")).toHaveTextContent(
			"Preparando a geração…",
		);
		expect(within(feedback).getByRole("progressbar")).not.toHaveAttribute(
			"aria-valuenow",
		);
		expect(submit).toBeDisabled();
		expect(submit).toHaveAttribute("aria-busy", "true");
		expect(submit.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
		expect(screen.getByLabelText("Sprint / Iteração")).toBeDisabled();
		expect(screen.getByLabelText("Chave OpenAI desta execução")).toBeDisabled();
		expect(
			screen.getByRole("switch", {
				name: /Criar também no Azure DevOps/,
			}),
		).toHaveAttribute("aria-disabled", "true");
		await user.click(submit);
		expect(desktop.runGeneration).toHaveBeenCalledOnce();

		act(() => {
			progressHandler?.({
				phase: "generating",
				message: "Processando src/App.tsx",
				current: 1,
				total: 2,
				activeFiles: ["src/App.tsx"],
			});
		});

		expect(within(feedback).getByRole("status")).toHaveTextContent(
			"Processando src/App.tsx",
		);
		expect(
			within(feedback).getByRole("list", { name: "Arquivos em processamento" }),
		).toHaveTextContent("src/App.tsx");
		expect(
			screen.getByRole("progressbar", { name: "Progresso da geração" }),
		).toHaveAttribute("aria-valuenow", "50");

		await act(async () => {
			finishGeneration?.(generationResult);
		});

		expect(await screen.findByText("1 tarefa pronta")).toBeVisible();
		expect(
			screen.queryByRole("region", { name: "Geração em andamento" }),
		).not.toBeInTheDocument();
		expect(desktop.runGeneration).toHaveBeenCalledWith({
			repositoryPath: "/workspace/projeto",
			sprintId: "Projeto\\Sprint 1",
			areaPathId: "Projeto\\Produto",
			assignedTo: "Pessoa <pessoa@infortechms.com.br>",
			itemContrato: "Item 1",
			aiProvider: "openai",
			openaiModel: "gpt-5-nano",
			codexModel: "gpt-5.6-luna",
			codexReasoningEffort: "low",
			createAzureTasks: false,
			registerTimeLog: false,
			timeLogStartDate: expect.any(String),
			timeLogEndDate: expect.any(String),
			azureOrganization: "https://dev.azure.com/empresa",
			azureProject: "Projeto",
		});
		expect(screen.getByText("IDs criados 321.")).toBeVisible();

		await user.click(screen.getByRole("button", { name: "Abrir CSV" }));
		expect(desktop.openCsvFile).toHaveBeenCalledWith(generationResult.csvPath);
		const openingCsv = screen.getByRole("button", { name: "Abrindo CSV…" });
		expect(openingCsv).toBeDisabled();
		expect(openingCsv).toHaveAttribute("aria-busy", "true");
		expect(
			openingCsv.querySelector('[data-slot="spinner"]'),
		).toBeInTheDocument();
		await user.click(openingCsv);
		expect(desktop.openCsvFile).toHaveBeenCalledOnce();

		await act(async () => finishOpeningCsv?.());
		const csvToast = await screen.findByRole("dialog", {
			name: "CSV localizado",
		});
		expect(csvToast).toHaveTextContent(
			"O arquivo foi destacado no gerenciador de arquivos.",
		);
	});

	test("exige e envia o item pai na criação direta no Azure", async () => {
		const user = userEvent.setup();
		render(<App />);

		await screen.findByText("src/novo.ts");
		expect(screen.queryByLabelText("ID do item pai")).not.toBeInTheDocument();

		const azureSwitch = screen.getByRole("switch", {
			name: /Criar também no Azure DevOps/,
		});
		await user.click(azureSwitch);
		expect(azureSwitch).toHaveAttribute("aria-checked", "true");
		const parentWorkItemId = screen.getByLabelText("ID do item pai");
		expect(parentWorkItemId).toHaveAccessibleDescription(
			"PBI, User Story ou Requirement que receberá as tarefas como filhas. Não será salvo.",
		);
		await user.type(parentWorkItemId, "201878");
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		await waitFor(() =>
			expect(desktop.runGeneration).toHaveBeenCalledWith(
				expect.objectContaining({
					createAzureTasks: true,
					parentWorkItemId: 201878,
				}),
			),
		);
	});

	test("mantém o Time Log opcional e dependente da criação no Azure", async () => {
		const user = userEvent.setup();
		render(<App />);

		await screen.findByText("src/novo.ts");
		expect(
			screen.queryByRole("switch", {
				name: /Registrar também no Time Log/,
			}),
		).not.toBeInTheDocument();

		const azureSwitch = screen.getByRole("switch", {
			name: /Criar também no Azure DevOps/,
		});
		await user.click(azureSwitch);
		const timeLogSwitch = screen.getByRole("switch", {
			name: /Registrar também no Time Log/,
		});
		expect(timeLogSwitch).toHaveAttribute("aria-checked", "false");
		expect(
			screen.queryByLabelText("Data inicial do Time Log"),
		).not.toBeInTheDocument();

		await user.click(timeLogSwitch);
		expect(screen.getByLabelText("Data inicial do Time Log")).toHaveAttribute(
			"max",
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
		);
		expect(screen.getByLabelText("Data final do Time Log")).toBeVisible();

		await user.click(azureSwitch);
		expect(
			screen.queryByRole("switch", {
				name: /Registrar também no Time Log/,
			}),
		).not.toBeInTheDocument();
		await user.click(azureSwitch);
		expect(
			screen.getByRole("switch", {
				name: /Registrar também no Time Log/,
			}),
		).toHaveAttribute("aria-checked", "false");
	});

	test("exige item pai e organização para a geração com Time Log", async () => {
		const user = userEvent.setup();
		render(<App />);

		await screen.findByText("src/novo.ts");
		await user.click(
			screen.getByRole("switch", {
				name: /Criar também no Azure DevOps/,
			}),
		);
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Informe o ID do item pai para criar as tarefas no Azure.",
		);
		expect(desktop.runGeneration).not.toHaveBeenCalled();

		await user.type(screen.getByLabelText("ID do item pai"), "201878");
		await user.click(
			screen.getByRole("switch", {
				name: /Registrar também no Time Log/,
			}),
		);
		await user.clear(screen.getByLabelText("Organização Azure"));
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Informe a organização Azure para registrar o Time Log.",
		);
		expect(desktop.runGeneration).not.toHaveBeenCalled();
	});

	test("envia o período e desmarca somente a opção de Time Log após tentar", async () => {
		const user = userEvent.setup();
		render(<App />);

		await screen.findByText("src/novo.ts");
		await user.click(
			screen.getByRole("switch", {
				name: /Criar também no Azure DevOps/,
			}),
		);
		await user.type(screen.getByLabelText("ID do item pai"), "201878");
		const timeLogSwitch = screen.getByRole("switch", {
			name: /Registrar também no Time Log/,
		});
		await user.click(timeLogSwitch);
		const startDate = screen.getByLabelText("Data inicial do Time Log");
		const endDate = screen.getByLabelText("Data final do Time Log");
		await user.clear(startDate);
		await user.type(startDate, "2020-01-02");
		await user.clear(endDate);
		await user.type(endDate, "2020-01-03");
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		await waitFor(() =>
			expect(desktop.runGeneration).toHaveBeenCalledWith(
				expect.objectContaining({
					createAzureTasks: true,
					parentWorkItemId: 201878,
					registerTimeLog: true,
					timeLogStartDate: "2020-01-02",
					timeLogEndDate: "2020-01-03",
				}),
			),
		);
		expect(timeLogSwitch).toHaveAttribute("aria-checked", "false");
		await user.click(timeLogSwitch);
		expect(screen.getByLabelText("Data inicial do Time Log")).toHaveValue(
			"2020-01-02",
		);
		expect(screen.getByLabelText("Data final do Time Log")).toHaveValue(
			"2020-01-03",
		);
	});

	test("retenta somente o Time Log com o período corrigido", async () => {
		const user = userEvent.setup();
		const pendingEntry = {
			date: "2020-01-02",
			minutes: 420,
			type: "Backend" as const,
			comment: "Implementar serviço",
		};
		const retryInput = {
			workItemId: 201878,
			startDate: "2020-01-02",
			endDate: "2020-01-02",
			work: [
				{
					minutes: 480,
					type: "Backend" as const,
					comment: "Implementar serviço",
				},
			],
			organization: "https://dev.azure.com/empresa",
		};
		vi.mocked(desktop.runGeneration).mockResolvedValueOnce({
			...generationResult,
			timeLogResult: {
				plan: {
					workItemId: 201878,
					requestedMinutes: 480,
					scheduledMinutes: 420,
					missingMinutes: 60,
					days: [
						{
							date: "2020-01-02",
							existingMinutes: 0,
							newMinutes: 420,
							totalMinutes: 420,
							entries: [pendingEntry],
						},
					],
				},
				created: [],
				pending: [pendingEntry],
				postAttempts: 0,
				retryable: true,
			},
			timeLogRetryInput: retryInput,
		});
		vi.mocked(desktop.createTimeLog).mockResolvedValueOnce(timeLogBatchResult);
		render(<App />);

		await screen.findByText("src/novo.ts");
		await user.click(
			screen.getByRole("switch", {
				name: /Criar também no Azure DevOps/,
			}),
		);
		await user.type(screen.getByLabelText("ID do item pai"), "201878");
		await user.click(
			screen.getByRole("switch", {
				name: /Registrar também no Time Log/,
			}),
		);
		await user.clear(screen.getByLabelText("Data inicial do Time Log"));
		await user.type(
			screen.getByLabelText("Data inicial do Time Log"),
			"2020-01-02",
		);
		await user.clear(screen.getByLabelText("Data final do Time Log"));
		await user.type(
			screen.getByLabelText("Data final do Time Log"),
			"2020-01-02",
		);
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		expect(
			await screen.findByText("Período sem capacidade suficiente"),
		).toBeVisible();
		expect(screen.getByRole("alert")).toHaveTextContent("Faltaram 1h");
		const retryEndDate = screen.getByLabelText("Data final do Time Log");
		await user.clear(retryEndDate);
		await user.type(retryEndDate, "2020-01-03");
		await user.click(
			screen.getByRole("button", {
				name: "Tentar novamente somente o Time Log",
			}),
		);

		await waitFor(() =>
			expect(desktop.createTimeLog).toHaveBeenCalledWith({
				...retryInput,
				endDate: "2020-01-03",
			}),
		);
		expect(desktop.runGeneration).toHaveBeenCalledOnce();
		expect(
			await screen.findByText("Horas registradas no Time Log"),
		).toBeVisible();
		expect(
			screen.queryByRole("button", {
				name: "Tentar novamente somente o Time Log",
			}),
		).not.toBeInTheDocument();
	});

	test("não oferece retentativa após um POST de resultado indeterminado", async () => {
		const user = userEvent.setup();
		const failedEntry = {
			date: "2020-01-02",
			minutes: 120,
			type: "Teste" as const,
			comment: "Validar integração",
		};
		vi.mocked(desktop.runGeneration).mockResolvedValueOnce({
			...generationResult,
			timeLogResult: {
				plan: {
					workItemId: 201878,
					requestedMinutes: 120,
					scheduledMinutes: 120,
					missingMinutes: 0,
					days: [
						{
							date: "2020-01-02",
							existingMinutes: 300,
							newMinutes: 120,
							totalMinutes: 420,
							entries: [failedEntry],
						},
					],
				},
				created: [],
				pending: [failedEntry],
				failure: {
					entry: failedEntry,
					error: "A resposta da extensão não foi recebida.",
					indeterminate: true,
				},
				postAttempts: 1,
				retryable: false,
			},
		});
		render(<App />);

		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		expect(
			await screen.findByText("Resultado do Time Log indeterminado"),
		).toBeVisible();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Confira o Time Log Free antes de fazer outro lançamento.",
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Pendentes: 02/01/2020 · Teste 2h.",
		);
		expect(
			screen.queryByRole("button", {
				name: "Tentar novamente somente o Time Log",
			}),
		).not.toBeInTheDocument();
	});

	test("bloqueia ID de item pai que não seja inteiro positivo", async () => {
		const user = userEvent.setup();
		render(<App />);

		await screen.findByText("src/novo.ts");
		await user.click(
			screen.getByRole("switch", {
				name: /Criar também no Azure DevOps/,
			}),
		);
		await user.type(screen.getByLabelText("ID do item pai"), "12.5");
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Informe um ID do item pai como número inteiro positivo.",
		);
		expect(desktop.runGeneration).not.toHaveBeenCalled();
	});

	test("exige uma chave OpenAI quando o ambiente não está configurado", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue({
			...configuredState,
			aiProviders: configuredState.aiProviders.map((provider) =>
				provider.id === "openai"
					? {
							...provider,
							ready: false,
							statusDetail: "Chave necessária",
						}
					: provider,
			),
		});

		render(<App />);

		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Informe uma chave OpenAI",
		);
		expect(desktop.runGeneration).not.toHaveBeenCalled();

		const apiKey = screen.getByLabelText("Chave OpenAI desta execução");
		vi.mocked(desktop.runGeneration).mockRejectedValueOnce(
			"Falha simulada da OpenAI",
		);
		await user.type(apiKey, "sk-local-test");
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		await waitFor(() =>
			expect(desktop.runGeneration).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: "sk-local-test" }),
			),
		);
		await waitFor(() => expect(apiKey).toHaveValue(""));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Falha simulada da OpenAI",
		);
	});

	test("bloqueia Codex indisponível usando a mensagem do backend", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue({
			...configuredState,
			config: {
				...configuredState.config,
				aiProvider: "codex",
			},
			aiProviders: configuredState.aiProviders.map((provider) =>
				provider.id === "codex"
					? {
							...provider,
							ready: false,
							statusDetail: "Login necessário",
						}
					: provider,
			),
		});

		render(<App />);

		await screen.findByText("src/novo.ts");
		expect(
			screen.queryByLabelText("Chave OpenAI desta execução"),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			codexPendingMessage,
		);
		expect(desktop.runGeneration).not.toHaveBeenCalled();
	});

	test("exibe falhas parciais, aviso de stage, Azure e configuração", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.runGeneration).mockResolvedValue({
			...generationResult,
			files: [
				{
					...generationResult.files[0],
					staged: false,
					stageError: "O arquivo mudou durante a geração",
				},
			],
			failures: [
				{
					relativePath: "src/falhou.ts",
					error: "Resposta inválida do provedor",
				},
			],
			azureTaskIds: [321],
			azureError: "Falha ao criar a segunda tarefa",
			warnings: ["A configuração não pôde ser salva"],
		});

		render(<App />);

		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		expect(await screen.findByText("1 tarefa pronta")).toBeVisible();
		expect(screen.getByText("Geração concluída com avisos")).toBeVisible();
		expect(screen.getByText("Stage falhou")).toBeVisible();
		expect(screen.getByText("O arquivo mudou durante a geração")).toBeVisible();
		expect(screen.getByText("src/falhou.ts")).toBeVisible();
		expect(screen.getByText("Resposta inválida do provedor")).toBeVisible();
		expect(screen.getByText("Falha ao criar a segunda tarefa")).toBeVisible();
		expect(screen.getByText("A configuração não pôde ser salva")).toBeVisible();
		expect(screen.getByText("IDs criados 321.")).toBeVisible();
	});

	test("torna avisos de configuração da inicialização visíveis", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue({
			...configuredState,
			warnings: ["Configuração corrompida; usando valores padrão"],
		});

		render(<App />);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"Configuração corrompida; usando valores padrão",
		);

		await user.click(screen.getByRole("tab", { name: "Registrar horas" }));
		expect(alert).toBeVisible();
	});

	test("abre o onboarding com defaults e permite pular sem persistir", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue(onboardingState);

		render(<App />);

		expect(
			await screen.findByRole("heading", {
				name: "Prepare o aplicativo para começar",
			}),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Configurações" }),
		).toBeDisabled();
		expect(screen.getByLabelText("Nome")).toHaveValue("Ygor Azambuja");
		expect(screen.getByLabelText("E-mail Infortech")).toHaveValue(
			"ygor.azambuja@infortechms.com.br",
		);
		expect(screen.getByLabelText("Organização Azure padrão")).toHaveValue(
			"https://dev.azure.com/InfortechMS",
		);
		expect(screen.getByLabelText("Projeto Azure padrão")).toHaveValue(
			"SPF-SIAFIC",
		);

		await user.click(screen.getByRole("button", { name: "Pular por agora" }));

		expect(desktop.saveAppSettings).not.toHaveBeenCalled();
		expect(
			screen.getByRole("heading", { name: "Do código ao Azure DevOps" }),
		).toBeVisible();
		expect(screen.getByRole("status")).toHaveTextContent(
			"Configuração inicial pendente",
		);
	});

	test("apresenta e salva Luna 6 recebido do backend no onboarding", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue({
			...onboardingState,
			config: {
				...onboardingState.config,
				openaiModel: "gpt-6-luna",
				codexModel: "gpt-6-luna",
			},
		});
		render(<App />);

		expect(await screen.findByLabelText("Modelo")).toHaveTextContent(
			"Luna 6 do catálogo",
		);
		await user.click(screen.getByRole("radio", { name: /OpenAI/ }));
		expect(screen.getByLabelText("Modelo")).toHaveTextContent(
			"Luna 6 do catálogo",
		);
		await user.click(
			screen.getByRole("button", { name: "Salvar configurações" }),
		);
		await waitFor(() =>
			expect(desktop.saveAppSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					aiProvider: "openai",
					openaiModel: "gpt-6-luna",
					codexModel: "gpt-6-luna",
				}),
			),
		);
	});

	test("valida, foca o primeiro campo inválido e não salva", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue(onboardingState);
		render(<App />);

		const name = await screen.findByLabelText("Nome");
		await user.clear(name);
		await user.clear(screen.getByLabelText("E-mail Infortech"));
		await user.click(
			screen.getByRole("button", { name: "Salvar configurações" }),
		);

		await waitFor(() => expect(name).toHaveFocus());
		expect(name).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByLabelText("E-mail Infortech")).toHaveAttribute(
			"aria-invalid",
			"true",
		);
		expect(desktop.saveAppSettings).not.toHaveBeenCalled();
	});

	test("rejeita nome, organização e e-mail que o backend não normaliza", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue(onboardingState);
		render(<App />);

		const name = await screen.findByLabelText("Nome");
		const email = await screen.findByLabelText("E-mail Infortech");
		const organization = screen.getByLabelText("Organização Azure padrão");
		await user.clear(name);
		await user.type(name, "<Ygor>");
		await user.clear(email);
		await user.type(email, ".ygor@infortechms.com.br");
		await user.clear(organization);
		await user.type(organization, "Infortech_MS");
		await user.click(
			screen.getByRole("button", { name: "Salvar configurações" }),
		);

		expect(name).toHaveAttribute("aria-invalid", "true");
		expect(email).toHaveAttribute("aria-invalid", "true");
		expect(organization).toHaveAttribute("aria-invalid", "true");
		expect(desktop.saveAppSettings).not.toHaveBeenCalled();
	});

	test("verifica e salva um novo PAT sem mantê-lo no campo", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue(onboardingState);
		vi.mocked(desktop.identifyAzureUser).mockResolvedValue({
			displayName: "Maria Infortech",
			email: "maria@infortechms.com.br",
		});
		vi.mocked(desktop.saveAppSettings).mockResolvedValue({
			config: {
				...onboardingState.config,
				assignedTo: "Maria Infortech <ygor.azambuja@infortechms.com.br>",
				azureOrganization: "https://dev.azure.com/InfortechMS",
				azureProject: "SPF-SIAFIC",
			},
			profile: {
				displayName: "Maria Infortech",
				email: "ygor.azambuja@infortechms.com.br",
			},
			timeLogPatConfigured: true,
			warnings: [],
		});
		render(<App />);

		const name = await screen.findByLabelText("Nome");
		await user.clear(name);
		const pat = await screen.findByLabelText("PAT do Azure DevOps");
		await user.type(pat, "pat-da-sessao");
		await user.click(screen.getByRole("button", { name: "Verificar PAT" }));

		await waitFor(() =>
			expect(desktop.identifyAzureUser).toHaveBeenCalledWith({
				organization: "https://dev.azure.com/InfortechMS",
				pat: "pat-da-sessao",
			}),
		);
		expect(pat).toHaveValue("");
		expect(await screen.findByRole("status")).toHaveTextContent(
			"PAT verificado para Maria Infortech",
		);
		expect(screen.getByLabelText("Nome")).toHaveValue("Maria Infortech");
		expect(screen.getByLabelText("E-mail Infortech")).toHaveValue(
			"ygor.azambuja@infortechms.com.br",
		);

		await user.click(
			screen.getByRole("button", { name: "Salvar configurações" }),
		);
		await waitFor(() =>
			expect(desktop.saveAppSettings).toHaveBeenCalledWith({
				displayName: "Maria Infortech",
				email: "ygor.azambuja@infortechms.com.br",
				azureOrganization: "https://dev.azure.com/InfortechMS",
				azureProject: "SPF-SIAFIC",
				aiProvider: "codex",
				openaiModel: "gpt-5-nano",
				codexModel: "gpt-5.6-luna",
				codexReasoningEffort: "low",
				timeLogPat: "pat-da-sessao",
				removeTimeLogPat: false,
			}),
		);
		expect(
			await screen.findByRole("dialog", { name: "Configurações salvas" }),
		).toHaveTextContent("Suas preferências foram atualizadas.");
	});

	test("mantém avisos de configuração salvos e os sinaliza em toast", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.saveAppSettings).mockResolvedValueOnce({
			config: configuredState.config,
			profile: configuredState.profile,
			timeLogPatConfigured: false,
			warnings: ["O PAT não pôde ser salvo."],
		});
		render(<App />);

		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("button", { name: "Configurações" }));
		await user.click(
			screen.getByRole("button", { name: "Salvar configurações" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"O PAT não pôde ser salvo.",
		);
		expect(
			await screen.findByRole("dialog", {
				name: "Configurações salvas com avisos",
			}),
		).toHaveTextContent("Revise o aviso exibido antes de continuar.");
	});

	test("corrige somente o e-mail inválido ao verificar o PAT", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue(onboardingState);
		vi.mocked(desktop.identifyAzureUser).mockResolvedValue({
			displayName: "Maria Infortech",
			email: "maria@infortechms.com.br",
		});
		render(<App />);

		const email = await screen.findByLabelText("E-mail Infortech");
		await user.clear(email);
		await user.type(email, "email-invalido");
		const pat = await screen.findByLabelText("PAT do Azure DevOps");
		await user.type(pat, "pat-da-sessao");
		await user.click(screen.getByRole("button", { name: "Verificar PAT" }));

		expect(await screen.findByRole("status")).toHaveTextContent(
			"PAT verificado para Maria Infortech",
		);
		expect(screen.getByLabelText("Nome")).toHaveValue("Ygor Azambuja");
		expect(screen.getByLabelText("E-mail Infortech")).toHaveValue(
			"maria@infortechms.com.br",
		);
	});

	test("mostra PAT inválido como erro e não como identidade verificada", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue(onboardingState);
		vi.mocked(desktop.identifyAzureUser).mockRejectedValue(
			"a credencial informada é inválida ou não foi aceita pela organização do Azure DevOps",
		);
		render(<App />);

		const pat = await screen.findByLabelText("PAT do Azure DevOps");
		await user.type(pat, "pat-invalido");
		await user.click(screen.getByRole("button", { name: "Verificar PAT" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/credencial informada é inválida/i,
		);
		expect(screen.queryByText(/PAT verificado para/)).not.toBeInTheDocument();
		expect(pat).toHaveValue("");
	});

	test("preserva rascunhos do workspace ao editar e cancelar configurações", async () => {
		const user = userEvent.setup();
		render(<App />);
		const sprint = await screen.findByLabelText("Sprint / Iteração");
		await user.clear(sprint);
		await user.type(sprint, "Sprint em rascunho");

		await user.click(screen.getByRole("button", { name: "Configurações" }));
		expect(
			await screen.findByRole("heading", {
				name: "Configurações do aplicativo",
			}),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Cancelar" }));

		expect(screen.getByLabelText("Sprint / Iteração")).toHaveValue(
			"Sprint em rascunho",
		);
	});

	test("registro de horas ignora a organização temporária da geração", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue({
			...configuredState,
			config: {
				...configuredState.config,
				azureOrganization: "https://dev.azure.com/configurada",
			},
		});
		render(<App />);

		await screen.findByText("src/novo.ts");
		await user.click(
			screen.getByRole("switch", {
				name: /Criar também no Azure DevOps/,
			}),
		);
		const generationOrganization = screen.getByLabelText("Organização Azure");
		await user.clear(generationOrganization);
		await user.type(generationOrganization, "https://dev.azure.com/temporaria");
		await user.click(screen.getByRole("tab", { name: "Registrar horas" }));
		await user.type(screen.getByLabelText("ID do work item"), "201878");
		await user.clear(screen.getByLabelText("Minutos"));
		await user.type(screen.getByLabelText("Minutos"), "15");
		await user.type(
			screen.getByLabelText("Trabalho realizado"),
			"Revisei a configuração",
		);
		await user.click(screen.getByRole("button", { name: "Registrar horas" }));

		await waitFor(() => expect(desktop.createTimeLog).toHaveBeenCalledOnce());
		expect(vi.mocked(desktop.createTimeLog).mock.calls[0][0]).toMatchObject({
			organization: "https://dev.azure.com/configurada",
		});
	});

	test("remove um PAT salvo sem revelar o segredo e reabre o estado atualizado", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue({
			...configuredState,
			timeLogPatConfigured: true,
		});
		render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("button", { name: "Configurações" }));

		expect(screen.getByText("PAT configurado")).toBeVisible();
		expect(
			screen.queryByLabelText("PAT do Azure DevOps"),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Remover PAT" }));
		expect(
			screen.getByText("O PAT salvo será removido ao salvar."),
		).toBeVisible();
		await user.click(
			screen.getByRole("button", { name: "Salvar configurações" }),
		);

		await waitFor(() =>
			expect(desktop.saveAppSettings).toHaveBeenCalledWith({
				displayName: "Pessoa",
				email: "pessoa@infortechms.com.br",
				azureOrganization: "https://dev.azure.com/empresa",
				azureProject: "Projeto",
				aiProvider: "openai",
				openaiModel: "gpt-5-nano",
				codexModel: "gpt-5.6-luna",
				codexReasoningEffort: "low",
				removeTimeLogPat: true,
			}),
		);
		await user.click(screen.getByRole("button", { name: "Configurações" }));
		expect(screen.getByLabelText("PAT do Azure DevOps")).toHaveValue("");
		expect(screen.queryByText("PAT configurado")).not.toBeInTheDocument();
	});

	test("persiste um modelo para cada provedor", async () => {
		const user = userEvent.setup();
		const selectOption = async (label: string, option: string) => {
			await user.click(screen.getByLabelText(label));
			await user.click(await screen.findByRole("option", { name: option }));
			await waitFor(() =>
				expect(
					screen.queryByRole("option", { name: option }),
				).not.toBeInTheDocument(),
			);
		};
		render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("button", { name: "Configurações" }));

		await user.click(screen.getByRole("radio", { name: /Codex/ }));
		await selectOption("Modelo", "Sol do catálogo");
		await selectOption("Esforço de raciocínio", "Alto do catálogo");
		await user.click(screen.getByRole("radio", { name: /OpenAI/ }));
		await selectOption("Modelo", "Mini do catálogo");
		await user.click(screen.getByRole("radio", { name: /Codex/ }));
		expect(screen.getByLabelText("Modelo")).toHaveTextContent(
			"Sol do catálogo",
		);

		await user.click(
			screen.getByRole("button", { name: "Salvar configurações" }),
		);
		expect(desktop.saveAppSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				aiProvider: "codex",
				openaiModel: "gpt-5-mini",
				codexModel: "gpt-5.6-sol",
				codexReasoningEffort: "high",
			}),
		);
	});

	test("não permite gerar com responsável fora do domínio corporativo", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.getInitialState).mockResolvedValue({
			...configuredState,
			config: {
				...configuredState.config,
				assignedTo: "Pessoa <pessoa@example.com>",
			},
		});
		render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"email@infortechms.com.br",
		);
		expect(desktop.runGeneration).not.toHaveBeenCalled();
	});
});

describe("TimeLogPanel", () => {
	test("usa o tipo acessível e envia com a organização configurada", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<TimeLogPanel organization="https://dev.azure.com/empresa" />,
		);
		expect(
			screen.getByRole("group", { name: "Detalhes do trabalho" }),
		).toBeVisible();
		expect(screen.getByRole("group", { name: "Duração" })).toBeVisible();
		expect(
			screen.queryByRole("group", { name: "Autenticação" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText("Organização Azure"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText("Credencial (opcional)"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("combobox", { name: "Tipo da credencial" }),
		).not.toBeInTheDocument();
		await user.type(screen.getByLabelText("ID do work item"), "201878");
		await user.clear(screen.getByLabelText("Horas"));
		await user.type(screen.getByLabelText("Horas"), "2");
		await user.clear(screen.getByLabelText("Minutos"));
		await user.type(screen.getByLabelText("Minutos"), "30");
		await user.clear(screen.getByLabelText("Data inicial"));
		await user.type(screen.getByLabelText("Data inicial"), "2026-08-12");
		await user.clear(screen.getByLabelText("Data final"));
		await user.type(screen.getByLabelText("Data final"), "2026-08-12");

		const typeCombobox = screen.getByRole("combobox", { name: "Tipo" });
		await user.click(typeCombobox);
		const meetingOption = await screen.findByRole("option", {
			name: "Reunião",
		});
		expect(container).not.toContainElement(meetingOption);
		expect(document.body).toContainElement(meetingOption);
		expect(screen.getByRole("option", { name: "Análise" })).toBeVisible();
		await user.click(meetingOption);
		expect(typeCombobox).toHaveTextContent("Reunião");

		await user.type(
			screen.getByLabelText("Trabalho realizado"),
			"Implementei a integração visual",
		);

		await user.click(typeCombobox);
		expect(
			await screen.findByRole("option", { name: "Backend" }),
		).toBeVisible();
		await user.keyboard("{Escape}");
		await waitFor(() =>
			expect(
				screen.queryByRole("option", { name: "Backend" }),
			).not.toBeInTheDocument(),
		);
		expect(typeCombobox).toHaveFocus();

		await user.click(screen.getByRole("button", { name: "Registrar horas" }));

		await waitFor(() =>
			expect(desktop.createTimeLog).toHaveBeenCalledWith({
				workItemId: 201878,
				startDate: "2026-08-12",
				endDate: "2026-08-12",
				work: [
					{
						minutes: 150,
						type: "Reunião",
						comment: "Implementei a integração visual",
					},
				],
				organization: "https://dev.azure.com/empresa",
			}),
		);
		expect(await screen.findByRole("status")).toHaveTextContent(
			"Horas registradas no Time Log",
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"12/08/2026 já existiam 1h · Reunião 2h 30min · total 3h 30min",
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Documentos: documento-1.",
		);
	});

	test("associa erros aos campos e foca o primeiro valor inválido", async () => {
		const user = userEvent.setup();
		render(<TimeLogPanel organization="empresa" />);

		const workItemId = screen.getByLabelText("ID do work item");
		const hours = screen.getByLabelText("Horas");
		const comment = screen.getByLabelText("Trabalho realizado");
		await user.click(screen.getByRole("button", { name: "Registrar horas" }));

		await waitFor(() => expect(workItemId).toHaveFocus());
		expect(workItemId).toHaveAttribute("aria-invalid", "true");
		expect(workItemId).toHaveAttribute(
			"aria-describedby",
			"timeLogWorkItemIdError",
		);
		expect(workItemId).toHaveAccessibleDescription(
			"Use um ID inteiro e maior que zero. Exemplo: 201878.",
		);
		expect(hours).toHaveAttribute("aria-invalid", "true");
		expect(hours).toHaveAccessibleDescription(
			"Informe pelo menos uma hora ou um minuto.",
		);
		expect(comment).toHaveAttribute("aria-invalid", "true");
		expect(comment).toHaveAccessibleDescription("Resuma o trabalho realizado.");

		await user.type(workItemId, "201878");
		await user.type(comment, "Revisei a API");
		await user.click(screen.getByRole("button", { name: "Registrar horas" }));

		await waitFor(() => expect(hours).toHaveFocus());
		expect(workItemId).toHaveAttribute("aria-invalid", "false");
		expect(hours).toHaveAttribute("aria-invalid", "true");
		expect(desktop.createTimeLog).not.toHaveBeenCalled();
	});

	test("rejeita intervalo invertido antes de chamar o backend", async () => {
		const user = userEvent.setup();
		render(<TimeLogPanel organization="empresa" />);

		await user.type(screen.getByLabelText("ID do work item"), "201878");
		await user.clear(screen.getByLabelText("Minutos"));
		await user.type(screen.getByLabelText("Minutos"), "20");
		await user.clear(screen.getByLabelText("Data inicial"));
		await user.type(screen.getByLabelText("Data inicial"), "2020-01-02");
		await user.clear(screen.getByLabelText("Data final"));
		await user.type(screen.getByLabelText("Data final"), "2020-01-01");
		await user.type(
			screen.getByLabelText("Trabalho realizado"),
			"Revisei a integração",
		);
		await user.click(screen.getByRole("button", { name: "Registrar horas" }));

		const endDate = screen.getByLabelText("Data final");
		await waitFor(() => expect(endDate).toHaveFocus());
		expect(endDate).toHaveAccessibleDescription(
			"A data final deve ser igual ou posterior à data inicial.",
		);
		expect(desktop.createTimeLog).not.toHaveBeenCalled();
	});

	test("orienta abrir Configurações quando a organização estiver ausente", async () => {
		const user = userEvent.setup();
		render(<TimeLogPanel />);

		await user.type(screen.getByLabelText("ID do work item"), "201878");
		await user.clear(screen.getByLabelText("Minutos"));
		await user.type(screen.getByLabelText("Minutos"), "20");
		await user.type(
			screen.getByLabelText("Trabalho realizado"),
			"Revisei a integração",
		);
		await user.click(screen.getByRole("button", { name: "Registrar horas" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Configure a organização do Azure DevOps em Configurações.",
		);
		expect(desktop.createTimeLog).not.toHaveBeenCalled();
	});

	test("bloqueia todo o formulário enquanto o registro está pendente", async () => {
		const user = userEvent.setup();
		let finishSubmission: ((result: TimeLogBatchResult) => void) | undefined;
		vi.mocked(desktop.createTimeLog).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishSubmission = resolve;
				}),
		);
		render(<TimeLogPanel organization="empresa" />);

		await user.type(screen.getByLabelText("ID do work item"), "201878");
		await user.clear(screen.getByLabelText("Minutos"));
		await user.type(screen.getByLabelText("Minutos"), "15");
		await user.type(
			screen.getByLabelText("Trabalho realizado"),
			"Ajustei os testes",
		);
		const submit = screen.getByRole("button", { name: "Registrar horas" });
		const form = submit.closest("form");
		await user.click(submit);

		await waitFor(() => expect(desktop.createTimeLog).toHaveBeenCalledOnce());
		expect(form).toHaveAttribute("aria-busy", "true");
		for (const label of [
			"ID do work item",
			"Horas",
			"Minutos",
			"Data inicial",
			"Data final",
			"Trabalho realizado",
		]) {
			expect(screen.getByLabelText(label)).toBeDisabled();
		}
		for (const combobox of screen.getAllByRole("combobox")) {
			expect(combobox).toBeDisabled();
		}
		const pendingButton = screen.getByRole("button", { name: /Registrando/ });
		expect(pendingButton).toBeDisabled();
		expect(pendingButton).toHaveAttribute("aria-busy", "true");
		expect(pendingButton).toHaveTextContent("Registrando…");
		expect(
			pendingButton.querySelector('[data-slot="spinner"]'),
		).toBeInTheDocument();
		expect(desktop.createTimeLog).toHaveBeenCalledOnce();

		await act(async () => {
			finishSubmission?.(timeLogBatchResult);
		});
		await waitFor(() => expect(form).toHaveAttribute("aria-busy", "false"));
	});

	test("expõe falha de resultado indeterminado", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.createTimeLog).mockRejectedValueOnce(
			"Falha de rede ao criar o lançamento. O resultado pode ser indeterminado; confira a aba Time Log Free antes de repetir.",
		);
		render(<TimeLogPanel organization="empresa" />);

		await user.type(screen.getByLabelText("ID do work item"), "201878");
		await user.clear(screen.getByLabelText("Minutos"));
		await user.type(screen.getByLabelText("Minutos"), "15");
		await user.type(
			screen.getByLabelText("Trabalho realizado"),
			"Ajustei os testes",
		);
		await user.click(screen.getByRole("button", { name: "Registrar horas" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"resultado pode ser indeterminado",
		);
	});
});

describe("descoberta de modelos", () => {
	test("atualiza automaticamente sem botões e preserva seleção, drafts e catálogo em falhas", async () => {
		const user = userEvent.setup();
		render(<App />);
		await screen.findByText("src/novo.ts");
		await waitFor(() => {
			expect(desktop.listAiModels).toHaveBeenCalledWith("openai", "");
			expect(desktop.listAiModels).toHaveBeenCalledWith("codex", undefined);
		});
		expect(
			screen.queryByRole("button", { name: /Atualizar modelos/ }),
		).not.toBeInTheDocument();
		await user.clear(screen.getByLabelText("Sprint / Iteração"));
		await user.type(
			screen.getByLabelText("Sprint / Iteração"),
			"Sprint rascunho",
		);
		let resolveModels!: (catalog: AiModelCatalog) => void;
		const updated = new Promise<AiModelCatalog>((resolve) => {
			resolveModels = resolve;
		});
		vi.mocked(desktop.listAiModels).mockImplementation((provider) =>
			provider === "openai"
				? updated
				: Promise.resolve({
						models: aiProviders[1].models,
						source: "provider",
						warnings: [],
					}),
		);
		await user.click(screen.getByRole("button", { name: "Configurações" }));
		expect(
			screen.queryByRole("button", { name: /Atualizar modelos/ }),
		).not.toBeInTheDocument();
		expect(
			await within(screen.getByRole("main")).findByText(
				"Atualizando modelos automaticamente…",
			),
		).toBeVisible();
		await user.clear(screen.getByLabelText("Nome"));
		await user.type(screen.getByLabelText("Nome"), "Nome rascunho");
		await act(async () => {
			resolveModels({
				models: [
					aiProviders[0].models[3],
					{
						value: "gpt-7-new",
						label: "Modelo descoberto",
						reasoningEfforts: [],
						defaultReasoningEffort: null,
						compatibilityVerified: false,
					},
				],
				source: "provider",
				warnings: [],
			});
		});
		expect(screen.getByLabelText("Nome")).toHaveValue("Nome rascunho");
		expect(screen.getByLabelText("Modelo")).toHaveTextContent(
			"Nano do catálogo",
		);
		vi.mocked(desktop.listAiModels).mockResolvedValue({
			models: aiProviders[0].models,
			source: "local",
			warnings: ["Falha de consulta simulada"],
		});
		await user.click(screen.getByRole("button", { name: "Cancelar" }));
		expect(screen.getByLabelText("Sprint / Iteração")).toHaveValue(
			"Sprint rascunho",
		);
		expect(await screen.findByText("Falha de consulta simulada")).toBeVisible();
		expect(screen.getByLabelText("Modelo para geração")).toHaveTextContent(
			"Nano do catálogo",
		);
		await user.click(screen.getByLabelText("Modelo para geração"));
		await user.click(
			await screen.findByRole("option", { name: "Modelo descoberto" }),
		);
		expect(
			await screen.findByText("Compatibilidade ainda não verificada"),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));
		await waitFor(() =>
			expect(desktop.runGeneration).toHaveBeenCalledWith(
				expect.objectContaining({
					openaiModel: "gpt-7-new",
					sprintId: "Sprint rascunho",
				}),
			),
		);
	});

	test("modelo salvo ausente permanece visível e impede geração sem substituição silenciosa", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.listAiModels).mockImplementation(async (provider) => ({
			models:
				provider === "openai"
					? [aiProviders[0].models[0]]
					: aiProviders[1].models,
			source: "provider",
			warnings: [],
		}));
		render(<App />);
		await screen.findByText(
			"O modelo salvo está indisponível. Escolha outro modelo antes de gerar.",
		);
		expect(screen.getByLabelText("Modelo para geração")).toHaveTextContent(
			"gpt-5-nano — indisponível",
		);
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));
		expect(desktop.runGeneration).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Configurações" }));
		expect(screen.getByLabelText("Modelo")).toHaveTextContent(
			"gpt-5-nano — indisponível",
		);
		await user.click(
			screen.getByRole("button", { name: "Salvar configurações" }),
		);
		expect(desktop.saveAppSettings).toHaveBeenCalledWith(
			expect.objectContaining({ openaiModel: "gpt-5-nano" }),
		);
	});

	test("ajusta esforço ao modelo Codex descoberto e informa a alteração", async () => {
		const user = userEvent.setup();
		vi.mocked(desktop.listAiModels).mockImplementation(async (provider) => ({
			models:
				provider === "openai"
					? aiProviders[0].models
					: [
							{
								...aiProviders[1].models[3],
								reasoningEfforts: [{ value: "max", label: "Máximo" }],
								defaultReasoningEffort: "max",
							},
						],
			source: "provider",
			warnings: [],
		}));
		render(<App />);
		await screen.findByText("src/novo.ts");
		await user.click(screen.getByRole("radio", { name: "Codex" }));
		expect(
			await screen.findByText(
				"Esforço de raciocínio ajustado para max, padrão do modelo selecionado.",
			),
		).toBeVisible();
		expect(
			screen.getByLabelText("Esforço de raciocínio para geração"),
		).toHaveTextContent("Máximo");
		await user.click(screen.getByRole("button", { name: "Gerar tarefas" }));
		await waitFor(() =>
			expect(desktop.runGeneration).toHaveBeenCalledWith(
				expect.objectContaining({ codexReasoningEffort: "max" }),
			),
		);
	});
});
