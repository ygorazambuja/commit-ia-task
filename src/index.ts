import { $ } from "bun";
import { parseArgs } from "util";
import { buildCsvFile } from "./csv";
import { getDiff } from "./git";

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    sprintId: {
      type: "string",
    },
    areaPathId: {
      type: "string",
    },
  },
  strict: true,
  allowPositionals: true,
});

if (!values.sprintId || !values.areaPathId) {
  console.error("--sprintId and --areaPathId are required");
  process.exit(1);
}

const pwd = await $`pwd`.text();
console.log("Iniciando Processo");
const files = await getDiff(pwd);
buildCsvFile(files, values.areaPathId, values.sprintId);
console.log("Finalizado com sucesso");
