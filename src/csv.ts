import type { z } from "zod";
import type { expectedOutputTask } from "./ai";

const writeHeader = () => {
  const headers = [
    "ID",
    "Work Item Type",
    "Title 2",
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

  return headers;
};

export const buildCsvFile = (
  files: z.infer<typeof expectedOutputTask>[],
  areaId: string,
  iterationId: string
) => {
  const tasks = files.map(({ tasks }) => tasks).flat();
  const outputTasks = tasks.map(
    (t) =>
      `,Task,${
        t.title
      },Ygor Azambuja <ygor.azambuja@infortechms.com.br>,To Do,${areaId},${iterationId},Item 1, 22,4,ÚNICA,Development,${t.description.replaceAll(
        ",",
        ""
      )}, 1,1`
  );

  const fileContent = [writeHeader(), [...outputTasks].join("\n")].join("\n");

  const currentDate = new Date();
  const formattedDate = `${currentDate.getDate()}-${
    currentDate.getMonth() + 1
  }-${currentDate.getHours()}-${currentDate.getMinutes()}`;
  Bun.write(`tasks-${formattedDate}.csv`, fileContent);
};
