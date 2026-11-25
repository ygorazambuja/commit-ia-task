import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { $ } from "bun";
import {
	type AiProvider,
	resolveAiProvider,
	setAiProvider,
	setJevAllowed,
	validateAiProviderSetup,
} from "./ai-provider";
import { createAzureTasks, getAzureDevopsDefaults } from "./azure-devops";
import {
	getConfigFilePath,
	loadConfig,
	type SavedConfig,
	saveConfig,
} from "./config";
import { buildCsvFile, buildTaskRecords } from "./csv";
import { getDiff } from "./git";
import { logger } from "./logger";

const DEFAULT_ASSIGNED_TO = "Ygor Azambuja <ygor.azambuja@infortechms.com.br>";
const DEFAULT_ITEM_CONTRATO = "Item 1";

const { values } = parseArgs({
	args: Bun.argv,
	options: {
		sprintId: {
			type: "string",
		},
		areaPathId: {
			type: "string",
		},
		assignedTo: {
			type: "string",
		},
		itemContrato: {
			type: "string",
		},
		aiProvider: {
			type: "string",
		},
		createAzureTasks: {
			type: "boolean",
		},
		azureOrganization: {
			type: "string",
		},
		azureProject: {
			type: "string",
		},
		branch: {
			type: "string",
		},
		baseBranch: {
			type: "string",
		},
		pbi: {
			type: "string",
		},
		noCsv: {
			type: "boolean",
		},
		noJev: {
			type: "boolean",
		},
	},
	strict: true,
	allowPositionals: true,
});

let aiProvider: AiProvider;
try {
	aiProvider = resolveAiProvider(values.aiProvider);
} catch (error) {
	logger.error("❌ Provedor de IA inválido", {
		aiProvider: values.aiProvider,
		error: error instanceof Error ? error.message : String(error),
	});
	process.exit(1);
}

if (values.pbi !== undefined) {
	if (!/^\d+$/.test(values.pbi)) {
		logger.error("❌ --pbi deve ser o ID numérico do PBI", { pbi: values.pbi });
		process.exit(1);
	}
	if (!values.createAzureTasks) {
		logger.error("❌ --pbi só funciona junto com --createAzureTasks");
		process.exit(1);
	}
}

if (values.noCsv && !values.createAzureTasks) {
	logger.error("❌ --noCsv só faz sentido com --createAzureTasks");
	process.exit(1);
}

setAiProvider(aiProvider);
setJevAllowed(!values.noJev);
await validateAiProviderSetup(aiProvider);

logger.info("🚀 Iniciando aplicação Commit IA Task");

// Tenta carregar configurações salvas se parâmetros não foram fornecidos
const savedConfig = await loadConfig();

const isInteractiveTerminal = Boolean(
	process.stdin.isTTY && process.stdout.isTTY,
);

// Sprint e área só são obrigatórias para criar tasks no Azure; o CSV sai com os campos vazios.
const azureRequired = Boolean(values.createAzureTasks);

const formatCurrentValue = (value: string): string => {
	return value.trim().length > 0 ? value : "(não definido)";
};

const promptValue = async ({
	rl,
	label,
	currentValue,
	required = false,
}: {
	rl: ReturnType<typeof createInterface>;
	label: string;
	currentValue: string;
	required?: boolean;
}): Promise<string> => {
	while (true) {
		const answer = await rl.question(
			`${label} [${formatCurrentValue(currentValue)}]: `,
		);
		const nextValue = answer.trim() || currentValue;

		if (!required || nextValue.trim().length > 0) {
			return nextValue;
		}

		console.error(`O campo "${label}" é obrigatório.`);
	}
};

