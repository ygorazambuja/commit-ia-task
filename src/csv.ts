import type { z } from "zod";
import type { expectedOutputTask } from "./ai";
import { createObjectCsvWriter } from "csv-writer";

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
  const tasks = files.map(({ tasks }) => tasks).flat();
  const currentDate = new Date();
  const formattedDate = `${currentDate.getDate()}-${
    currentDate.getMonth() + 1
  }-${currentDate.getHours()}-${currentDate.getMinutes()}`;

  const csvWriter = createObjectCsvWriter({
    path: `tasks-${formattedDate}.csv`,
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
    "ID SPF": 22,
    UST: 4,
    Complexidade: "ÚNICA",
    Activity: "Development",
    Description: t.description,
    "Estimate Made": 1,
    "Remaining Work": 1,
  }));

  await csvWriter.writeRecords(records);
};

type BuildCsvInput = {
  files: z.infer<typeof expectedOutputTask>[];
  assignedTo: string;
  areaId: string;
  sprintId: string;
};
