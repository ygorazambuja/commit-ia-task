import { SERVICOS } from "./catalogo";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
// Versão fixa: os aliases (jev-latest) trocam de modelo sem aviso, e a classificação define a UST.
const JEV_MODEL = "jev-1.14.0";
// Medido no histórico de tasks: a partir de 0,7 a escolha se mantém em 98% dos casos ao inverter a ordem das opções.
export const MIN_PROBABILITY = 0.7;
const MAX_RETRIES = 3;

const criteria = Object.fromEntries(
	Object.entries(SERVICOS).map(([id, { o_que, nao_usar_para }]) => [
		id,
		{ o_que, nao_usar_para },
	]),
);

export type ClassifyInput = {
	arquivo: string;
	isNew: boolean;
	title: string;
	description: string;
};

export type Classification = { idSpf: string; probability: number };

// O Jev não gera texto: recebe a tarefa escrita pela IA e escolhe o serviço do catálogo, com a probabilidade da escolha.
export async function classifyServico(
	{ arquivo, isNew, title, description }: ClassifyInput,
	fetchImpl: typeof fetch = fetch,
): Promise<Classification> {
	const body = JSON.stringify({
		model: JEV_MODEL,
		state: {
			arquivo,
			mudanca: isNew ? "arquivo novo" : "arquivo existente modificado",
			titulo: title,
			descricao: description,
		},
		questions: {
			servico: {
				type: "choice",
				instructions:
					"Qual serviço do catálogo de serviços descreve o trabalho realizado nesta tarefa",
				criteria,
			},
		},
	});

	for (let attempt = 0; ; attempt += 1) {
		const response = await fetchImpl(JEV_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${Bun.env.JEV_API_KEY}`,
				"Content-Type": "application/json",
			},
			body,
		});

		// Os arquivos são processados em paralelo; 429 é limite de taxa e some com espera.
		if (
			(response.status === 429 || response.status >= 500) &&
			attempt < MAX_RETRIES
		) {
			await Bun.sleep(500 * 2 ** attempt);
			continue;
		}

		if (!response.ok) {
			throw new Error(
				`Jev respondeu ${response.status}: ${(await response.text()).slice(0, 300)}`,
			);
		}

		const answer = (
			(await response.json()) as {
				answers?: {
					servico?: { choice?: string; probabilities?: Record<string, number> };
				};
			}
		).answers?.servico;
		const idSpf = answer?.choice;
		const probability = idSpf ? answer?.probabilities?.[idSpf] : undefined;

		if (!idSpf || !(idSpf in SERVICOS) || typeof probability !== "number") {
			throw new Error(
				`Resposta do Jev sem serviço válido: ${JSON.stringify(answer)}`,
			);
		}

		return { idSpf, probability };
	}
}
