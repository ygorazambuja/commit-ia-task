import { Check, Clock3 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import type { GenerationProgress } from "./types";

export interface GenerationActivity {
	startedAt: number;
	events: (GenerationProgress & { receivedAt: number })[];
}

const phases = [
	{ id: "preparing", label: "Preparação" },
	{ id: "generating", label: "Tarefas" },
	{ id: "staging", label: "Stage" },
	{ id: "exporting", label: "CSV" },
	{ id: "azure", label: "Azure" },
	{ id: "timeLog", label: "Time Log" },
] as const;

function duration(milliseconds: number) {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	return `${Math.floor(seconds / 60)
		.toString()
		.padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export default function GenerationFeedback({
	activity,
	provider,
	createAzureTasks,
	registerTimeLog,
}: {
	activity: GenerationActivity;
	provider: string;
	createAzureTasks: boolean;
	registerTimeLog: boolean;
}) {
	const [now, setNow] = useState(Date.now);
	const panel = useRef<HTMLElement>(null);
	useEffect(() => {
		panel.current?.scrollIntoView?.({ block: "start" });
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);

	const progress = activity.events[activity.events.length - 1];
	const steps = phases.filter(
		(phase) =>
			(phase.id !== "azure" || createAzureTasks) &&
			(phase.id !== "timeLog" || (createAzureTasks && registerTimeLog)),
	);
	const currentStep =
		progress.phase === "completed"
			? steps.length
			: steps.findIndex((step) => step.id === progress.phase);
	const count = `${progress.current} de ${progress.total}`;
	const unit =
		progress.phase === "generating"
			? "arquivos analisados"
			: progress.phase === "staging"
				? "arquivos verificados"
				: progress.phase === "azure"
					? "tarefas criadas e vinculadas"
					: "itens processados";
	const hasCount = progress.total > 0;
	const wait = {
		preparing: "Verificando o provedor e as alterações do repositório.",
		generating: `Aguardando respostas do ${provider}. Cada arquivo pode levar alguns minutos.`,
		staging:
			"Conferindo as alterações antes de adicionar cada arquivo ao stage.",
		exporting: "Salvando as tarefas geradas no arquivo CSV.",
		azure:
			"Aguardando o Azure DevOps. As tarefas são criadas e vinculadas uma por vez.",
		timeLog: "Consultando o saldo e registrando as horas no Time Log.",
		completed: "Preparando os resultados para exibição.",
	}[progress.phase];
	const silentFor = now - progress.receivedAt;

	return (
		<section
			aria-labelledby="generationFeedbackTitle"
			className="generation-feedback"
			ref={panel}
		>
			<div className="generation-feedback-heading">
				<h2 id="generationFeedbackTitle">Geração em andamento</h2>
				<span
					className="generation-elapsed"
					role="timer"
					aria-label="Tempo decorrido"
				>
					<Clock3 aria-hidden="true" className="generation-elapsed-icon" />
					{duration(now - activity.startedAt)}
				</span>
			</div>
			<ol className="generation-steps" aria-label="Etapas da geração">
				{steps.map((step, index) => (
					<li
						key={step.id}
						aria-current={index === currentStep ? "step" : undefined}
						data-state={
							index < currentStep
								? "done"
								: index === currentStep
									? "active"
									: "pending"
						}
					>
						{index < currentStep ? (
							<Check aria-hidden="true" className="generation-step-icon" />
						) : (
							<span aria-hidden="true" className="generation-step-icon">
								{index + 1}
							</span>
						)}
						{step.label}
						<span className="sr-only">
							{index < currentStep
								? ": etapa encerrada"
								: index === currentStep
									? ": em andamento"
									: ": pendente"}
						</span>
					</li>
				))}
			</ol>
			<div
				className="generation-current"
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				<Spinner aria-hidden="true" className="generation-current-spinner" />
				<p>{progress.message}</p>
			</div>
			{hasCount ? (
				<p className="generation-count">
					{count} {unit}
				</p>
			) : null}
			<Progress
				aria-label="Progresso da geração"
				aria-valuetext={
					hasCount ? `${count} ${unit} nesta etapa` : progress.message
				}
				className="progress-track"
				value={
					hasCount
						? Math.min(100, (progress.current / progress.total) * 100)
						: null
				}
			/>
			<p className="generation-wait">{wait}</p>
			{silentFor >= 15000 ? (
				<p className="generation-silence">
					Sem nova atualização há {duration(silentFor)}.
				</p>
			) : null}
			{progress.activeFiles.length ? (
				<div className="generation-active-files">
					<h3>Em processamento ({progress.activeFiles.length})</h3>
					<ul aria-label="Arquivos em processamento">
						{progress.activeFiles.map((path) => (
							<li key={path}>{path}</li>
						))}
					</ul>
				</div>
			) : null}
			<details className="generation-history">
				<summary>Atividade recente</summary>
				<ol aria-label="Atualizações recentes">
					{activity.events
						.slice()
						.reverse()
						.map((event) => (
							<li
								key={`${event.receivedAt}-${event.phase}-${event.current}-${event.message}`}
							>
								<span>{duration(event.receivedAt - activity.startedAt)}</span>
								<p>{event.message}</p>
							</li>
						))}
				</ol>
			</details>
		</section>
	);
}
