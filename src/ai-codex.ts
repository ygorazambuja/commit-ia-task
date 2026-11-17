import { Codex } from "@openai/codex-sdk";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
	buildTaskGenerationPrompt,
	type TaskGenerationInput,
} from "./ai-prompt";
import { expectedOutputTask, sanitizeTask } from "./ai-schema";
import { logger } from "./logger";

// Lazy: `new Codex()` exige o binário do Codex CLI, só deve rodar com --aiProvider codex
let codexClient: Codex | undefined;

export function parseCodexTaskResponse(
	finalResponse: string,
): z.infer<typeof expectedOutputTask> {
	let parsedJson: unknown;

	try {
		parsedJson = JSON.parse(finalResponse);
	} catch (error) {
		throw new Error(
			`Resposta do Codex não é JSON válido: ${truncateForLog(finalResponse)}`,
			{ cause: error },
		);
	}

	return expectedOutputTask.parse(parsedJson);
}

export async function getCodexResponse({ file, diff }: TaskGenerationInput) {
	const fileName = file.split("/").pop() || file;
	const model = Bun.env.CODEX_MODEL;

	logger.debug("📤 Enviando requisição para Codex", {
		fileName,
		model: model ?? "(padrão do Codex)",
		diffLength: diff.length,
	});

	try {
		codexClient ??= new Codex();
		const thread = codexClient.startThread({
			sandboxMode: "read-only",
			approvalPolicy: "never",
			...(model ? { model } : {}),
		});

		const turn = await thread.run(buildTaskGenerationPrompt({ file, diff }), {
			outputSchema: zodToJsonSchema(expectedOutputTask, { target: "openAi" }),
		});

		const parsed = parseCodexTaskResponse(turn.finalResponse);

		logger.debug("📥 Resposta recebida do Codex", {
			fileName,
			tasksCount: parsed.tasks.length,
			responseStructure: {
				hasFullFilePath: !!parsed.fullFilePath,
				tasksStructure: parsed.tasks.map((rawTask) => {
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
			fullFilePath: parsed.fullFilePath,
			tasks: parsed.tasks.map(sanitizeTask),
		};
	} catch (error) {
		if (error instanceof Error) {
			logger.error("🚨 Erro na chamada Codex", {
				fileName,
				errorName: error.name,
				errorMessage: error.message,
				stack: error.stack,
			});
		} else {
			logger.error("🚨 Erro desconhecido na chamada Codex", {
				fileName,
				error: String(error),
			});
		}
		throw error;
	}
}

function truncateForLog(value: string, maxLength = 500): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength)}...`;
}
