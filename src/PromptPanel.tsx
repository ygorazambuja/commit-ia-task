import { CircleAlert, MessageSquareText, RotateCcw, Save } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
} from "./components/ui/field";
import { Spinner } from "./components/ui/spinner";
import { Textarea } from "./components/ui/textarea";
import { toast } from "./components/ui/toast";
import { savePromptSettings } from "./desktop";
import type { PromptSettings } from "./types";

interface PromptPanelProps {
	settings: PromptSettings;
	defaultSystemPrompt: string;
	onSaved: (settings: PromptSettings) => void;
}

export default function PromptPanel({
	settings,
	defaultSystemPrompt,
	onSaved,
}: PromptPanelProps) {
	const [draft, setDraft] = useState(settings.systemPrompt);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState("");
	const [isInvalid, setIsInvalid] = useState(false);
	const hasChanges = draft !== settings.systemPrompt;

	const updateDraft = (value: string) => {
		setDraft(value);
		setError("");
		setIsInvalid(false);
	};

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSaving || !hasChanges) return;
		setError("");
		if (!draft.trim()) {
			setIsInvalid(true);
			return;
		}

		setIsInvalid(false);
		setIsSaving(true);
		try {
			const saved = await savePromptSettings({ systemPrompt: draft });
			setDraft(saved.systemPrompt);
			onSaved(saved);
			toast.success(
				"Instruções salvas",
				"A próxima geração usará estas instruções.",
			);
		} catch (saveError) {
			const detail =
				typeof saveError === "string"
					? saveError
					: saveError instanceof Error
						? saveError.message
						: "Tente salvar novamente.";
			setError(detail || "Tente salvar novamente.");
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<section aria-labelledby="promptsTitle" className="prompts-panel">
			<header className="prompts-heading">
				<div className="prompts-title">
					<span aria-hidden="true" className="prompts-title-icon">
						<MessageSquareText className="size-[19px]" />
					</span>
					<div>
						<h2 id="promptsTitle">Prompts de geração</h2>
						<p>
							As mesmas instruções são usadas pelo OpenAI e pelo Codex em todos
							os repositórios.
						</p>
					</div>
				</div>
			</header>

			<form aria-busy={isSaving} onSubmit={handleSubmit}>
				<div className="prompts-editor">
					<Field data-invalid={isInvalid || undefined}>
						<FieldLabel htmlFor="systemPrompt">
							Instruções de geração
						</FieldLabel>
						<FieldDescription id="systemPromptDescription">
							Defina como agrupar e descrever as tarefas. O aplicativo envia o
							arquivo e o diff automaticamente.
						</FieldDescription>
						<Textarea
							aria-describedby={`systemPromptDescription${isInvalid ? " systemPromptError" : ""}`}
							aria-invalid={isInvalid || undefined}
							className="prompts-textarea"
							disabled={isSaving}
							id="systemPrompt"
							onChange={(event) => updateDraft(event.target.value)}
							value={draft}
						/>
						{isInvalid ? (
							<FieldError id="systemPromptError" role="alert">
								As instruções não podem ficar vazias.
							</FieldError>
						) : null}
					</Field>
					{error ? (
						<Alert className="prompts-error" variant="destructive">
							<CircleAlert aria-hidden="true" />
							<AlertTitle>Não foi possível salvar as instruções</AlertTitle>
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<section
						aria-labelledby="csvLegendTitle"
						className="prompts-csv-legend"
					>
						<h3 id="csvLegendTitle">Como o CSV é gerado para importação</h3>
						<p>
							O prompt orienta o conteúdo das tarefas. O aplicativo aplica estas
							regras ao montar o arquivo:
						</p>
						<dl>
							<div>
								<dt>Origem dos campos</dt>
								<dd>
									A IA gera título, descrição, tipo, complexidade e estimativa.
									Responsável vem de Configurações; Área, Sprint e Item de
									contrato vêm do formulário de geração.
								</dd>
							</div>
							<div>
								<dt>Linhas e valores fixos</dt>
								<dd>
									Cada tarefa ocupa uma linha com ID vazio. Work Item Type:
									Task; State: To Do; Activity: Development.
								</dd>
							</div>
							<div>
								<dt>Tipo e ID SPF</dt>
								<dd>Backend: 17 · Frontend: 19 · Testes: 22.</dd>
							</div>
							<div>
								<dt>Complexidade e UST</dt>
								<dd>
									BAIXA: 8 · MEDIA: 24 · ALTA: 40 · ÚNICA: 8. Complexidade
									inválida usa ÚNICA.
								</dd>
							</div>
							<div>
								<dt>Estimativas</dt>
								<dd>
									O inteiro de 1 a 8 é repetido em Estimate Made, Remaining Work
									e Original Estimate. Valores inválidos usam 1.
								</dd>
							</div>
							<div>
								<dt>Arquivo gerado</dt>
								<dd>
									Salvo na raiz do repositório como{" "}
									<code>tasks-dia-mês-hora-minuto.csv</code>, com sufixo
									numérico quando o nome já existe.
								</dd>
							</div>
						</dl>
					</section>
				</div>

				<div className="prompts-actions">
					<div className="prompts-save-status" role="status">
						<strong>{hasChanges ? "Alterações não salvas" : "Salvo"}</strong>
						<span>As alterações salvas valem para a próxima geração.</span>
					</div>
					<div className="prompts-buttons">
						<Button
							disabled={isSaving || draft === defaultSystemPrompt}
							onClick={() => updateDraft(defaultSystemPrompt)}
							type="button"
							variant="ghost"
						>
							<RotateCcw aria-hidden="true" />
							Restaurar padrão
						</Button>
						<Button
							disabled={isSaving || !hasChanges}
							onClick={() => updateDraft(settings.systemPrompt)}
							type="button"
							variant="outline"
						>
							Descartar alterações
						</Button>
						<Button disabled={isSaving || !hasChanges} type="submit">
							{isSaving ? (
								<Spinner aria-hidden="true" />
							) : (
								<Save aria-hidden="true" />
							)}
							{isSaving ? "Salvando…" : "Salvar"}
						</Button>
					</div>
				</div>
			</form>
		</section>
	);
}
