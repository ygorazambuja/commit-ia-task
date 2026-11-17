import { query } from "@anthropic-ai/claude-agent-sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
	buildTaskGenerationPrompt,
	buildTaskGenerationSystemPrompt,
	type TaskGenerationInput,
} from "./ai-prompt";
import { expectedOutputTask, sanitizeTask } from "./ai-schema";
import { logger } from "./logger";

// Autentica pela sessão do Claude Code (`claude login`) ou ANTHROPIC_API_KEY.
export async function getClaudeResponse({ file, diff }: TaskGenerationInput) {
	const fileName = file.split("/").pop() || file;
	const model = Bun.env.CLAUDE_MODEL;

	logger.debug("📤 Enviando requisição para Claude", {
		fileName,
		model: model ?? "(padrão do Claude Code)",
		diffLength: diff.length,
	});

	for await (const message of query({
		prompt: buildTaskGenerationPrompt({ file, diff }),
		options: {
			systemPrompt: buildTaskGenerationSystemPrompt(),
			tools: [], // sem ferramentas: o diff já vem no prompt
			persistSession: false,
			outputFormat: {
				type: "json_schema",
				schema: zodToJsonSchema(expectedOutputTask),
			},
			...(model ? { model } : {}),
		},
	})) {
		if (message.type !== "result") continue;

		if (
			message.subtype !== "success" ||
			message.is_error ||
			!message.structured_output
		) {
			throw new Error(
				`Claude não retornou saída estruturada (subtype: ${message.subtype})`,
			);
		}

		const parsed = expectedOutputTask.parse(message.structured_output);
		logger.debug("📥 Resposta recebida do Claude", {
			fileName,
			tasksCount: parsed.tasks.length,
		});

		return {
			fullFilePath: parsed.fullFilePath,
			tasks: parsed.tasks.map(sanitizeTask),
		};
	}

	throw new Error("Claude encerrou sem mensagem de resultado");
}
