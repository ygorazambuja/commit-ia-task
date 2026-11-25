import { existsSync } from "node:fs";
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
// Mesma checagem do SDK: o pacote pode existir sem o claude.exe (antivírus, download interrompido).
export function resolveClaudeExecutable({
	env = Bun.env,
	resolve = require.resolve,
	exists = existsSync,
	which = Bun.which,
}: {
	env?: Record<string, string | undefined>;
	resolve?: (id: string) => string;
	exists?: (path: string) => boolean;
	which?: (command: string) => string | null;
} = {}): string | undefined {
	if (env.CLAUDE_CODE_PATH) return env.CLAUDE_CODE_PATH;
	const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
	const ext = process.platform === "win32" ? ".exe" : "";
	for (const candidate of [pkg, `${pkg}-musl`]) {
		try {
			if (exists(resolve(`${candidate}/claude${ext}`))) return undefined;
		} catch {}
	}
	const fromPath = which("claude") ?? undefined;
	logger.warn(
		"⚠️ Binário do Claude Agent SDK ausente, usando o claude do PATH",
		{
			path: fromPath ?? "(não encontrado)",
		},
	);
	return fromPath;
}

// Resolvido só na primeira chamada: openai/codex não dependem do claude.
let claudeExecutable: { path?: string } | undefined;

// Uma chamada sem ferramentas (o conteúdo já vem no prompt) que devolve JSON validado pelo schema.
export async function queryClaude<T>(
	prompt: string,
	schema: z.ZodType<T>,
	options: { systemPrompt?: string; model?: string; effort?: "low" },
): Promise<T> {
	claudeExecutable ??= { path: resolveClaudeExecutable() };
	const executablePath = claudeExecutable.path;
	for await (const message of query({
		prompt,
		options: {
			tools: [],
			persistSession: false,
			outputFormat: { type: "json_schema", schema: zodToJsonSchema(schema) },
			...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
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
