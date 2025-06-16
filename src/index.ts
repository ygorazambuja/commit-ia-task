import { $ } from "bun";
import { parseArgs } from "util";
import { buildCsvFile } from "./csv";
import { getDiff } from "./git";
import { logger } from "./logger";

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

if (!values.sprintId || !values.areaPathId) {
  logger.error("❌ Parâmetros obrigatórios não fornecidos", {
    sprintId: values.sprintId,
    areaPathId: values.areaPathId,
  });
  console.error("--sprintId and --areaPathId are required");
  process.exit(1);
}

logger.info("📋 Configurações validadas", {
  sprintId: values.sprintId,
  areaPathId: values.areaPathId,
  assignedTo: values.assignedTo,
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
    areaId: values.areaPathId,
    assignedTo: values.assignedTo,
    sprintId: values.sprintId,
  });

  logger.info("✅ Processo finalizado com sucesso!");
} catch (error) {
  logger.error("💥 Erro durante a execução", { error });
  process.exit(1);
}
