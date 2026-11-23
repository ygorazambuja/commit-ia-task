import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "./components/ui/toast";
import * as desktop from "./desktop";
import MyTasksPanel from "./MyTasksPanel";
import type { AzureTasksSnapshot, CardAnalysis } from "./types";

vi.mock("./desktop", () => ({
	analyzeAzureTask: vi.fn(),
	chooseRepository: vi.fn(),
	getAzureTasks: vi.fn(),
	markAzureNotificationsRead: vi.fn(),
	onAzureTasksUpdated: vi.fn(),
	refreshAzureTasks: vi.fn(),
}));

vi.mock("./components/ui/toast", () => ({
	toast: { success: vi.fn() },
}));

const snapshot: AzureTasksSnapshot = {
	status: "ready",
	message: null,
	lastCheckedAt: "2026-10-09T16:30:00Z",
	items: [
		{
			id: 123,
			revision: 4,
			title: "Validar cadastro de receitas",
			workItemType: "Product Backlog Item",
			state: "To Do",
			assignedTo: "Pessoa do PAT",
			changedDate: "2026-10-09T16:00:00Z",
			iterationPath: "Projeto\\Sprint 10",
			areaPath: "Projeto\\Produto",
			url: "https://dev.azure.com/empresa/Projeto/_workitems/edit/123",
			priority: 2,
			canAnalyze: true,
		},
	],
	notifications: [
		{
			id: "123-4",
			workItemId: 123,
			title: "Validar cadastro de receitas",
			message: "O card foi alterado.",
			createdAt: "2026-10-09T16:00:00Z",
			read: false,
		},
	],
};

const analysis: CardAnalysis = {
	summary: "Adicionar validação no cadastro existente.",
	acceptanceCriteria: ["Rejeitar código duplicado."],
	relevantFiles: ["src/receitas.rs"],
	implementationPlan: ["Validar unicidade antes de salvar."],
	testPlan: ["Cobrir código duplicado no teste de integração."],
	risks: ["Cadastros legados podem conter duplicatas."],
	openQuestions: ["Como tratar duplicatas existentes?"],
	warnings: ["Critérios complementares não encontrados no card."],
};

let publish: (next: AzureTasksSnapshot) => void;
let stop = vi.fn<() => void>();

beforeEach(() => {
	stop = vi.fn();
	vi.mocked(desktop.onAzureTasksUpdated).mockImplementation(async (handler) => {
		publish = handler;
		return stop;
	});
	vi.mocked(desktop.getAzureTasks).mockResolvedValue(snapshot);
	vi.mocked(desktop.refreshAzureTasks).mockResolvedValue(snapshot);
	vi.mocked(desktop.markAzureNotificationsRead).mockResolvedValue({
		...snapshot,
		notifications: snapshot.notifications.map((item) => ({
			...item,
			read: true,
		})),
	});
	vi.mocked(desktop.chooseRepository).mockResolvedValue("/workspace/receitas");
	vi.mocked(desktop.analyzeAzureTask).mockResolvedValue(analysis);
});

function setup(codexReady = true) {
	const onOpenSettings = vi.fn();
	const onUnreadChange = vi.fn();
	const view = render(
		<MyTasksPanel
			codexReady={codexReady}
			onOpenSettings={onOpenSettings}
			onUnreadChange={onUnreadChange}
		/>,
	);
	return { ...view, onOpenSettings, onUnreadChange, user: userEvent.setup() };
}

