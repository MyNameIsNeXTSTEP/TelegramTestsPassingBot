import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const fileQueues = new Map<string, Promise<unknown>>();

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
  await withFileQueue(path, async () => {
    await writeJsonFileAtomic(path, value);
  });
}

export async function readJsonFileValidated<T>(
  path: string,
  fallback: T,
  validate: (value: unknown) => T,
): Promise<T> {
  const value = await readJsonFile<unknown>(path, fallback as unknown);
  return validate(value);
}

export async function updateJsonFileValidated<T>(params: {
  path: string;
  fallback: T;
  validate: (value: unknown) => T;
  update: (current: T) => T | Promise<T>;
}): Promise<T> {
  return withFileQueue(params.path, async () => {
    const current = await readJsonFileValidated(params.path, params.fallback, params.validate);
    const updated = await params.update(current);
    const next = params.validate(updated);
    await writeJsonFileAtomic(params.path, next);
    return next;
  });
}

async function withFileQueue<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  fileQueues.set(path, next);
  return next.finally(() => {
    if (fileQueues.get(path) === next) {
      fileQueues.delete(path);
    }
  });
}

async function writeJsonFileAtomic<T>(path: string, value: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
