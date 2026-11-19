// Registra horas na aba "Time Log Free" (extensão TimeLog.time-logging-extension) de um work item.
// Port do CLI Rust timelog-bot, usando a credencial do `az devops` em vez de PAT. Documentação: README.md, seção "Skills".
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	type AzureCliExecutor,
	defaultExecutor,
	getAzureDevopsDefaults,
} from "../src/azure-devops";
import { loadConfig } from "../src/config";

export const TIME_TYPES = ["Backend", "Frontend"] as const;
export type TimeType = (typeof TIME_TYPES)[number];
export type Identity = { name: string; id: string };

export type TimeLogInput = {
	workItemId: number;
	hours: number;
	minutes: number;
	date: string;
	type: string;
	comment: string;
};

export type TimeLogDocument = {
	minutes: number;
	user: string;
	userId: string;
	date: string;
	dateWeek: string;
	workItemId: number;
	type: TimeType;
	comment: string;
};

export const totalMinutes = (hours: number, minutes: number) => {
	if (!Number.isInteger(hours) || hours < 0) {
		throw new Error("as horas devem ser um inteiro maior ou igual a zero");
	}
	if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
		throw new Error("os minutos devem ser um inteiro entre 0 e 59");
	}
	const total = hours * 60 + minutes;
	if (total === 0) throw new Error("informe pelo menos uma hora ou um minuto");
	return total;
};

// Aceita só datas reais no formato YYYY-MM-DD.
export const parseDate = (value: string) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match) {
		const [year, month, day] = match.slice(1).map(Number) as [
			number,
			number,
			number,
		];
		const date = new Date(Date.UTC(year, month - 1, day));
		if (
			date.getUTCFullYear() === year &&
			date.getUTCMonth() === month - 1 &&
			date.getUTCDate() === day
		) {
			return date;
		}
	}
	throw new Error("a data deve existir e usar o formato YYYY-MM-DD");
};

