import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import type {
	AzureTasksSnapshot,
	CardAnalysis,
	InitialState,
} from "../src/types";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repository, ".cache/visual-review");
const skillDirectory = resolve(
	process.env.DEV_BROWSER_SKILL_DIR ||
		join(homedir(), ".codex/skills/dev-browser"),
);
const browserUrl = new URL(
	process.env.DEV_BROWSER_URL || "http://127.0.0.1:9222",
);
assert(
	browserUrl.protocol === "http:" &&
		["localhost", "127.0.0.1", "[::1]"].includes(browserUrl.hostname),
	"DEV_BROWSER_URL deve apontar para o servidor local da skill dev-browser.",
);
const clientPath = join(skillDirectory, "src/client.ts");
await access(clientPath).catch(() => {
	throw new Error(
		"Skill dev-browser não encontrada. Informe DEV_BROWSER_SKILL_DIR (veja docs/testing/visual.md).",
	);
});
await fetch(browserUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => {
	throw new Error(
		"Inicie o servidor dev-browser e aguarde Ready (veja docs/testing/visual.md).",
	);
});
// O cliente resolve suas dependências na skill, sem instalar Playwright no app.
process.chdir(skillDirectory);
const { connect } = await import(pathToFileURL(clientPath).href);
const client = await connect(browserUrl.href.replace(/\/$/, ""));
assert.equal(
	(await client.getServerInfo()).mode,
	"launch",
	"Use o servidor independente da skill, sem uma sessão pessoal do navegador.",
);

