import { isValidElement, type HTMLAttributes, type ReactNode } from "react";
import { highlightCode } from "../lib/syntax-highlight.js";

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

export default function SyntaxHighlightedPre({ children, ...props }: HTMLAttributes<HTMLPreElement>) {
  if (!isValidElement<CodeElementProps>(children)) {
    return <pre {...props}>{children}</pre>;
  }

  const code = String(children.props.children ?? "").replace(/\n$/, "");
  const language = /language-([^\s]+)/.exec(children.props.className ?? "")?.[1];
  const className = ["hljs", language ? `language-${language}` : ""].filter(Boolean).join(" ");

  return (
    <pre {...props}>
      <code
        className={className}
        dangerouslySetInnerHTML={{ __html: highlightCode(code, language) }}
      />
    </pre>
  );
}
