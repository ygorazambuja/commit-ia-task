import { describe, expect, test } from "bun:test";
import { createAzureTasks, getAzureDevopsDefaults } from "../src/azure-devops";
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
	"ID SPF": 19,
	UST: 4,
	Complexidade: "MEDIA",
	Activity: "Development",
	Description: "Criar task via CLI",
	"Estimate Made": 5,
	"Remaining Work": 5,
	"Original Estimate": 5,
};

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
			"--state",
			"To Do",
			"--area",
			"Projeto\\Area",
			"--iteration",
			"Projeto\\Sprint 1",
			"--fields",
			"Microsoft.VSTS.Common.Activity=Development",
			"Microsoft.VSTS.Scheduling.OriginalEstimate=5",
			"Microsoft.VSTS.Scheduling.RemainingWork=5",
			"--org",
			"https://dev.azure.com/org",
			"--project",
			"Projeto",
			"--output",
			"json",
		]);
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
