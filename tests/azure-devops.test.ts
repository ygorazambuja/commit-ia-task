import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAzureTasks,
	getAzureDevopsDefaults,
	toCmdSafeArgs,
} from "../src/azure-devops";
import type { TaskRecord } from "../src/csv";

const record: TaskRecord = {
	ID: "",
	"Work Item Type": "Task",
	Title: "Criar integração Azure",
	"Assigned To": "Pessoa <dev@example.com>",
	State: "To Do",
	"Area ID": "Projeto\\Area",
	"Iteration ID": "Projeto\\Sprint 1",
	"Item Contrato": "Item 1",
	"ID SPF": "19",
	UST: 4,
	Complexidade: "MEDIA",
	Activity: "Development",
	Description: "Criar task via CLI",
	"Estimate Made": 5,
	"Remaining Work": 5,
	"Original Estimate": 5,
};

describe("toCmdSafeArgs", () => {
	test("moves args with cmd.exe special chars to @files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "commit-ia-task-test-"));
		try {
			const value = 'Pessoa <dev@example.com> & "aspas" 100%';
			const args = await toCmdSafeArgs(
				["--assigned-to", value, "Custom.Complexidade=ÚNICA"],
				dir,
			);

			expect(args[0]).toBe("--assigned-to");
			expect(args[1]?.startsWith("@")).toBe(true);
			expect(await Bun.file(args[1]?.slice(1) ?? "").text()).toBe(value);
			expect(await Bun.file(args[2]?.slice(1) ?? "").text()).toBe(
				"Custom.Complexidade=ÚNICA",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("createAzureTasks", () => {
	test("creates one Azure DevOps task per record", async () => {
		const calls: string[][] = [];

		const ids = await createAzureTasks({
			records: [record],
			organization: "https://dev.azure.com/org",
			project: "Projeto",
			executor: async (args) => {
				calls.push(args);
				return JSON.stringify({ id: 123 });
			},
		});

		expect(ids).toEqual([123]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual([
			"boards",
			"work-item",
			"create",
			"--type",
			"Task",
			"--title",
			"Criar integração Azure",
			"--description",
			"Criar task via CLI",
			"--assigned-to",
			"Pessoa <dev@example.com>",
			"--area",
			"Projeto\\Area",
			"--iteration",
			"Projeto\\Sprint 1",
			"--fields",
			"System.State=To Do",
			"Microsoft.VSTS.Common.Activity=Development",
			"Microsoft.VSTS.Scheduling.OriginalEstimate=5",
			"Microsoft.VSTS.Scheduling.RemainingWork=5",
			"Custom.ItemContrato=Item 1",
			"Custom.IDSPF=19",
			"Custom.UST=4",
			"Custom.Complexidade=MEDIA",
			"Custom.EstimateMade=5",
			"--org",
			"https://dev.azure.com/org",
			"--project",
			"Projeto",
			"--output",
			"json",
		]);
	});

	test("sends numeric area and iteration as ID fields", async () => {
		const calls: string[][] = [];

		await createAzureTasks({
			records: [{ ...record, "Area ID": "1333", "Iteration ID": "1513" }],
			executor: async (args) => {
				calls.push(args);
				return JSON.stringify({ id: 123 });
			},
		});

		expect(calls[0]).not.toContain("--area");
		expect(calls[0]).not.toContain("--iteration");
		expect(calls[0]).toContain("System.AreaId=1333");
		expect(calls[0]).toContain("System.IterationId=1513");
	});

	test("links each created task to the parent PBI", async () => {
		const calls: string[][] = [];

		await createAzureTasks({
			records: [record],
			organization: "https://dev.azure.com/org",
			project: "Projeto",
			parentId: 456,
			executor: async (args) => {
				calls.push(args);
				return JSON.stringify({ id: 123 });
			},
		});

		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual([
			"boards",
			"work-item",
			"relation",
			"add",
			"--id",
			"123",
			"--relation-type",
			"parent",
			"--target-id",
			"456",
			"--org",
			"https://dev.azure.com/org",
			"--output",
			"none",
		]);
	});

	test("reports the created task id when linking to the PBI fails", async () => {
		expect(
			createAzureTasks({
				records: [record],
				parentId: 456,
				executor: async (args) => {
					if (args[2] === "relation") throw new Error("TF401232");
					return JSON.stringify({ id: 123 });
				},
			}),
		).rejects.toThrow("Task 123 criada, mas falhou ao vincular ao PBI 456");
	});

	test("does not call Azure CLI when there are no records", async () => {
		let calls = 0;

		const ids = await createAzureTasks({
			records: [],
			executor: async () => {
				calls += 1;
				return JSON.stringify({ id: 123 });
			},
		});

		expect(ids).toEqual([]);
		expect(calls).toBe(0);
	});

	test("reads Azure DevOps CLI defaults", async () => {
		const defaults = await getAzureDevopsDefaults(
			async () => `
[defaults]
organization = https://dev.azure.com/org
project = Projeto

Use git alias = No
`,
		);

		expect(defaults).toEqual({
			organization: "https://dev.azure.com/org",
			project: "Projeto",
		});
	});

	test("returns empty defaults when Azure CLI defaults cannot be read", async () => {
		const defaults = await getAzureDevopsDefaults(async () => {
			throw new Error("az not configured");
		});

		expect(defaults).toEqual({
			organization: "",
			project: "",
		});
	});
});
