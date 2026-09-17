import { createHash } from "node:crypto";
import { createReadStream, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const platform = process.argv[2];
if (!["windows", "macos"].includes(platform)) throw new Error("Expected windows or macos");
const extension = platform === "windows" ? ".exe" : ".dmg";
const files = readdirSync("release").filter(name => name.endsWith(extension)).sort();
if (!files.length) throw new Error("No release installers found");
const lines = [];
for (const file of files) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join("release", file))) hash.update(chunk);
  lines.push(`${hash.digest("hex")}  ${file}`);
}
writeFileSync(`release/SHA256SUMS-${platform}.txt`, `${lines.join("\n")}\n`);
