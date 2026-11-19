import { describe, expect, test } from "bun:test";
import { registerDaily } from "../scripts/daily";

const base = {
	sprintId: "1513",
	areaPathId: "1333",
	assignedTo: "Pessoa <dev@example.com>",
	itemContrato: "Item 1",
	organization: "https://dev.azure.com/org",
	project: "Projeto",
};

const fakeAz = (
	pbis: unknown[],
	existing: unknown[] = [],
	activities: unknown[] = [],
) => {
	const calls: string[][] = [];
	const queries = [pbis, existing, activities];
	const executor = async (args: string[]) => {
		calls.push(args);
		if (args[1] === "query") {
			const result = queries.shift() ?? [];
			// Imita o az real: consulta sem resultado não imprime nada.
			return result.length ? JSON.stringify(result) : "";
		}
		if (args[2] === "create") return JSON.stringify({ id: 999 });
		return "";
	};
	return { calls, executor };
};

const pbi = {
	id: 226643,
	fields: { "System.IterationPath": "SPF-SIAFIC\\Divida\\Divida - SP13" },
};

describe("registerDaily", () => {
	test("creates a done Daily listing today's tasks under the Institucional PBI", async () => {
		const { calls, executor } = fakeAz(
			[pbi],
			[],
			[
				{
					id: 10,
					fields: {
						"System.Title": "Ajustar <tela> & API",
						"System.State": "Done",
					},
				},
			],
		);

		const result = await registerDaily({ ...base, executor });

		expect(result).toEqual({ pbi: 226643, id: 999, status: "criada" });
		expect(calls[0]?.join(" ")).toContain("[System.IterationId] = 1513");
		expect(calls[1]?.join(" ")).toContain("[System.Parent] = 226643");
		expect(calls[2]?.join(" ")).toContain("[System.ChangedDate] >= @Today");
		const create = calls[3] ?? [];
		expect(create).toContain("Daily");
		expect(create).toContain(
			'<p>Reunião diária da SP13.</p><p>Atividades do dia:</p><ul><li><a href="https://dev.azure.com/org/Projeto/_workitems/edit/10/">#10</a> Ajustar &lt;tela&gt; &amp; API (Done)</li></ul>',
		);
		expect(create).toContain("System.State=Done");
		expect(create).toContain("Custom.IDSPF=17");
		expect(calls[4]).toContain("parent");
		expect(calls[4]).toContain("226643");
	});

	test("says so when no task changed today", async () => {
		const { calls, executor } = fakeAz([pbi]);

		await registerDaily({ ...base, executor });

		expect(calls[3]).toContain(
			"<p>Reunião diária da SP13.</p><p>Nenhuma task alterada hoje.</p>",
		);
	});

	test("does nothing when today's Daily already exists", async () => {
		const { calls, executor } = fakeAz([pbi], [{ id: 5 }]);

		const result = await registerDaily({ ...base, executor });

		expect(result).toEqual({ pbi: 226643, id: 5, status: "existente" });
		expect(calls).toHaveLength(2);
	});

	test("dry run does not create", async () => {
		const { calls, executor } = fakeAz([pbi]);

		const result = await registerDaily({ ...base, dryRun: true, executor });

		expect(result.status).toBe("simulada");
		expect(calls).toHaveLength(3);
		expect(calls.every((args) => args[1] === "query")).toBe(true);
	});

	test("fails when the sprint has zero or several Institucional PBIs", async () => {
		await expect(
			registerDaily({ ...base, executor: fakeAz([]).executor }),
		).rejects.toThrow("Nenhuma PBI Institucional");
		await expect(
			registerDaily({
				...base,
				executor: fakeAz([{ id: 1 }, { id: 2 }]).executor,
			}),
		).rejects.toThrow("1, 2");
	});
});
