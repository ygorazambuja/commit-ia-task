import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { queryClaude } from "./ai-claude";
import { getCodexClient } from "./ai-codex";
import { type AiProvider, CLASSIFIER_MODELS } from "./ai-provider";
import { SERVICOS } from "./catalogo";
import type { Classification, ClassifyInput } from "./jev";

const resposta = z.object({
	servico: z
		.enum(Object.keys(SERVICOS) as [string, ...string[]])
		.describe("ID do serviço escolhido"),
	confianca: z.number().describe("Confiança na escolha, de 0 a 1"),
});

export function buildClassificationPrompt({
	arquivo,
	isNew,
	title,
	description,
}: ClassifyInput): string {
	const catalogo = Object.entries(SERVICOS)
		.map(
			([id, { o_que, nao_usar_para }]) =>
				`- ${id}: ${o_que}${nao_usar_para ? ` Não usar para: ${nao_usar_para}` : ""}`,
		)
		.join("\n");

	return `Escolha o serviço do catálogo que descreve o trabalho realizado na tarefa abaixo.
Responda com exatamente um ID do catálogo e a sua confiança na escolha, de 0 a 1.

Catálogo de serviços:
${catalogo}

Tarefa:
Arquivo: ${arquivo} (${isNew ? "arquivo novo" : "arquivo existente modificado"})
Título: ${title}
Descrição: ${description}`;
}

// Substitui o Jev quando ele não está disponível. A confiança é declarada pelo próprio modelo, não é uma probabilidade medida.
export async function classifyServicoIa(
	input: ClassifyInput,
	provider: AiProvider,
): Promise<Classification> {
	if (provider === "openai") {
		throw new Error(
			"Sem o Jev, a classificação do serviço exige o provedor claude ou codex",
		);
	}

	const prompt = buildClassificationPrompt(input);
	const { servico, confianca } =
		provider === "claude"
			? await queryClaude(prompt, resposta, {
					model: CLASSIFIER_MODELS.claude,
					effort: "low",
				})
			: await classifyWithCodex(prompt);

	return { idSpf: servico, probability: Math.min(1, Math.max(0, confianca)) };
}

async function classifyWithCodex(prompt: string) {
	const thread = getCodexClient().startThread({
		model: CLASSIFIER_MODELS.codex,
		modelReasoningEffort: "low",
		sandboxMode: "read-only",
		approvalPolicy: "never",
	});
	const turn = await thread.run(prompt, {
		outputSchema: zodToJsonSchema(resposta, { target: "openAi" }),
	});

	return resposta.parse(JSON.parse(turn.finalResponse));
}
