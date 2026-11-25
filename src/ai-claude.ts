import { query } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
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

	const parsed = await queryClaude(
		buildTaskGenerationPrompt({ file, diff }),
		expectedOutputTask,
		{
			systemPrompt: buildTaskGenerationSystemPrompt(),
			...(model ? { model } : {}),
		},
	);
	logger.debug("📥 Resposta recebida do Claude", {
		fileName,
		tasksCount: parsed.tasks.length,
	});

	return {
		fullFilePath: parsed.fullFilePath,
		tasks: parsed.tasks.map(sanitizeTask),
	};
}

// O SDK usa o binário do pacote opcional da plataforma; se a instalação o pulou, cai no `claude` do PATH.
function resolveClaudeExecutable(): string | undefined {
	if (Bun.env.CLAUDE_CODE_PATH) return Bun.env.CLAUDE_CODE_PATH;
	try {
		require.resolve(
			`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
		);
		return undefined;
	} catch {
		return Bun.which("claude") ?? undefined;
	}
}

const claudeExecutable = resolveClaudeExecutable();

// Uma chamada sem ferramentas (o conteúdo já vem no prompt) que devolve JSON validado pelo schema.
export async function queryClaude<T>(
	prompt: string,
	schema: z.ZodType<T>,
	options: { systemPrompt?: string; model?: string; effort?: "low" },
): Promise<T> {
	for await (const message of query({
		prompt,
		options: {
			tools: [],
			persistSession: false,
			outputFormat: { type: "json_schema", schema: zodToJsonSchema(schema) },
			...(claudeExecutable
				? { pathToClaudeCodeExecutable: claudeExecutable }
				: {}),
			...options,
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

		return schema.parse(message.structured_output);
	}

	throw new Error("Claude encerrou sem mensagem de resultado");
}
