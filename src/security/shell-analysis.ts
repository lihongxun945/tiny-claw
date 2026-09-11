import parse from "bash-parser";

export interface ShellWord {
  type: "Word";
  text: string;
  expansion?: Array<{ type: string; parameter?: string; commandAST?: ShellNode }>;
}
export interface ShellRedirect {
  type: "Redirect";
  op: { text: string };
  file: ShellWord;
}
export interface ShellNode {
  type: string;
  async?: boolean;
  name?: ShellWord;
  suffix?: Array<ShellWord | ShellRedirect>;
  prefix?: Array<ShellWord | ShellRedirect>;
  commands?: ShellNode[];
  list?: ShellNode;
  redirections?: ShellRedirect[];
  left?: ShellNode;
  right?: ShellNode;
  op?: string;
}

/** The parser performs syntax analysis only; no shell is launched. */
export function parseShell(source: string): ShellNode {
  return parse(source) as ShellNode;
}
