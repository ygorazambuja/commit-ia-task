import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDiff } from "../src/git";

let tempDir: string;

async function run(command: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr || `${command.join(" ")} exited ${exitCode}`);
	}
	return stdout.trim();
}

async function initRepository(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	await run(["git", "init", "--quiet"], directory);
	await run(["git", "config", "user.email", "test@example.com"], directory);
	await run(["git", "config", "user.name", "Test"], directory);
	await Bun.write(join(directory, "README.md"), "initial\n");
	await run(["git", "add", "README.md"], directory);
	await run(["git", "commit", "--quiet", "-m", "initial"], directory);
}

describe("getDiff", () => {
	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "commit-ia-task-git-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("runs every Git operation in the requested repository", async () => {
		const targetRepository = join(tempDir, "target");
		const cleanRepository = join(tempDir, "clean");
		await initRepository(targetRepository);
		await initRepository(cleanRepository);
		const changedFile = "ação com espaço.ts";
		await Bun.write(join(targetRepository, changedFile), "export {};\n");
		await mkdir(join(targetRepository, "subproject"));
		await Bun.write(join(targetRepository, "subproject", "bun.lockb"), "lock");

		const gitModuleUrl = pathToFileURL(
			join(import.meta.dir, "..", "src", "git.ts"),
		).href;
		const scriptPath = join(tempDir, "run.ts");
		await Bun.write(
			scriptPath,
			`const { getDiff } = await import(${JSON.stringify(gitModuleUrl)});
const results = await getDiff(${JSON.stringify(targetRepository)}, {
	taskCreator: async ({ file }) => ({
		fullFilePath: file,
		tasks: [{ title: "Teste", description: "Teste", tipo: "TESTES", complexidade: "BAIXA", estimateMade: 1 }],
	}),
});
if (results.length !== 1 || !results[0]?.fullFilePath.endsWith(${JSON.stringify("ação com espaço.ts")})) process.exit(2);
`,
		);

		await run(["bun", "run", scriptPath], cleanRepository);

		expect(
			await run(
				["git", "diff", "--cached", "--name-only", "-z"],
				targetRepository,
			),
		).toBe(`${changedFile}\0`);
		expect(await run(["git", "status", "--short"], cleanRepository)).toBe("");
	});

	test("handles a staged rename with an accented path", async () => {
		const repository = join(tempDir, "repository");
		await initRepository(repository);
		const renamedFile = "visão geral.md";
		await run(["git", "mv", "README.md", renamedFile], repository);

		const results = await getDiff(repository, {
			taskCreator: async ({ file }) => ({
				fullFilePath: file,
				tasks: [
					{
						title: "Teste",
						description: "Teste",
						tipo: "TESTES",
						complexidade: "BAIXA",
						estimateMade: 1,
					},
				],
			}),
		});

		expect(results.map(({ fullFilePath }) => fullFilePath)).toEqual([
			join(repository, renamedFile),
		]);
	});

	test("fails when no changed file can be processed", async () => {
		const repository = join(tempDir, "repository");
		await initRepository(repository);
		await Bun.write(join(repository, "README.md"), "changed\n");

		expect(
			getDiff(repository, {
				taskCreator: async () => {
					throw new Error("AI unavailable");
				},
			}),
		).rejects.toThrow("Nenhum arquivo alterado pôde ser processado");
	});
});
