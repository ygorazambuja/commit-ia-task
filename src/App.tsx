import {
	Check,
	CircleAlert,
	CircleHelp,
	Clock3,
	Code2,
	ExternalLink,
	Folder,
	ListTodo,
	MessageSquareText,
	RefreshCw,
	Settings,
	X,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster, toast } from "@/components/ui/toast";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import AiModelFields from "./AiModelFields";
import {
	chooseRepository,
	createTimeLog,
	getInitialState,
	inspectRepository,
	onGenerationProgress,
	openCsvFile,
	runGeneration,
} from "./desktop";
import GenerationFeedback, {
	type GenerationActivity,
} from "./GenerationFeedback";
import HelpPanel from "./HelpPanel";
import MyTasksPanel from "./MyTasksPanel";
import PromptPanel from "./PromptPanel";
import SettingsPanel from "./SettingsPanel";
import TimeLogBatchFeedback from "./TimeLogBatchFeedback";
import TimeLogPanel from "./TimeLogPanel";
import type {
	AiProvider,
	GenerationInput,
	GenerationResult,
	InitialState,
	RepositoryInspection,
	SaveAppSettingsResult,
	TaskType,
} from "./types";
import { useAiModels } from "./useAiModels";

type FormState = Omit<
	GenerationInput,
	"apiKey" | "parentWorkItemId" | "assignedTo"
> & {
	apiKey: string;
	parentWorkItemId: string;
};

const featureTabs = [
	{
		id: "tasks",
		label: "Gerar tarefas",
		description: "Transforme alterações Git em tarefas prontas para o Azure.",
		panelId: "task-generation-panel",
		tabId: "task-generation-tab",
		icon: Code2,
	},
	{
		id: "time-log",
		label: "Registrar horas",
		description: "Lance o trabalho realizado no Time Log Free.",
		panelId: "time-log-feature-panel",
		tabId: "time-log-tab",
		icon: Clock3,
	},
	{
		id: "prompts",
		label: "Prompts",
		description: "Personalize as instruções usadas para gerar tarefas.",
		panelId: "prompts-feature-panel",
		tabId: "prompts-tab",
		icon: MessageSquareText,
	},
	{
		id: "my-tasks",
		label: "Minhas tarefas",
		description: "Acompanhe seus cards e prepare o próximo trabalho.",
		panelId: "my-tasks-feature-panel",
		tabId: "my-tasks-tab",
		icon: ListTodo,
	},
	{
		id: "help",
		label: "Ajuda",
		description: "Consulte requisitos e dúvidas sobre as integrações.",
		panelId: "help-feature-panel",
		tabId: "help-tab",
		icon: CircleHelp,
	},
] as const;

type FeatureTabId = (typeof featureTabs)[number]["id"];

function localDate(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

const initialTimeLogDate = localDate();

const emptyForm: FormState = {
	repositoryPath: "",
	sprintId: "",
	areaPathId: "",
	itemContrato: "",
	aiProvider: "openai",
	openaiModel: "",
	codexModel: "",
	codexReasoningEffort: "",
	apiKey: "",
	createAzureTasks: false,
	registerTimeLog: false,
	timeLogStartDate: initialTimeLogDate,
	timeLogEndDate: initialTimeLogDate,
	azureOrganization: "",
	azureProject: "",
	parentWorkItemId: "",
};

const fileKindLabels: Record<string, string> = {
	new: "Novo",
	modified: "Modificado",
	staged: "No stage",
	mixed: "Misto",
};

const taskTypeLabels: Record<TaskType, string> = {
	BACKEND: "Backend",
	FRONTEND: "Frontend",
	TESTES: "Testes",
};

function errorMessage(error: unknown): string {
	if (typeof error === "string" && error.trim()) {
		return error;
	}

	if (error instanceof Error && error.message.trim()) {
		return error.message;
	}

	return "Não foi possível concluir a operação.";
}

function isCorporateAssignee(value: string): boolean {
	const match = value.trim().match(/^([^<>]+?)\s+<([^<>]+)>$/);
	if (!match) return false;
	const displayName = match[1].trim();
	const invalidDisplayName = [...displayName].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
	});
	if (!displayName || invalidDisplayName) {
		return false;
	}
	const email = match[2].trim();
	const emailMatch = email.match(/^([A-Z0-9._%+-]+)@infortechms\.com\.br$/i);
	return Boolean(
		emailMatch &&
			!emailMatch[1].startsWith(".") &&
			!emailMatch[1].endsWith(".") &&
			!emailMatch[1].includes(".."),
	);
}

function ProviderStatus({
	label,
	ready,
	detail,
	loading,
}: {
	label: string;
	ready: boolean;
	detail: string;
	loading: boolean;
}) {
	const visibleDetail = loading ? "Verificando…" : detail;

	return (
		<Badge
			className={`provider-status ${loading ? "is-loading" : ready ? "is-ready" : "is-warning"}`}
			title={`${label}: ${visibleDetail}`}
			variant={ready ? "secondary" : "outline"}
		>
			{loading ? (
				<Spinner aria-hidden="true" className="size-3!" />
			) : (
				<span aria-hidden="true" className="status-dot" />
			)}
			<span className="provider-name">{label}</span>
			<span className="provider-detail">{visibleDetail}</span>
		</Badge>
	);
}

