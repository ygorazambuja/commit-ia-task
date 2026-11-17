import { $ } from "bun";
import { logger } from "./logger";

export const AI_PROVIDERS = ["openai", "codex", "claude"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

let configuredProvider: AiProvider = "openai";

export function setAiProvider(provider: AiProvider): void {
	configuredProvider = provider;
}

export function getAiProvider(): AiProvider {
	return configuredProvider;
}

export function resolveAiProvider(value: string | undefined): AiProvider {
	if (!value) {
		return "openai";
	}

	const normalized = value.trim().toLowerCase();
	if ((AI_PROVIDERS as readonly string[]).includes(normalized)) {
		return normalized as AiProvider;
	}

	throw new Error(
		`Provedor de IA inválido: "${value}". Use "openai", "codex" ou "claude".`,
	);
}

export async function validateAiProviderSetup(
	provider: AiProvider,
): Promise<void> {
	if (provider === "openai") {
		if (!Bun.env.OPENAI_API_KEY) {
			logger.error("❌ Variável de ambiente OPENAI_API_KEY não configurada");
			console.error(
				"Configure OPENAI_API_KEY ou use --aiProvider codex com `codex login`.",
			);
			process.exit(1);
		}
		return;
	}

	if (provider === "claude") {
		// O SDK traz o próprio executável do Claude Code; a autenticação falha na primeira chamada se não houver login.
		logger.info("🤖 Provedor de IA configurado", { provider: "claude" });
		return;
	}

	const versionResult = await $`codex --version`.nothrow().quiet();
	if (versionResult.exitCode !== 0) {
		logger.error("❌ Codex CLI não encontrado no PATH", {
			stderr: versionResult.stderr.toString(),
		});
		console.error(
			"Instale o Codex CLI (npm i -g @openai/codex) e execute `codex login`.",
		);
		process.exit(1);
	}

	logger.info("🤖 Provedor de IA configurado", {
		provider: "codex",
		codexVersion: versionResult.stdout.toString().trim(),
	});
}
