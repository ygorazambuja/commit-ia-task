import { describe, expect, test } from "bun:test";
import {
	normalizeComplexidade,
	normalizeEstimate,
	sanitizeTask,
} from "../src/ai";
import { parseCodexTaskResponse } from "../src/ai-codex";
import { buildTaskGenerationPrompt } from "../src/ai-prompt";
import {
	getAiProvider,
	resolveAiProvider,
	setAiProvider,
	setJevAllowed,
	usesJev,
} from "../src/ai-provider";
import {
	buildClassificationPrompt,
	classifyServicoIa,
} from "../src/classificador-ia";

describe("AI task normalization", () => {
	test("normalizes complexity values to the allowed set", () => {
		expect(normalizeComplexidade(" alta ")).toBe("ALTA");
		expect(normalizeComplexidade("media")).toBe("MEDIA");
		expect(normalizeComplexidade("baixa")).toBe("BAIXA");
		expect(normalizeComplexidade("única")).toBe("ÚNICA");
		expect(normalizeComplexidade("invalid")).toBe("ÚNICA");
		expect(normalizeComplexidade(null)).toBe("ÚNICA");
	});

	test("normalizes estimates to integers between 1 and 8", () => {
		expect(normalizeEstimate(1)).toBe(1);
		expect(normalizeEstimate(8)).toBe(8);
		expect(normalizeEstimate("5")).toBe(5);
		expect(normalizeEstimate(0)).toBe(1);
		expect(normalizeEstimate(9)).toBe(1);
		expect(normalizeEstimate(1.5)).toBe(1);
		expect(normalizeEstimate("invalid")).toBe(1);
	});

	test("sanitizes a generated task without changing valid fields", () => {
		expect(
			sanitizeTask({
				title: "Criar exportação",
				description: "Gera CSV de tarefas",
				complexidade: " media ",
				estimateMade: 3,
			}),
		).toEqual({
			title: "Criar exportação",
			description: "Gera CSV de tarefas",
			complexidade: "MEDIA",
			estimateMade: 3,
		});
	});
});

describe("AI provider resolution", () => {
	test("defaults to openai when no value is provided", () => {
		expect(resolveAiProvider(undefined)).toBe("openai");
	});

	test("accepts openai and codex providers", () => {
		expect(resolveAiProvider("openai")).toBe("openai");
		expect(resolveAiProvider("codex")).toBe("codex");
		expect(resolveAiProvider(" CODEX ")).toBe("codex");
		expect(resolveAiProvider("Claude")).toBe("claude");
	});

	test("rejects invalid providers", () => {
		expect(() => resolveAiProvider("anthropic")).toThrow(
			'Provedor de IA inválido: "anthropic". Use "openai", "codex" ou "claude".',
		);
	});

	test("stores configured provider", () => {
		setAiProvider("codex");
		expect(getAiProvider()).toBe("codex");
		setAiProvider("openai");
	});

	test("uses Jev only with a key and without --noJev", () => {
		const key = Bun.env.JEV_API_KEY;
		try {
			Bun.env.JEV_API_KEY = "chave";
			expect(usesJev()).toBe(true);
			setJevAllowed(false);
			expect(usesJev()).toBe(false);
			setJevAllowed(true);
			delete Bun.env.JEV_API_KEY;
			expect(usesJev()).toBe(false);
		} finally {
			setJevAllowed(true);
			if (key) Bun.env.JEV_API_KEY = key;
		}
	});
});

describe("Service classification without Jev", () => {
	const input = {
		arquivo: "src/Services/EmpenhoService.php",
		isNew: true,
		title: "Correção do cálculo de saldo",
		description: "Corrige a soma em dobro.",
	};

	test("prompt carries the catalog and the task evidence", () => {
		const prompt = buildClassificationPrompt(input);

		expect(prompt).toContain("- 21E: ");
		expect(prompt).toContain("- 17: ");
		expect(prompt).toContain(
			"Arquivo: src/Services/EmpenhoService.php (arquivo novo)",
		);
		expect(prompt).toContain("Título: Correção do cálculo de saldo");
	});

	test("openai has no classifier without Jev", () => {
		expect(classifyServicoIa(input, "openai")).rejects.toThrow(
			"exige o provedor claude ou codex",
		);
	});
});

describe("Codex response parsing", () => {
	test("parses valid JSON responses", () => {
		const parsed = parseCodexTaskResponse(
			JSON.stringify({
				fullFilePath: "/tmp/src/index.ts",
				tasks: [
					{
						title: "Atualizar CLI",
						description: "Adiciona flag de provider",
						complexidade: "MEDIA",
						estimateMade: 3,
					},
				],
			}),
		);

		expect(parsed.fullFilePath).toBe("/tmp/src/index.ts");
		expect(parsed.tasks).toHaveLength(1);
		expect(parsed.tasks[0]?.title).toBe("Atualizar CLI");
	});

	test("rejects invalid JSON responses", () => {
		expect(() => parseCodexTaskResponse("not-json")).toThrow(
			"Resposta do Codex não é JSON válido",
		);
	});

	test("rejects JSON that does not match the schema", () => {
		expect(() =>
			parseCodexTaskResponse(JSON.stringify({ tasks: [] })),
		).toThrow();
	});
});

describe("Task generation prompt", () => {
	test("includes file path and diff content", () => {
		const prompt = buildTaskGenerationPrompt({
			file: "/tmp/src/index.ts",
			diff: "+ console.log('test');",
		});

		expect(prompt).toContain("/tmp/src/index.ts");
		expect(prompt).toContain("+ console.log('test');");
		expect(prompt).toContain("Gere poucas tarefas");
		expect(prompt).toContain("ALTA, MEDIA, BAIXA.");
	});
});
