import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLocalModelDefinition, LOCAL_MODELS } from "./local-catalog.js";

interface ModelRecord { path: string; }
interface DownloadState {
  status: "idle" | "downloading" | "ready" | "error";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

const states = new Map<string, DownloadState>();
const downloads = new Map<string, Promise<string>>();

function modelsDir(workspacePath: string): string {
  return resolve(workspacePath, "models");
}

function manifestPath(workspacePath: string): string {
  return resolve(modelsDir(workspacePath), "manifest.json");
}

function readManifest(workspacePath: string): Record<string, ModelRecord> {
  try { return JSON.parse(readFileSync(manifestPath(workspacePath), "utf8")) as Record<string, ModelRecord>; }
  catch { return {}; }
}

function writeManifest(workspacePath: string, manifest: Record<string, ModelRecord>): void {
  mkdirSync(modelsDir(workspacePath), { recursive: true });
  writeFileSync(manifestPath(workspacePath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function getLocalModelPath(workspacePath: string, modelId: string): string | undefined {
  const path = readManifest(workspacePath)[modelId]?.path;
  return path && existsSync(path) ? path : undefined;
}

export function listLocalModelStatus(workspacePath: string) {
  return LOCAL_MODELS.map((model) => {
    const path = getLocalModelPath(workspacePath, model.id);
    const installedBytes = path ? statSync(path).size : 0;
    return {
      ...model,
      installed: Boolean(path),
      ...(states.get(`${workspacePath}:${model.id}`) ?? {
        status: path ? "ready" : "idle",
        progress: path ? 1 : 0,
        downloadedBytes: installedBytes,
        totalBytes: installedBytes,
      }),
    };
  });
}

export function downloadLocalModel(workspacePath: string, modelId: string): Promise<string> {
  const installed = getLocalModelPath(workspacePath, modelId);
  if (installed) return Promise.resolve(installed);
  const key = `${workspacePath}:${modelId}`;
  const current = downloads.get(key);
  if (current) return current;
  const model = getLocalModelDefinition(modelId);
  const task = (async () => {
    states.set(key, { status: "downloading", progress: 0, downloadedBytes: 0, totalBytes: 0 });
    try {
      mkdirSync(modelsDir(workspacePath), { recursive: true });
      const { createModelDownloader } = await import("node-llama-cpp");
      const downloader = await createModelDownloader({
        modelUri: model.modelUri,
        dirPath: modelsDir(workspacePath),
        showCliProgress: false,
        onProgress: ({ totalSize, downloadedSize }) => {
          states.set(key, {
            status: "downloading",
            progress: totalSize > 0 ? downloadedSize / totalSize : 0,
            downloadedBytes: downloadedSize,
            totalBytes: totalSize,
          });
        },
      });
      const path = await downloader.download();
      const manifest = readManifest(workspacePath);
      manifest[modelId] = { path };
      writeManifest(workspacePath, manifest);
      const totalBytes = statSync(path).size;
      states.set(key, { status: "ready", progress: 1, downloadedBytes: totalBytes, totalBytes });
      return path;
    } catch (error) {
      const previous = states.get(key);
      states.set(key, {
        status: "error",
        progress: previous?.progress ?? 0,
        downloadedBytes: previous?.downloadedBytes ?? 0,
        totalBytes: previous?.totalBytes ?? 0,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      downloads.delete(key);
    }
  })();
  downloads.set(key, task);
  return task;
}
