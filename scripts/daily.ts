// Lança a task "Daily" do dia na PBI Institucional da sprint. Documentação: README.md, seção "Skills".
import { parseArgs } from "node:util";
import {
	type AzureCliExecutor,
	createAzureTasks,
	defaultExecutor,
	getAzureDevopsDefaults,
} from "../src/azure-devops";
import { loadConfig } from "../src/config";
import type { TaskRecord } from "../src/csv";
import { logger } from "../src/logger";

type WorkItem = { id: number; fields?: Record<string, unknown> };

export type RegisterDailyInput = {
	sprintId: string;
	areaPathId: string;
	assignedTo: string;
	itemContrato: string;
	organization?: string;
	project?: string;
	pbi?: number;
	dryRun?: boolean;
	executor?: AzureCliExecutor;
};

export type RegisterDailyResult = {
	pbi: number;
	id?: number;
	status: "criada" | "existente" | "simulada";
};

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

const iterationFilter = (sprintId: string) =>
	/^\d+$/.test(sprintId.trim())
		? `[System.IterationId] = ${sprintId.trim()}`
		: `[System.IterationPath] = ${quote(sprintId)}`;

export const registerDaily = async ({
	sprintId,
	areaPathId,
	assignedTo,
	itemContrato,
	organization,
	project,
	pbi,
	dryRun = false,
	executor = defaultExecutor,
}: RegisterDailyInput): Promise<RegisterDailyResult> => {
	const scope = [
		...(organization ? ["--org", organization] : []),
		...(project ? ["--project", project] : []),
	];
	// Sem resultados o az não imprime nada (nem "[]").
	const query = async (wiql: string) =>
		JSON.parse(
			(await executor([
				"boards",
				"query",
				"--wiql",
				wiql,
				...scope,
				"--output",
				"json",
			])) || "[]",
		) as WorkItem[];

	const pbiFilter = pbi
		? `[System.Id] = ${pbi}`
		: `[System.WorkItemType] = 'Product Backlog Item' AND [System.Title] CONTAINS 'Institucional' AND ${iterationFilter(sprintId)}`;
	const pbis = await query(
		`SELECT [System.Id], [System.IterationPath] FROM WorkItems WHERE ${pbiFilter}`,
	);
	if (pbis.length !== 1 || !pbis[0]) {
		throw new Error(
			pbis.length === 0
				? `Nenhuma PBI Institucional encontrada (${pbi ? `ID ${pbi}` : `sprint ${sprintId}`})`
				: `Mais de uma PBI Institucional na sprint ${sprintId}: ${pbis.map((p) => p.id).join(", ")}. Use --pbi <id>.`,
		);
	}
	const parent = pbis[0];

	const existing = await query(
		`SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = ${parent.id} AND [System.WorkItemType] = 'Task' AND [System.Title] = 'Daily' AND [System.AssignedTo] = ${quote(assignedTo)} AND [System.CreatedDate] >= @Today`,
	);
	if (existing[0]) {
		logger.info("ℹ️ Daily de hoje já lançada", {
			id: existing[0].id,
			pbi: parent.id,
		});
		return { pbi: parent.id, id: existing[0].id, status: "existente" };
	}

	const iterationPath = String(parent.fields?.["System.IterationPath"] ?? "");
	const sprintLabel =
		iterationPath.match(/SP\s*\d+/i)?.[0] ??
		iterationPath.split("\\").pop() ??
		sprintId;

	// Roda no fim do expediente: a descrição lista as tasks do responsável que mudaram hoje.
	const activities = await query(
		`SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.WorkItemType] = 'Task' AND [System.AssignedTo] = ${quote(assignedTo)} AND [System.ChangedDate] >= @Today AND [System.Title] <> 'Daily' ORDER BY [System.Id]`,
	);
	const link = (id: number) =>
		organization && project
			? `<a href="${organization.replace(/\/$/, "")}/${encodeURIComponent(project)}/_workitems/edit/${id}/">#${id}</a>`
			: `#${id}`;
	const activityList = activities
		.map(
			({ id, fields }) =>
				`<li>${link(id)} ${escapeHtml(String(fields?.["System.Title"] ?? ""))} (${escapeHtml(String(fields?.["System.State"] ?? ""))})</li>`,
		)
		.join("");
	const description = `<p>Reunião diária da ${escapeHtml(sprintLabel)}.</p>${
		activityList
			? `<p>Atividades do dia:</p><ul>${activityList}</ul>`
			: "<p>Nenhuma task alterada hoje.</p>"
	}`;

	// Mesmo padrão das Dailies já lançadas manualmente: 1h, ID SPF 17, UST 1, BAIXA, já concluída.
	const record: TaskRecord = {
		ID: "",
		"Work Item Type": "Task",
		Title: "Daily",
		"Assigned To": assignedTo,
		State: "Done",
		"Area ID": areaPathId,
		"Iteration ID": sprintId,
		"Item Contrato": itemContrato,
		"ID SPF": "17",
		UST: 1,
		Complexidade: "BAIXA",
		Activity: "Development",
		Description: description,
		"Estimate Made": 1,
		"Remaining Work": 0,
		"Original Estimate": 1,
	};

	if (dryRun) {
		logger.info("🧪 Simulação: a Daily seria criada assim", {
			pbi: parent.id,
			record,
		});
		// O logger trunca strings longas; a descrição sai inteira para conferência.
		console.log(description);
		return { pbi: parent.id, status: "simulada" };
	}

	const [id] = await createAzureTasks({
		records: [record],
		organization,
		project,
		parentId: parent.id,
		executor,
	});
	return { pbi: parent.id, id, status: "criada" };
};

if (import.meta.main) {
	try {
		const { values } = parseArgs({
			options: {
				sprintId: { type: "string" },
				pbi: { type: "string" },
				dryRun: { type: "boolean" },
			},
			strict: true,
		});
		const config = await loadConfig();
		const sprintId = values.sprintId || config?.sprintId;
		if (!sprintId || !config?.areaPathId || !config.assignedTo) {
			throw new Error(
				"Config sem sprintId/areaPathId/assignedTo. Rode o commit-ia-task uma vez para salvar a config.",
			);
		}
		const pbi = values.pbi ? Number(values.pbi) : undefined;
		if (pbi !== undefined && !Number.isInteger(pbi)) {
			throw new Error(`--pbi deve ser um ID numérico: ${values.pbi}`);
		}
		const defaults =
			config.azureOrganization && config.azureProject
				? { organization: "", project: "" }
				: await getAzureDevopsDefaults();

		const result = await registerDaily({
			sprintId,
			areaPathId: config.areaPathId,
			assignedTo: config.assignedTo,
			itemContrato: config.itemContrato || "Item 1",
			organization: config.azureOrganization || defaults.organization,
			project: config.azureProject || defaults.project,
			pbi,
			dryRun: values.dryRun,
		});
		logger.info(`✅ Daily ${result.status}`, result);
	} catch (error) {
		logger.error("❌ Falha ao lançar a Daily", {
			error: error instanceof Error ? error.message : String(error),
		});
		process.exit(1);
	}
}