// Semana ISO 8601 (ex.: 2021-01-01 → 2020-W53), como a extensão grava em dateWeek.
export const isoWeek = (date: Date) => {
	const target = new Date(date.getTime());
	target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
	const year = target.getUTCFullYear();
	const week = Math.ceil(
		((target.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7,
	);
	return `${year}-W${String(week).padStart(2, "0")}`;
};

export const normalizeType = (value: string): TimeType => {
	const type = TIME_TYPES.find((t) => t.toLowerCase() === value.toLowerCase());
	if (!type) throw new Error(`o tipo deve ser ${TIME_TYPES.join(" ou ")}`);
	return type;
};

export const buildDocument = (
	input: TimeLogInput,
	identity: Identity,
): TimeLogDocument => {
	if (!Number.isInteger(input.workItemId) || input.workItemId <= 0) {
		throw new Error("o ID do work item deve ser um inteiro positivo");
	}
	if (!input.comment.trim())
		throw new Error("o comentário não pode ficar vazio");
	return {
		minutes: totalMinutes(input.hours, input.minutes),
		user: identity.name,
		userId: identity.id,
		date: input.date,
		dateWeek: isoWeek(parseDate(input.date)),
		workItemId: input.workItemId,
		type: normalizeType(input.type),
		// Reproduz o escape (sem ";" no &gt) que o JavaScript da extensão grava.
		comment: input.comment.replaceAll("<", "&lt;").replaceAll(">", "&gt"),
	};
};

type AzureScope = {
	organization?: string;
	project?: string;
	executor?: AzureCliExecutor;
};

// O usuário autenticado no az: @Me numa WIQL devolve nome e ID da identidade (o mesmo da connectionData).
export const getIdentity = async ({
	organization,
	project,
	executor = defaultExecutor,
}: AzureScope): Promise<Identity> => {
	const output = await executor([
		"boards",
		"query",
		"--wiql",
		"SELECT [System.Id], [System.AssignedTo] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.ChangedDate] >= @Today - 90",
		...(organization ? ["--org", organization] : []),
		...(project ? ["--project", project] : []),
		"--output",
		"json",
	]);
	const items = JSON.parse(output || "[]") as {
		fields?: { "System.AssignedTo"?: { displayName?: string; id?: string } };
	}[];
	const user = items[0]?.fields?.["System.AssignedTo"];
	if (!user?.displayName || !user.id) {
		throw new Error(
			"não foi possível descobrir a identidade do az: nenhum work item atribuído a você nos últimos 90 dias",
		);
	}
	return { name: user.displayName, id: user.id };
};

export const logTime = async ({
	input,
	organization,
	project,
	dryRun = false,
	executor = defaultExecutor,
}: AzureScope & { input: TimeLogInput; dryRun?: boolean }) => {
	const identity = await getIdentity({ organization, project, executor });
	const document = buildDocument(input, identity);
	if (dryRun) return { document, id: undefined };

	// `az devops invoke` usa a credencial salva do `az devops login`; o corpo vai por arquivo.
	const dir = await mkdtemp(join(tmpdir(), "commit-ia-task-timelog-"));
	try {
		const file = join(dir, "document.json");
		await Bun.write(file, JSON.stringify(document));
		const output = await executor([
			"devops",
			"invoke",
			"--area",
			"ExtensionManagement",
			"--resource",
			"Data",
			"--route-parameters",
			"publisherName=TimeLog",
			"extensionName=time-logging-extension",
			"scopeType=Default",
			"scopeValue=Current",
			"collectionName=TimeLogData",
			"--http-method",
			"POST",
			"--api-version",
			"7.1-preview",
			"--in-file",
			file,
			...(organization ? ["--org", organization] : []),
			"--output",
			"json",
		]).catch((error) => {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}. O resultado pode ser indeterminado; confira a aba Time Log Free antes de repetir`,
			);
		});
		// A criação já ocorreu mesmo se a resposta não trouxer o ID.
		let id: string | undefined;
		try {
			id = JSON.parse(output)?.id;
		} catch {}
		return { document, id };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

if (import.meta.main) {
	try {
		const { values, positionals } = parseArgs({
			allowPositionals: true,
			options: {
				hours: { type: "string", default: "0" },
				minutes: { type: "string", default: "0" },
				date: { type: "string" },
				type: { type: "string" },
				comment: { type: "string" },
				dryRun: { type: "boolean" },
			},
			strict: true,
		});
		if (positionals.length !== 1 || !values.type || !values.comment) {
			throw new Error(
				'uso: bun run scripts/timelog.ts <workItemId> --hours 2 [--minutes 30] [--date YYYY-MM-DD] --type Backend|Frontend --comment "..." [--dryRun]',
			);
		}
		const config = await loadConfig();
		const defaults =
			config?.azureOrganization && config.azureProject
				? { organization: "", project: "" }
				: await getAzureDevopsDefaults();
		const input: TimeLogInput = {
			workItemId: Number(positionals[0]),
			hours: Number(values.hours),
			minutes: Number(values.minutes),
			// Padrão: hoje no fuso local ("sv-SE" formata como YYYY-MM-DD).
			date: values.date ?? new Date().toLocaleDateString("sv-SE"),
			type: values.type,
			comment: values.comment,
		};

		const { document, id } = await logTime({
			input,
			organization: config?.azureOrganization || defaults.organization,
			project: config?.azureProject || defaults.project,
			dryRun: values.dryRun,
		});
		if (values.dryRun) {
			console.log(JSON.stringify(document, null, 2));
		} else {
			console.log(
				`registrado: ${input.hours}h${String(input.minutes).padStart(2, "0")}min em #${document.workItemId} no dia ${document.date} como ${document.type}${id ? ` (documento ${id})` : ""}`,
			);
		}
	} catch (error) {
		console.error(
			`erro: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
