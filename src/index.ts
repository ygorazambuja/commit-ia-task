import { parseArgs } from "node:util";
import { $ } from "bun";
import { loadConfig, saveConfig } from "./config";
import { buildCsvFile } from "./csv";
import { getDiff } from "./git";
import { logger } from "./logger";


if(!Bun.env.OPENAI_API_KEY) {
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
			default: "Ygor Azambuja <ygor.azambuja@infortechms.com.br>",
		},
	},
	strict: true,
	allowPositionals: true,
});

logger.info("🚀 Iniciando aplicação Commit IA Task");

// Tenta carregar configurações salvas se parâmetros não foram fornecidos
const savedConfig = await loadConfig();

const sprintId = values.sprintId || savedConfig?.sprintId;
const areaPathId = values.areaPathId || savedConfig?.areaPathId;
const assignedTo =
	values.assignedTo || savedConfig?.assignedTo || "Ygor Azambuja <ygor.azambuja@infortechms.com.br>";

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
});

// Salva configurações para próxima execução
await saveConfig({
	sprintId,
	areaPathId,
	assignedTo,
});

try {
	const pwd = await $`pwd`.text();
	logger.debug("📁 Diretório de trabalho", { pwd: pwd.trim() });

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
		assignedTo: assignedTo,
		sprintId: sprintId,
	});

	logger.info("✅ Processo finalizado com sucesso!");
} catch (error) {
	logger.error("💥 Erro durante a execução", { error });
	process.exit(1);
}
