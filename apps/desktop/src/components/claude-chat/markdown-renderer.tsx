import { type FC, type ReactNode, memo, useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  PlusIcon,
  PlayIcon,
  LoaderIcon,
  CheckIcon,
  XIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import katex from "katex";
import "katex/dist/katex.min.css";

import { useDocumentStore } from "@/stores/document-store";
import {
  isOpenableChatHref,
  promoteChatCitations,
  transformChatUrl,
} from "@/lib/chat-citations";
import {
  canPreviewLatexBlock,
  normalizeChatMath,
  unwrapMathDelimiters,
} from "@/lib/chat-math";
import { cn } from "@/lib/utils";

// ─── Shell Detection ───

const SHELL_LANGUAGES = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "terminal",
  "console",
]);

function looksLikeShellCommand(code: string): boolean {
  const firstLine = code
    .trim()
    .split("\n")[0]
    .replace(/^[$#]\s*/, "")
    .trim();
  const prefixes = [
    "wget",
    "curl",
    "tlmgr",
    "apt",
    "brew",
    "npm",
    "pip",
    "sudo",
    "mkdir",
    "cd ",
    "cp ",
    "mv ",
    "rm ",
    "git ",
    "make",
    "tar ",
    "unzip",
    "latexmk",
    "pdflatex",
    "xelatex",
    "bibtex",
  ];
  return prefixes.some((p) => firstLine.startsWith(p));
}

function isShellCodeBlock(language: string, code: string): boolean {
  if (SHELL_LANGUAGES.has(language.toLowerCase())) return true;
  if (!language && looksLikeShellCommand(code)) return true;
  return false;
}

// ─── Markdown Renderer ───

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

interface MarkdownRendererProps {
  content: string;
  className?: string;
  preview?: boolean;
}

function MarkdownCode({
  className: codeClassName,
  children,
  node,
  preview = false,
  ...props
}: {
  className?: string;
  children?: ReactNode;
  node?: { position?: { start: { line: number }; end: { line: number } } };
  preview?: boolean;
}) {
  const match = /language-(\w+)/.exec(codeClassName || "");
  const language = match?.[1];
  const code = String(children).replace(/\n$/, "");
  const isBlock =
    node?.position && node.position.start.line !== node.position.end.line;

  if (!match && !isBlock) {
    return (
      <code
        className={cn("break-words [overflow-wrap:anywhere]", codeClassName)}
        {...props}
      >
        {children}
      </code>
    );
  }

  return <CodeBlock language={language || ""} code={code} preview={preview} />;
}

function MarkdownLink({
  href,
  children,
  node: _node,
  ...props
}: {
  href?: string;
  children?: ReactNode;
  node?: unknown;
}) {
  const url = transformChatUrl(href ?? "");
  const isExternal = isOpenableChatHref(url);

  const openSafeUrl = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!isExternal) return;
    void shellOpen(url).catch(() => undefined);
  };

  return (
    <a
      {...props}
      href={url || undefined}
      data-testid="chat-markdown-link"
      className="inline max-w-full break-all rounded-md border border-primary/20 bg-primary/10 px-1.5 py-px text-primary underline decoration-primary/45 underline-offset-2 transition-colors hover:bg-primary/15"
      onClick={openSafeUrl}
      onAuxClick={openSafeUrl}
    >
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS = {
  a: MarkdownLink,
  pre({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
  table({
    children,
    node: _node,
    ...props
  }: {
    children?: ReactNode;
    node?: unknown;
  }) {
    return (
      <div className="chat-markdown-table my-3 w-full max-w-full overflow-x-auto rounded-lg border border-border">
        <table
          className="m-0 w-max min-w-full border-collapse text-left text-sm"
          {...props}
        >
          {children}
        </table>
      </div>
    );
  },
  thead({
    children,
    node: _node,
    ...props
  }: {
    children?: ReactNode;
    node?: unknown;
  }) {
    return (
      <thead className="bg-muted/70" {...props}>
        {children}
      </thead>
    );
  },
  th({
    children,
    node: _node,
    ...props
  }: {
    children?: ReactNode;
    node?: unknown;
  }) {
    return (
      <th
        className="whitespace-nowrap border-border border-r border-b px-3 py-2 font-medium text-foreground last:border-r-0"
        {...props}
      >
        {children}
      </th>
    );
  },
  td({
    children,
    node: _node,
    ...props
  }: {
    children?: ReactNode;
    node?: unknown;
  }) {
    return (
      <td
        className="whitespace-nowrap border-border border-t border-r px-3 py-2 align-top text-foreground last:border-r-0"
        {...props}
      >
        {children}
      </td>
    );
  },
  hr({ node: _node, ...props }: { node?: unknown }) {
    return <hr className="my-5 border-border border-t" {...props} />;
  },
  code(props: {
    className?: string;
    children?: ReactNode;
    node?: { position?: { start: { line: number }; end: { line: number } } };
  }) {
    return <MarkdownCode {...props} />;
  },
};

export const MarkdownRenderer: FC<MarkdownRendererProps> = memo(
  ({ content, className, preview = false }) => {
    return (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={transformChatUrl}
        className={cn(
          "chat-markdown min-w-0 max-w-full break-words [overflow-wrap:anywhere]",
          className ?? "prose prose-sm dark:prose-invert max-w-none",
        )}
        components={
          preview
            ? {
                ...MARKDOWN_COMPONENTS,
                code(props) {
                  return <MarkdownCode {...props} preview />;
                },
              }
            : MARKDOWN_COMPONENTS
        }
      >
        {promoteChatCitations(normalizeChatMath(content))}
      </ReactMarkdown>
    );
  },
);

// ─── Code Block ───

type RunState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "running" }
  | { status: "done"; exitCode: number; stdout: string; stderr: string }
  | { status: "error"; message: string };

const LATEX_PREVIEW_CACHE_LIMIT = 100;
const latexPreviewCache = new Map<string, string | null>();

function latexPreviewHtml(code: string): string | null {
  const cached = latexPreviewCache.get(code);
  if (cached !== undefined) {
    latexPreviewCache.delete(code);
    latexPreviewCache.set(code, cached);
    return cached;
  }

  let html: string | null = null;
  if (canPreviewLatexBlock(code)) {
    try {
      html = katex.renderToString(unwrapMathDelimiters(code), {
        displayMode: true,
        throwOnError: true,
        strict: "ignore",
        trust: false,
      });
    } catch {
      html = null;
    }
  }

  latexPreviewCache.set(code, html);
  if (latexPreviewCache.size > LATEX_PREVIEW_CACHE_LIMIT) {
    const oldest = latexPreviewCache.keys().next().value;
    if (oldest !== undefined) latexPreviewCache.delete(oldest);
  }
  return html;
}

function LatexInsertButton({ onInsert }: { onInsert: () => void }) {
  return (
    <button
      type="button"
      onClick={onInsert}
      className="flex items-center gap-0.5 rounded bg-primary px-1.5 py-0.5 text-primary-foreground text-xs"
    >
      <PlusIcon className="size-3" />
      Insert
    </button>
  );
}

const CodeBlock: FC<{ language: string; code: string; preview?: boolean }> = ({
  language,
  code,
  preview = false,
}) => {
  const insertAtCursor = useDocumentStore((s) => s.insertAtCursor);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const normalizedLanguage = language.toLowerCase();
  const isLatexLang =
    normalizedLanguage === "latex" || normalizedLanguage === "tex";
  const isLatex = !preview && isLatexLang;
  const latexHtml = isLatexLang ? latexPreviewHtml(code) : null;
  const isShell = !preview && isShellCodeBlock(language, code);

  const [runState, setRunState] = useState<RunState>({ status: "idle" });

  const handleInsert = useCallback(() => {
    insertAtCursor(code);
  }, [insertAtCursor, code]);

  // Strip leading $ or # prompts for execution
  const cleanedCommand = code
    .split("\n")
    .map((line) => line.replace(/^\$\s*/, ""))
    .join("\n")
    .trim();

  const handleRun = useCallback(() => {
    setRunState({ status: "confirming" });
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!projectRoot) {
      setRunState({ status: "error", message: "No project open" });
      return;
    }
    setRunState({ status: "running" });
    try {
      const result = await invoke<{
        exit_code: number;
        stdout: string;
        stderr: string;
      }>("run_shell_command", { command: cleanedCommand, cwd: projectRoot });
      setRunState({
        status: "done",
        exitCode: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      // Refresh file tree to pick up any new/deleted files
      useDocumentStore
        .getState()
        .refreshFiles()
        .catch((err) => {
          console.error("Failed to refresh files:", err);
        });
    } catch (err: any) {
      setRunState({ status: "error", message: err?.message || String(err) });
    }
  }, [cleanedCommand, projectRoot]);

  const handleCancel = useCallback(() => {
    setRunState({ status: "idle" });
  }, []);

  if (latexHtml) {
    return (
      <div className="not-prose group relative my-2">
        <div
          data-testid="chat-latex-preview"
          className="chat-latex-preview max-w-full overflow-x-auto rounded-lg border border-border/70 bg-muted/30 px-3 py-1"
          dangerouslySetInnerHTML={{ __html: latexHtml }}
        />
        {isLatex && (
          <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <LatexInsertButton onInsert={handleInsert} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="not-prose group relative my-2">
      <pre className="chat-markdown-code max-w-full overflow-x-auto whitespace-pre rounded bg-muted p-3 text-sm [overflow-wrap:normal]">
        <code>{code}</code>
      </pre>

      {/* Hover-reveal buttons */}
      <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {isLatex && <LatexInsertButton onInsert={handleInsert} />}
        {isShell && runState.status === "idle" && (
          <button
            type="button"
            onClick={handleRun}
            className="flex items-center gap-0.5 rounded bg-green-600 px-1.5 py-0.5 text-white text-xs"
          >
            <PlayIcon className="size-3" />
            Run
          </button>
        )}
      </div>

      {/* Inline confirmation */}
      {runState.status === "confirming" && (
        <div className="mt-1 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
            <AlertTriangleIcon className="size-3.5 text-yellow-500" />
            <span className="text-xs">
              Run in{" "}
              <code className="rounded bg-muted px-1 text-xs">
                {projectRoot?.split(/[/\\]/).pop()}/
              </code>
            </span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleConfirm}
              className="flex items-center gap-1 rounded bg-green-600 px-2.5 py-1 text-white text-xs"
            >
              <PlayIcon className="size-3" />
              Run
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded bg-muted px-2.5 py-1 text-muted-foreground text-xs hover:bg-muted/80"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Running spinner */}
      {runState.status === "running" && (
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-border bg-[#1e1e2e] px-3 py-2 text-sm">
          <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
          <span className="font-mono text-muted-foreground text-xs">
            Running...
          </span>
        </div>
      )}

      {/* Command output */}
      {runState.status === "done" && (
        <CommandOutput
          exitCode={runState.exitCode}
          stdout={runState.stdout}
          stderr={runState.stderr}
        />
      )}

      {/* Error */}
      {runState.status === "error" && (
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
          <XIcon className="size-3.5" />
          {runState.message}
        </div>
      )}
    </div>
  );
};

// ─── Command Output ───

const CommandOutput: FC<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> = ({ exitCode, stdout, stderr }) => {
  const [expanded, setExpanded] = useState(true);
  const success = exitCode === 0;
  const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
  const truncated =
    output.length > 2000 ? `${output.slice(0, 2000)}\n...` : output;

  return (
    <div className="mt-1 rounded-lg border border-border bg-[#1e1e2e] text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2"
        onClick={() => setExpanded(!expanded)}
      >
        {success ? (
          <CheckIcon className="size-3.5 text-green-500" />
        ) : (
          <XIcon className="size-3.5 text-red-400" />
        )}
        <span
          className={`font-mono text-xs ${success ? "text-green-300" : "text-red-300"}`}
        >
          {success ? "Command completed" : `Exited with code ${exitCode}`}
        </span>
        <span className="ml-auto">
          {expanded ? (
            <ChevronDownIcon className="size-3.5 text-gray-500" />
          ) : (
            <ChevronRightIcon className="size-3.5 text-gray-500" />
          )}
        </span>
      </button>
      {expanded && truncated && (
        <div className="max-h-40 overflow-auto border-border/50 border-t px-3 py-2">
          <pre className="whitespace-pre-wrap font-mono text-gray-300 text-xs">
            {truncated}
          </pre>
        </div>
      )}
    </div>
  );
};
