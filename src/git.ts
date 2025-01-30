import { $ } from "bun";
import pino from "pino";
import type { z } from "zod";
import { createTasks, expectedOutputTask } from "./ai";

const logger = pino();

export async function getDiff(gitFolder: string) {
  const files = await getAlteredFileNames(gitFolder);
  const jsons: z.infer<typeof expectedOutputTask>[] = [];

  const promises = files.map(async (file) => {
    const diff = await $`git diff ${file}`.text();
    console.log("Criando Tasks para o arquivo " + file);

    return createTasks({ file, diff });
  });

  const results = await Promise.allSettled(promises);

  const corrects = results.filter((r) => r.status === "fulfilled");
  const errors = results.filter((r) => r.status === "rejected");

  corrects.map(async (c) => {
    console.log(`Gerado tasks para o Arquivo ${c.value.fullFilePath}`);

    jsons.push({
      fullFilePath: c.value?.fullFilePath ?? "",
      tasks: c.value?.tasks ?? [],
    });
  });

  for (const c of corrects) {
    const { stderr, exitCode } = await $`git add ${c.value?.fullFilePath}`
      .nothrow()
      .quiet();

    if (exitCode !== 0) console.log(stderr.toString());
  }

  errors.map((e) => logger.error(e));

  return jsons;
}
async function getAlteredFileNames(gitFolder: string): Promise<Array<string>> {
  const diffProc = Bun.spawn(["git", "diff", "--name-only"]);
  const newFilesProc = Bun.spawn([
    "git",
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  const ignoredPatterns = ["pnpm-lock.yaml", "bun.lockb", "package-lock.json"];

  const diffText = await new Response(diffProc.stdout).text();
  const diffFiles = diffText
    .split("\n")
    .filter(Boolean)
    .filter((f) => !ignoredPatterns.includes(f))
    .map((f) => gitFolder.concat(`/${f}`))
    .map((f) => f.replaceAll("\n", ""));

  const newFilesText = await new Response(newFilesProc.stdout).text();
  const newFiles = newFilesText
    .split("\n")
    .filter(Boolean)
    .filter((f) => !ignoredPatterns.includes(f))
    .map((f) => gitFolder.concat(`/${f}`))
    .map((f) => f.replaceAll("\n", ""));

  return [...diffFiles, ...newFiles];
}
