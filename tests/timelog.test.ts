import { describe, expect, test } from "bun:test";
import {
	buildDocument,
	isoWeek,
	logTime,
	parseDate,
	totalMinutes,
} from "../scripts/timelog";

const input = {
	workItemId: 201878,
	hours: 2,
	minutes: 30,
	date: "2026-08-12",
	type: "frontend",
	comment: "Implementei A < B > C",
};
const identity = { name: "Ygor Azambuja", id: "user-guid" };

const fakeAz = () => {
	const calls: string[][] = [];
	let posted: unknown;
	const executor = async (args: string[]) => {
		calls.push(args);
		if (args[1] === "query") {
			return JSON.stringify([
				{
					id: 1,
					fields: {
						"System.AssignedTo": {
							displayName: "Ygor Azambuja",
							id: "user-guid",
						},
					},
				},
			]);
		}
		const file = args[args.indexOf("--in-file") + 1] ?? "";
		posted = await Bun.file(file).json();
		return JSON.stringify({ id: "doc-1", continuation_token: null });
	};
	return { calls, executor, posted: () => posted };
};

describe("timelog", () => {
	test("builds the extension document exactly", () => {
		expect(buildDocument(input, identity)).toEqual({
			minutes: 150,
			user: "Ygor Azambuja",
			userId: "user-guid",
			date: "2026-08-12",
			dateWeek: "2026-W33",
			workItemId: 201878,
			type: "Frontend",
			comment: "Implementei A &lt; B &gt C",
		});
	});

	test("uses the ISO week year at year boundaries", () => {
		expect(isoWeek(parseDate("2021-01-01"))).toBe("2020-W53");
	});

	test("rejects invalid duration, date and type", () => {
		expect(() => totalMinutes(0, 0)).toThrow();
		expect(() => totalMinutes(1, 60)).toThrow();
		expect(() => parseDate("2026-02-29")).toThrow();
		expect(parseDate("2028-02-29").toISOString()).toStartWith("2028-02-29");
		expect(() => buildDocument({ ...input, type: "Testes" }, identity)).toThrow(
			"Backend ou Frontend",
		);
		expect(() =>
			buildDocument({ ...input, workItemId: 0 }, identity),
		).toThrow();
	});

	test("posts the document via az devops invoke as the @Me identity", async () => {
		const { calls, executor, posted } = fakeAz();

		const result = await logTime({
			input,
			organization: "https://dev.azure.com/org",
			project: "Projeto",
			executor,
		});

		expect(result.id).toBe("doc-1");
		expect(calls[0]?.join(" ")).toContain("[System.AssignedTo] = @Me");
		expect(calls[1]).toContain("invoke");
		expect(calls[1]).toContain("collectionName=TimeLogData");
		expect(calls[1]).toContain("POST");
		expect(posted()).toEqual(buildDocument(input, identity));
	});

	test("dry run only reads the identity", async () => {
		const { calls, executor } = fakeAz();

		const result = await logTime({ input, dryRun: true, executor });

		expect(result.document.minutes).toBe(150);
		expect(calls).toHaveLength(1);
	});
});
