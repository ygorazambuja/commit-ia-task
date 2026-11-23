export type AiProvider = "openai" | "codex";
export type TaskType = "BACKEND" | "FRONTEND" | "TESTES";
export type TimeLogType =
	| "Backend"
	| "Frontend"
	| "Teste"
	| "Análise"
	| "Reunião";
export type TimeLogCredentialKind = "pat" | "bearer";

export interface AiOption {
	value: string;
	label: string;
}

export interface AiModel extends AiOption {
	reasoningEfforts: AiOption[];
	defaultReasoningEffort: string | null;
	compatibilityVerified: boolean;
}

export interface AiModelCatalog {
	models: AiModel[];
	source: "local" | "provider";
	warnings: string[];
}

export interface AiProviderCapability {
	id: AiProvider;
	displayName: string;
	description: string;
	models: AiModel[];
	defaultModel: string;
	reasoningEfforts: AiOption[];
	defaultReasoningEffort?: string;
	allowsApiKeyInput: boolean;
	ready: boolean;
	statusDetail: string;
	pendingMessage: string;
}

export interface SavedConfig {
	repositoryPath: string;
	sprintId: string;
	areaPathId: string;
	assignedTo: string;
	itemContrato: string;
	aiProvider: AiProvider;
	openaiModel: string;
	codexModel: string;
	codexReasoningEffort: string;
	azureOrganization: string;
	azureProject: string;
}

export interface AzureDefaults {
	organization: string;
	project: string;
}

export interface UserProfile {
	displayName: string;
	email: string;
}

export interface PromptSettings {
	systemPrompt: string;
}

export interface InitialState {
	config: SavedConfig;
	aiProviders: AiProviderCapability[];
	openaiConfigured: boolean;
	codexAvailable: boolean;
	codexAuthenticated: boolean;
	codexVersion?: string;
	azureDefaults: AzureDefaults;
	requiresOnboarding: boolean;
	profile: UserProfile;
	timeLogPatConfigured: boolean;
	promptSettings: PromptSettings;
	defaultSystemPrompt: string;
	warnings: string[];
}

export interface IdentifyAzureUserInput {
	organization: string;
	pat: string;
}

export interface AzureUserIdentity {
	displayName: string;
	email?: string;
}

export interface AzureWorkItem {
	id: number;
	revision: number;
	title: string;
	workItemType: string;
	state: string;
	assignedTo: string;
	changedDate: string;
	iterationPath: string;
	areaPath: string;
	url: string;
	priority: number | null;
	canAnalyze: boolean;
}

export interface AzureTaskNotification {
	id: string;
	workItemId: number;
	title: string;
	message: string;
	createdAt: string;
	read: boolean;
}

export interface AzureTasksSnapshot {
	items: AzureWorkItem[];
	notifications: AzureTaskNotification[];
	status: "loading" | "ready" | "error" | "unconfigured";
	message: string | null;
	lastCheckedAt: string | null;
}

export interface CardAnalysis {
	summary: string;
	acceptanceCriteria: string[];
	relevantFiles: string[];
	implementationPlan: string[];
	testPlan: string[];
	risks: string[];
	openQuestions: string[];
	warnings: string[];
}

export interface AnalyzeAzureTaskInput {
	workItemId: number;
	repositoryPath: string;
}

export interface SaveAppSettingsInput {
	displayName: string;
	email: string;
	azureOrganization: string;
	azureProject: string;
	aiProvider: AiProvider;
	openaiModel: string;
	codexModel: string;
	codexReasoningEffort: string;
	timeLogPat?: string;
	removeTimeLogPat: boolean;
}

export interface SaveAppSettingsResult {
	config: SavedConfig;
	profile: UserProfile;
	timeLogPatConfigured: boolean;
	warnings: string[];
}

export interface ChangedFileSummary {
	path: string;
	kind: string;
}

export interface RepositoryInspection {
	repositoryPath: string;
	files: ChangedFileSummary[];
}

export interface GenerationInput {
	repositoryPath: string;
	sprintId: string;
	areaPathId: string;
	assignedTo: string;
	itemContrato: string;
	aiProvider: AiProvider;
	openaiModel: string;
	codexModel: string;
	codexReasoningEffort: string;
	apiKey?: string;
	createAzureTasks: boolean;
	registerTimeLog: boolean;
	timeLogStartDate: string;
	timeLogEndDate: string;
	azureOrganization: string;
	azureProject: string;
	parentWorkItemId?: number;
}

export interface Task {
	title: string;
	description: string;
	tipo: TaskType;
	complexidade: string;
	estimateMade: number;
}

export interface GeneratedFile {
	fullFilePath: string;
	relativePath: string;
	tasks: Task[];
	staged: boolean;
	stageError?: string;
}

export interface FileFailure {
	relativePath: string;
	error: string;
}

export interface GenerationResult {
	repositoryPath: string;
	files: GeneratedFile[];
	failures: FileFailure[];
	csvPath: string;
	azureTaskIds: number[];
	azureError?: string;
	timeLogResult?: TimeLogBatchResult;
	timeLogError?: string;
	timeLogRetryInput?: Omit<TimeLogInput, "credential" | "credentialKind">;
	warnings: string[];
}

export interface GenerationProgress {
	phase:
		| "preparing"
		| "generating"
		| "staging"
		| "exporting"
		| "azure"
		| "timeLog"
		| "completed";
	message: string;
	current: number;
	total: number;
	activeFiles: string[];
}

export interface TimeLogWork {
	minutes: number;
	type: TimeLogType;
	comment: string;
}

export interface TimeLogPlanEntry extends TimeLogWork {
	date: string;
}

export interface TimeLogPlanDay {
	date: string;
	existingMinutes: number;
	newMinutes: number;
	totalMinutes: number;
	entries: TimeLogPlanEntry[];
}

export interface TimeLogPlan {
	workItemId: number;
	requestedMinutes: number;
	scheduledMinutes: number;
	missingMinutes: number;
	days: TimeLogPlanDay[];
}

export interface TimeLogCreatedEntry {
	entry: TimeLogPlanEntry;
	documentId?: string;
}

export interface TimeLogBatchFailure {
	entry: TimeLogPlanEntry;
	error: string;
	indeterminate: boolean;
}

export interface TimeLogBatchResult {
	plan: TimeLogPlan;
	created: TimeLogCreatedEntry[];
	pending: TimeLogPlanEntry[];
	failure?: TimeLogBatchFailure;
	postAttempts: number;
	retryable: boolean;
}

export interface TimeLogInput {
	workItemId: number;
	startDate: string;
	endDate: string;
	work: TimeLogWork[];
	organization: string;
	credential?: string;
	credentialKind?: TimeLogCredentialKind;
}
