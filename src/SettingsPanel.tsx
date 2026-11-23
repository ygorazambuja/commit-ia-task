import { CheckCircle2, KeyRound, Settings2 } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import AiModelFields from "./AiModelFields";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import { Spinner } from "./components/ui/spinner";
import { identifyAzureUser, saveAppSettings } from "./desktop";
import type {
	AiModelCatalog,
	AiProvider,
	InitialState,
	SaveAppSettingsResult,
} from "./types";

type SettingsField =
	| "displayName"
	| "email"
	| "azureOrganization"
	| "azureProject"
	| "timeLogPat";

type SettingsErrors = Partial<Record<SettingsField, string>>;
type PatMode = "existing" | "entry" | "remove";

interface SettingsPanelProps {
	initialState: InitialState;
	catalogs: Partial<Record<AiProvider, AiModelCatalog>>;
	modelsLoading: Partial<Record<AiProvider, boolean>>;
	mode: "onboarding" | "edit";
	onCancel: () => void;
	onSaved: (result: SaveAppSettingsResult) => void;
	onSkip: () => void;
}

function errorMessage(error: unknown): string {
	if (typeof error === "string" && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;
	return "Não foi possível concluir a configuração.";
}

function isCorporateEmail(value: string): boolean {
	const match = value.trim().match(/^([A-Z0-9._%+-]+)@infortechms\.com\.br$/i);
	return Boolean(
		match &&
			!match[1].startsWith(".") &&
			!match[1].endsWith(".") &&
			!match[1].includes(".."),
	);
}

function isDisplayName(value: string): boolean {
	const displayName = value.trim();
	return Boolean(
		displayName &&
			![...displayName].some((character) => {
				const code = character.charCodeAt(0);
				return (
					character === "<" ||
					character === ">" ||
					code <= 0x1f ||
					(code >= 0x7f && code <= 0x9f)
				);
			}),
	);
}

function isAzureOrganization(value: string): boolean {
	const organization = value
		.trim()
		.replace(/^https:\/\/dev\.azure\.com\//i, "")
		.replace(/\/$/, "");
	return /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/i.test(organization);
}

export default function SettingsPanel({
	initialState,
	catalogs,
	modelsLoading,
	mode,
	onCancel,
	onSaved,
	onSkip,
}: SettingsPanelProps) {
	const [displayName, setDisplayName] = useState(
		initialState.profile.displayName,
	);
	const [email, setEmail] = useState(initialState.profile.email);
	const [azureOrganization, setAzureOrganization] = useState(
		initialState.config.azureOrganization ||
			initialState.azureDefaults.organization,
	);
	const [azureProject, setAzureProject] = useState(
		initialState.config.azureProject || initialState.azureDefaults.project,
	);
	const [aiProvider, setAiProvider] = useState<AiProvider>(
		initialState.config.aiProvider,
	);
	const [openaiModel, setOpenaiModel] = useState(
		initialState.config.openaiModel,
	);
	const [codexModel, setCodexModel] = useState(initialState.config.codexModel);
	const [codexReasoningEffort, setCodexReasoningEffort] = useState(
		initialState.config.codexReasoningEffort,
	);
	const [timeLogPat, setTimeLogPat] = useState("");
	const [patMode, setPatMode] = useState<PatMode>(
		initialState.timeLogPatConfigured ? "existing" : "entry",
	);
	const [fieldErrors, setFieldErrors] = useState<SettingsErrors>({});
	const [error, setError] = useState("");
	const [identityStatus, setIdentityStatus] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [isVerifying, setIsVerifying] = useState(false);
	const formRef = useRef<HTMLFormElement>(null);
	const verifiedPatRef = useRef("");
	const verifiedOrganizationRef = useRef("");

	const clearSecret = () => {
		setTimeLogPat("");
		verifiedPatRef.current = "";
		verifiedOrganizationRef.current = "";
	};

	const invalidateVerification = () => {
		verifiedPatRef.current = "";
		verifiedOrganizationRef.current = "";
		setIdentityStatus("");
	};

	const focusFirstError = (errors: SettingsErrors) => {
		const field = Object.keys(errors)[0];
		if (!field) return;
		requestAnimationFrame(() => {
			formRef.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus();
		});
	};

	const validate = (): SettingsErrors => {
		const errors: SettingsErrors = {};
		if (!isDisplayName(displayName)) {
			errors.displayName = "Informe um nome sem os caracteres < ou >.";
		}
		if (!isCorporateEmail(email)) {
			errors.email = "Use seu e-mail @infortechms.com.br.";
		}
		if (!isAzureOrganization(azureOrganization)) {
			errors.azureOrganization =
				"Use o nome da organização ou https://dev.azure.com/organizacao.";
		}
		if (!azureProject.trim()) {
			errors.azureProject = "Informe o projeto do Azure DevOps.";
		}
		if (patMode === "remove" && timeLogPat.trim()) {
			errors.timeLogPat =
				"Remoção e substituição de PAT não podem ser combinadas.";
		}
		return errors;
	};

	const handleVerifyPat = async () => {
		setError("");
		setIdentityStatus("");
		const errors: SettingsErrors = {};
		if (!isAzureOrganization(azureOrganization)) {
			errors.azureOrganization =
				"Use o nome da organização ou https://dev.azure.com/organizacao.";
		}
		if (!timeLogPat.trim()) errors.timeLogPat = "Informe o PAT para verificar.";
		setFieldErrors(errors);
		focusFirstError(errors);
		if (Object.keys(errors).length) return;

		const pat = timeLogPat.trim();
		const organization = azureOrganization.trim();
		setIsVerifying(true);
		try {
			const identity = await identifyAzureUser({ organization, pat });
			verifiedPatRef.current = pat;
			verifiedOrganizationRef.current = organization;
			const verifiedDisplayName = identity.displayName.trim();
			if (!isDisplayName(displayName) && isDisplayName(verifiedDisplayName)) {
				setDisplayName(verifiedDisplayName);
			}
			const hasCorporateEmail = Boolean(
				identity.email && isCorporateEmail(identity.email),
			);
			if (!isCorporateEmail(email) && identity.email && hasCorporateEmail) {
				setEmail(identity.email.trim());
			}
			setIdentityStatus(
				hasCorporateEmail
					? `PAT verificado para ${identity.displayName} (${identity.email}).`
					: `PAT verificado para ${identity.displayName}. Confirme o e-mail manualmente.`,
			);
		} catch (verificationError) {
			verifiedPatRef.current = "";
			verifiedOrganizationRef.current = "";
			setError(
				`Não foi possível verificar o PAT: ${errorMessage(verificationError)}`,
			);
		} finally {
			setTimeLogPat("");
			setIsVerifying(false);
		}
	};

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError("");
		setFieldErrors({});
		const errors = validate();
		if (Object.keys(errors).length) {
			setFieldErrors(errors);
			focusFirstError(errors);
			return;
		}

		const currentPat = timeLogPat.trim();
		const verifiedPat =
			verifiedOrganizationRef.current === azureOrganization.trim()
				? verifiedPatRef.current
				: "";
		setIsSaving(true);
		try {
			const result = await saveAppSettings({
				displayName: displayName.trim(),
				email: email.trim(),
				azureOrganization: azureOrganization.trim(),
				azureProject: azureProject.trim(),
				aiProvider,
				openaiModel,
				codexModel,
				codexReasoningEffort,
				...(patMode === "entry" && (currentPat || verifiedPat)
					? { timeLogPat: currentPat || verifiedPat }
					: {}),
				removeTimeLogPat: patMode === "remove",
			});
			onSaved(result);
		} catch (saveError) {
			setError(`Não foi possível salvar: ${errorMessage(saveError)}`);
		} finally {
			clearSecret();
			setIsSaving(false);
		}
	};

	const isBusy = isSaving || isVerifying;
	const selectedProvider = initialState.aiProviders.find(
		(provider) => provider.id === aiProvider,
	);
	const selectedModel = aiProvider === "openai" ? openaiModel : codexModel;
	const close = (action: () => void) => {
		clearSecret();
		action();
	};

	return (
		<main className="settings-workspace">
			<Card className="settings-card">
				<div className="settings-heading">
					<span aria-hidden="true" className="settings-heading-icon">
						<Settings2 />
					</span>
					<div>
						<p className="settings-eyebrow">
							{mode === "onboarding" ? "Primeiro acesso" : "Configurações"}
						</p>
						<h1>
							{mode === "onboarding"
								? "Prepare o aplicativo para começar"
								: "Configurações do aplicativo"}
						</h1>
						<p>
							Confirme sua identidade, o destino no Azure DevOps e o provedor de
							IA.
						</p>
					</div>
				</div>

				{mode === "onboarding" && initialState.warnings.length ? (
					<Alert className="settings-warning" role="status">
						<AlertTitle>Configuração precisa ser revisada</AlertTitle>
						<AlertDescription>
							{initialState.warnings.join(" ")}
						</AlertDescription>
					</Alert>
				) : null}
				{error ? (
					<Alert className="settings-error" role="alert" variant="destructive">
						<AlertTitle>Não foi possível continuar</AlertTitle>
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<form
					aria-busy={isBusy}
					noValidate
					onSubmit={handleSubmit}
					ref={formRef}
				>
					<section className="settings-section" aria-labelledby="identityTitle">
						<div className="section-heading">
							<div>
								<h2 id="identityTitle">Sua identidade</h2>
								<p>Usada como responsável nas tarefas geradas.</p>
							</div>
						</div>
						<div className="field-grid">
							<div className="field">
								<label htmlFor="settingsDisplayName">Nome</label>
								<Input
									aria-describedby={
										fieldErrors.displayName
											? "settingsDisplayNameError"
											: undefined
									}
									aria-invalid={Boolean(fieldErrors.displayName)}
									autoComplete="name"
									disabled={isBusy}
									id="settingsDisplayName"
									name="displayName"
									onChange={(event) => setDisplayName(event.target.value)}
									value={displayName}
								/>
								{fieldErrors.displayName ? (
									<span className="field-error" id="settingsDisplayNameError">
										{fieldErrors.displayName}
									</span>
								) : null}
							</div>
							<div className="field">
								<label htmlFor="settingsEmail">E-mail Infortech</label>
								<Input
									aria-describedby={
										fieldErrors.email
											? "settingsEmailError"
											: "settingsEmailHint"
									}
									aria-invalid={Boolean(fieldErrors.email)}
									autoComplete="email"
									disabled={isBusy}
									id="settingsEmail"
									name="email"
									onChange={(event) => setEmail(event.target.value)}
									type="email"
									value={email}
								/>
								<span
									className={fieldErrors.email ? "field-error" : "field-hint"}
									id={
										fieldErrors.email
											? "settingsEmailError"
											: "settingsEmailHint"
									}
								>
									{fieldErrors.email ||
										"Somente endereços @infortechms.com.br."}
								</span>
							</div>
						</div>
					</section>

					<section
						className="settings-section"
						aria-labelledby="azureSettingsTitle"
					>
						<div className="section-heading">
							<div>
								<h2 id="azureSettingsTitle">Azure DevOps</h2>
								<p>Destino padrão das tarefas e do Time Log Free.</p>
							</div>
						</div>
						<div className="field-grid">
							<div className="field">
								<label htmlFor="settingsAzureOrganization">
									Organização Azure padrão
								</label>
								<Input
									aria-describedby={
										fieldErrors.azureOrganization
											? "settingsAzureOrganizationError"
											: undefined
									}
									aria-invalid={Boolean(fieldErrors.azureOrganization)}
									disabled={isBusy}
									id="settingsAzureOrganization"
									name="azureOrganization"
									onChange={(event) => {
										setAzureOrganization(event.target.value);
										invalidateVerification();
									}}
									value={azureOrganization}
								/>
								{fieldErrors.azureOrganization ? (
									<span
										className="field-error"
										id="settingsAzureOrganizationError"
									>
										{fieldErrors.azureOrganization}
									</span>
								) : null}
							</div>
							<div className="field">
								<label htmlFor="settingsAzureProject">
									Projeto Azure padrão
								</label>
								<Input
									aria-describedby={
										fieldErrors.azureProject
											? "settingsAzureProjectError"
											: undefined
									}
									aria-invalid={Boolean(fieldErrors.azureProject)}
									disabled={isBusy}
									id="settingsAzureProject"
									name="azureProject"
									onChange={(event) => setAzureProject(event.target.value)}
									value={azureProject}
								/>
								{fieldErrors.azureProject ? (
									<span className="field-error" id="settingsAzureProjectError">
										{fieldErrors.azureProject}
									</span>
								) : null}
							</div>
						</div>
					</section>

					<section
						className="settings-section"
						aria-labelledby="providerSettingsTitle"
					>
						<div className="section-heading">
							<div>
								<h2 id="providerSettingsTitle">Provedor de IA</h2>
								<p>Escolha o padrão; a disponibilidade não impede salvar.</p>
							</div>
						</div>
						<RadioGroup
							aria-label="Provedor de IA da configuração"
							className="provider-selector settings-provider-selector"
							disabled={isBusy}
							name="settingsAiProvider"
							onValueChange={(value: AiProvider) => setAiProvider(value)}
							value={aiProvider}
						>
							{initialState.aiProviders.map((provider) => {
								const inputId = `settings-provider-${provider.id}`;
								return (
									<label
										className={aiProvider === provider.id ? "is-selected" : ""}
										htmlFor={inputId}
										key={provider.id}
									>
										<RadioGroupItem id={inputId} value={provider.id} />
										<span className="provider-option-title">
											{provider.displayName}{" "}
											<span
												aria-hidden="true"
												className={`mini-dot ${provider.ready ? "is-ready" : ""}`}
											/>
										</span>
										<span>{provider.statusDetail}</span>
									</label>
								);
							})}
						</RadioGroup>
						{selectedProvider ? (
							<AiModelFields
								provider={selectedProvider}
								catalog={catalogs[aiProvider]}
								loading={modelsLoading[aiProvider]}
								model={selectedModel}
								effort={codexReasoningEffort}
								onModelChange={
									aiProvider === "openai" ? setOpenaiModel : setCodexModel
								}
								onEffortChange={setCodexReasoningEffort}
								disabled={isBusy}
								prefix="settings"
							/>
						) : null}
					</section>

					<section
						className="settings-section"
						aria-labelledby="patSettingsTitle"
					>
						<div className="section-heading">
							<div>
								<h2 id="patSettingsTitle">
									PAT do Azure DevOps{" "}
									<span className="optional-label">opcional</span>
								</h2>
								<p>Fica armazenado localmente e nunca é exibido novamente.</p>
								<p>
									Minhas tarefas requer Work Items — Read. Para registrar horas,
									inclua também Extension Data — Read &amp; Write.
								</p>
							</div>
						</div>
						{patMode === "existing" ? (
							<div className="pat-status-row">
								<Badge variant="outline">
									<CheckCircle2 /> PAT configurado
								</Badge>
								<div>
									<Button
										disabled={isBusy}
										onClick={() => setPatMode("entry")}
										type="button"
										variant="outline"
									>
										Substituir PAT
									</Button>
									<Button
										disabled={isBusy}
										onClick={() => {
											clearSecret();
											setPatMode("remove");
										}}
										type="button"
										variant="ghost"
									>
										Remover PAT
									</Button>
								</div>
							</div>
						) : patMode === "remove" ? (
							<div className="pat-status-row is-removing">
								<p>O PAT salvo será removido ao salvar.</p>
								<Button
									disabled={isBusy}
									onClick={() => setPatMode("existing")}
									type="button"
									variant="outline"
								>
									Manter PAT
								</Button>
							</div>
						) : (
							<div className="pat-entry-row">
								<div className="field">
									<label htmlFor="settingsTimeLogPat">
										PAT do Azure DevOps
									</label>
									<Input
										aria-describedby={
											fieldErrors.timeLogPat
												? "settingsTimeLogPatError"
												: "settingsTimeLogPatHint"
										}
										aria-invalid={Boolean(fieldErrors.timeLogPat)}
										autoComplete="off"
										disabled={isBusy}
										id="settingsTimeLogPat"
										name="timeLogPat"
										onChange={(event) => {
											setTimeLogPat(event.target.value);
											invalidateVerification();
										}}
										placeholder={
											initialState.timeLogPatConfigured
												? "Novo PAT"
												: "Opcional"
										}
										type="password"
										value={timeLogPat}
									/>
									<span
										className={
											fieldErrors.timeLogPat ? "field-error" : "field-hint"
										}
										id={
											fieldErrors.timeLogPat
												? "settingsTimeLogPatError"
												: "settingsTimeLogPatHint"
										}
									>
										{fieldErrors.timeLogPat ||
											"Verifique para sugerir sua identidade antes de salvar."}
									</span>
								</div>
								<Button
									aria-busy={isVerifying}
									className="secondary-button"
									disabled={isBusy || !timeLogPat.trim()}
									onClick={handleVerifyPat}
									type="button"
									variant="outline"
								>
									{isVerifying ? (
										<>
											<Spinner aria-hidden="true" /> Verificando…
										</>
									) : (
										<>
											<KeyRound /> Verificar PAT
										</>
									)}
								</Button>
							</div>
						)}
						{identityStatus ? (
							<p className="identity-status" role="status">
								{identityStatus}
							</p>
						) : null}
					</section>

					<div className="settings-actions">
						<div>
							{mode === "onboarding" ? (
								<Button
									disabled={isBusy}
									onClick={() => close(onSkip)}
									type="button"
									variant="ghost"
								>
									Pular por agora
								</Button>
							) : (
								<Button
									disabled={isBusy}
									onClick={() => close(onCancel)}
									type="button"
									variant="ghost"
								>
									Cancelar
								</Button>
							)}
						</div>
						<Button
							aria-busy={isSaving}
							className="primary-button"
							disabled={isBusy}
							type="submit"
						>
							{isSaving ? (
								<>
									<Spinner aria-hidden="true" /> Salvando…
								</>
							) : (
								"Salvar configurações"
							)}
						</Button>
					</div>
				</form>
			</Card>
		</main>
	);
}
