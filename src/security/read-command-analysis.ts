const findFlags = new Set(["-a", "-and", "-o", "-or", "!", "-not", "(", ")", "-print", "-print0", "-ls", "-prune", "-quit", "-empty", "-depth", "-xdev", "-mount", "-true", "-false"]);
const findArguments = new Set(["-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-type", "-maxdepth", "-mindepth", "-mtime", "-mmin", "-size", "-user", "-group", "-perm", "-newer", "-printf"]);

export function isReadOnlyFind(args: string[]): boolean {
  let expression = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!expression && ["-H", "-L", "-P"].includes(arg)) continue;
    if (findFlags.has(arg)) expression = true;
    else if (findArguments.has(arg)) {
      expression = true;
      if (++index >= args.length) return false;
    } else if (expression || arg.startsWith("-")) return false;
  }
  return true;
}

export function isReadOnlyGit(args: string[]): boolean {
  const [command, ...options] = args;
  const flags = command === "status"
    ? new Set(["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--long", "-z", "--show-stash", "--untracked-files", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"])
    : command === "ls-files"
      ? new Set(["--cached", "-c", "--deleted", "-d", "--modified", "-m", "--others", "-o", "--ignored", "-i", "--exclude-standard", "--stage", "-s", "--unmerged", "-u", "--full-name", "-z"])
      : command === "rev-parse"
        ? new Set(["--show-toplevel", "--show-prefix", "--is-inside-work-tree", "--is-bare-repository", "--show-object-format"])
        : undefined;
  if (!flags) return false;
  for (const option of options) {
    if (option === "--" && command !== "rev-parse") return true;
    if (!flags.has(option)) return false;
  }
  return true;
}
