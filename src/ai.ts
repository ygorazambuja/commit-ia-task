import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { logger, formatDuration } from "./logger";

export const expectedOutputTask = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
    })
  ),
  fullFilePath: z.string(),
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
      model: openai("gpt-4o-mini-2024-07-18"),
      schema: expectedOutputTask,
      messages: [
        {
          role: "system",
          content: `Você receberá um arquivo, e um diff, crie quantas tarefas forem necessarias para explicar tudo o que ocorreu nas alterações dos arquivos, crie um titulo e uma descrição. 
              Leve em conta a extensão e nome do arquivo que foram enviados, não retorne o markdown, retorne apenas o texto puro. Retorne sempre o texto em portugues brasileiro, se a task for muito grande divida em mais de uma task.
              Evite palavras como 'Inutil', 'Refatoração' troque elas por Reprocessamento, ou algo que seja menos agressivo e mais agradavel ao cliente
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
        tasksStructure: response.object.tasks.map((t) => ({
          hasTitleAndDescription: !!(t.title && t.description),
          titleLength: t.title?.length || 0,
          descriptionLength: t.description?.length || 0,
        })),
      },
    });

    return response.object;
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