const promptConfig = async (config: SavedConfig): Promise<SavedConfig> => {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		console.log(
			"\nConfigurações atuais (pressione Enter para manter o valor):",
		);
		const sprintId = await promptValue({
			rl,
			label: "Sprint ID",
			currentValue: config.sprintId,
			required: azureRequired,
		});
		const areaPathId = await promptValue({
			rl,
			label: "Area Path ID",
			currentValue: config.areaPathId,
			required: azureRequired,
		});
		const assignedTo = await promptValue({
			rl,
			label: "Assigned To",
			currentValue: config.assignedTo,
			required: true,
		});
		const itemContrato = await promptValue({
			rl,
			label: "Item Contrato",
			currentValue: config.itemContrato,
			required: true,
		});
		const azureOrganization = await promptValue({
			rl,
			label: "Azure Organization",
			currentValue: config.azureOrganization,
		});
		const azureProject = await promptValue({
			rl,
			label: "Azure Project",
			currentValue: config.azureProject,
		});

		return {
			sprintId,
			areaPathId,
			assignedTo,
			itemContrato,
			azureOrganization,
			azureProject,
		};
	} finally {
		rl.close();
	}
};

const azureDefaults = await getAzureDevopsDefaults();

let config: SavedConfig = {
	sprintId: values.sprintId || savedConfig?.sprintId || "",
	areaPathId: values.areaPathId || savedConfig?.areaPathId || "",
	assignedTo:
		values.assignedTo || savedConfig?.assignedTo || DEFAULT_ASSIGNED_TO,
	itemContrato:
		values.itemContrato || savedConfig?.itemContrato || DEFAULT_ITEM_CONTRATO,
	azureOrganization:
		values.azureOrganization ||
		savedConfig?.azureOrganization ||
		azureDefaults.organization,
	azureProject:
		values.azureProject || savedConfig?.azureProject || azureDefaults.project,
};

logger.info("📋 Configuração atual", {
	sprintId: formatCurrentValue(config.sprintId),
	areaPathId: formatCurrentValue(config.areaPathId),
	assignedTo: formatCurrentValue(config.assignedTo),
	itemContrato: formatCurrentValue(config.itemContrato),
	azureOrganization: formatCurrentValue(config.azureOrganization),
	azureProject: formatCurrentValue(config.azureProject),
	configFile: getConfigFilePath(),
});

if (isInteractiveTerminal) {
	config = await promptConfig(config);
}

const {
	sprintId,
	areaPathId,
	assignedTo,
	itemContrato,
	azureOrganization,
	azureProject,
} = config;

if (azureRequired && (!sprintId || !areaPathId)) {
	logger.error("❌ Parâmetros obrigatórios não fornecidos", {
		sprintId,
		areaPathId,
	});
	console.error(
		"--createAzureTasks exige --sprintId e --areaPathId (ou config salva)",
	);
	process.exit(1);
}

if (savedConfig) {
	logger.info("📂 Usando configurações salvas", { savedConfig });
}

logger.info("📋 Configurações validadas", {
	sprintId,
	areaPathId,
	assignedTo,
	itemContrato,
	aiProvider,
	createAzureTasks: values.createAzureTasks,
	azureOrganization: formatCurrentValue(azureOrganization),
	azureProject: formatCurrentValue(azureProject),
});

// Salva configurações para próxima execução
await saveConfig({
	sprintId,
	areaPathId,
	assignedTo,
	itemContrato,
	azureOrganization,
	azureProject,
});

try {
	const pwd = (await $`pwd`.text()).trim();
	logger.debug("📁 Diretório de trabalho", { pwd });

	logger.info("🔍 Iniciando análise de diferenças do Git...");
	const files = await getDiff(pwd, {
		aiProvider,
		branch: values.branch,
		baseBranch: values.baseBranch,
	});

	logger.info("📊 Análise concluída", {
		totalFiles: files.length,
		totalTasks: files.reduce((sum, file) => sum + file.tasks.length, 0),
	});

	if (!values.noCsv) {
		logger.info("📝 Gerando arquivo CSV...");
		await buildCsvFile({
			files,
			areaId: areaPathId,
			assignedTo,
			sprintId,
			itemContrato,
		});
	}

	if (values.createAzureTasks) {
		const records = buildTaskRecords({
			files,
			areaId: areaPathId,
			assignedTo,
			sprintId,
			itemContrato,
		});

		await createAzureTasks({
			records,
			organization: azureOrganization,
			project: azureProject,
			parentId: values.pbi ? Number(values.pbi) : undefined,
		});
	}

	logger.info("✅ Processo finalizado com sucesso!");
} catch (error) {
	logger.error("💥 Erro durante a execução", { error });
	process.exit(1);
}
