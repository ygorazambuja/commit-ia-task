import type { TaskRecord } from "./csv";
import { logger } from "./logger";

type AzureCliExecutor = (args: string[]) => Promise<string>;

export type CreateAzureTasksInput = {
	records: TaskRecord[];
	organization?: string;
	project?: string;
	executor?: AzureCliExecutor;
};

export type AzureDevopsDefaults = {
	organization: string;
	project: string;
};

const defaultExecutor: AzureCliExecutor = async (args) => {
	const proc = Bun.spawn(["az", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `az exited ${exitCode}`);
	}

	return stdout;
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

const buildCreateWorkItemArgs = (
	record: TaskRecord,
	options: Pick<CreateAzureTasksInput, "organization" | "project">,
): string[] => [
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
	"--state",
	record.State,
	"--area",
	record["Area ID"],
	"--iteration",
	record["Iteration ID"],
	"--fields",
	`Microsoft.VSTS.Common.Activity=${record.Activity}`,
	`Microsoft.VSTS.Scheduling.OriginalEstimate=${record["Original Estimate"]}`,
	`Microsoft.VSTS.Scheduling.RemainingWork=${record["Remaining Work"]}`,
	...optionalArgs(options),
	"--output",
	"json",
];

export const createAzureTasks = async ({
	records,
	organization,
	project,
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
