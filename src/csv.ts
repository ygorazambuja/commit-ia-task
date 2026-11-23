import { existsSync } from "node:fs";
import { createObjectCsvWriter } from "csv-writer";
import type { TaskFile } from "./ai";
import { resolveUst } from "./catalogo";
import { logger } from "./logger";

const writeHeader = () => [
	"ID",
	"Work Item Type",
	"Title",
	"Assigned To",
	"State",
	"Area ID",
	"Iteration ID",
	"Item Contrato",
	"ID SPF",
	"UST",
	"Complexidade",
	"Activity",
	"Description",
	"Estimate Made",
	"Remaining Work",
	"Original Estimate",
];

const sanitizeCsvText = (value: string) =>
	value
		.replace(/\r\n/g, " ")
		.replace(/\n/g, " ")
		.replace(/\r/g, " ")
		.replace(/\s+/g, " ")
		.trim();

export const buildTaskRecords = ({
	files,
	assignedTo,
	areaId,
	sprintId,
	itemContrato,
}: BuildCsvInput): TaskRecord[] => {
	return files.flatMap(({ tasks }) =>
		tasks.map((t) => {
			const { ust, complexidade } = resolveUst(t.idSpf, t.complexidade);
			return {
				ID: "",
				"Work Item Type": "Task",
				Title: sanitizeCsvText(t.title),
				"Assigned To": sanitizeCsvText(assignedTo),
				State: "To Do",
				"Area ID": areaId,
				"Iteration ID": sprintId,
				"Item Contrato": sanitizeCsvText(itemContrato),
				"ID SPF": t.idSpf,
				UST: ust,
				Complexidade: complexidade,
				Activity: "Development",
				Description: sanitizeCsvText(t.description),
				"Estimate Made": t.estimateMade,
				"Remaining Work": t.estimateMade,
				"Original Estimate": t.estimateMade,
			};
		}),
	);
};

export const buildCsvFile = async ({
	files,
	assignedTo,
	areaId,
	sprintId,
	itemContrato,
}: BuildCsvInput) => {
	logger.info("📝 Iniciando geração do arquivo CSV");

	const records = buildTaskRecords({
		files,
		assignedTo,
		areaId,
		sprintId,
		itemContrato,
	});
	const currentDate = new Date();
	const formattedDate = `${currentDate.getDate()}-${
		currentDate.getMonth() + 1
	}-${currentDate.getHours()}-${currentDate.getMinutes()}`;

	const baseFileName = `tasks-${formattedDate}`;
	let fileName = `${baseFileName}.csv`;
	let suffix = 1;
	while (existsSync(fileName)) {
		fileName = `${baseFileName}-${suffix}.csv`;
		suffix += 1;
	}

	logger.info("📊 Dados para CSV preparados", {
		totalFiles: files.length,
		totalTasks: records.length,
		fileName,
		config: {
			assignedTo,
			areaId,
			sprintId,
			itemContrato,
		},
	});

	const csvWriter = createObjectCsvWriter({
		path: fileName,
		header: writeHeader().map((header) => ({ id: header, title: header })),
	});

	logger.debug("📋 Estrutura dos registros", {
		recordsCount: records.length,
		sampleRecord: records[0]
			? {
					title: records[0].Title,
					descriptionLength: records[0].Description.length,
					assignedTo: records[0]["Assigned To"],
				}
			: null,
	});

	try {
		await csvWriter.writeRecords(records);

		logger.info("✅ Arquivo CSV gerado com sucesso", {
			fileName,
			recordsWritten: records.length,
			path: `${process.cwd()}/${fileName}`,
		});
	} catch (error) {
		logger.error("❌ Erro ao gerar arquivo CSV", {
			fileName,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
};

type BuildCsvInput = {
	files: TaskFile[];
	assignedTo: string;
	areaId: string;
	sprintId: string;
	itemContrato: string;
};

export type TaskRecord = {
	ID: string;
	"Work Item Type": "Task";
	Title: string;
	"Assigned To": string;
	State: "To Do" | "Done";
	"Area ID": string;
	"Iteration ID": string;
	"Item Contrato": string;
	"ID SPF": string;
	UST: number;
	Complexidade: string;
	Activity: "Development";
	Description: string;
	"Estimate Made": number;
	"Remaining Work": number;
	"Original Estimate": number;
};
