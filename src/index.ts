import { $ } from "bun";
import { buildCsvFile } from "./csv";
import { getDiff } from "./git";

const pwd = await $`pwd`.text();

console.log("Iniciando Processo");

const files = await getDiff(pwd);

buildCsvFile(files);

console.log("Finalizado com sucesso");
