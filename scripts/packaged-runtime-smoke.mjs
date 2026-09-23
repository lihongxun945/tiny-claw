import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(resolve(process.argv[2], "package.json"));
const workspace = mkdtempSync(join(tmpdir(), "breeze-coder-native-"));
try {
  const lancedb = require("@lancedb/lancedb");
  const db = await lancedb.connect(join(workspace, "vectors"));
  const table = await db.createTable("smoke", [{ id: "test", vector: [1, 0], text: "memory" }]);
  assert.equal((await table.search([1, 0]).limit(1).toArray())[0].text, "memory");
  table.close();
  db.close();
  const { getLlama } = await import(pathToFileURL(require.resolve("node-llama-cpp")).href);
  const llama = await getLlama({ gpu: process.platform === "darwin" ? "auto" : false, build: "never" });
  await llama.dispose();
  console.log("Packaged LanceDB and llama native runtimes loaded successfully");
} finally { rmSync(workspace, { recursive: true, force: true }); }
