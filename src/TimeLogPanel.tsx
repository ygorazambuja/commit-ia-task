import { Clock3, Info, LockKeyhole } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "./components/ui/field";
import { Input } from "./components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "./components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./components/ui/select";
import { Spinner } from "./components/ui/spinner";
import { Textarea } from "./components/ui/textarea";
import { createTimeLog } from "./desktop";
import TimeLogBatchFeedback from "./TimeLogBatchFeedback";
import type { TimeLogBatchResult, TimeLogInput, TimeLogType } from "./types";

interface TimeLogPanelProps {
	organization?: string;
}

interface TimeLogFormState {
	workItemId: string;
	hours: string;
	minutes: string;
	startDate: string;
	endDate: string;
	type: TimeLogType;
	comment: string;
}

type TimeLogField =
	| "workItemId"
	| "hours"
	| "minutes"
	| "startDate"
	| "endDate"
	| "comment";

type TimeLogErrors = Partial<Record<TimeLogField, string>>;

function localDate(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

function errorMessage(error: unknown): string {
	if (typeof error === "string" && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;
	return "Não foi possível registrar as horas.";
}

export default function TimeLogPanel({ organization = "" }: TimeLogPanelProps) {
	const today = localDate();
	const [form, setForm] = useState<TimeLogFormState>(() => {
		const initialDate = localDate();
		return {
			workItemId: "",
			hours: "0",
			minutes: "0",
			startDate: initialDate,
			endDate: initialDate,
			type: "Backend",
			comment: "",
		};
	});
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState("");
	const [fieldErrors, setFieldErrors] = useState<TimeLogErrors>({});
	const [result, setResult] = useState<TimeLogBatchResult | null>(null);
	const formRef = useRef<HTMLFormElement>(null);

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError("");
		setFieldErrors({});
		setResult(null);

		const workItemId = Number(form.workItemId);
		const hours = Number(form.hours);
		const minutes = Number(form.minutes);

		const validationErrors: TimeLogErrors = {};
		if (!Number.isInteger(workItemId) || workItemId <= 0) {
			validationErrors.workItemId =
				"Use um ID inteiro e maior que zero. Exemplo: 201878.";
		}

		if (form.hours === "" || !Number.isInteger(hours) || hours < 0) {
			validationErrors.hours =
				"Informe um número inteiro igual ou maior que 0.";
		}
		if (
			form.minutes === "" ||
			!Number.isInteger(minutes) ||
			minutes < 0 ||
			minutes > 59
		) {
			validationErrors.minutes = "Informe minutos entre 0 e 59.";
		}

		if (
			!validationErrors.hours &&
			!validationErrors.minutes &&
			hours === 0 &&
			minutes === 0
		) {
			validationErrors.hours = "Informe pelo menos uma hora ou um minuto.";
		}

		if (!form.startDate) {
			validationErrors.startDate = "Informe a data inicial.";
		} else if (form.startDate > today) {
			validationErrors.startDate = "A data inicial não pode estar no futuro.";
		}
		if (!form.endDate) {
			validationErrors.endDate = "Informe a data final.";
		} else if (form.endDate > today) {
			validationErrors.endDate = "A data final não pode estar no futuro.";
		} else if (form.startDate && form.endDate < form.startDate) {
			validationErrors.endDate =
				"A data final deve ser igual ou posterior à data inicial.";
		}
		if (!form.comment.trim()) {
			validationErrors.comment = "Resuma o trabalho realizado.";
		}

		const firstInvalidField = Object.keys(validationErrors)[0];
		if (firstInvalidField) {
			setFieldErrors(validationErrors);
			requestAnimationFrame(() => {
				formRef.current
					?.querySelector<HTMLElement>(`[name="${firstInvalidField}"]`)
					?.focus();
			});
			return;
		}

		const configuredOrganization = organization.trim();
		if (!configuredOrganization) {
			setError("Configure a organização do Azure DevOps em Configurações.");
			return;
		}

		const input: TimeLogInput = {
			workItemId,
			startDate: form.startDate,
			endDate: form.endDate,
			work: [
				{
					minutes: hours * 60 + minutes,
					type: form.type,
					comment: form.comment.trim(),
				},
			],
			organization: configuredOrganization,
		};

		setIsSubmitting(true);

		try {
			setResult(await createTimeLog(input));
		} catch (submissionError) {
			setError(errorMessage(submissionError));
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<section aria-labelledby="timeLogTitle" className="time-log-panel">
			<div className="time-log-heading">
				<div className="time-log-title">
					<span aria-hidden="true" className="time-log-title-icon">
						<Clock3 />
					</span>
					<div>
						<h2 id="timeLogTitle">Registrar horas</h2>
						<p>
							Envie o tempo trabalhado diretamente para o Time Log Free do Azure
							DevOps.
						</p>
					</div>
				</div>
				<Badge className="time-log-session-note" variant="outline">
					<LockKeyhole />
					Autenticação pelas configurações
				</Badge>
			</div>

			<form
				aria-busy={isSubmitting}
				className="time-log-form"
				noValidate
				onSubmit={handleSubmit}
				ref={formRef}
			>
				<div className="time-log-form-content">
					<FieldSet className="time-log-section">
						<FieldLegend>Detalhes do trabalho</FieldLegend>
						<FieldDescription className="time-log-section-description">
							Informe onde, quando e por quanto tempo o trabalho foi realizado.
						</FieldDescription>

						<div className="time-log-entry-grid">
							<Field
								className="field time-log-work-item"
								data-invalid={Boolean(fieldErrors.workItemId)}
							>
								<FieldLabel htmlFor="timeLogWorkItemId">
									ID do work item
								</FieldLabel>
								<Input
									aria-describedby={
										fieldErrors.workItemId
											? "timeLogWorkItemIdError"
											: undefined
									}
									aria-invalid={Boolean(fieldErrors.workItemId)}
									disabled={isSubmitting}
									id="timeLogWorkItemId"
									inputMode="numeric"
									name="workItemId"
									onChange={(event) =>
										setForm((current) => ({
											...current,
											workItemId: event.target.value,
										}))
									}
									placeholder="Ex.: 201878"
									pattern="[0-9]*"
									required
									type="text"
									value={form.workItemId}
								/>
								<FieldError id="timeLogWorkItemIdError">
									{fieldErrors.workItemId}
								</FieldError>
							</Field>

							<Field
								aria-labelledby="timeLogDurationLabel"
								className="field time-log-duration"
								data-invalid={Boolean(fieldErrors.hours || fieldErrors.minutes)}
								role="group"
							>
								<FieldLabel id="timeLogDurationLabel">Duração</FieldLabel>
								<div className="time-log-duration-inputs">
									<Field
										className="time-log-duration-field"
										data-invalid={Boolean(fieldErrors.hours)}
									>
										<FieldLabel className="sr-only" htmlFor="timeLogHours">
											Horas
										</FieldLabel>
										<InputGroup className="time-log-duration-control">
											<InputGroupInput
												aria-describedby={
													fieldErrors.hours ? "timeLogHoursError" : undefined
												}
												aria-invalid={Boolean(fieldErrors.hours)}
												aria-label="Horas"
												disabled={isSubmitting}
												id="timeLogHours"
												inputMode="numeric"
												min="0"
												name="hours"
												onChange={(event) =>
													setForm((current) => ({
														...current,
														hours: event.target.value,
													}))
												}
												required
												step="1"
												type="number"
												value={form.hours}
											/>
											<InputGroupAddon align="inline-end">
												<InputGroupText>h</InputGroupText>
											</InputGroupAddon>
										</InputGroup>
										<FieldError id="timeLogHoursError">
											{fieldErrors.hours}
										</FieldError>
									</Field>
									<Field
										className="time-log-duration-field"
										data-invalid={Boolean(fieldErrors.minutes)}
									>
										<FieldLabel className="sr-only" htmlFor="timeLogMinutes">
											Minutos
										</FieldLabel>
										<InputGroup className="time-log-duration-control">
											<InputGroupInput
												aria-describedby={
													fieldErrors.minutes
														? "timeLogMinutesError"
														: undefined
												}
												aria-invalid={Boolean(fieldErrors.minutes)}
												aria-label="Minutos"
												disabled={isSubmitting}
												id="timeLogMinutes"
												inputMode="numeric"
												max="59"
												min="0"
												name="minutes"
												onChange={(event) =>
													setForm((current) => ({
														...current,
														minutes: event.target.value,
													}))
												}
												required
												step="1"
												type="number"
												value={form.minutes}
											/>
											<InputGroupAddon align="inline-end">
												<InputGroupText>min</InputGroupText>
											</InputGroupAddon>
										</InputGroup>
										<FieldError id="timeLogMinutesError">
											{fieldErrors.minutes}
										</FieldError>
									</Field>
								</div>
							</Field>

							<Field
								className="field time-log-start-date"
								data-invalid={Boolean(fieldErrors.startDate)}
							>
								<FieldLabel htmlFor="timeLogStartDate">Data inicial</FieldLabel>
								<Input
									aria-describedby={
										fieldErrors.startDate ? "timeLogStartDateError" : undefined
									}
									aria-invalid={Boolean(fieldErrors.startDate)}
									disabled={isSubmitting}
									id="timeLogStartDate"
									max={today}
									name="startDate"
									onChange={(event) =>
										setForm((current) => ({
											...current,
											startDate: event.target.value,
										}))
									}
									required
									type="date"
									value={form.startDate}
								/>
								<FieldError id="timeLogStartDateError">
									{fieldErrors.startDate}
								</FieldError>
							</Field>

							<Field
								className="field time-log-end-date"
								data-invalid={Boolean(fieldErrors.endDate)}
							>
								<FieldLabel htmlFor="timeLogEndDate">Data final</FieldLabel>
								<Input
									aria-describedby={
										fieldErrors.endDate ? "timeLogEndDateError" : undefined
									}
									aria-invalid={Boolean(fieldErrors.endDate)}
									disabled={isSubmitting}
									id="timeLogEndDate"
									max={today}
									name="endDate"
									onChange={(event) =>
										setForm((current) => ({
											...current,
											endDate: event.target.value,
										}))
									}
									required
									type="date"
									value={form.endDate}
								/>
								<FieldError id="timeLogEndDateError">
									{fieldErrors.endDate}
								</FieldError>
							</Field>

							<Field className="field time-log-type">
								<FieldLabel htmlFor="timeLogType">Tipo</FieldLabel>
								<Select
									disabled={isSubmitting}
									items={{
										Backend: "Backend",
										Frontend: "Frontend",
										Teste: "Teste",
										Análise: "Análise",
										Reunião: "Reunião",
									}}
									onValueChange={(value) =>
										setForm((current) => ({
											...current,
											type: value as TimeLogType,
										}))
									}
									value={form.type}
								>
									<SelectTrigger
										aria-label="Tipo"
										className="time-log-select"
										id="timeLogType"
										name="type"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent align="start">
										<SelectItem value="Backend">Backend</SelectItem>
										<SelectItem value="Frontend">Frontend</SelectItem>
										<SelectItem value="Teste">Teste</SelectItem>
										<SelectItem value="Análise">Análise</SelectItem>
										<SelectItem value="Reunião">Reunião</SelectItem>
									</SelectContent>
								</Select>
							</Field>

							<Field
								className="field time-log-comment"
								data-invalid={Boolean(fieldErrors.comment)}
							>
								<FieldLabel htmlFor="timeLogComment">
									Trabalho realizado
								</FieldLabel>
								<Textarea
									aria-describedby={
										fieldErrors.comment ? "timeLogCommentError" : undefined
									}
									aria-invalid={Boolean(fieldErrors.comment)}
									disabled={isSubmitting}
									id="timeLogComment"
									name="comment"
									onChange={(event) =>
										setForm((current) => ({
											...current,
											comment: event.target.value,
										}))
									}
									placeholder="Resuma o que foi concluído neste work item"
									required
									rows={3}
									value={form.comment}
								/>
								<FieldError id="timeLogCommentError">
									{fieldErrors.comment}
								</FieldError>
							</Field>
						</div>
					</FieldSet>

					<TimeLogBatchFeedback
						error={error || undefined}
						result={result || undefined}
					/>
				</div>

				<div className="time-log-actions">
					<div className="time-log-action-note">
						<Info />
						<p>
							<strong>Evite lançamentos duplicados.</strong>
							<span>
								Se houver falha de rede, confira o Time Log Free antes de tentar
								novamente.
							</span>
						</p>
					</div>
					<Button
						aria-busy={isSubmitting}
						className="primary-button"
						disabled={isSubmitting}
						type="submit"
					>
						{isSubmitting ? (
							<>
								<Spinner aria-hidden="true" />
								Registrando…
							</>
						) : (
							"Registrar horas"
						)}
					</Button>
				</div>
			</form>
		</section>
	);
}
