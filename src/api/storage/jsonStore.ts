import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const writeQueues = new Map<string, Promise<void>>();

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isMissingFileError(error)) {
      return fallback;
    }

    throw error;
  }
}

export async function writeJsonFile<T>(path: string, value: T): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();

  const next = previous.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  });

  writeQueues.set(path, next.catch(() => undefined));
  await next;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
