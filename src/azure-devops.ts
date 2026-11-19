import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "./csv";
import { logger } from "./logger";

export type AzureCliExecutor = (args: string[]) => Promise<string>;

export type CreateAzureTasksInput = {
	records: TaskRecord[];
	organization?: string;
	project?: string;
	parentId?: number;
	executor?: AzureCliExecutor;
};

export type AzureDevopsDefaults = {
	organization: string;
	project: string;
};

// No Windows o az é um .cmd: o Bun recusa caracteres especiais do cmd.exe e acentos podem ser corrompidos pela codepage.
const CMD_SPECIAL_CHARS = /[%^&|<>"!()\r\n]|[^\x20-\x7E]/;

// O Azure CLI lê o valor de um argumento "@caminho" do arquivo indicado.
export const toCmdSafeArgs = async (
	args: string[],
	tempDir: string,
): Promise<string[]> =>
	Promise.all(
		args.map(async (arg, index) => {
			if (!CMD_SPECIAL_CHARS.test(arg)) {
				return arg;
			}
			const file = join(tempDir, `arg-${index}.txt`);
			await Bun.write(file, arg);
			return `@${file}`;
		}),
	);

export const defaultExecutor: AzureCliExecutor = async (args) => {
	const tempDir =
		process.platform === "win32"
			? await mkdtemp(join(tmpdir(), "commit-ia-task-az-"))
			: undefined;

	try {
		const safeArgs = tempDir ? await toCmdSafeArgs(args, tempDir) : args;
		const proc = Bun.spawn(["az", ...safeArgs], {
			stdout: "pipe",
			stderr: "pipe",
		});

		// No Windows o az escreve em cp1252 mesmo com PYTHONIOENCODING=utf-8; ler como UTF-8 quebra acentos.
		const decoder = new TextDecoder(tempDir ? "windows-1252" : "utf-8");
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).arrayBuffer().then((b) => decoder.decode(b)),
			new Response(proc.stderr).arrayBuffer().then((b) => decoder.decode(b)),
			proc.exited,
		]);

		if (exitCode !== 0) {
			throw new Error(
				stderr.trim() || stdout.trim() || `az exited ${exitCode}`,
			);
		}

		return stdout;
	} finally {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	}
};

export const getAzureDevopsDefaults = async (
	executor: AzureCliExecutor = defaultExecutor,
): Promise<AzureDevopsDefaults> => {
	try {
		const output = await executor(["devops", "configure", "-l"]);
		const defaults: AzureDevopsDefaults = {
			organization: "",
			project: "",
		};

		for (const line of output.split(/\r?\n/)) {
			const [rawKey, ...rawValue] = line.split("=");
			const key = rawKey?.trim();
			const value = rawValue.join("=").trim();

			if (key === "organization") {
				defaults.organization = value;
			}

			if (key === "project") {
				defaults.project = value;
			}
		}

		return defaults;
	} catch (error) {
		logger.debug("Configuração padrão do Azure DevOps CLI não encontrada", {
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			organization: "",
			project: "",
		};
	}
};

const optionalArgs = ({
	organization,
	project,
}: Pick<CreateAzureTasksInput, "organization" | "project">): string[] => {
	const args: string[] = [];

	if (organization) {
		args.push("--org", organization);
	}

	if (project) {
		args.push("--project", project);
	}

	return args;
};

const isNumericId = (value: string) => /^\d+$/.test(value.trim());

const buildCreateWorkItemArgs = (
	record: TaskRecord,
	options: Pick<CreateAzureTasksInput, "organization" | "project">,
): string[] => {
	const area = record["Area ID"];
	const iteration = record["Iteration ID"];

	// --area/--iteration do az aceitam só caminho; IDs numéricos vão como campo.
	return [
		"boards",
		"work-item",
		"create",
		"--type",
		record["Work Item Type"],
		"--title",
		record.Title,
		"--description",
		record.Description,
		"--assigned-to",
		record["Assigned To"],
		...(isNumericId(area) ? [] : ["--area", area]),
		...(isNumericId(iteration) ? [] : ["--iteration", iteration]),
		"--fields",
		`System.State=${record.State}`,
		`Microsoft.VSTS.Common.Activity=${record.Activity}`,
		`Microsoft.VSTS.Scheduling.OriginalEstimate=${record["Original Estimate"]}`,
		`Microsoft.VSTS.Scheduling.RemainingWork=${record["Remaining Work"]}`,
		`Custom.ItemContrato=${record["Item Contrato"]}`,
		`Custom.IDSPF=${record["ID SPF"]}`,
		`Custom.UST=${record.UST}`,
		`Custom.Complexidade=${record.Complexidade}`,
		`Custom.EstimateMade=${record["Estimate Made"]}`,
		...(isNumericId(area) ? [`System.AreaId=${area.trim()}`] : []),
		...(isNumericId(iteration)
			? [`System.IterationId=${iteration.trim()}`]
			: []),
		...optionalArgs(options),
		"--output",
		"json",
	];
};

export const createAzureTasks = async ({
	records,
	organization,
	project,
	parentId,
	executor = defaultExecutor,
}: CreateAzureTasksInput): Promise<number[]> => {
	if (records.length === 0) {
		logger.info("ℹ️ Nenhuma task para criar no Azure DevOps");
		return [];
	}

	logger.info("☁️ Criando tasks no Azure DevOps", {
		totalTasks: records.length,
		organization: organization || "(configurado no az)",
		project: project || "(configurado no az)",
		parentId,
	});

	const createdIds: number[] = [];

	for (const [index, record] of records.entries()) {
		try {
			const output = await executor(
				buildCreateWorkItemArgs(record, { organization, project }),
			);
			const parsed = JSON.parse(output) as { id?: number };

			if (typeof parsed.id === "number") {
				createdIds.push(parsed.id);
			}

			logger.info("✅ Task criada no Azure DevOps", {
				current: index + 1,
				total: records.length,
				id: parsed.id,
				title: record.Title,
			});

			if (parentId !== undefined) {
				if (typeof parsed.id !== "number") {
					throw new Error(
						"Azure CLI não retornou o ID da task; não foi possível vincular ao PBI",
					);
				}
				await executor([
					"boards",
					"work-item",
					"relation",
					"add",
					"--id",
					String(parsed.id),
					"--relation-type",
					"parent",
					"--target-id",
					String(parentId),
					...(organization ? ["--org", organization] : []),
					"--output",
					"none",
				]).catch((error) => {
					throw new Error(
						`Task ${parsed.id} criada, mas falhou ao vincular ao PBI ${parentId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
				logger.info("🔗 Task vinculada ao PBI", {
					id: parsed.id,
					parentId,
				});
			}
		} catch (error) {
			logger.error("❌ Erro ao criar task no Azure DevOps", {
				current: index + 1,
				total: records.length,
				title: record.Title,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	logger.info("✅ Criação de tasks no Azure DevOps concluída", {
		created: createdIds.length,
		ids: createdIds,
	});

	return createdIds;
};
