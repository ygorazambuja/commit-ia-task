import { AlertCircle, Check, Clock3, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Spinner } from "./components/ui/spinner";
import type { TimeLogBatchResult, TimeLogPlanEntry } from "./types";

interface TimeLogBatchFeedbackProps {
	result?: TimeLogBatchResult;
	error?: string;
	isRetrying?: boolean;
	onRetry?: () => void;
}

export function durationLabel(minutes: number): string {
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return (
		[hours ? `${hours}h` : "", remainingMinutes ? `${remainingMinutes}min` : ""]
			.filter(Boolean)
			.join(" ") || "0min"
	);
}

function dateLabel(date: string): string {
	const [year, month, day] = date.split("-");
	return year && month && day ? `${day}/${month}/${year}` : date;
}

function entryLabel(entry: TimeLogPlanEntry): string {
	return `${dateLabel(entry.date)} · ${entry.type} ${durationLabel(entry.minutes)}`;
}

export default function TimeLogBatchFeedback({
	result,
	error,
	isRetrying = false,
	onRetry,
}: TimeLogBatchFeedbackProps) {
	if (!result && !error) return null;

	const noWork = result?.plan.requestedMinutes === 0;
	const missingCapacity = Boolean(result?.plan.missingMinutes);
	const failure = result?.failure;
	const hasProblem = Boolean(error || missingCapacity || failure);
	const documentIds =
		result?.created.flatMap(({ documentId }) =>
			documentId ? [documentId] : [],
		) ?? [];
	const matchesEntry = (left: TimeLogPlanEntry, right: TimeLogPlanEntry) =>
		left.date === right.date && left.type === right.type;

	return (
		<Alert
			className={`time-log-batch-feedback ${hasProblem ? "inline-warning" : "is-success"}`}
			role={hasProblem ? "alert" : "status"}
			variant={failure?.indeterminate ? "destructive" : "default"}
		>
			{hasProblem ? (
				<AlertCircle aria-hidden="true" />
			) : noWork ? (
				<Clock3 aria-hidden="true" />
			) : (
				<Check aria-hidden="true" />
			)}
			<AlertTitle>
				{error
					? "Time Log não concluído"
					: failure
						? failure.indeterminate
							? "Resultado do Time Log indeterminado"
							: result?.created.length
								? "Time Log parcialmente registrado"
								: "Time Log não registrado"
						: missingCapacity
							? "Período sem capacidade suficiente"
							: noWork
								? "Nenhuma hora para registrar"
								: "Horas registradas no Time Log"}
			</AlertTitle>
			<AlertDescription>
				{error ? <p>{error}</p> : null}

				{result && !noWork ? (
					<p>
						Solicitadas {durationLabel(result.plan.requestedMinutes)}.
						Programadas {durationLabel(result.plan.scheduledMinutes)}.
						{result.plan.missingMinutes
							? ` Faltaram ${durationLabel(result.plan.missingMinutes)}.`
							: ""}
					</p>
				) : null}

				{missingCapacity ? (
					<p>
						Nenhum lançamento foi criado. Amplie o período para acomodar todas
						as horas antes de tentar novamente.
					</p>
				) : null}

				{result?.plan.days.length ? (
					<ul className="time-log-day-list">
						{result.plan.days.map((day) => {
							const confirmedMinutes = result.created
								.filter(({ entry }) => entry.date === day.date)
								.reduce((total, { entry }) => total + entry.minutes, 0);
							const completedDay = day.entries.every((entry) =>
								result.created.some(({ entry: item }) =>
									matchesEntry(item, entry),
								),
							);
							return (
								<li key={day.date}>
									<strong>{dateLabel(day.date)}</strong>{" "}
									<span>
										já existiam {durationLabel(day.existingMinutes)}
										{day.entries.map((entry) => (
											<span key={entry.type}>
												{" · "}
												{entry.type} {durationLabel(entry.minutes)}
											</span>
										))}
										{completedDay ? " · total " : " · total planejado "}
										{durationLabel(day.totalMinutes)}
										{completedDay
											? ""
											: ` · total confirmado ${durationLabel(day.existingMinutes + confirmedMinutes)}`}
									</span>
									{day.entries.length ? (
										<small>
											{day.entries.map((entry) => {
												const created = result.created.find(({ entry: item }) =>
													matchesEntry(item, entry),
												);
												const failed =
													failure && matchesEntry(failure.entry, entry);
												const pending = result.pending.some((item) =>
													matchesEntry(item, entry),
												);
												const state = created
													? created.documentId
														? `registrado · documento ${created.documentId}`
														: "registrado"
													: failed
														? failure.indeterminate
															? "incerto"
															: "falhou"
														: pending
															? "pendente"
															: "planejado";
												return (
													<span key={entry.type}>
														{entry.type}: {state}.{" "}
													</span>
												);
											})}
										</small>
									) : null}
								</li>
							);
						})}
					</ul>
				) : null}

				{documentIds.length ? (
					<p>
						<strong>Documentos:</strong> {documentIds.join(", ")}.
					</p>
				) : null}

				{failure ? (
					<p>
						<strong>{failure.indeterminate ? "Confira" : "Falha"}:</strong>{" "}
						{entryLabel(failure.entry)}. {failure.error}
						{failure.indeterminate
							? " Confira o Time Log Free antes de fazer outro lançamento."
							: ""}
					</p>
				) : null}

				{result?.pending.length ? (
					<p>
						<strong>Pendentes:</strong>{" "}
						{result.pending.map(entryLabel).join("; ")}.
					</p>
				) : null}

				{onRetry ? (
					<Button
						aria-busy={isRetrying}
						disabled={isRetrying}
						onClick={onRetry}
						type="button"
						variant="outline"
					>
						{isRetrying ? (
							<>
								<Spinner aria-hidden="true" />
								Registrando novamente…
							</>
						) : (
							<>
								<RotateCcw aria-hidden="true" />
								Tentar novamente somente o Time Log
							</>
						)}
					</Button>
				) : null}
			</AlertDescription>
		</Alert>
	);
}
