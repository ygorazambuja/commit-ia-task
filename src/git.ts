import { $ } from "bun";
import { createTasks } from "./ai";

export async function getDiff(gitFolder: string) {
  const files = await getAlteredFileNames(gitFolder);
  const jsons = [];

  for (const file of files) {
    const diff = await $`git diff ${file}`.text();

    console.log("Criando Tasks para o arquivo " + file);

    const json = await createTasks({ file, diff });
    if (json) jsons.push(json);
  }

  Bun.write("tasks.json", JSON.stringify(jsons));

  return jsons;
}

// export async function getMockFile() {
//   const file = Bun.file("./tasks.json");
//   return await file.json();
// }

async function getAlteredFileNames(gitFolder: string): Promise<Array<string>> {
  const proc = Bun.spawn(["git", "diff", "--name-only"]);

  const ignoredPatterns = ["pnpm-lock.yaml"];

  const text = await new Response(proc.stdout).text();
  const files = text
    .split("\n")
    .filter(Boolean)
    .filter((f) => !ignoredPatterns.includes(f))
    .map((f) => gitFolder.concat(`/${f}`))
    .map((f) => f.replaceAll("\n", ""));

  return files;
}
