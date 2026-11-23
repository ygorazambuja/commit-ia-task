import { z } from "zod";

export const allowedComplexities = ["ALTA", "MEDIA", "BAIXA", "ÚNICA"] as const;
export type Complexity = (typeof allowedComplexities)[number];

export const expectedOutputTask = z.object({
	tasks: z.array(
		z.object({
			title: z.string().describe("O titulo da tarefa"),
			description: z.string().describe("A descrição da tarefa"),
			complexidade: z
				.string()
				.describe("A complexidade da tarefa: ALTA, MEDIA ou BAIXA"),
			estimateMade: z
				.number()
				.describe("Estimativa da tarefa como número inteiro entre 1 e 8"),
		}),
	),
	fullFilePath: z.string().describe("O caminho completo do arquivo"),
});

export function sanitizeTask(
	task: z.infer<typeof expectedOutputTask>["tasks"][number],
) {
	return {
		...task,
		complexidade: normalizeComplexidade(task.complexidade),
		estimateMade: normalizeEstimate(task.estimateMade),
	};
}

export function normalizeEstimate(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);

	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
		return 1;
	}

	return parsed;
}

export function normalizeComplexidade(value: unknown): Complexity {
	if (typeof value !== "string") {
		return "ÚNICA";
	}

	const normalized = value.toUpperCase().trim();
	if (allowedComplexities.includes(normalized as Complexity)) {
		return normalized as Complexity;
	}

	return "ÚNICA";
}
