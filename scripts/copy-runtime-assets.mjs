import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const target = resolve(root, "dist/prompts");
mkdirSync(target, { recursive: true });
cpSync(resolve(root, "src/prompts/default.md"), resolve(target, "default.md"));
cpSync(resolve(root, "src/prompts/sub_agent.md"), resolve(target, "sub_agent.md"));
