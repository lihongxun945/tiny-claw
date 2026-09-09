/** Recognizes literal line-printing scripts, not the full sed language. */
export function isReadOnlySed(args: string[]): boolean {
  const scripts: string[] = [];
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (options && arg === "--") { options = false; continue; }
    if (options && /^-(?:[nEr]+)$/.test(arg)) continue;
    if (options && ["--quiet", "--silent", "--regexp-extended"].includes(arg)) continue;
    if (options && (arg === "-e" || arg === "--expression")) {
      const script = args[++index];
      if (script === undefined) return false;
      scripts.push(script);
    } else if (options && arg.startsWith("-e") && arg.length > 2) {
      scripts.push(arg.slice(2));
    } else if (options && arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
    } else if (options && arg.startsWith("-") && arg !== "-") {
      return false;
    } else if (scripts.length === 0) {
      scripts.push(arg);
    }
  }
  // Restrict the accepted grammar to p with optional numeric/end-of-file addresses.
  const print = /^(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?\s*)?p$/;
  return scripts.length > 0 && scripts.every(script => {
    const commands = script.split(/[;\n]/).map(part => part.trim()).filter(Boolean);
    return commands.length > 0 && commands.every(command => print.test(command));
  });
}
