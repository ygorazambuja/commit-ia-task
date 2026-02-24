import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { $ } from "bun";
import {
	getConfigFilePath,
	loadConfig,
	type SavedConfig,
	saveConfig,
} from "./config";
import { buildCsvFile } from "./csv";
import { getDiff } from "./git";
import { logger } from "./logger";

const DEFAULT_ASSIGNED_TO = "Ygor Azambuja <ygor.azambuja@infortechms.com.br>";
const DEFAULT_ITEM_CONTRATO = "Item 1";

if (!Bun.env.OPENAI_API_KEY) {
	logger.error("❌ Variável de ambiente OPENAI_API_KEY não configurada");
	process.exit(1);
}

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
	},
	strict: true,
	allowPositionals: true,
});

logger.info("🚀 Iniciando aplicação Commit IA Task");

// Tenta carregar configurações salvas se parâmetros não foram fornecidos
const savedConfig = await loadConfig();

const isInteractiveTerminal = Boolean(
	process.stdin.isTTY && process.stdout.isTTY,
);

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
			required: true,
		});
		const areaPathId = await promptValue({
			rl,
			label: "Area Path ID",
			currentValue: config.areaPathId,
			required: true,
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

		return { sprintId, areaPathId, assignedTo, itemContrato };
	} finally {
		rl.close();
	}
};

let config: SavedConfig = {
	sprintId: values.sprintId || savedConfig?.sprintId || "",
	areaPathId: values.areaPathId || savedConfig?.areaPathId || "",
	assignedTo:
		values.assignedTo || savedConfig?.assignedTo || DEFAULT_ASSIGNED_TO,
	itemContrato:
		values.itemContrato || savedConfig?.itemContrato || DEFAULT_ITEM_CONTRATO,
};

logger.info("📋 Configuração atual", {
	sprintId: formatCurrentValue(config.sprintId),
	areaPathId: formatCurrentValue(config.areaPathId),
	assignedTo: formatCurrentValue(config.assignedTo),
	itemContrato: formatCurrentValue(config.itemContrato),
	configFile: getConfigFilePath(),
});

if (isInteractiveTerminal) {
	config = await promptConfig(config);
}

const { sprintId, areaPathId, assignedTo, itemContrato } = config;

if (!sprintId || !areaPathId) {
	logger.error("❌ Parâmetros obrigatórios não fornecidos", {
		sprintId,
		areaPathId,
	});
	console.error(
		"--sprintId and --areaPathId are required (or run with saved config)",
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
});

// Salva configurações para próxima execução
await saveConfig({
	sprintId,
	areaPathId,
	assignedTo,
	itemContrato,
});

try {
	const pwd = (await $`pwd`.text()).trim();
	logger.debug("📁 Diretório de trabalho", { pwd });

	logger.info("🔍 Iniciando análise de diferenças do Git...");
	const files = await getDiff(pwd);

	logger.info("📊 Análise concluída", {
		totalFiles: files.length,
		totalTasks: files.reduce((sum, file) => sum + file.tasks.length, 0),
	});

	logger.info("📝 Gerando arquivo CSV...");
	await buildCsvFile({
		files,
		areaId: areaPathId,
		assignedTo,
		sprintId,
		itemContrato,
	});

	logger.info("✅ Processo finalizado com sucesso!");
} catch (error) {
	logger.error("💥 Erro durante a execução", { error });
	process.exit(1);
}
