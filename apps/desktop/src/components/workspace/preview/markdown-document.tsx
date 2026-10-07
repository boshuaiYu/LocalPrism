import { type FC, type HTMLAttributes, type ReactNode, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

import { resolveMarkdownAssetUrl } from "@/lib/markdown-preview-assets";
import {
  markdownSourceDataAttributes,
  rehypeMarkdownSourcePositions,
} from "@/lib/markdown-source-position";
import { cn } from "@/lib/utils";

interface MarkdownDocumentProps {
  content: string;
  filePath?: string;
  className?: string;
}

type SourcedTag =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "p"
  | "ul"
  | "ol"
  | "li"
  | "blockquote"
  | "tr"
  | "th"
  | "td"
  | "thead"
  | "tbody"
  | "section"
  | "strong"
  | "em"
  | "del"
  | "sup";

function withSourcePosition(tag: SourcedTag) {
  function SourcedMarkdownBlock({
    node,
    children,
    ...props
  }: HTMLAttributes<HTMLElement> & {
    node?: unknown;
    children?: ReactNode;
  }) {
    const Tag = tag;
    return (
      <Tag {...props} {...markdownSourceDataAttributes(node)}>
        {children}
      </Tag>
    );
  }
  SourcedMarkdownBlock.displayName = `MarkdownSource(${tag})`;
  return SourcedMarkdownBlock;
}

function SourcedHr({
  node,
  children: _children,
  ...props
}: HTMLAttributes<HTMLHRElement> & {
  node?: unknown;
  children?: ReactNode;
}) {
  return <hr {...props} {...markdownSourceDataAttributes(node)} />;
}

const sourcedBlocks = {
  h1: withSourcePosition("h1"),
  h2: withSourcePosition("h2"),
  h3: withSourcePosition("h3"),
  h4: withSourcePosition("h4"),
  h5: withSourcePosition("h5"),
  h6: withSourcePosition("h6"),
  p: withSourcePosition("p"),
  ul: withSourcePosition("ul"),
  ol: withSourcePosition("ol"),
  li: withSourcePosition("li"),
  blockquote: withSourcePosition("blockquote"),
  hr: SourcedHr,
  tr: withSourcePosition("tr"),
  th: withSourcePosition("th"),
  td: withSourcePosition("td"),
  thead: withSourcePosition("thead"),
  tbody: withSourcePosition("tbody"),
  section: withSourcePosition("section"),
  strong: withSourcePosition("strong"),
  em: withSourcePosition("em"),
  del: withSourcePosition("del"),
  sup: withSourcePosition("sup"),
} satisfies Partial<Components>;

function createDocumentComponents(filePath?: string): Components {
  return {
    ...sourcedBlocks,
    a({ href, children, node, ...props }) {
      const isExternal = /^https?:/i.test(href ?? "");
      return (
        <a
          {...props}
          {...markdownSourceDataAttributes(node)}
          href={href}
          {...(isExternal
            ? { target: "_blank", rel: "noreferrer noopener" }
            : {})}
        >
          {children}
        </a>
      );
    },
    img({ src, alt, node, ...props }) {
      return (
        <img
          {...props}
          {...markdownSourceDataAttributes(node)}
          src={resolveMarkdownAssetUrl(src, filePath)}
          alt={alt ?? ""}
          loading="lazy"
        />
      );
    },
    input({ type, checked, node: _node, ...props }) {
      if (type === "checkbox") {
        return (
          <input
            type="checkbox"
            defaultChecked={Boolean(checked)}
            disabled
            readOnly
            tabIndex={-1}
            aria-hidden="true"
          />
        );
      }
      return <input type={type} {...props} />;
    },
    pre({ children }) {
      return <>{children}</>;
    },
    code({ className, children, node, ...props }) {
      const match = /language-(\w+)/.exec(className || "");
      const language = match?.[1];
      const isBlock =
        Boolean(language) ||
        (node?.position != null &&
          node.position.start.line !== node.position.end.line);
      const source = markdownSourceDataAttributes(node);

      if (!isBlock) {
        return (
          <code className={className} {...props} {...source}>
            {children}
          </code>
        );
      }

      return (
        <div
          className="md-document-code"
          data-language={language || undefined}
          {...source}
        >
          {language ? (
            <span className="md-document-code-lang">{language}</span>
          ) : null}
          <pre>
            <code className={className} {...props}>
              {String(children).replace(/\n$/, "")}
            </code>
          </pre>
        </div>
      );
    },
    table({ children, node, ...props }) {
      return (
        <div
          className="md-document-table-wrap"
          {...markdownSourceDataAttributes(node)}
        >
          <table {...props}>{children}</table>
        </div>
      );
    },
  };
}

export const MarkdownDocument: FC<MarkdownDocumentProps> = ({
  content,
  filePath,
  className,
}) => {
  const components = useMemo(
    () => createDocumentComponents(filePath),
    [filePath],
  );

  return (
    <div className={cn("md-document", className)} data-testid="md-document">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeMarkdownSourcePositions]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
