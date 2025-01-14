import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { z } from "zod";

const openai = new OpenAI({
  apiKey: Bun.env.OPEN_AI_KEY,
});

export const expectedOutputTask = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
    })
  ),
  filename: z.string(),
});

export const createTasks = async ({ file, diff }: Input) => {
  return await getOpenaiResponse({ file, diff });
};

const getOpenaiResponse = async ({ file, diff }: Input) => {
  const response = await openai.beta.chat.completions.parse({
    model: "gpt-4o-mini-2024-07-18",
    response_format: zodResponseFormat(expectedOutputTask, "tasks"),
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

  return response.choices[0].message.parsed;
};

type Input = {
  file: string;
  diff: string;
};
