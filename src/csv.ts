import { createObjectCsvWriter } from "csv-writer";
import type { z } from "zod";
import type { expectedOutputTask } from "./ai";
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

export const buildCsvFile = async ({
	files,
	assignedTo,
	areaId,
	sprintId,
	itemContrato,
}: BuildCsvInput) => {
	logger.info("📝 Iniciando geração do arquivo CSV");

	const tasks = files.flatMap(({ tasks }) => tasks);
	const currentDate = new Date();
	const formattedDate = `${currentDate.getDate()}-${
		currentDate.getMonth() + 1
	}-${currentDate.getHours()}-${currentDate.getMinutes()}`;

	const fileName = `tasks-${formattedDate}.csv`;

	logger.info("📊 Dados para CSV preparados", {
		totalFiles: files.length,
		totalTasks: tasks.length,
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

	const records = tasks.map((t) => ({
		ID: "",
		"Work Item Type": "Task",
		Title: sanitizeCsvText(t.title),
		"Assigned To": sanitizeCsvText(assignedTo),
		State: "To Do",
		"Area ID": areaId,
		"Iteration ID": sprintId,
		"Item Contrato": sanitizeCsvText(itemContrato),
		"ID SPF": 19,
		UST: 4,
		Complexidade: t.complexidade,
		Activity: "Development",
		Description: sanitizeCsvText(t.description),
		"Estimate Made": t.estimateMade,
		"Remaining Work": t.estimateMade,
		"Original Estimate": t.estimateMade,
	}));

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
	files: z.infer<typeof expectedOutputTask>[];
	assignedTo: string;
	areaId: string;
	sprintId: string;
	itemContrato: string;
};