export default function App() {
	const [form, setForm] = useState<FormState>(emptyForm);
	const [initialState, setInitialState] = useState<InitialState | null>(null);
	const [inspection, setInspection] = useState<RepositoryInspection | null>(
		null,
	);
	const [result, setResult] = useState<GenerationResult | null>(null);
	const [generationActivity, setGenerationActivity] =
		useState<GenerationActivity | null>(null);
	const [error, setError] = useState("");
	const [isBootstrapping, setIsBootstrapping] = useState(true);
	const [isInspecting, setIsInspecting] = useState(false);
	const [isRunning, setIsRunning] = useState(false);
	const [isRetryingTimeLog, setIsRetryingTimeLog] = useState(false);
	const [isOpeningCsv, setIsOpeningCsv] = useState(false);
	const [activeFeature, setActiveFeature] = useState<FeatureTabId>("tasks");
	const [settingsMode, setSettingsMode] = useState<
		"onboarding" | "edit" | null
	>(null);
	const [skippedOnboarding, setSkippedOnboarding] = useState(false);
	const [azureTasksContext, setAzureTasksContext] = useState(0);
	const [unreadAzureNotifications, setUnreadAzureNotifications] = useState(0);

	const { catalogs, loading: modelsLoading } = useAiModels(
		initialState,
		form.apiKey,
		settingsMode !== null,
	);

	useEffect(() => {
		let active = true;

		const initialize = async () => {
			try {
				const state = await getInitialState();
				if (!active) return;

				const repositoryPath = state.config.repositoryPath;
				setInitialState(state);
				if (state.requiresOnboarding) setSettingsMode("onboarding");
				if (state.warnings.length) {
					setError(state.warnings.join(" "));
				}
				setForm({
					...emptyForm,
					repositoryPath: state.config.repositoryPath,
					sprintId: state.config.sprintId,
					areaPathId: state.config.areaPathId,
					itemContrato: state.config.itemContrato,
					aiProvider: state.config.aiProvider,
					openaiModel: state.config.openaiModel,
					codexModel: state.config.codexModel,
					codexReasoningEffort: state.config.codexReasoningEffort,
					azureOrganization:
						state.config.azureOrganization || state.azureDefaults.organization,
					azureProject:
						state.config.azureProject || state.azureDefaults.project,
				});

				if (repositoryPath) {
					setIsInspecting(true);
					try {
						const repository = await inspectRepository(repositoryPath);
						if (!active) return;
						setInspection(repository);
						setForm((current) => ({
							...current,
							repositoryPath: repository.repositoryPath,
						}));
					} catch (inspectionError) {
						if (active) {
							setError(
								`Não foi possível inspecionar o repositório salvo: ${errorMessage(inspectionError)}`,
							);
						}
					} finally {
						if (active) setIsInspecting(false);
					}
				}
			} catch (initialError) {
				if (active) {
					setError(
						`Não foi possível carregar a configuração: ${errorMessage(initialError)}`,
					);
				}
			} finally {
				if (active) setIsBootstrapping(false);
			}
		};

		void initialize();
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		let active = true;
		let stopListening: (() => void) | undefined;

		void onGenerationProgress((nextProgress) => {
			if (active) {
				const receivedAt = Date.now();
				setGenerationActivity((current) =>
					current
						? {
								...current,
								events: [
									...current.events.slice(-5),
									{ ...nextProgress, receivedAt },
								],
							}
						: null,
				);
			}
		})
			.then((unlisten) => {
				if (active) {
					stopListening = unlisten;
				} else {
					unlisten();
				}
			})
			.catch((listenerError) => {
				if (active) {
					setError(
						`Não foi possível acompanhar o progresso: ${errorMessage(listenerError)}`,
					);
				}
			});

		return () => {
			active = false;
			stopListening?.();
		};
	}, []);

	const taskCount = useMemo(
		() =>
			result?.files.reduce(
				(total, generatedFile) => total + generatedFile.tasks.length,
				0,
			) ?? 0,
		[result],
	);
	const hasResultWarnings = Boolean(
		result &&
			(result.failures.length ||
				result.files.some((file) => !file.staged) ||
				result.azureError ||
				result.timeLogError ||
				result.timeLogResult?.failure ||
				result.timeLogResult?.plan.missingMinutes ||
				result.warnings.length),
	);
	const selectedProvider = initialState?.aiProviders.find(
		(provider) => provider.id === form.aiProvider,
	);

	const inspectPath = async (repositoryPath: string) => {
		setIsInspecting(true);
		setError("");
		setResult(null);

		try {
			const nextInspection = await inspectRepository(repositoryPath);
			setInspection(nextInspection);
			setForm((current) => ({
				...current,
				repositoryPath: nextInspection.repositoryPath,
			}));
		} catch (inspectionError) {
			setInspection(null);
			setError(
				`Não foi possível inspecionar o repositório: ${errorMessage(inspectionError)}`,
			);
		} finally {
			setIsInspecting(false);
		}
	};

	const handleChooseRepository = async () => {
		setError("");

		try {
			const repositoryPath = await chooseRepository();
			if (!repositoryPath) return;

			setForm((current) => ({ ...current, repositoryPath }));
			await inspectPath(repositoryPath);
		} catch (selectionError) {
			toast.error(
				"Não foi possível escolher a pasta",
				errorMessage(selectionError),
			);
		}
	};

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError("");
		setResult(null);
		const assignedTo = initialState?.config.assignedTo.trim() ?? "";

		const requiredValues = [
			form.repositoryPath,
			form.sprintId,
			form.areaPathId,
			form.itemContrato,
		];
		if (requiredValues.some((value) => !value.trim())) {
			setError("Preencha os campos obrigatórios antes de gerar as tarefas.");
			return;
		}

		if (!isCorporateAssignee(assignedTo)) {
			setError(
				"Revise o responsável em Configurações: use Nome <email@infortechms.com.br>.",
			);
			return;
		}

		if (
			!selectedProvider ||
			(!selectedProvider.ready &&
				!(selectedProvider.allowsApiKeyInput && form.apiKey.trim()))
		) {
			setError(
				selectedProvider?.pendingMessage ||
					"O provedor de IA selecionado não está disponível.",
			);
			return;
		}

		const selectedModel =
			form.aiProvider === "openai" ? form.openaiModel : form.codexModel;
		const models = catalogs[form.aiProvider]?.models ?? selectedProvider.models;
		if (
			catalogs[form.aiProvider] &&
			!models.some((model) => model.value === selectedModel)
		) {
			setError(
				"O modelo salvo está indisponível. Escolha outro modelo antes de gerar.",
			);
			return;
		}

		const parentWorkItemId = form.parentWorkItemId.trim();
		const parsedParentWorkItemId = Number(parentWorkItemId);
		if (form.createAzureTasks && !parentWorkItemId) {
			setError("Informe o ID do item pai para criar as tarefas no Azure.");
			return;
		}
		if (
			form.createAzureTasks &&
			(!/^\d+$/.test(parentWorkItemId) ||
				!Number.isSafeInteger(parsedParentWorkItemId) ||
				parsedParentWorkItemId <= 0)
		) {
			setError("Informe um ID do item pai como número inteiro positivo.");
			return;
		}

		if (form.registerTimeLog && !form.azureOrganization.trim()) {
			setError("Informe a organização Azure para registrar o Time Log.");
			return;
		}

		if (
			form.registerTimeLog &&
			(!form.timeLogStartDate || !form.timeLogEndDate)
		) {
			setError("Informe as datas inicial e final do Time Log.");
			return;
		}

		if (form.registerTimeLog && form.timeLogEndDate < form.timeLogStartDate) {
			setError(
				"A data final do Time Log deve ser igual ou posterior à inicial.",
			);
			return;
		}

		if (
			form.registerTimeLog &&
			(form.timeLogStartDate > localDate() || form.timeLogEndDate > localDate())
		) {
			setError("O período do Time Log não pode incluir datas futuras.");
			return;
		}

		const input: GenerationInput = {
			repositoryPath: form.repositoryPath.trim(),
			sprintId: form.sprintId.trim(),
			areaPathId: form.areaPathId.trim(),
			assignedTo,
			itemContrato: form.itemContrato.trim(),
			aiProvider: form.aiProvider,
			openaiModel: form.openaiModel,
			codexModel: form.codexModel,
			codexReasoningEffort: form.codexReasoningEffort,
			...(selectedProvider.allowsApiKeyInput && form.apiKey.trim()
				? { apiKey: form.apiKey.trim() }
				: {}),
			createAzureTasks: form.createAzureTasks,
			registerTimeLog: form.registerTimeLog,
			timeLogStartDate: form.timeLogStartDate,
			timeLogEndDate: form.timeLogEndDate,
			azureOrganization: form.azureOrganization.trim(),
			azureProject: form.azureProject.trim(),
			...(form.createAzureTasks && parentWorkItemId
				? { parentWorkItemId: parsedParentWorkItemId }
				: {}),
		};

		setIsRunning(true);
		setForm((current) => ({ ...current, apiKey: "" }));
		const startedAt = Date.now();
		setGenerationActivity({
			startedAt,
			events: [
				{
					phase: "preparing",
					message: "Preparando a geração…",
					current: 0,
					total: 0,
					activeFiles: [],
					receivedAt: startedAt,
				},
			],
		});

		try {
			const generationResult = await runGeneration(input);
			setResult(generationResult);
			setInspection({
				repositoryPath: generationResult.repositoryPath,
				files: generationResult.files.map((generatedFile) => ({
					path: generatedFile.relativePath,
					kind: generatedFile.staged ? "staged" : "modified",
				})),
			});
		} catch (generationError) {
			setError(`A geração não foi concluída: ${errorMessage(generationError)}`);
		} finally {
			setForm((current) => ({ ...current, registerTimeLog: false }));
			setIsRunning(false);
			setGenerationActivity(null);
		}
	};

	const handleRetryTimeLog = async () => {
		if (!result?.timeLogRetryInput || isRetryingTimeLog) return;

		if (!form.timeLogStartDate || !form.timeLogEndDate) {
			setError("Informe as datas inicial e final do Time Log.");
			return;
		}
		if (form.timeLogEndDate < form.timeLogStartDate) {
			setError(
				"A data final do Time Log deve ser igual ou posterior à inicial.",
			);
			return;
		}
		if (
			form.timeLogStartDate > localDate() ||
			form.timeLogEndDate > localDate()
		) {
			setError("O período do Time Log não pode incluir datas futuras.");
			return;
		}

		const retryInput = {
			...result.timeLogRetryInput,
			startDate: form.timeLogStartDate,
			endDate: form.timeLogEndDate,
		};
		setError("");
		setIsRetryingTimeLog(true);

		try {
			const timeLogResult = await createTimeLog(retryInput);
			setResult((current) =>
				current
					? {
							...current,
							timeLogResult,
							timeLogError: undefined,
							timeLogRetryInput: timeLogResult.retryable
								? retryInput
								: undefined,
						}
					: current,
			);
		} catch (retryError) {
			setResult((current) =>
				current
					? {
							...current,
							timeLogResult: undefined,
							timeLogError: errorMessage(retryError),
						}
					: current,
			);
		} finally {
			setIsRetryingTimeLog(false);
		}
	};

	const handleOpenCsv = async () => {
		if (!result?.csvPath || isOpeningCsv) return;

		setIsOpeningCsv(true);
		try {
			await openCsvFile(result.csvPath);
			toast.success(
				"CSV localizado",
				"O arquivo foi destacado no gerenciador de arquivos.",
			);
		} catch (openError) {
			toast.error("Não foi possível localizar o CSV", errorMessage(openError));
		} finally {
			setIsOpeningCsv(false);
		}
	};

	const updateProvider = (aiProvider: AiProvider) => {
		setForm((current) => ({ ...current, aiProvider }));
		setError("");
	};

	const handleSettingsSaved = (saved: SaveAppSettingsResult) => {
		setAzureTasksContext((current) => current + 1);
		setUnreadAzureNotifications(0);
		setForm((current) => ({
			...current,
			aiProvider: saved.config.aiProvider,
			openaiModel: saved.config.openaiModel,
			codexModel: saved.config.codexModel,
			codexReasoningEffort: saved.config.codexReasoningEffort,
			azureOrganization: saved.config.azureOrganization,
			azureProject: saved.config.azureProject,
		}));
		setInitialState((current) =>
			current
				? {
						...current,
						config: saved.config,
						profile: saved.profile,
						timeLogPatConfigured: saved.timeLogPatConfigured,
						requiresOnboarding: false,
						warnings: saved.warnings,
					}
				: current,
		);
		setSkippedOnboarding(false);
		setSettingsMode(null);
		setError(saved.warnings.join(" "));
		if (saved.warnings.length) {
			toast.warning(
				"Configurações salvas com avisos",
				"Revise o aviso exibido antes de continuar.",
			);
		} else {
			toast.success(
				"Configurações salvas",
				"Suas preferências foram atualizadas.",
			);
		}
	};

	const handleFeatureTabKeyDown = (
		event: KeyboardEvent<HTMLButtonElement>,
		currentTabId: FeatureTabId,
	) => {
		const currentIndex = featureTabs.findIndex(
			(tab) => tab.id === currentTabId,
		);
		let nextIndex: number;

		switch (event.key) {
			case "ArrowRight":
				nextIndex = (currentIndex + 1) % featureTabs.length;
				break;
			case "ArrowLeft":
				nextIndex =
					(currentIndex - 1 + featureTabs.length) % featureTabs.length;
				break;
			case "Home":
				nextIndex = 0;
				break;
			case "End":
				nextIndex = featureTabs.length - 1;
				break;
			default:
				return;
		}

		event.preventDefault();
		const nextTab = featureTabs[nextIndex];
		setActiveFeature(nextTab.id);
		document.getElementById(nextTab.tabId)?.focus();
	};

	const isBusy =
		isBootstrapping || isInspecting || isRunning || isRetryingTimeLog;

	return (
		<div className="app-shell">
			<Toaster />
			<header className="topbar">
				<div className="brand-lockup">
					<img
						alt=""
						className="brand-mark"
						height={38}
						src="/app-icon.png"
						width={38}
					/>
					<div>
						<strong>Infortech Automation</strong>
						<span className="brand-tagline">
							Tarefas e horas, sem retrabalho
						</span>
					</div>
				</div>

				<div className="topbar-actions">
					<section
						aria-labelledby="providerStatusTitle"
						className="provider-statuses"
					>
						<span className="sr-only" id="providerStatusTitle">
							Status dos provedores
						</span>
						{initialState ? (
							initialState.aiProviders.map((provider) => (
								<ProviderStatus
									detail={provider.statusDetail}
									key={provider.id}
									label={provider.displayName}
									loading={false}
									ready={provider.ready}
								/>
							))
						) : (
							<ProviderStatus
								detail="Indisponível"
								label="Provedores"
								loading={isBootstrapping}
								ready={false}
							/>
						)}
					</section>
					<Button
						className="settings-button h-5 min-h-5 max-h-5 gap-1 px-2 py-0.5 text-xs leading-none"
						disabled={isBootstrapping || !initialState || settingsMode !== null}
						onClick={() => setSettingsMode("edit")}
						size="xs"
						type="button"
						variant="outline"
					>
						<Settings aria-hidden="true" className="size-3" />
						Configurações
					</Button>
				</div>
			</header>

			{settingsMode && initialState ? (
				<SettingsPanel
					initialState={initialState}
					catalogs={catalogs}
					modelsLoading={modelsLoading}
					mode={settingsMode}
					onCancel={() => setSettingsMode(null)}
					onSaved={handleSettingsSaved}
					onSkip={() => {
						setSkippedOnboarding(true);
						setSettingsMode(null);
					}}
				/>
			) : null}

			<main className="workspace" hidden={settingsMode !== null}>
				<div className="page-heading">
					<div>
						<h1>Do código ao Azure DevOps</h1>
						<p>
							Gere tarefas a partir das alterações Git e registre o tempo
							trabalhado sem sair do aplicativo.
						</p>
					</div>
					<div className="page-shortcuts">
						<span className="local-note">Operações nativas locais</span>
					</div>
				</div>

				{skippedOnboarding ? (
					<Alert className="onboarding-reminder" role="status">
						<CircleAlert aria-hidden="true" />
						<AlertTitle>Configuração inicial pendente</AlertTitle>
						<AlertDescription>
							Você pode usar o aplicativo agora e concluir a configuração antes
							de gerar tarefas.
						</AlertDescription>
						<AlertAction>
							<Button
								onClick={() => setSettingsMode("onboarding")}
								type="button"
								variant="outline"
							>
								Concluir configuração
							</Button>
						</AlertAction>
					</Alert>
				) : null}

				{error ? (
					<Alert className="error-banner" variant="destructive">
						<CircleAlert aria-hidden="true" className="error-symbol" />
						<AlertTitle className="sr-only">Aviso</AlertTitle>
						<AlertDescription>
							<p>{error}</p>
						</AlertDescription>
						<AlertAction>
							<Button
								aria-label="Fechar aviso"
								onClick={() => setError("")}
								size="icon-sm"
								type="button"
								variant="ghost"
							>
								<X aria-hidden="true" />
							</Button>
						</AlertAction>
					</Alert>
				) : null}

				<Tabs
					className="feature-workspace"
					onValueChange={(value) => {
						if (
							value === "tasks" ||
							value === "time-log" ||
							value === "prompts" ||
							value === "my-tasks" ||
							value === "help"
						) {
							setActiveFeature(value);
						}
					}}
					value={activeFeature}
				>
					<TabsList
						aria-label="Funcionalidades"
						className="feature-tabs"
						variant="line"
					>
						{featureTabs.map((tab) => {
							const TabIcon = tab.icon;
							return (
								<TabsTrigger
									aria-controls={tab.panelId}
									aria-describedby={
										tab.id === "my-tasks" && unreadAzureNotifications
											? "my-tasks-unread"
											: undefined
									}
									aria-label={tab.label}
									className="feature-tab"
									id={tab.tabId}
									key={tab.id}
									onKeyDown={(event) => handleFeatureTabKeyDown(event, tab.id)}
									value={tab.id}
								>
									<span aria-hidden="true" className="feature-tab-icon">
										<TabIcon />
									</span>
									<span className="feature-tab-copy">
										<strong>
											{tab.label}
											{tab.id === "my-tasks" && unreadAzureNotifications ? (
												<span className="my-tasks-unread" id="my-tasks-unread">
													<span aria-hidden="true">
														{unreadAzureNotifications}
													</span>
													<span className="sr-only">
														{unreadAzureNotifications} notificações não lidas
													</span>
												</span>
											) : null}
										</strong>
										<small>{tab.description}</small>
									</span>
								</TabsTrigger>
							);
						})}
					</TabsList>

					<TabsContent
						aria-labelledby="task-generation-tab"
						className="feature-panel"
						id="task-generation-panel"
						keepMounted
						value="tasks"
					>
						<div className="workspace-grid">
							<Card className="generation-panel">
								<form aria-busy={isRunning} noValidate onSubmit={handleSubmit}>
									<section className="form-section">
										<div className="section-heading">
											<div>
												<h2>Repositório</h2>
												<p>Escolha a pasta que contém as alterações Git.</p>
											</div>
											{form.repositoryPath ? (
												<Tooltip>
													<TooltipTrigger
														render={
															<Button
																aria-busy={isInspecting}
																aria-label="Atualizar inspeção do repositório"
																className="icon-button"
																disabled={isBusy}
																onClick={() => inspectPath(form.repositoryPath)}
																size="icon"
																type="button"
																variant="ghost"
															>
																{isInspecting ? (
																	<Spinner
																		aria-hidden="true"
																		className="icon"
																	/>
																) : (
																	<RefreshCw
																		aria-hidden="true"
																		className="icon"
																	/>
																)}
															</Button>
														}
													/>
													<TooltipContent>Atualizar alterações</TooltipContent>
												</Tooltip>
											) : null}
										</div>

										<div className="repository-picker">
											<div className="repository-path">
												<Folder aria-hidden="true" className="icon" />
												<span
													className={
														form.repositoryPath ? "" : "is-placeholder"
													}
													title={form.repositoryPath}
												>
													{form.repositoryPath ||
														"Nenhum repositório selecionado"}
												</span>
											</div>
											<Button
												className="secondary-button"
												disabled={isBusy}
												onClick={handleChooseRepository}
												type="button"
												variant="outline"
											>
												Escolher pasta
											</Button>
										</div>
									</section>

									<section className="form-section">
										<div className="section-heading">
											<div>
												<h2>Provedor de IA</h2>
												<p>A tarefa usa apenas o provedor selecionado.</p>
											</div>
										</div>

										<RadioGroup
											aria-label="Provedor de IA"
											className="provider-selector"
											disabled={isBusy}
											name="aiProvider"
											onValueChange={(value: AiProvider) =>
												updateProvider(value)
											}
											value={form.aiProvider}
										>
											{initialState?.aiProviders.map((provider) => {
												const inputId = `ai-provider-${provider.id}`;
												const labelId = `${inputId}-label`;
												return (
													<label
														className={
															form.aiProvider === provider.id
																? "is-selected"
																: ""
														}
														htmlFor={inputId}
														key={provider.id}
													>
														<RadioGroupItem
															aria-labelledby={labelId}
															id={inputId}
															value={provider.id}
														/>
														<span
															className="provider-option-title"
															id={labelId}
														>
															{provider.displayName}
															<span
																aria-hidden="true"
																className={`mini-dot ${provider.ready ? "is-ready" : ""}`}
															/>
														</span>
														<span>{provider.description}</span>
													</label>
												);
											})}
										</RadioGroup>

										{selectedProvider ? (
											<AiModelFields
												provider={selectedProvider}
												catalog={catalogs[form.aiProvider]}
												loading={modelsLoading[form.aiProvider]}
												model={
													form.aiProvider === "openai"
														? form.openaiModel
														: form.codexModel
												}
												effort={form.codexReasoningEffort}
												onModelChange={(value) =>
													setForm((current) => ({
														...current,
														[form.aiProvider === "openai"
															? "openaiModel"
															: "codexModel"]: value,
													}))
												}
												onEffortChange={(value) =>
													setForm((current) => ({
														...current,
														codexReasoningEffort: value,
													}))
												}
												disabled={isRunning}
												prefix="generation"
											/>
										) : null}
										{selectedProvider?.allowsApiKeyInput ? (
											<div className="field api-key-field">
												<label htmlFor="apiKey">
													Chave OpenAI desta execução
												</label>
												<Input
													aria-describedby="apiKeyHint"
													autoComplete="off"
													disabled={isBusy}
													id="apiKey"
													name="apiKey"
													onChange={(event) =>
														setForm((current) => ({
															...current,
															apiKey: event.target.value,
														}))
													}
													placeholder={
														selectedProvider.ready
															? "Opcional — usando OPENAI_API_KEY"
															: "sk-…"
													}
													type="password"
													value={form.apiKey}
												/>
												<span className="field-hint" id="apiKeyHint">
													Não será salva. Deixe em branco para usar a variável
													de ambiente.
												</span>
											</div>
										) : selectedProvider ? (
											<p className="provider-note">
												{selectedProvider.ready
													? selectedProvider.statusDetail
													: selectedProvider.pendingMessage}
											</p>
										) : null}
									</section>

									<section className="form-section">
										<div className="section-heading">
											<div>
												<h2>Destino das tarefas</h2>
												<p>
													Esses valores serão lembrados na próxima execução.
												</p>
											</div>
										</div>

										<div className="field-grid">
											<div className="field">
												<label htmlFor="sprintId">Sprint / Iteração</label>
												<Input
													disabled={isBusy}
													id="sprintId"
													name="sprintId"
													onChange={(event) =>
														setForm((current) => ({
															...current,
															sprintId: event.target.value,
														}))
													}
													placeholder="Projeto\\Sprint 1"
													required
													value={form.sprintId}
												/>
											</div>
											<div className="field">
												<label htmlFor="areaPathId">Área</label>
												<Input
													disabled={isBusy}
													id="areaPathId"
													name="areaPathId"
													onChange={(event) =>
														setForm((current) => ({
															...current,
															areaPathId: event.target.value,
														}))
													}
													placeholder="Projeto\\Área"
													required
													value={form.areaPathId}
												/>
											</div>
											<div className="field">
												<label htmlFor="itemContrato">Item do contrato</label>
												<Input
													disabled={isBusy}
													id="itemContrato"
													name="itemContrato"
													onChange={(event) =>
														setForm((current) => ({
															...current,
															itemContrato: event.target.value,
														}))
													}
													placeholder="Item 1"
													required
													value={form.itemContrato}
												/>
											</div>
										</div>
									</section>

									<section className="form-section azure-section">
										<label className="toggle-row" htmlFor="createAzureTasks">
											<span>
												<strong id="createAzureTasksLabel">
													Criar também no Azure DevOps
												</strong>
												<small>
													O CSV será gerado independentemente desta opção.
												</small>
											</span>
											<Switch
												aria-labelledby="createAzureTasksLabel"
												checked={form.createAzureTasks}
												className="switch"
												disabled={isBusy}
												id="createAzureTasks"
												name="createAzureTasks"
												onCheckedChange={(createAzureTasks) =>
													setForm((current) => ({
														...current,
														createAzureTasks,
														registerTimeLog: createAzureTasks
															? current.registerTimeLog
															: false,
													}))
												}
											/>
										</label>

										{form.createAzureTasks ? (
											<>
												<div className="field-grid azure-fields">
													<div className="field">
														<label htmlFor="azureOrganization">
															Organização Azure
														</label>
														<Input
															disabled={isBusy}
															id="azureOrganization"
															name="azureOrganization"
															onChange={(event) =>
																setForm((current) => ({
																	...current,
																	azureOrganization: event.target.value,
																}))
															}
															placeholder="https://dev.azure.com/empresa"
															value={form.azureOrganization}
														/>
													</div>
													<div className="field">
														<label htmlFor="azureProject">Projeto Azure</label>
														<Input
															disabled={isBusy}
															id="azureProject"
															name="azureProject"
															onChange={(event) =>
																setForm((current) => ({
																	...current,
																	azureProject: event.target.value,
																}))
															}
															placeholder="Meu projeto"
															value={form.azureProject}
														/>
													</div>
													<div className="field">
														<label htmlFor="parentWorkItemId">
															ID do item pai
														</label>
														<Input
															aria-describedby="parentWorkItemIdHint"
															disabled={isBusy}
															id="parentWorkItemId"
															inputMode="numeric"
															name="parentWorkItemId"
															onChange={(event) =>
																setForm((current) => ({
																	...current,
																	parentWorkItemId: event.target.value,
																}))
															}
															placeholder="12345"
															required
															value={form.parentWorkItemId}
														/>
														<span
															className="field-hint"
															id="parentWorkItemIdHint"
														>
															PBI, User Story ou Requirement que receberá as
															tarefas como filhas. Não será salvo.
														</span>
													</div>
												</div>

												<label className="toggle-row" htmlFor="registerTimeLog">
													<span>
														<strong id="registerTimeLogLabel">
															Registrar também no Time Log
														</strong>
														<small>
															As estimativas serão distribuídas no item pai, com
															no máximo 7h por dia.
														</small>
													</span>
													<Switch
														aria-labelledby="registerTimeLogLabel"
														checked={form.registerTimeLog}
														className="switch"
														disabled={isBusy}
														id="registerTimeLog"
														name="registerTimeLog"
														onCheckedChange={(registerTimeLog) =>
															setForm((current) => ({
																...current,
																registerTimeLog,
															}))
														}
													/>
												</label>

												{form.registerTimeLog || result?.timeLogRetryInput ? (
													<div className="field-grid time-log-range-fields">
														<div className="field">
															<label htmlFor="timeLogStartDate">
																Data inicial do Time Log
															</label>
															<Input
																disabled={isBusy}
																id="timeLogStartDate"
																max={localDate()}
																name="timeLogStartDate"
																onChange={(event) =>
																	setForm((current) => ({
																		...current,
																		timeLogStartDate: event.target.value,
																	}))
																}
																required={form.registerTimeLog}
																type="date"
																value={form.timeLogStartDate}
															/>
														</div>
														<div className="field">
															<label htmlFor="timeLogEndDate">
																Data final do Time Log
															</label>
															<Input
																disabled={isBusy}
																id="timeLogEndDate"
																max={localDate()}
																name="timeLogEndDate"
																onChange={(event) =>
																	setForm((current) => ({
																		...current,
																		timeLogEndDate: event.target.value,
																	}))
																}
																required={form.registerTimeLog}
																type="date"
																value={form.timeLogEndDate}
															/>
														</div>
													</div>
												) : null}
											</>
										) : null}
									</section>

									<div className="form-actions">
										<p>
											<Check aria-hidden="true" className="icon" />
											Arquivos processados com sucesso serão adicionados ao
											stage.
										</p>
										<Button
											aria-busy={isRunning}
											className="primary-button"
											disabled={isBusy || !form.repositoryPath}
											type="submit"
										>
											{isRunning ? (
												<>
													<Spinner aria-hidden="true" className="spinner" />
													Gerando tarefas…
												</>
											) : (
												"Gerar tarefas"
											)}
										</Button>
									</div>
								</form>
							</Card>

							<aside
								aria-busy={isInspecting}
								aria-labelledby="changesTitle"
								className={`review-panel${generationActivity ? " is-generating" : ""}`}
							>
								{generationActivity ? (
									<GenerationFeedback
										activity={generationActivity}
										provider={selectedProvider?.displayName ?? form.aiProvider}
										createAzureTasks={form.createAzureTasks}
										registerTimeLog={form.registerTimeLog}
									/>
								) : null}
								<Card className="review-card">
									<div className="review-heading">
										<div>
											<h2 id="changesTitle">Alterações encontradas</h2>
											<p>Arquivos que serão enviados ao provedor.</p>
										</div>
										{inspection ? (
											<Badge className="file-count" variant="secondary">
												{inspection.files.length}
											</Badge>
										) : null}
									</div>

									{isBootstrapping || isInspecting ? (
										<div aria-live="polite" className="loading-state">
											<Spinner aria-hidden="true" className="spinner" />
											<span>
												{isBootstrapping
													? "Carregando configuração…"
													: "Lendo alterações do Git…"}
											</span>
										</div>
									) : !form.repositoryPath ? (
										<div className="empty-state">
											<span aria-hidden="true" className="empty-folder">
												<Folder className="icon" />
											</span>
											<strong>Escolha um repositório</strong>
											<p>A lista de arquivos alterados aparecerá aqui.</p>
										</div>
									) : inspection?.files.length ? (
										<ul className="file-list">
											{inspection.files.map((file) => (
												<li key={file.path}>
													<span className="file-path" title={file.path}>
														{file.path}
													</span>
													<Badge
														className={`kind-badge kind-${file.kind}`}
														variant="outline"
													>
														{fileKindLabels[file.kind] || file.kind}
													</Badge>
												</li>
											))}
										</ul>
									) : (
										<div className="empty-state is-clean">
											<span aria-hidden="true" className="empty-check">
												<Check className="icon" />
											</span>
											<strong>Nenhuma alteração pendente</strong>
											<p>
												O repositório está limpo ou só contém arquivos
												ignorados.
											</p>
										</div>
									)}
								</Card>
							</aside>
						</div>

						{result ? (
							<section
								aria-labelledby="resultTitle"
								aria-live="polite"
								className="result-panel"
							>
								<Card className="result-card">
									<div className="result-heading">
										<div>
											<Badge
												className={`success-label ${hasResultWarnings ? "has-warnings" : ""}`}
												variant={hasResultWarnings ? "outline" : "secondary"}
											>
												<Check aria-hidden="true" className="icon" />
												{hasResultWarnings
													? "Geração concluída com avisos"
													: "Geração concluída"}
											</Badge>
											<h2 id="resultTitle">
												{taskCount === 1
													? "1 tarefa pronta"
													: `${taskCount} tarefas prontas`}
											</h2>
											<p>
												{result.files.length}{" "}
												{result.files.length === 1
													? "arquivo processado"
													: "arquivos processados"}
												{result.failures.length
													? ` · ${result.failures.length} com falha`
													: ""}
											</p>
										</div>
										<Button
											aria-busy={isOpeningCsv}
											className="secondary-button open-csv-button"
											disabled={isOpeningCsv}
											onClick={handleOpenCsv}
											type="button"
											variant="outline"
										>
											{isOpeningCsv ? (
												<>
													<Spinner aria-hidden="true" className="icon" />
													Abrindo CSV…
												</>
											) : (
												<>
													<ExternalLink aria-hidden="true" className="icon" />
													Abrir CSV
												</>
											)}
										</Button>
									</div>

									<div className="csv-path-row">
										<span>Arquivo exportado</span>
										<code title={result.csvPath}>{result.csvPath}</code>
									</div>

									{result.azureTaskIds.length ? (
										<p className="azure-result">
											<strong>Azure DevOps:</strong> IDs criados{" "}
											{result.azureTaskIds.join(", ")}.
										</p>
									) : null}

									{result.azureError ? (
										<Alert className="inline-warning" role="status">
											<CircleAlert aria-hidden="true" />
											<AlertTitle>
												O CSV foi salvo, mas o Azure DevOps falhou.
											</AlertTitle>
											<AlertDescription>{result.azureError}</AlertDescription>
										</Alert>
									) : null}

									{result.timeLogResult || result.timeLogError ? (
										<TimeLogBatchFeedback
											error={result.timeLogError}
											isRetrying={isRetryingTimeLog}
											onRetry={
												result.timeLogRetryInput
													? handleRetryTimeLog
													: undefined
											}
											result={result.timeLogResult}
										/>
									) : null}

									{result.warnings
										.filter(
											(warning) => warning !== "Nenhuma hora para registrar.",
										)
										.map((warning) => (
											<Alert
												className="inline-warning"
												key={warning}
												role="status"
											>
												<CircleAlert aria-hidden="true" />
												<AlertTitle>Aviso da configuração</AlertTitle>
												<AlertDescription>{warning}</AlertDescription>
											</Alert>
										))}

									<Accordion
										className="result-files"
										defaultValue={
											result.files.length === 1
												? [result.files[0].fullFilePath]
												: []
										}
										key={result.csvPath}
										multiple
									>
										{result.files.map((generatedFile) => (
											<AccordionItem
												className="file-result"
												key={generatedFile.fullFilePath}
												value={generatedFile.fullFilePath}
											>
												<AccordionTrigger>
													<span>
														<strong>{generatedFile.relativePath}</strong>
														<small>
															{generatedFile.tasks.length}{" "}
															{generatedFile.tasks.length === 1
																? "tarefa"
																: "tarefas"}
														</small>
													</span>
													<Badge
														className={`stage-status ${generatedFile.staged ? "is-staged" : "is-failed"}`}
														variant={
															generatedFile.staged ? "secondary" : "destructive"
														}
													>
														{generatedFile.staged ? "No stage" : "Stage falhou"}
													</Badge>
												</AccordionTrigger>
												<AccordionContent>
													{generatedFile.stageError ? (
														<p className="stage-error">
															{generatedFile.stageError}
														</p>
													) : null}
													<div className="task-list">
														{generatedFile.tasks.map((task) => (
															<article
																className="task-row"
																key={`${generatedFile.relativePath}-${task.tipo}-${task.title}-${task.description}`}
															>
																<div className="task-row-heading">
																	<h3>{task.title}</h3>
																	<Badge
																		className={`task-type type-${task.tipo}`}
																		variant="outline"
																	>
																		{taskTypeLabels[task.tipo]}
																	</Badge>
																</div>
																<p>{task.description}</p>
																<div className="task-meta">
																	<span>{task.complexidade}</span>
																	<span>{task.estimateMade}h estimadas</span>
																</div>
															</article>
														))}
													</div>
												</AccordionContent>
											</AccordionItem>
										))}
									</Accordion>

									{result.failures.length ? (
										<Alert
											className="failure-list"
											role="status"
											variant="destructive"
										>
											<CircleAlert aria-hidden="true" />
											<AlertTitle>Arquivos não processados</AlertTitle>
											<AlertDescription>
												<ul>
													{result.failures.map((failure) => (
														<li key={failure.relativePath}>
															<strong>{failure.relativePath}</strong>
															<span>{failure.error}</span>
														</li>
													))}
												</ul>
											</AlertDescription>
										</Alert>
									) : null}
								</Card>
							</section>
						) : null}
					</TabsContent>

					<TabsContent
						aria-labelledby="time-log-tab"
						className="feature-panel"
						id="time-log-feature-panel"
						keepMounted
						value="time-log"
					>
						<TimeLogPanel
							organization={
								initialState?.config.azureOrganization ||
								initialState?.azureDefaults.organization ||
								""
							}
						/>
					</TabsContent>

					<TabsContent
						aria-labelledby="prompts-tab"
						className="feature-panel"
						id="prompts-feature-panel"
						keepMounted
						value="prompts"
					>
						{initialState ? (
							<PromptPanel
								defaultSystemPrompt={initialState.defaultSystemPrompt}
								onSaved={(promptSettings) => {
									setInitialState((current) =>
										current ? { ...current, promptSettings } : current,
									);
								}}
								settings={initialState.promptSettings}
							/>
						) : (
							<p aria-live="polite">
								{isBootstrapping
									? "Carregando instruções…"
									: "Não foi possível carregar as instruções. Reinicie o aplicativo para tentar novamente."}
							</p>
						)}
					</TabsContent>

					<TabsContent
						aria-labelledby="my-tasks-tab"
						className="feature-panel"
						id="my-tasks-feature-panel"
						keepMounted
						value="my-tasks"
					>
						{initialState ? (
							<MyTasksPanel
								codexReady={
									initialState.codexAvailable && initialState.codexAuthenticated
								}
								key={azureTasksContext}
								onOpenSettings={() => setSettingsMode("edit")}
								onUnreadChange={setUnreadAzureNotifications}
							/>
						) : (
							<p role="status">Carregando suas tarefas…</p>
						)}
					</TabsContent>

					<TabsContent
						aria-labelledby="help-tab"
						className="feature-panel"
						id="help-feature-panel"
						keepMounted
						value="help"
					>
						<HelpPanel />
					</TabsContent>
				</Tabs>
			</main>

			<footer className="app-footer">
				<span>Infortech Automation</span>
				<span>
					Entre as credenciais, somente o PAT é persistido localmente.
				</span>
			</footer>
		</div>
	);
}
