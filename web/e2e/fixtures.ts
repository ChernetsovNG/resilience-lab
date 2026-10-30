import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExperimentFile } from "../src/api/apiTypes";

/** Copies a short UI fixture into an existing, test-owned workspace directory. */
export async function copySmallExperiment(directory: string, name = "retry-storm.experiment.json", window = "50ms"): Promise<ExperimentFile> {
  const source = resolve("../examples/retry-storm");
  for (const file of ["retry-storm.model.json", "retry-storm.layout.json"]) {
    await copyFile(resolve(source, file), resolve(directory, file));
  }
  const experiment: ExperimentFile = JSON.parse(await readFile(resolve(source, "retry-storm.experiment.json"), "utf8"));
  // Layout scenarios need only six windows; range-loading tests request 3ms for 100 windows.
  experiment.execution = { ...experiment.execution, replications: 2, measurement: "300ms", window };
  experiment.faults = experiment.faults?.map(fault => ({ ...fault, from: "60ms", to: "210ms" }));
  await writeFile(resolve(directory, name), JSON.stringify(experiment));
  return experiment;
}
