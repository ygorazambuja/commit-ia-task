import { join, relative, resolve } from "node:path";
import { $ } from "bun";
import type { z } from "zod";
import { createTasks, type expectedOutputTask } from "./ai";
import { logger } from "./logger";

type ContentSource =
	| "full_file"
	| "unstaged_diff"
	| "staged_diff"
	| "combined_diff"
	| "fallback";

type FileKind = "new" | "modified" | "staged" | "mixed";

type FileChangeMeta = {
	relPath: string;
	absPath: string;
	isNew: boolean;
	hasStaged: boolean;
	hasUnstaged: boolean;
	kind: FileKind;
};

const IGNORED_PATTERNS = new Set([
	"pnpm-lock.yaml",
	"bun.lockb",
	"package-lock.json",
]);

export async function getDiff(gitFolder: string) {
	const normalizedGitFolder = resolve(gitFolder.trim());
	logger.info("🔍 Iniciando análise de arquivos alterados", {
		gitFolder: normalizedGitFolder,
	});

	const files = await getAlteredFileMetas(normalizedGitFolder);
	logger.info("📁 Arquivos encontrados", {
		count: files.length,
		files: files.map((f) => f.relPath),
	});

	const jsons: z.infer<typeof expectedOutputTask>[] = [];

	const promises = files.map(async (fileMeta) => {
		const fileName = fileMeta.relPath;
		logger.info("🤖 Iniciando criação de tasks para arquivo", { fileName });
		const contentResult = await getFileContentForAI(fileMeta);

		if (!contentResult.content.trim()) {
			logger.warn("⚠️ Conteúdo vazio detectado; tentando fallback", {
				fileName,
				kind: fileMeta.kind,
				status: {
					isNew: fileMeta.isNew,
					hasStaged: fileMeta.hasStaged,
					hasUnstaged: fileMeta.hasUnstaged,
				},
				source: contentResult.source,
			});

			const fallbackContent = await Bun.file(fileMeta.absPath).text();
			if (!fallbackContent.trim()) {
				throw new Error(
					`Conteúdo vazio para ${fileName} (source=${contentResult.source}); arquivo ignorado`,
				);
			}

			logger.info("🛟 Fallback aplicado com sucesso", {
				fileName,
				kind: fileMeta.kind,
				source: "fallback",
				payloadSize: fallbackContent.length,
			});

			const result = await createTasks({
				file: fileMeta.absPath,
				diff: fallbackContent,
			});
			return { ...result, fullFilePath: fileMeta.absPath };
		}

		logger.info("🧾 Conteúdo coletado para IA", {
			fileName,
			kind: fileMeta.kind,
			source: contentResult.source,
			payloadSize: contentResult.content.length,
			status: {
				isNew: fileMeta.isNew,
				hasStaged: fileMeta.hasStaged,
				hasUnstaged: fileMeta.hasUnstaged,
			},
		});

		const result = await createTasks({
			file: fileMeta.absPath,
			diff: contentResult.content,
		});
		return { ...result, fullFilePath: fileMeta.absPath };
	});

	const results = await Promise.allSettled(promises);

	const corrects = results.filter((r) => r.status === "fulfilled");
	const errors = results.filter((r) => r.status === "rejected");

	logger.info("📊 Resultados do processamento", {
		sucessos: corrects.length,
		erros: errors.length,
		total: results.length,
	});

	for (const c of corrects) {
		const fileName = toRelativeFileName(
			c.value.fullFilePath,
			normalizedGitFolder,
		);
		logger.info("✅ Tasks geradas com sucesso", {
			fileName,
			tasksCount: c.value.tasks.length,
			tasks: c.value.tasks.map((t) => t.title),
		});

		jsons.push({
			fullFilePath: c.value?.fullFilePath ?? "",
			tasks: c.value?.tasks ?? [],
		});
	}

	logger.info("📝 Adicionando arquivos ao Git...");
	for (const c of corrects) {
		const fileName = c.value?.fullFilePath
			? toRelativeFileName(c.value.fullFilePath, normalizedGitFolder)
			: "unknown";

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

async function getAlteredFileMetas(
	gitFolder: string,
): Promise<FileChangeMeta[]> {
	logger.debug("🔍 Buscando arquivos alterados (unstaged/staged) e novos...");

	const [unstagedNames, stagedNames, statusMap] = await Promise.all([
		getChangedFileNames("unstaged"),
		getChangedFileNames("staged"),
		getStatusMap(),
	]);

	const namesSet = new Set<string>([...unstagedNames, ...stagedNames]);

	for (const [relPath, meta] of statusMap.entries()) {
		if (meta.isNew) {
			namesSet.add(relPath);
		}
	}

	const filteredNames = [...namesSet].filter(
		(relPath) => !isIgnoredFile(relPath),
	);
	const metas = filteredNames.map((relPath) => {
		const statusMeta = statusMap.get(relPath);
		const hasStaged = statusMeta?.hasStaged ?? stagedNames.includes(relPath);
		const hasUnstaged =
			statusMeta?.hasUnstaged ?? unstagedNames.includes(relPath);
		const isNew = statusMeta?.isNew ?? false;

		return {
			relPath,
			absPath: join(gitFolder, relPath),
			isNew,
			hasStaged,
			hasUnstaged,
			kind: resolveFileKind({ isNew, hasStaged, hasUnstaged }),
		};
	});

	logger.debug("📊 Arquivos encontrados por origem", {
		unstagedCount: unstagedNames.length,
		stagedCount: stagedNames.length,
		statusEntries: statusMap.size,
		totalFiltered: metas.length,
		ignoredPatterns: [...IGNORED_PATTERNS],
	});

	return metas;
}

async function getFileContentForAI(
	fileMeta: FileChangeMeta,
): Promise<{ content: string; source: ContentSource }> {
	if (fileMeta.isNew) {
		const fullContent = await Bun.file(fileMeta.absPath).text();
		return { content: fullContent, source: "full_file" };
	}

	if (fileMeta.hasStaged && fileMeta.hasUnstaged) {
		const [stagedDiff, unstagedDiff] = await Promise.all([
			$`git diff --cached -- ${fileMeta.relPath}`.text(),
			$`git diff -- ${fileMeta.relPath}`.text(),
		]);

		const combined = [
			"=== STAGED CHANGES ===",
			stagedDiff.trim(),
			"",
			"=== UNSTAGED CHANGES ===",
			unstagedDiff.trim(),
		]
			.join("\n")
			.trim();

		return { content: combined, source: "combined_diff" };
	}

	if (fileMeta.hasStaged) {
		const stagedDiff = await $`git diff --cached -- ${fileMeta.relPath}`.text();
		return { content: stagedDiff, source: "staged_diff" };
	}

	if (fileMeta.hasUnstaged) {
		const unstagedDiff = await $`git diff -- ${fileMeta.relPath}`.text();
		return { content: unstagedDiff, source: "unstaged_diff" };
	}

	return { content: "", source: "fallback" };
}

async function getChangedFileNames(
	kind: "unstaged" | "staged",
): Promise<string[]> {
	const command =
		kind === "staged"
			? ["git", "diff", "--cached", "--name-only"]
			: ["git", "diff", "--name-only"];
	const proc = Bun.spawn(command);
	const output = await new Response(proc.stdout).text();

	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((file) => !isIgnoredFile(file));
}

async function getStatusMap(): Promise<
	Map<string, Pick<FileChangeMeta, "isNew" | "hasStaged" | "hasUnstaged">>
> {
	const proc = Bun.spawn([
		"git",
		"status",
		"--porcelain",
		"--untracked-files=all",
	]);
	const output = await new Response(proc.stdout).text();
	const map = new Map<
		string,
		Pick<FileChangeMeta, "isNew" | "hasStaged" | "hasUnstaged">
	>();

	for (const rawLine of output.split("\n")) {
		if (!rawLine.trim()) {
			continue;
		}

		const x = rawLine[0] ?? " ";
		const y = rawLine[1] ?? " ";
		const rawPath = rawLine.slice(3).trim();
		const relPath = normalizeStatusPath(rawPath);

		if (!relPath || isIgnoredFile(relPath)) {
			continue;
		}

		const hasStaged = x !== " " && x !== "?";
		const hasUnstaged = y !== " " || rawLine.startsWith("??");
		const isNew = x === "A" || rawLine.startsWith("??");

		map.set(relPath, { isNew, hasStaged, hasUnstaged });
	}

	return map;
}

function normalizeStatusPath(pathValue: string): string {
	if (pathValue.includes(" -> ")) {
		return pathValue.split(" -> ").pop()?.trim() ?? "";
	}
	return pathValue.trim();
}

function resolveFileKind({
	isNew,
	hasStaged,
	hasUnstaged,
}: Pick<FileChangeMeta, "isNew" | "hasStaged" | "hasUnstaged">): FileKind {
	if (isNew) {
		return "new";
	}
	if (hasStaged && hasUnstaged) {
		return "mixed";
	}
	if (hasStaged) {
		return "staged";
	}
	return "modified";
}

function isIgnoredFile(file: string): boolean {
	return IGNORED_PATTERNS.has(file.trim());
}

function toRelativeFileName(fullFilePath: string, gitFolder: string): string {
	const normalizedFullPath = resolve(fullFilePath.trim());
	const rel = relative(gitFolder, normalizedFullPath).trim();

	return rel.length > 0 && !rel.startsWith("..") ? rel : fullFilePath;
}
