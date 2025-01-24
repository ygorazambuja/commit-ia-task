import pino from "pino";
import { z } from "zod";

import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";

const logger = pino();

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
  return await getOpenaiResponse({ file, diff });
};

const getOpenaiResponse = async ({ file, diff }: Input) => {
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

    return response.object;
  } catch (error) {
    logger.error(error);
    throw error;
  }
};

type Input = {
  file: string;
  diff: string;
};