describe("Minhas tarefas", () => {
	test("exibe avisos retornados em consultas concluídas e orienta a lista vazia", async () => {
		vi.mocked(desktop.getAzureTasks).mockResolvedValueOnce({
			...snapshot,
			items: [],
			notifications: [],
			message:
				"O catálogo de estados não está disponível. A análise foi desativada.",
		});
		setup();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"O catálogo de estados não está disponível",
		);
		expect(
			screen.getByRole("heading", { name: "Nenhum card atribuído a você" }),
		).toBeVisible();
	});
	test("mostra os cards do PAT e atualiza notificações sem repetir a carga inicial", async () => {
		const { user, onUnreadChange, unmount } = setup();
		await screen.findByRole("heading", { name: snapshot.items[0].title });
		expect(screen.getByText("Prioridade 2")).toBeVisible();
		expect(screen.getByText(/a cada 2 minutos/)).toBeVisible();
		expect(onUnreadChange).toHaveBeenLastCalledWith(1);
		expect(toast.success).not.toHaveBeenCalled();
		const updated = {
			...snapshot,
			notifications: [
				{ ...snapshot.notifications[0], id: "123-5" },
				...snapshot.notifications,
			],
		};
		act(() => publish(updated));
		expect(onUnreadChange).toHaveBeenLastCalledWith(2);
		expect(toast.success).toHaveBeenCalledTimes(1);
		act(() => publish(updated));
		expect(toast.success).toHaveBeenCalledTimes(1);
		await user.click(screen.getByText(/Atualizações dos cards/));
		await user.click(
			screen.getByRole("button", { name: "Marcar todas como lidas" }),
		);
		await waitFor(() => expect(onUnreadChange).toHaveBeenLastCalledWith(0));
		expect(desktop.markAzureNotificationsRead).toHaveBeenCalledOnce();
		unmount();
		expect(stop).toHaveBeenCalledOnce();
	});

	test("orienta configuração e escopo do PAT quando não há conexão", async () => {
		vi.mocked(desktop.getAzureTasks).mockResolvedValue({
			...snapshot,
			items: [],
			notifications: [],
			status: "unconfigured",
			lastCheckedAt: null,
			message: "Configure um PAT para acompanhar seus cards.",
		});
		const { user, onOpenSettings } = setup();
		await screen.findByText("Conecte suas tarefas do Azure");
		expect(screen.getByText(/Work Items — Read/)).toBeVisible();
		await user.click(
			screen.getByRole("button", { name: "Abrir Configurações" }),
		);
		expect(onOpenSettings).toHaveBeenCalledOnce();
		expect(desktop.analyzeAzureTask).not.toHaveBeenCalled();
	});

	test("Fazer escolhe um repositório e apresenta o plano sem implementar", async () => {
		const { user } = setup();
		await user.click(
			await screen.findByRole("button", { name: "Fazer análise do card #123" }),
		);
		await screen.findByRole("heading", { name: "Análise e plano · #123" });
		expect(desktop.chooseRepository).toHaveBeenCalledOnce();
		expect(desktop.analyzeAzureTask).toHaveBeenCalledWith({
			workItemId: 123,
			repositoryPath: "/workspace/receitas",
		});
		expect(screen.getByText(analysis.summary)).toBeVisible();
		for (const values of Object.values(analysis).filter(Array.isArray)) {
			for (const value of values) expect(screen.getByText(value)).toBeVisible();
		}
		expect(
			screen.getByText(/Nenhuma implementação foi iniciada/),
		).toBeVisible();
		expect(
			screen.queryByRole("button", { name: /Implementar/ }),
		).not.toBeInTheDocument();
	});

	test("cancelar o seletor não inicia a análise e falhas permitem nova tentativa", async () => {
		vi.mocked(desktop.chooseRepository).mockResolvedValueOnce(null);
		vi.mocked(desktop.analyzeAzureTask).mockRejectedValueOnce(
			"Faça login no Codex.",
		);
		const { user } = setup();
		const button = await screen.findByRole("button", {
			name: "Fazer análise do card #123",
		});
		await user.click(button);
		expect(desktop.analyzeAzureTask).not.toHaveBeenCalled();
		expect(button).toBeEnabled();
		await user.click(button);
		await screen.findByText(
			/Não foi possível analisar o card #123. Faça login no Codex./,
		);
		expect(button).toBeEnabled();
		await user.click(button);
		await screen.findByRole("heading", { name: "Análise e plano · #123" });
	});

	test("impede análises concorrentes e avisa quando o Codex não está pronto", async () => {
		const { rerender, user, onOpenSettings, onUnreadChange } = setup(false);
		const button = await screen.findByRole("button", {
			name: "Fazer análise do card #123",
		});
		expect(button).toBeDisabled();
		expect(screen.getByText(/execute codex login/)).toBeVisible();
		rerender(
			<MyTasksPanel
				codexReady
				onOpenSettings={onOpenSettings}
				onUnreadChange={onUnreadChange}
			/>,
		);
		let resolveAnalysis: ((value: CardAnalysis) => void) | undefined;
		vi.mocked(desktop.analyzeAzureTask).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveAnalysis = resolve;
				}),
		);
		await user.click(button);
		await screen.findByText(/Analisando o card #123 com o Codex/);
		expect(button).toBeDisabled();
		await act(async () => resolveAnalysis?.(analysis));
		expect(button).toBeEnabled();
	});

	test("ignora snapshot inicial atrasado depois de receber um evento mais recente", async () => {
		let finishLoad: ((value: AzureTasksSnapshot) => void) | undefined;
		vi.mocked(desktop.getAzureTasks).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishLoad = resolve;
				}),
		);
		setup();
		await waitFor(() => expect(desktop.getAzureTasks).toHaveBeenCalled());
		act(() =>
			publish({
				...snapshot,
				items: [{ ...snapshot.items[0], title: "Título atualizado" }],
			}),
		);
		await act(async () => finishLoad?.(snapshot));
		expect(
			screen.getByRole("heading", { name: "Título atualizado" }),
		).toBeVisible();
		expect(
			screen.queryByRole("heading", { name: snapshot.items[0].title }),
		).not.toBeInTheDocument();
	});

	test("desinscreve listener resolvido após desmontar e descarta análise antiga", async () => {
		let finishListener: ((value: () => void) => void) | undefined;
		vi.mocked(desktop.onAzureTasksUpdated).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishListener = resolve;
				}),
		);
		const view = setup();
		view.unmount();
		await act(async () => finishListener?.(stop));
		expect(stop).toHaveBeenCalledOnce();
		expect(desktop.getAzureTasks).not.toHaveBeenCalled();

		let finishAnalysis: ((value: CardAnalysis) => void) | undefined;
		vi.mocked(desktop.analyzeAzureTask).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishAnalysis = resolve;
				}),
		);
		const next = setup();
		await next.user.click(
			await screen.findByRole("button", { name: "Fazer análise do card #123" }),
		);
		next.unmount();
		await act(async () => finishAnalysis?.(analysis));
		expect(toast.success).not.toHaveBeenCalled();
	});

	test("preserva cards na falha de atualização e permite tentar novamente", async () => {
		vi.mocked(desktop.refreshAzureTasks).mockRejectedValueOnce(
			"PAT expirado. Atualize o PAT em Configurações.",
		);
		const { user } = setup();
		await screen.findByRole("heading", { name: snapshot.items[0].title });
		await user.click(screen.getByRole("button", { name: "Atualizar" }));
		await screen.findByText(/PAT expirado/);
		expect(
			screen.getByRole("heading", { name: snapshot.items[0].title }),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Atualizar" }));
		await waitFor(() =>
			expect(screen.queryByText(/PAT expirado/)).not.toBeInTheDocument(),
		);
	});
});
