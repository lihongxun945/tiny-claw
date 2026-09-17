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

export function isReadOnlyGit(args: string[], hardenedDiff = false): boolean {
  const [command, ...options] = args;
  if (command === "branch") return options.length === 1 && options[0] === "--show-current";
  if (command === "log") {
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!;
      if (["--oneline", "--graph", "--all", "--decorate", "--no-decorate"].includes(option) || /^-\d+$/.test(option) || /^--max-count=\d+$/.test(option)) continue;
      if ((option === "-n" || option === "--max-count") && /^\d+$/.test(options[++i] ?? "")) continue;
      return false;
    }
    return true;
  }
  // Patch output can invoke configured helpers; only permit explicitly disabled helpers.
  if (command === "diff") {
    if (!hardenedDiff && (!options.includes("--no-ext-diff") || !options.includes("--no-textconv"))) return false;
    for (const option of options) {
      if (option === "--") return true;
      if (!["--no-ext-diff", "--no-textconv", "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--cached", "--staged", "--check", "-p"].includes(option) && (!hardenedDiff || option.startsWith("-"))) return false;
    }
    return true;
  }
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

/** A deliberately small AWK grammar: one print/printf of fields, literals and arithmetic. */
export function isReadOnlyAwk(args: string[]): boolean {
  const [script, ...files] = args;
  if (!script || files.some(file => file.startsWith("-") || file.includes("="))) return false;
  const body = /^\s*\{\s*(?:print|printf)\s+([\s\S]*?)\s*;?\s*\}\s*$/.exec(script)?.[1];
  if (!body) return false;
  // Consume whole tokens, so function calls, redirects, getline and assignments cannot slip through.
  const token = /\s+|"(?:[^"\\]|\\[\s\S])*"|\$(?:\d+|NF)|\d+(?:\.\d+)?|[(),+*/%.-]/y;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < body.length) {
    token.lastIndex = offset;
    const match = token.exec(body);
    if (!match) return false;
    if (match[0].trim()) tokens.push(match[0]);
    offset = token.lastIndex;
  }
  // Slash is division only after an operand, never an AWK regex opener that could hide code.
  let index = 0;
  const atom = (): boolean => {
    const current = tokens[index++];
    if (current === "+" || current === "-") return atom();
    if (current === "(") return expression() && tokens[index++] === ")";
    return !!current && /^(?:"|\$|\d)/.test(current);
  };
  const expression = (): boolean => {
    if (!atom()) return false;
    while (index < tokens.length && tokens[index] !== "," && tokens[index] !== ")") {
      if (["+", "-", "*", "/", "%"].includes(tokens[index]!)) index++;
      if (!atom()) return false;
    }
    return true;
  };
  if (!expression()) return false;
  while (tokens[index] === ",") { index++; if (!expression()) return false; }
  return index === tokens.length;
}
