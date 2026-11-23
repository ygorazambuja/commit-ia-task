import { useEffect, useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./components/ui/select";
import type { AiModelCatalog, AiProviderCapability } from "./types";

export default function AiModelFields({
	provider,
	catalog,
	loading,
	model,
	effort,
	onModelChange,
	onEffortChange,
	disabled,
	prefix,
}: {
	provider: AiProviderCapability;
	catalog?: AiModelCatalog;
	loading?: boolean;
	model: string;
	effort: string;
	onModelChange: (value: string) => void;
	onEffortChange: (value: string) => void;
	disabled: boolean;
	prefix: string;
}) {
	const models = catalog?.models ?? provider.models;
	const selected = models.find((item) => item.value === model);
	const [effortNotice, setEffortNotice] = useState("");
	const missing = Boolean(model && !selected);
	const unavailable = missing && Boolean(catalog);
	useEffect(() => {
		if (
			provider.id !== "codex" ||
			!selected ||
			selected.reasoningEfforts.some((item) => item.value === effort)
		)
			return;
		const next = selected.defaultReasoningEffort;
		if (next) {
			onEffortChange(next);
			setEffortNotice(
				`Esforço de raciocínio ajustado para ${next}, padrão do modelo selecionado.`,
			);
		}
	}, [provider.id, selected, effort, onEffortChange]);
	const options = missing
		? [
				{
					value: model,
					label: `${model} — ${unavailable ? "indisponível" : "seleção salva"}`,
				},
				...models,
			]
		: models;
	return (
		<>
			<div className="field model-selector">
				<label htmlFor={`${prefix}AiModel`}>
					{prefix === "settings" ? "Modelo" : "Modelo para geração"}
				</label>
				<Select
					disabled={disabled}
					items={Object.fromEntries(
						options.map(({ value, label }) => [value, label]),
					)}
					value={model}
					onValueChange={(value) => {
						if (value) {
							onModelChange(value);
							setEffortNotice("");
						}
					}}
				>
					<SelectTrigger id={`${prefix}AiModel`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent align="start">
						{options.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{unavailable ? (
					<span role="status" className="field-error">
						O modelo salvo está indisponível. Escolha outro modelo antes de
						gerar.
					</span>
				) : null}
				{selected && !selected.compatibilityVerified ? (
					<span className="field-hint">
						Compatibilidade ainda não verificada
					</span>
				) : null}
			</div>
			{provider.id === "codex" && selected?.reasoningEfforts.length ? (
				<div className="field model-selector">
					<label htmlFor={`${prefix}CodexReasoningEffort`}>
						{prefix === "settings"
							? "Esforço de raciocínio"
							: "Esforço de raciocínio para geração"}
					</label>
					<Select
						disabled={disabled}
						items={Object.fromEntries(
							selected.reasoningEfforts.map(({ value, label }) => [
								value,
								label,
							]),
						)}
						value={effort}
						onValueChange={(value) => {
							if (value) {
								onEffortChange(value);
								setEffortNotice("");
							}
						}}
					>
						<SelectTrigger id={`${prefix}CodexReasoningEffort`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent align="start">
							{selected.reasoningEfforts.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}
			{provider.id === "codex" && effortNotice ? (
				<p role="status" className="field-hint">
					{effortNotice}
				</p>
			) : null}
			<p aria-live="polite" className="field-hint model-catalog-status">
				{loading
					? "Atualizando modelos automaticamente…"
					: catalog?.source === "provider"
						? "Catálogo consultado no provedor."
						: "Catálogo local de reserva."}
			</p>
			{catalog?.warnings.map((warning) => (
				<p key={warning} role="status" className="field-error">
					{warning}
				</p>
			))}
		</>
	);
}
