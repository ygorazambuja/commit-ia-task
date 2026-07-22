import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { getCodexResponse } from "./ai-codex";
import {
	buildTaskGenerationPrompt,
	buildTaskGenerationSystemPrompt,
	type TaskGenerationInput,
} from "./ai-prompt";
import { type AiProvider, getAiProvider } from "./ai-provider";
import { expectedOutputTask, sanitizeTask } from "./ai-schema";
import { formatDuration, logger } from "./logger";

export {
	allowedComplexities,
	type Complexity,
	expectedOutputTask,
	normalizeComplexidade,
	normalizeEstimate,
	sanitizeTask,
	type TaskType,
	taskTypes,
} from "./ai-schema";

const openaiApiClient = createOpenAI({
	apiKey: Bun.env.OPENAI_API_KEY,
});

export type CreateTasksOptions = {
	provider?: AiProvider;
};

export const createTasks = async (
	{ file, diff }: TaskGenerationInput,
	options: CreateTasksOptions = {},
) => {
	const provider = options.provider ?? getAiProvider();
	const fileName = file.split("/").pop() || file;
	logger.info("🤖 Processando arquivo com IA", { fileName, provider });

	const startTime = Date.now();

	try {
		const result =
			provider === "codex"
				? await getCodexResponse({ file, diff })
				: await getOpenaiResponse({ file, diff });
		const duration = Date.now() - startTime;

		logger.info("✅ IA processou arquivo com sucesso", {
			fileName,
			provider,
			tasksGenerated: result.tasks.length,
			duration: formatDuration(duration),
			tasks: result.tasks.map((t) => ({
				title: t.title,
				descriptionLength: t.description.length,
				tipo: t.tipo,
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
						tipo: task.tipo,
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
