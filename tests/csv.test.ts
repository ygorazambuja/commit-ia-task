import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
							tipo: "BACKEND",
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
		expect(csv).toContain("Item Contrato,17,4,MEDIA");
		expect(csv).toContain("MEDIA,Development,Linha 1 Linha 2,5,5,5");
	});

	test("maps task types to their SPF IDs", async () => {
		await buildCsvFile({
			assignedTo: "Pessoa <dev@example.com>",
			areaId: "AREA-1",
			sprintId: "SPRINT-2",
			itemContrato: "Item 1",
			files: [
				{
					fullFilePath: "/repo/src/example.ts",
					tasks: [
						{
							title: "Backend",
							description: "API",
							tipo: "BACKEND",
							complexidade: "BAIXA",
							estimateMade: 1,
						},
						{
							title: "Frontend",
							description: "Interface",
							tipo: "FRONTEND",
							complexidade: "BAIXA",
							estimateMade: 1,
						},
						{
							title: "Testes",
							description: "Cobertura",
							tipo: "TESTES",
							complexidade: "BAIXA",
							estimateMade: 1,
						},
					],
				},
			],
		});

		const csvFiles = Array.from(new Bun.Glob("tasks-*.csv").scanSync(tempDir));
		const csv = await readFile(join(tempDir, csvFiles[0]), "utf8");
		expect(csv).toContain(
			"Backend,Pessoa <dev@example.com>,To Do,AREA-1,SPRINT-2,Item 1,17",
		);
		expect(csv).toContain(
			"Frontend,Pessoa <dev@example.com>,To Do,AREA-1,SPRINT-2,Item 1,19",
		);
		expect(csv).toContain(
			"Testes,Pessoa <dev@example.com>,To Do,AREA-1,SPRINT-2,Item 1,22",
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