const initial: InitialState = {
	config: {
		repositoryPath: "",
		sprintId: "Sprint 12",
		areaPathId: "Produto",
		assignedTo: "Pessoa <pessoa@infortechms.com.br>",
		itemContrato: "Item 1",
		aiProvider: "codex",
		openaiModel: "gpt-6-luna",
		codexModel: "gpt-6-luna",
		codexReasoningEffort: "low",
		azureOrganization: "https://dev.azure.com/exemplo",
		azureProject: "Projeto",
	},
	aiProviders: ["openai", "codex"].map((id) => ({
		id: id as "openai" | "codex",
		displayName: id === "codex" ? "Codex" : "OpenAI",
		description: "Provedor configurado",
		models: [
			{
				value: "gpt-6-luna",
				label: "GPT-6 Luna",
				reasoningEfforts: [{ value: "low", label: "Baixo" }],
				defaultReasoningEffort: "low",
				compatibilityVerified: true,
			},
		],
		defaultModel: "gpt-6-luna",
		reasoningEfforts: [{ value: "low", label: "Baixo" }],
		defaultReasoningEffort: "low",
		allowsApiKeyInput: id === "openai",
		ready: true,
		statusDetail: "Pronto",
		pendingMessage: "",
	})),
	openaiConfigured: true,
	codexAvailable: true,
	codexAuthenticated: true,
	azureDefaults: {
		organization: "https://dev.azure.com/exemplo",
		project: "Projeto",
	},
	requiresOnboarding: false,
	profile: { displayName: "Pessoa", email: "pessoa@infortechms.com.br" },
	timeLogPatConfigured: true,
	promptSettings: { systemPrompt: "Gere tarefas em português." },
	defaultSystemPrompt: "Gere tarefas em português.",
	warnings: [],
};
const item = {
	id: 201878,
	revision: 3,
	title:
		"Permitir acompanhamento de parcelas e atualização do saldo do contrato",
	workItemType: "Product Backlog Item",
	state: "To Do",
	assignedTo: "Pessoa",
	changedDate: "2026-10-09T18:00:00Z",
	priority: 2,
	iterationPath: "Projeto / Sprint 12",
	areaPath: "Produto",
	url: "https://dev.azure.com/exemplo/Projeto/_workitems/edit/201878",
	canAnalyze: true,
};
const snapshot: AzureTasksSnapshot = {
	status: "ready",
	message: null,
	lastCheckedAt: item.changedDate,
	items: [
		item,
		{
			...item,
			id: 201879,
			title: "Corrigir validação ao salvar os dados cadastrais",
			state: "In Progress",
			workItemType: "Bug",
		},
		{
			...item,
			id: 201880,
			title: "Atualizar relatório de arrecadação",
			state: "Done",
			canAnalyze: false,
		},
	],
	notifications: [
		{
			id: "201878:3",
			workItemId: item.id,
			title: item.title,
			message: "Estado alterado: New → To Do.",
			createdAt: item.changedDate,
			read: false,
		},
	],
};
const analysis: CardAnalysis = {
	summary:
		"O card solicita acompanhar as parcelas de um contrato e atualizar o saldo após uma alteração. A implementação deve reaproveitar o serviço atual de cálculo e preservar os lançamentos já conciliados.",
	acceptanceCriteria: ["Exibir o saldo atualizado após uma alteração válida."],
	relevantFiles: [
		"src/services/contratos.ts — cálculo de saldo e consulta de parcelas",
	],
	implementationPlan: [
		"Verificar as regras de alteração das parcelas e de conciliação.",
		"Atualizar o cálculo no serviço existente e apresentar o resultado na tela.",
	],
	testPlan: [
		"Validar uma alteração permitida e a tentativa de alterar uma parcela conciliada.",
	],
	risks: ["Alterações no cálculo podem afetar relatórios existentes."],
	openQuestions: ["O saldo deve considerar juros até qual data?"],
	warnings: [],
};
const mockBridge = `
let state = ${JSON.stringify(snapshot)};
const initial = ${JSON.stringify(initial)};
const listeners = new Set();
export const getInitialState = async () => initial;
export const listAiModels = async (provider) => ({models: initial.aiProviders.find(p => p.id === provider).models, source: 'local', warnings: []});
export const onGenerationProgress = async () => () => {};
export const getAzureTasks = async () => state;
export const onAzureTasksUpdated = async (callback) => { listeners.add(callback); return () => listeners.delete(callback); };
export const refreshAzureTasks = async () => state;
export const markAzureNotificationsRead = async () => {
	state = {...state, notifications: state.notifications.map(n => ({...n, read: true}))};
	for (const callback of listeners) callback(state);
	return state;
};
export const chooseRepository = async () => '/workspace/repositorio-exemplo';
export const analyzeAzureTask = async (input) => {
	if (input.workItemId !== 201878 || input.repositoryPath !== '/workspace/repositorio-exemplo') throw new Error('Seleção inesperada');
	return ${JSON.stringify(analysis)};
};
const unexpected = async () => { throw new Error('Operação fora do cenário visual'); };
export { unexpected as inspectRepository, unexpected as identifyAzureUser, unexpected as saveAppSettings, unexpected as savePromptSettings, unexpected as runGeneration, unexpected as createTimeLog, unexpected as openCsvFile };
`;
const server = await createServer({
	root: repository,
	server: { host: "127.0.0.1", port: 0, hmr: false, open: false },
});
const pageName = `infortech-visual-${process.pid}`;
const page = await client.page(pageName, {
	viewport: { width: 1440, height: 900 },
});
const errors: string[] = [];
const captures: { file: string; width: number; height: number }[] = [];
page.on("pageerror", (error: Error) => errors.push(error.message));
try {
	await mkdir(outputDirectory, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 900 });
	await server.listen();
	const origin = new URL(server.resolvedUrls?.local?.[0] || "").origin;
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.hostname === "fonts.googleapis.com" && url.pathname === "/css2") {
			await route.fulfill({ contentType: "text/css", body: "" });
		} else if (url.origin !== origin) {
			errors.push(`Requisição externa bloqueada: ${route.request().url()}`);
			await route.abort();
		} else if (url.pathname === "/src/desktop.ts") {
			await route.fulfill({
				contentType: "application/javascript",
				body: mockBridge,
			});
		} else {
			await route.continue();
		}
	});
	await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
	await page.goto(origin);
	await page.getByRole("tab", { name: "Minhas tarefas" }).click();
	await page
		.getByRole("heading", { name: "Cards atribuídos a você", exact: false })
		.waitFor();
	await page.getByText("Atualizações dos cards", { exact: false }).click();
	assert.equal(
		await page
			.getByRole("button", { name: "Fazer análise do card #201880" })
			.count(),
		0,
	);
	const capture = async (file: string) => {
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			),
			false,
			`Rolagem horizontal em ${file}`,
		);
		await page.screenshot({
			path: join(outputDirectory, file),
			fullPage: true,
			animations: "disabled",
		});
		captures.push({ file, ...page.viewportSize() });
	};
	await capture("minhas-tarefas-1440.png");
	await page.getByRole("button", { name: "Marcar todas como lidas" }).click();
	await page
		.getByText("Atualizações dos cards · tudo lido", { exact: false })
		.waitFor();
	await page
		.getByRole("button", { name: "Fazer análise do card #201878" })
		.click();
	const planHeading = page.getByRole("heading", {
		name: "Análise e plano · #201878",
	});
	await planHeading.waitFor();
	await planHeading.scrollIntoViewIfNeeded();
	assert.equal(
		await page.getByText(analysis.summary, { exact: true }).count(),
		1,
	);
	await page
		.locator(".app-toast")
		.waitFor({ state: "hidden", timeout: 10_000 });
	await capture("minhas-tarefas-plano.png");
	await page.setViewportSize({ width: 860, height: 640 });
	await capture("minhas-tarefas-860.png");
	assert.deepEqual(
		errors,
		[],
		"A página gerou erros ou tentou acessar serviços externos.",
	);
	await writeFile(
		join(outputDirectory, "report.json"),
		`${JSON.stringify({ passed: true, captures }, null, 2)}\n`,
	);
	await rm(join(outputDirectory, "failure.png"), { force: true });
	console.log(`Verificação visual concluída: ${outputDirectory}`);
} catch (error) {
	await page
		.screenshot({ path: join(outputDirectory, "failure.png"), fullPage: true })
		.catch(() => {});
	await writeFile(
		join(outputDirectory, "report.json"),
		`${JSON.stringify({ passed: false, error: String(error), errors, captures }, null, 2)}\n`,
	).catch(() => {});
	throw error;
} finally {
	await client.close(pageName).catch(() => {});
	await client.disconnect();
	await server.close();
}
