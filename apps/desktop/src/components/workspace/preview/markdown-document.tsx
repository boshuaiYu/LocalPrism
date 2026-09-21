import { type FC, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

import { resolveMarkdownAssetUrl } from "@/lib/markdown-preview-assets";
import { cn } from "@/lib/utils";

interface MarkdownDocumentProps {
  content: string;
  filePath?: string;
  className?: string;
}

function createDocumentComponents(filePath?: string): Components {
  return {
    a({ href, children, node: _node, ...props }) {
      const isExternal = /^https?:/i.test(href ?? "");
      return (
        <a
          {...props}
          href={href}
          {...(isExternal
            ? { target: "_blank", rel: "noreferrer noopener" }
            : {})}
        >
          {children}
        </a>
      );
    },
    img({ src, alt, node: _node, ...props }) {
      return (
        <img
          {...props}
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

      if (!isBlock) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }

      return (
        <div className="md-document-code" data-language={language || undefined}>
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
    table({ children, node: _node, ...props }) {
      return (
        <div className="md-document-table-wrap">
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
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
