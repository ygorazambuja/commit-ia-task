import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import GenerationFeedback, {
	type GenerationActivity,
} from "./GenerationFeedback";

const startedAt = new Date("2026-10-07T12:00:00Z").getTime();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(startedAt);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("GenerationFeedback", () => {
	test("mantém tempo e espera visíveis sem inventar progresso enquanto a IA responde", () => {
		const activity: GenerationActivity = {
			startedAt,
			events: [
				{
					phase: "preparing",
					message: "Verificando o repositório",
					current: 0,
					total: 0,
					activeFiles: [],
					receivedAt: startedAt,
				},
				{
					phase: "generating",
					message: "Analisando os arquivos com Codex",
					current: 1,
					total: 3,
					activeFiles: ["src/App.tsx", "src/desktop.ts"],
					receivedAt: startedAt,
				},
			],
		};
		const { rerender, unmount } = render(
			<GenerationFeedback
				activity={activity}
				provider="Codex"
				createAzureTasks={false}
				registerTimeLog={false}
			/>,
		);
		const progress = screen.getByRole("progressbar", {
			name: "Progresso da geração",
		});
		const actualProgress = progress.getAttribute("aria-valuenow");
		expect(screen.getByRole("status")).toHaveTextContent(
			"Analisando os arquivos com Codex",
		);
		expect(screen.getByText("1 de 3 arquivos analisados")).toBeVisible();
		expect(
			within(screen.getByRole("list", { name: "Arquivos em processamento" }))
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["src/App.tsx", "src/desktop.ts"]);
		expect(screen.getByText(/Aguardando respostas do Codex/)).toBeVisible();

		act(() => vi.advanceTimersByTime(14000));
		expect(
			screen.getByRole("timer", { name: "Tempo decorrido" }),
		).toHaveTextContent("00:14");
		expect(screen.queryByText(/Sem nova atualização/)).not.toBeInTheDocument();
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.getByText("Sem nova atualização há 00:15.")).toBeVisible();
		expect(progress).toHaveAttribute("aria-valuenow", actualProgress);

		rerender(
			<GenerationFeedback
				activity={{
					...activity,
					events: [
						...activity.events,
						{
							phase: "generating",
							message: "Tarefas de src/App.tsx recebidas",
							current: 2,
							total: 3,
							activeFiles: ["src/desktop.ts"],
							receivedAt: Date.now(),
						},
					],
				}}
				provider="Codex"
				createAzureTasks={false}
				registerTimeLog={false}
			/>,
		);
		expect(screen.queryByText(/Sem nova atualização/)).not.toBeInTheDocument();
		expect(screen.getByText("2 de 3 arquivos analisados")).toBeVisible();
		expect(
			within(screen.getByRole("list", { name: "Arquivos em processamento" }))
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["src/desktop.ts"]);
		act(() => screen.getByText("Atividade recente").click());
		const history = within(
			screen.getByRole("list", { name: "Atualizações recentes" }),
		).getAllByRole("listitem");
		expect(history[0]).toHaveTextContent(
			"00:15Tarefas de src/App.tsx recebidas",
		);
		expect(history[1]).toHaveTextContent("Analisando os arquivos com Codex");
		expect(history[2]).toHaveTextContent("Verificando o repositório");
		unmount();
	});

	test("reinicia o relógio e usa progresso indeterminado durante a preparação", () => {
		const activity: GenerationActivity = {
			startedAt,
			events: [
				{
					phase: "preparing",
					message: "Verificando o provedor",
					current: 0,
					total: 0,
					activeFiles: [],
					receivedAt: startedAt,
				},
			],
		};
		const { unmount } = render(
			<GenerationFeedback
				activity={activity}
				provider="OpenAI"
				createAzureTasks={false}
				registerTimeLog={true}
			/>,
		);
		expect(screen.getByRole("progressbar")).not.toHaveAttribute(
			"aria-valuenow",
		);
		expect(
			screen.queryByRole("list", { name: "Arquivos em processamento" }),
		).not.toBeInTheDocument();
		const steps = screen.getByRole("list", { name: "Etapas da geração" });
		expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
		expect(within(steps).queryByText("Azure")).not.toBeInTheDocument();
		expect(within(steps).queryByText("Time Log")).not.toBeInTheDocument();
		act(() => vi.advanceTimersByTime(65000));
		expect(screen.getByRole("timer")).toHaveTextContent("01:05");
		unmount();
		expect(vi.getTimerCount()).toBe(0);
		render(
			<GenerationFeedback
				activity={{
					startedAt: Date.now(),
					events: activity.events.map((event) => ({
						...event,
						receivedAt: Date.now(),
					})),
				}}
				provider="OpenAI"
				createAzureTasks={false}
				registerTimeLog={false}
			/>,
		);
		expect(screen.getByRole("timer")).toHaveTextContent("00:00");
		expect(screen.queryByText(/Sem nova atualização/)).not.toBeInTheDocument();
	});

	test("mantém Azure e Time Log pendentes ao concluir a análise dos arquivos", () => {
		const activity: GenerationActivity = {
			startedAt,
			events: [
				{
					phase: "generating",
					message: "Análise dos arquivos concluída",
					current: 2,
					total: 2,
					activeFiles: [],
					receivedAt: startedAt,
				},
			],
		};
		const { rerender } = render(
			<GenerationFeedback
				activity={activity}
				provider="OpenAI"
				createAzureTasks
				registerTimeLog
			/>,
		);
		const steps = within(
			screen.getByRole("list", { name: "Etapas da geração" }),
		);
		expect(steps.getByText("Tarefas")).toHaveAttribute("aria-current", "step");
		expect(steps.getByText("Azure")).toHaveTextContent("pendente");
		expect(steps.getByText("Time Log")).toHaveTextContent("pendente");
		expect(screen.getByRole("progressbar")).toHaveAttribute(
			"aria-valuetext",
			"2 de 2 arquivos analisados nesta etapa",
		);
		rerender(
			<GenerationFeedback
				activity={{
					...activity,
					events: [
						...activity.events,
						{
							phase: "azure",
							message: "Criando e vinculando tarefas no Azure",
							current: 1,
							total: 2,
							activeFiles: [],
							receivedAt: startedAt,
						},
					],
				}}
				provider="OpenAI"
				createAzureTasks
				registerTimeLog
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Criando e vinculando tarefas no Azure",
		);
		expect(steps.getByText("Azure")).toHaveAttribute("aria-current", "step");
		expect(steps.getByText("Time Log")).toHaveTextContent("pendente");
		expect(screen.getByRole("progressbar")).toHaveAttribute(
			"aria-valuenow",
			"50",
		);
		expect(screen.getByRole("progressbar")).toHaveAttribute(
			"aria-valuetext",
			"1 de 2 tarefas criadas e vinculadas nesta etapa",
		);
		rerender(
			<GenerationFeedback
				activity={{
					...activity,
					events: [
						...activity.events,
						{
							phase: "timeLog",
							message: "Consultando o saldo de horas",
							current: 0,
							total: 0,
							activeFiles: [],
							receivedAt: startedAt,
						},
					],
				}}
				provider="OpenAI"
				createAzureTasks
				registerTimeLog
			/>,
		);
		expect(steps.getByText("Time Log")).toHaveAttribute("aria-current", "step");
		expect(screen.getByRole("progressbar")).not.toHaveAttribute(
			"aria-valuenow",
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Consultando o saldo de horas",
		);
	});
});
