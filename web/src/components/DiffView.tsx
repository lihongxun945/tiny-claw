import { useMemo } from "react";
import { highlightCode } from "../lib/syntax-highlight.js";

interface Props {
  text: string;
}

const META_PREFIXES = [
  "diff --git",
  "index ",
  "--- ",
  "+++ ",
  "rename ",
  "copy ",
  "old mode",
  "new mode",
  "deleted file",
  "new file",
  "similarity index",
  "dissimilarity index",
];

function isMetaLine(line: string): boolean {
  const trimmed = line.trimStart();
  return META_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

type DiffLineType = "header" | "add" | "del" | "ctx";

function classifyLine(line: string): DiffLineType {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("@@")) return "header";
  if (trimmed.startsWith("+")) return "add";
  if (trimmed.startsWith("-")) return "del";
  return "ctx";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function styleForType(type: DiffLineType): React.CSSProperties {
  switch (type) {
    case "header":
      return { color: "#569cd6", fontWeight: 500 };
    case "add":
      return { background: "rgba(35, 134, 54, 0.15)", color: "#7ee787" };
    case "del":
      return { background: "rgba(248, 81, 73, 0.15)", color: "#ffa198" };
    default:
      return {};
  }
}

function prefixForType(type: DiffLineType): string {
  switch (type) {
    case "add":
      return "+";
    case "del":
      return "-";
    default:
      return "";
  }
}

export default function DiffView({ text }: Props) {
  const rendered = useMemo(() => {
    const lines = text.split("\n").filter((line) => !isMetaLine(line));

    return lines.map((line, i) => {
      const type = classifyLine(line);
      const style = styleForType(type);
      const prefix = prefixForType(type);

      if (type === "header") {
        return (
          <span key={i} className="diff-line" style={style}>
            {escapeHtml(line)}
            {"\n"}
          </span>
        );
      }

      // Strip diff prefix (+/-/ ) for syntax highlighting
      const code = type === "ctx" ? line.slice(1) : line.slice(1);
      const highlighted = highlightCode(code);

      return (
        <span key={i} className="diff-line" style={style}>
          {prefix && (
            <span
              className="diff-prefix"
              style={{ userSelect: "none", marginRight: 0 }}
            >
              {prefix}
            </span>
          )}
          <span dangerouslySetInnerHTML={{ __html: highlighted }} />
          {"\n"}
        </span>
      );
    });
  }, [text]);

  return <pre className="diff-view">{rendered}</pre>;
}
