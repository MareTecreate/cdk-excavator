import { createReadStream } from "node:fs";
import { opendir } from "node:fs/promises";

import {
  JSON_INPUT_LIMITS,
  JsonInputBudget,
  JsonInputLimitError,
  JsonInputSyntaxError,
} from "@cdk-excavator/core";

export async function readJsonChunks(
  chunks: AsyncIterable<Uint8Array>,
  budget = new JsonInputBudget(),
): Promise<unknown> {
  const buffers: Buffer[] = [];
  for await (const chunk of chunks) {
    budget.addBytes(chunk.byteLength);
    buffers.push(Buffer.from(chunk));
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(buffers).toString("utf8"));
  } catch {
    throw new JsonInputSyntaxError();
  }
  budget.check(value);
  return value;
}

export async function readJsonFile(
  path: string,
  budget?: JsonInputBudget,
): Promise<unknown> {
  const stream = createReadStream(path);
  try {
    return await readJsonChunks(stream, budget);
  } finally {
    stream.destroy();
  }
}

export async function jsonFileNames(
  directory: string,
): Promise<readonly string[]> {
  const names: string[] = [];
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (names.length >= JSON_INPUT_LIMITS.collection)
      throw new JsonInputLimitError("collection");
    names.push(entry.name);
  }
  return names.sort();
}
