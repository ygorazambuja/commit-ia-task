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

	describe("branch mode", () => {
		const stubCreator = async ({ file }: { file: string }) => ({
			fullFilePath: file,
			tasks: [
				{
					title: "Teste",
					description: "Teste",
					tipo: "TESTES" as const,
					complexidade: "BAIXA" as const,
					estimateMade: 1,
				},
			],
		});

		async function commitFile(repo: string, file: string, content: string) {
			await Bun.write(join(repo, file), content);
			await run(["git", "add", "--", file], repo);
			await run(["git", "commit", "--quiet", "-m", file], repo);
		}

		async function setupBranch(): Promise<string> {
			const repo = join(tempDir, "repository");
			await initRepository(repo);
			await run(["git", "branch", "-M", "main"], repo);
			await run(["git", "checkout", "--quiet", "-b", "feature"], repo);
			await commitFile(repo, "feature.ts", "export const a = 1;\n");
			await commitFile(repo, "README.md", "feature change\n");
			await run(["git", "checkout", "--quiet", "main"], repo);
			await commitFile(repo, "main-only.ts", "export {};\n");
			return repo;
		}

		const relPaths = (repo: string, results: { fullFilePath: string }[]) =>
			results
				.map(({ fullFilePath }) => fullFilePath.slice(repo.length + 1))
				.sort();

		test("uses only files changed on the branch and leaves the index alone", async () => {
			const repo = await setupBranch();
			await Bun.write(join(repo, "uncommitted.ts"), "export {};\n");
			const diffs: string[] = [];

			const results = await getDiff(repo, {
				branch: "feature",
				taskCreator: async (input) => {
					diffs.push(input.diff);
					return stubCreator(input);
				},
			});

			expect(relPaths(repo, results)).toEqual(["README.md", "feature.ts"]);
			expect(diffs.join("\n")).toContain("+feature change");
			expect(await run(["git", "diff", "--cached", "--name-only"], repo)).toBe(
				"",
			);
		});

		test("prefers a Develop branch as the default base", async () => {
			const repo = await setupBranch();
			await run(
				["git", "checkout", "--quiet", "-b", "Develop", "feature~1"],
				repo,
			);
			await run(["git", "checkout", "--quiet", "main"], repo);

			const results = await getDiff(repo, {
				branch: "feature",
				taskCreator: stubCreator,
			});

			expect(relPaths(repo, results)).toEqual(["README.md"]);
		});

		test("finds the branch changes after it was merged with a merge commit", async () => {
			const repo = await setupBranch();
			await run(
				[
					"git",
					"merge",
					"--quiet",
					"--no-ff",
					"-m",
					"merge feature",
					"feature",
				],
				repo,
			);
			await commitFile(repo, "after-merge.ts", "export {};\n");

			const results = await getDiff(repo, {
				branch: "feature",
				taskCreator: stubCreator,
			});

			expect(relPaths(repo, results)).toEqual(["README.md", "feature.ts"]);
		});

		test("asks for --baseBranch when the branch was fast-forwarded", async () => {
			const repo = await setupBranch();
			await run(["git", "reset", "--quiet", "--hard", "feature"], repo);

			expect(
				getDiff(repo, { branch: "feature", taskCreator: stubCreator }),
			).rejects.toThrow("--baseBranch");
		});

		test("accepts an explicit base commit", async () => {
			const repo = await setupBranch();
			await run(["git", "reset", "--quiet", "--hard", "feature"], repo);
			const forkPoint = await run(["git", "rev-parse", "feature~2"], repo);

			const results = await getDiff(repo, {
				branch: "feature",
				baseBranch: forkPoint,
				taskCreator: stubCreator,
			});

			expect(relPaths(repo, results)).toEqual(["README.md", "feature.ts"]);
		});
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
