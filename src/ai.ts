import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { getClaudeResponse } from "./ai-claude";
import { getCodexResponse } from "./ai-codex";
import {
	buildTaskGenerationPrompt,
	buildTaskGenerationSystemPrompt,
	type TaskGenerationInput,
} from "./ai-prompt";
import { type AiProvider, getAiProvider, usesJev } from "./ai-provider";
import { type Complexity, expectedOutputTask, sanitizeTask } from "./ai-schema";
import { resolveUst } from "./catalogo";
import { classifyServicoIa } from "./classificador-ia";
import { classifyServico, MIN_PROBABILITY } from "./jev";
import { formatDuration, logger } from "./logger";

export {
	allowedComplexities,
	type Complexity,
	expectedOutputTask,
	normalizeComplexidade,
	normalizeEstimate,
	sanitizeTask,
} from "./ai-schema";

const openaiApiClient = createOpenAI({
	apiKey: Bun.env.OPENAI_API_KEY,
});

export type CreateTasksOptions = {
	provider?: AiProvider;
};

export type ClassifiedTask = {
	title: string;
	description: string;
	idSpf: string;
	complexidade: Complexity;
	estimateMade: number;
};

export type TaskFile = { fullFilePath: string; tasks: ClassifiedTask[] };

export const createTasks = async (
	{ file, diff, relPath, isNew = false }: TaskGenerationInput,
	options: CreateTasksOptions = {},
): Promise<TaskFile> => {
	const provider = options.provider ?? getAiProvider();
	const fileName = file.split("/").pop() || file;
	logger.info("🤖 Processando arquivo com IA", { fileName, provider });

	const startTime = Date.now();

	try {
		const generated =
			provider === "codex"
				? await getCodexResponse({ file, diff })
				: provider === "claude"
					? await getClaudeResponse({ file, diff })
					: await getOpenaiResponse({ file, diff });

		// A IA descreve a mudança; o Jev (ou o modelo rápido do provedor) decide o serviço do catálogo, e a UST sai de (serviço, complexidade).
		const tasks = await Promise.all(
			generated.tasks.map(async (task): Promise<ClassifiedTask> => {
				const input = {
					arquivo: relPath ?? fileName,
					isNew,
					title: task.title,
					description: task.description,
				};
				const { idSpf, probability } = usesJev()
					? await classifyServico(input)
					: await classifyServicoIa(input, provider);

				if (probability < MIN_PROBABILITY) {
					logger.warn("⚠️ Serviço classificado com baixa confiança; revise", {
						fileName,
						title: task.title,
						idSpf,
						probability,
					});
				}

				return {
					title: task.title,
					description: task.description,
					idSpf,
					complexidade: resolveUst(idSpf, task.complexidade).complexidade,
					estimateMade: task.estimateMade,
				};
			}),
		);
		const result = { fullFilePath: generated.fullFilePath, tasks };
		const duration = Date.now() - startTime;

		logger.info("✅ IA processou arquivo com sucesso", {
			fileName,
			provider,
			tasksGenerated: result.tasks.length,
			duration: formatDuration(duration),
			tasks: result.tasks.map((t) => ({
				title: t.title,
				descriptionLength: t.description.length,
				idSpf: t.idSpf,
				complexidade: t.complexidade,
				estimateMade: t.estimateMade,
			})),
		});

		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error("❌ Erro ao processar arquivo com IA", {
			fileName,
			provider,
			duration: formatDuration(duration),
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
};

const getOpenaiResponse = async ({ file, diff }: TaskGenerationInput) => {
	const fileName = file.split("/").pop() || file;

	logger.debug("📤 Enviando requisição para OpenAI", {
		fileName,
		model: "gpt-5-nano",
		diffLength: diff.length,
	});

	try {
		const response = await generateObject({
			model: openaiApiClient("gpt-5-nano"),
			schema: expectedOutputTask,
			messages: [
				{
					role: "system",
					content: buildTaskGenerationSystemPrompt(),
				},
				{
					role: "user",
					content: buildTaskGenerationPrompt({ file, diff }),
				},
			],
		});

		logger.debug("📥 Resposta recebida da OpenAI", {
			fileName,
			tasksCount: response.object.tasks.length,
			responseStructure: {
				hasFullFilePath: !!response.object.fullFilePath,
				tasksStructure: response.object.tasks.map((rawTask) => {
					const task = sanitizeTask(rawTask);
					return {
						hasTitleAndDescription: !!(task.title && task.description),
						titleLength: task.title.length,
						descriptionLength: task.description.length,
						complexidade: task.complexidade,
						estimateMade: task.estimateMade,
					};
				}),
			},
		});

		return {
			fullFilePath: response.object.fullFilePath,
			tasks: response.object.tasks.map(sanitizeTask),
		};
	} catch (error) {
		if (error instanceof Error) {
			logger.error("🚨 Erro na chamada OpenAI", {
				fileName,
				errorName: error.name,
				errorMessage: error.message,
				stack: error.stack,
			});
		} else {
			logger.error("🚨 Erro desconhecido na chamada OpenAI", {
				fileName,
				error: String(error),
			});
		}
		throw error;
	}
};
