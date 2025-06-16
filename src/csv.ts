import type { z } from "zod";
import type { expectedOutputTask } from "./ai";
import { createObjectCsvWriter } from "csv-writer";
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
];

export const buildCsvFile = async ({
  files,
  assignedTo,
  areaId,
  sprintId,
}: BuildCsvInput) => {
  logger.info("📝 Iniciando geração do arquivo CSV");

  const tasks = files.map(({ tasks }) => tasks).flat();
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
    },
  });

  const csvWriter = createObjectCsvWriter({
    path: fileName,
    header: writeHeader().map((header) => ({ id: header, title: header })),
  });

  const records = tasks.map((t) => ({
    ID: "",
    "Work Item Type": "Task",
    Title: t.title,
    "Assigned To": assignedTo,
    State: "To Do",
    "Area ID": areaId,
    "Iteration ID": sprintId,
    "Item Contrato": "Item 1",
    "ID SPF": 19,
    UST: 4,
    Complexidade: "ÚNICA",
    Activity: "Development",
    Description: t.description,
    "Estimate Made": 1,
    "Remaining Work": 1,
    "Original Estimated": 1,
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
      path: process.cwd() + "/" + fileName,
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
};
