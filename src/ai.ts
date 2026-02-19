import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { formatDuration, logger } from "./logger";

const openaiApiClient = createOpenAI({
	apiKey: Bun.env.OPENAI_API_KEY,
});

export const allowedComplexities = ["ALTA", "MEDIA", "BAIXA", "ÚNICA"] as const;
export type Complexity = (typeof allowedComplexities)[number];

export const expectedOutputTask = z.object({
	tasks: z.array(
		z.object({
			title: z.string().describe("O titulo da tarefa"),
			description: z.string().describe("A descrição da tarefa"),
			complexidade: z
				.string()
				.describe("A complexidade da tarefa: ALTA, MEDIA, BAIXA ou ÚNICA"),
			estimateMade: z
				.number()
				.describe("Estimativa da tarefa como número inteiro entre 1 e 8"),
		}),
	),
	fullFilePath: z.string().describe("O caminho completo do arquivo"),
});

export const createTasks = async ({ file, diff }: Input) => {
	const fileName = file.split("/").pop() || file;
	logger.info("🤖 Processando arquivo com IA", { fileName });

	const startTime = Date.now();

	try {
		const result = await getOpenaiResponse({ file, diff });
		const duration = Date.now() - startTime;

		logger.info("✅ IA processou arquivo com sucesso", {
			fileName,
			tasksGenerated: result.tasks.length,
			duration: formatDuration(duration),
			tasks: result.tasks.map((t) => ({
				title: t.title,
				descriptionLength: t.description.length,
				complexidade: t.complexidade,
				estimateMade: t.estimateMade,
			})),
		});

		return result;
	} catch (error) {
		const duration = Date.now() - startTime;
		logger.error("❌ Erro ao processar arquivo com IA", {
			fileName,
			duration: formatDuration(duration),
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
};

const getOpenaiResponse = async ({ file, diff }: Input) => {
	const fileName = file.split("/").pop() || file;

	logger.debug("📤 Enviando requisição para OpenAI", {
		fileName,
		model: "gpt-4o-mini-2024-07-18",
		diffLength: diff.length,
	});

	try {
		const response = await generateObject({
			model: openaiApiClient("gpt-5-nano"),
			schema: expectedOutputTask,
			messages: [
				{
					role: "system",
					content: `Você receberá um arquivo e um diff. Gere poucas tarefas, agrupando alterações relacionadas em uma mesma tarefa sempre que fizer sentido.
              Priorize qualidade sobre quantidade: somente separe em múltiplas tarefas quando houver contextos claramente diferentes.
              Para cada tarefa, gere: titulo, descrição, complexidade e estimateMade.
              A descrição deve ser completa e didática, explicando: o que mudou, por que mudou, impacto técnico e resultado esperado.
              Leve em conta a extensão e o nome do arquivo enviados. Não retorne markdown, apenas texto puro.
              Retorne sempre em português brasileiro.
              Evite palavras como 'Inutil' e 'Refatoração'; prefira termos como Reprocessamento ou alternativas mais agradáveis ao cliente.
              A complexidade deve ser obrigatoriamente um desses valores: ALTA, MEDIA, BAIXA, ÚNICA.
              Defina complexidade assim:
              ALTA = mudança ampla com várias regras/fluxos, alto risco ou forte impacto.
              MEDIA = mudança moderada com impacto controlado e algumas regras relevantes.
              BAIXA = ajuste pontual e simples, baixo risco e baixo impacto.
              ÚNICA = tarefa isolada e autocontida, sem dependências relevantes com outras mudanças.
              O estimateMade deve ser obrigatoriamente um número inteiro entre 1 e 8, coerente com a complexidade.
              `,
				},
				{
					role: "user",
					content: `
            ${file}
  
            ${diff}
          `,
				},
			],
		});

		logger.debug("📥 Resposta recebida da OpenAI", {
			fileName,
			tasksCount: response.object.tasks.length,
			responseStructure: {
				hasFullFilePath: !!response.object.fullFilePath,
				tasksStructure: response.object.tasks.map((rawTask) => {
					const task = sanitizeTask(rawTask);
					return {
						hasTitleAndDescription: !!(task.title && task.description),
						titleLength: task.title.length,
						descriptionLength: task.description.length,
						complexidade: task.complexidade,
						estimateMade: task.estimateMade,
					};
				}),
			},
		});

		return {
			fullFilePath: response.object.fullFilePath,
			tasks: response.object.tasks.map(sanitizeTask),
		};
	} catch (error) {
		if (error instanceof Error) {
			logger.error("🚨 Erro na chamada OpenAI", {
				fileName,
				errorName: error.name,
				errorMessage: error.message,
				stack: error.stack,
			});
		} else {
			logger.error("🚨 Erro desconhecido na chamada OpenAI", {
				fileName,
				error: String(error),
			});
		}
		throw error;
	}
};

type Input = {
	file: string;
	diff: string;
};

function sanitizeTask(
	task: z.infer<typeof expectedOutputTask>["tasks"][number],
) {
	return {
		...task,
		complexidade: normalizeComplexidade(task.complexidade),
		estimateMade: normalizeEstimate(task.estimateMade),
	};
}

function normalizeEstimate(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);

	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
		return 1;
	}

	return parsed;
}

function normalizeComplexidade(value: unknown): Complexity {
	if (typeof value !== "string") {
		return "ÚNICA";
	}

	const normalized = value.toUpperCase().trim();
	if (allowedComplexities.includes(normalized as Complexity)) {
		return normalized as Complexity;
	}

	return "ÚNICA";
}
