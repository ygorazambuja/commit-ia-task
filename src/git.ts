import { $ } from "bun";
import type { z } from "zod";
import { createTasks, expectedOutputTask } from "./ai";
import { logger } from "./logger";

export async function getDiff(gitFolder: string) {
  logger.info("🔍 Iniciando análise de arquivos alterados", { gitFolder });

  const files = await getAlteredFileNames(gitFolder);
  logger.info("📁 Arquivos encontrados", {
    count: files.length,
    files: files.map((f) => f.replace(gitFolder + "/", "")),
  });

  const jsons: z.infer<typeof expectedOutputTask>[] = [];

  const promises = files.map(async (file) => {
    const fileName = file.replace(gitFolder + "/", "");
    logger.info("🤖 Iniciando criação de tasks para arquivo", { fileName });

    const diff = await $`git diff ${file}`.text();
    logger.debug("📝 Diff obtido", { fileName, diffLength: diff.length });

    return createTasks({ file, diff });
  });

  const results = await Promise.allSettled(promises);

  const corrects = results.filter((r) => r.status === "fulfilled");
  const errors = results.filter((r) => r.status === "rejected");

  logger.info("📊 Resultados do processamento", {
    sucessos: corrects.length,
    erros: errors.length,
    total: results.length,
  });

  corrects.map(async (c) => {
    const fileName = c.value.fullFilePath.replace(gitFolder + "/", "");
    logger.info("✅ Tasks geradas com sucesso", {
      fileName,
      tasksCount: c.value.tasks.length,
      tasks: c.value.tasks.map((t) => t.title),
    });

    jsons.push({
      fullFilePath: c.value?.fullFilePath ?? "",
      tasks: c.value?.tasks ?? [],
    });
  });

  logger.info("📝 Adicionando arquivos ao Git...");
  for (const c of corrects) {
    const fileName =
      c.value?.fullFilePath?.replace(gitFolder + "/", "") || "unknown";

    const { stderr, exitCode } = await $`git add ${c.value?.fullFilePath}`
      .nothrow()
      .quiet();

    if (exitCode !== 0) {
      logger.error("❌ Erro ao adicionar arquivo ao Git", {
        fileName,
        error: stderr.toString(),
      });
    } else {
      logger.debug("✅ Arquivo adicionado ao Git", { fileName });
    }
  }

  if (errors.length > 0) {
    logger.error("❌ Erros encontrados durante o processamento", {
      errorCount: errors.length,
    });
    errors.forEach((error, index) => {
      logger.error(`Erro ${index + 1}:`, { error: error.reason });
    });
  }

  logger.info("🏁 Análise de diff concluída", {
    totalFiles: jsons.length,
    totalTasks: jsons.reduce((sum, json) => sum + json.tasks.length, 0),
  });

  return jsons;
}

async function getAlteredFileNames(gitFolder: string): Promise<Array<string>> {
  logger.debug("🔍 Buscando arquivos alterados e novos...");

  const diffProc = Bun.spawn(["git", "diff", "--name-only"]);
  const newFilesProc = Bun.spawn([
    "git",
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  const ignoredPatterns = ["pnpm-lock.yaml", "bun.lockb", "package-lock.json"];

  const diffText = await new Response(diffProc.stdout).text();
  const diffFiles = diffText
    .split("\n")
    .filter(Boolean)
    .filter((f) => !ignoredPatterns.includes(f))
    .map((f) => gitFolder.concat(`/${f}`))
    .map((f) => f.replaceAll("\n", ""));

  const newFilesText = await new Response(newFilesProc.stdout).text();
  const newFiles = newFilesText
    .split("\n")
    .filter(Boolean)
    .filter((f) => !ignoredPatterns.includes(f))
    .map((f) => gitFolder.concat(`/${f}`))
    .map((f) => f.replaceAll("\n", ""));

  logger.debug("📊 Arquivos encontrados", {
    arquivosAlterados: diffFiles.length,
    arquivosNovos: newFiles.length,
    arquivosIgnorados: ignoredPatterns,
  });

  return [...diffFiles, ...newFiles];
}
