import { $ } from "bun";
import type { z } from "zod";
import { createTasks, type expectedOutputTask } from "./ai";
import { logger } from "./logger";

export async function getDiff(gitFolder: string) {
	logger.info("🔍 Iniciando análise de arquivos alterados", { gitFolder });

	const files = await getAlteredFileNames(gitFolder);
	logger.info("📁 Arquivos encontrados", {
		count: files.length,
		files: files.map((f) => f.replace(`${gitFolder}/`, "")),
	});

	const jsons: z.infer<typeof expectedOutputTask>[] = [];

	const promises = files.map(async (file) => {
		const fileName = file.replace(`${gitFolder}/`, "");
		logger.info("🤖 Iniciando criação de tasks para arquivo", { fileName });

		// Verificar se o arquivo é novo (untracked) ou modificado
		const isNewFile = await isFileUntracked(gitFolder, fileName);
		let content: string;

		if (isNewFile) {
			// Para arquivos novos, ler o conteúdo completo
			content = await Bun.file(file).text();
			logger.debug("📝 Conteúdo completo obtido para arquivo novo", {
				fileName,
				contentLength: content.length
			});
		} else {
			// Para arquivos modificados, usar o diff
			content = await $`git diff ${file}`.text();
			logger.debug("📝 Diff obtido para arquivo modificado", {
				fileName,
				diffLength: content.length
			});
		}

		return createTasks({ file, diff: content });
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
		const fileName = c.value.fullFilePath.replace(`${gitFolder}/`, "");
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
			c.value?.fullFilePath?.replace(`${gitFolder}/`, "") || "unknown";

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

async function isFileUntracked(gitFolder: string, fileName: string): Promise<boolean> {
	try {
		// Verificar se o arquivo está entre os untracked files
		const untrackedFiles = await $`git ls-files --others --exclude-standard`.text();
		const untrackedList = untrackedFiles.split('\n').filter(Boolean);

		// O git ls-files retorna apenas nomes relativos, então precisamos comparar apenas o nome do arquivo
		const baseFileName = fileName.split('/').pop() || fileName;

		logger.debug("🔍 Verificação se arquivo é untracked", {
			fileName,
			baseFileName,
			untrackedFilesRaw: untrackedFiles,
			untrackedList,
			untrackedFilesCount: untrackedList.length,
			fileNameInList: untrackedList.includes(baseFileName)
		});

		// Verificar também se o arquivo existe no filesystem mas não está tracked
		const isInList = untrackedList.includes(baseFileName);

		// Verificação adicional: se não está no diff e não está staged, pode ser untracked
		const stagedFiles = await $`git diff --cached --name-only`.text();
		const stagedList = stagedFiles.split('\n').filter(Boolean);
		const isStaged = stagedList.includes(baseFileName);

		const isUntracked = isInList && !isStaged;

		logger.debug("🔍 Verificação completa de untracked", {
			fileName,
			isInList,
			isStaged,
			finalResult: isUntracked
		});

		return isUntracked;
	} catch (error) {
		logger.error("❌ Erro ao verificar se arquivo é untracked", {
			fileName,
			error: error instanceof Error ? error.message : String(error)
		});
		// Em caso de erro, assumir que não é untracked (usar diff)
		return false;
	}
}
