import { basename, join, relative, resolve } from "node:path";
import type { z } from "zod";
import { createTasks, type expectedOutputTask } from "./ai";
import type { AiProvider } from "./ai-provider";
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

export async function getDiff(
	gitFolder: string,
	options: { aiProvider?: AiProvider; taskCreator?: typeof createTasks } = {},
) {
	const { aiProvider, taskCreator = createTasks } = options;
	const normalizedGitFolder = resolve(gitFolder);
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
		const contentResult = await getFileContentForAI(
			fileMeta,
			normalizedGitFolder,
		);

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

			const result = await taskCreator(
				{
					file: fileMeta.absPath,
					diff: fallbackContent,
				},
				{ provider: aiProvider },
			);
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

		const result = await taskCreator(
			{
				file: fileMeta.absPath,
				diff: contentResult.content,
			},
			{ provider: aiProvider },
		);
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

		try {
			await runGit(["add", "--", c.value.fullFilePath], normalizedGitFolder);
			logger.debug("✅ Arquivo adicionado ao Git", { fileName });
		} catch (error) {
			logger.error("❌ Erro ao adicionar arquivo ao Git", {
				fileName,
				error: error instanceof Error ? error.message : String(error),
			});
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

	if (files.length > 0 && corrects.length === 0) {
		throw new Error("Nenhum arquivo alterado pôde ser processado");
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
		getChangedFileNames("unstaged", gitFolder),
		getChangedFileNames("staged", gitFolder),
		getStatusMap(gitFolder),
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
	gitFolder: string,
): Promise<{ content: string; source: ContentSource }> {
	if (fileMeta.isNew) {
		const fullContent = await Bun.file(fileMeta.absPath).text();
		return { content: fullContent, source: "full_file" };
	}

	if (fileMeta.hasStaged && fileMeta.hasUnstaged) {
		const [stagedDiff, unstagedDiff] = await Promise.all([
			runGit(["diff", "--cached", "--", fileMeta.relPath], gitFolder),
			runGit(["diff", "--", fileMeta.relPath], gitFolder),
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
		const stagedDiff = await runGit(
			["diff", "--cached", "--", fileMeta.relPath],
			gitFolder,
		);
		return { content: stagedDiff, source: "staged_diff" };
	}

	if (fileMeta.hasUnstaged) {
		const unstagedDiff = await runGit(
			["diff", "--", fileMeta.relPath],
			gitFolder,
		);
		return { content: unstagedDiff, source: "unstaged_diff" };
	}

	return { content: "", source: "fallback" };
}

async function getChangedFileNames(
	kind: "unstaged" | "staged",
	gitFolder: string,
): Promise<string[]> {
	const args =
		kind === "staged"
			? ["diff", "--cached", "--name-only", "-z"]
			: ["diff", "--name-only", "-z"];
	const output = await runGit(args, gitFolder);

	return output
		.split("\0")
		.filter(Boolean)
		.filter((file) => !isIgnoredFile(file));
}

async function getStatusMap(
	gitFolder: string,
): Promise<
	Map<string, Pick<FileChangeMeta, "isNew" | "hasStaged" | "hasUnstaged">>
> {
	const output = await runGit(
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		gitFolder,
	);
	const map = new Map<
		string,
		Pick<FileChangeMeta, "isNew" | "hasStaged" | "hasUnstaged">
	>();

	const entries = output.split("\0");
	for (let index = 0; index < entries.length; index += 1) {
		const rawLine = entries[index];
		if (!rawLine) {
			continue;
		}

		const x = rawLine[0] ?? " ";
		const y = rawLine[1] ?? " ";
		const relPath = rawLine.slice(3);
		if (x === "R" || x === "C" || y === "R" || y === "C") {
			index += 1;
		}

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

async function runGit(args: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git exited ${exitCode}`);
	}

	return stdout;
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
	return IGNORED_PATTERNS.has(basename(file));
}

function toRelativeFileName(fullFilePath: string, gitFolder: string): string {
	const normalizedFullPath = resolve(fullFilePath);
	const rel = relative(gitFolder, normalizedFullPath);

	return rel.length > 0 && !rel.startsWith("..") ? rel : fullFilePath;
}
