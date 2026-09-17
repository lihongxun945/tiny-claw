import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (process.env.GITHUB_REF_NAME !== `v${pkg.version}` || lock.version !== pkg.version || lock.packages[""].version !== pkg.version) {
  throw new Error("Release tag, package.json and package-lock.json versions must match");
}
console.log(`Release version verified: v${pkg.version}`);
