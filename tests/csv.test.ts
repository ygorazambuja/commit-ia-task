import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUst } from "../src/catalogo";
import { buildCsvFile } from "../src/csv";

const originalCwd = process.cwd();
let tempDir: string;

describe("buildCsvFile", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "commit-ia-task-csv-"));
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("writes sanitized task records with project metadata", async () => {
		await buildCsvFile({
			assignedTo: " Pessoa\nResponsavel <dev@example.com> ",
			areaId: "AREA-1",
			sprintId: "SPRINT-2",
			itemContrato: " Item\r\nContrato ",
			files: [
				{
					fullFilePath: "/repo/src/example.ts",
					tasks: [
						{
							title: " Criar\nCSV ",
							description: "Linha 1\r\nLinha 2",
							idSpf: "17",
							complexidade: "MEDIA",
							estimateMade: 5,
						},
					],
				},
			],
		});

		const csvFiles = Array.from(new Bun.Glob("tasks-*.csv").scanSync(tempDir));
		expect(csvFiles).toHaveLength(1);

		const csvPath = join(tempDir, csvFiles[0]);
		expect(existsSync(csvPath)).toBe(true);

		const csv = await readFile(csvPath, "utf8");
		expect(csv).toContain("ID,Work Item Type,Title,Assigned To,State");
		expect(csv).toContain(
			"Task,Criar CSV,Pessoa Responsavel <dev@example.com>",
		);
		expect(csv).toContain("AREA-1,SPRINT-2,Item Contrato");
		expect(csv).toContain("Item Contrato,17,24,MEDIA");
		expect(csv).toContain("MEDIA,Development,Linha 1 Linha 2,5,5,5");
	});

	test("takes UST and complexity from the service catalog", async () => {
		const task = (title: string, idSpf: string, complexidade: string) => ({
			title,
			description: title,
			idSpf,
			complexidade: complexidade as "BAIXA",
			estimateMade: 1,
		});

		await buildCsvFile({
			assignedTo: "Pessoa <dev@example.com>",
			areaId: "AREA-1",
			sprintId: "SPRINT-2",
			itemContrato: "Item 1",
			files: [
				{
					fullFilePath: "/repo/src/example.ts",
					tasks: [
						task("Componente", "17", "ALTA"),
						task("Teste", "22", "MEDIA"),
						// Serviço de nível único ignora a complexidade da IA.
						task("Bug", "21E", "ALTA"),
						// Complexidade que o serviço não tem cai no primeiro nível dele.
						task("Regra", "18", "ÚNICA"),
					],
				},
			],
		});

		const csvFiles = Array.from(new Bun.Glob("tasks-*.csv").scanSync(tempDir));
		const csv = await readFile(join(tempDir, csvFiles[0]), "utf8");
		expect(csv).toContain("Item 1,17,40,ALTA");
		expect(csv).toContain("Item 1,22,12,MEDIA");
		expect(csv).toContain("Item 1,21E,2,ÚNICA");
		expect(csv).toContain("Item 1,18,3,BAIXA");
	});

	test("rejects a service that is not in the catalog", () => {
		expect(() => resolveUst("99", "BAIXA")).toThrow(
			"Serviço 99 não está no catálogo",
		);
	});

	test("writes only the header when there are no tasks", async () => {
		await buildCsvFile({
			assignedTo: "Pessoa <dev@example.com>",
			areaId: "AREA-1",
			sprintId: "SPRINT-2",
			itemContrato: "Item 1",
			files: [],
		});

		const csvFiles = Array.from(new Bun.Glob("tasks-*.csv").scanSync(tempDir));
		expect(csvFiles).toHaveLength(1);

		const csv = await readFile(join(tempDir, csvFiles[0]), "utf8");
		expect(csv.trim().split("\n")).toHaveLength(1);
		expect(csv).toContain("Original Estimate");
	});

	test("does not overwrite a CSV generated in the same minute", async () => {
		const input = {
			assignedTo: "Pessoa <dev@example.com>",
			areaId: "AREA-1",
			sprintId: "SPRINT-2",
			itemContrato: "Item 1",
			files: [],
		};

		await buildCsvFile(input);
		await buildCsvFile(input);

		const csvFiles = Array.from(new Bun.Glob("tasks-*.csv").scanSync(tempDir));
		expect(csvFiles).toHaveLength(2);
	});
});
