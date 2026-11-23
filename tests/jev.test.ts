import { describe, expect, test } from "bun:test";
import { classifyServico } from "../src/jev";

const input = {
	arquivo: "src/Services/EmpenhoService.php",
	isNew: false,
	title: "Correção do cálculo de saldo do empenho",
	description: "Corrige a soma em dobro do valor estornado.",
};

const fakeFetch = (status: number, body: unknown) => {
	const calls: { url: string; init: RequestInit }[] = [];
	const impl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	return { impl, calls };
};

describe("classifyServico", () => {
	test("returns the chosen service with its probability", async () => {
		const { impl, calls } = fakeFetch(200, {
			answers: {
				servico: {
					choice: "21E",
					probabilities: { "17": 0.08, "21E": 0.92 },
				},
			},
		});

		expect(await classifyServico(input, impl)).toEqual({
			idSpf: "21E",
			probability: 0.92,
		});

		const request = JSON.parse(String(calls[0]?.init.body));
		expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(request.model).toBe("jev-1.14.0");
		expect(request.state).toEqual({
			arquivo: input.arquivo,
			mudanca: "arquivo existente modificado",
			titulo: input.title,
			descricao: input.description,
		});
		expect(request.questions.servico.type).toBe("choice");
		expect(Object.keys(request.questions.servico.criteria)).toContain("21E");
	});

	test("fails instead of guessing when the answer is not a catalog service", async () => {
		const { impl } = fakeFetch(200, {
			answers: { servico: { choice: "99", probabilities: { "99": 1 } } },
		});

		expect(classifyServico(input, impl)).rejects.toThrow(
			"Resposta do Jev sem serviço válido",
		);
	});

	test("surfaces API errors", async () => {
		const { impl } = fakeFetch(401, { detail: "invalid key" });

		expect(classifyServico(input, impl)).rejects.toThrow("Jev respondeu 401");
	});
});
