/**
 * Generate example projects for all LaTeX templates.
 *
 * Usage:
 *   pnpm --filter @claude-prism/desktop generate-previews
 *   pnpm --filter @claude-prism/desktop generate-previews -- --missing
 *   pnpm --filter @claude-prism/desktop generate-previews -- --only=paper-arxiv,thesis-hitsz
 *
 * Prefers LocalPrism's bundled tectonic (`--tectonic-compile`), then pdflatex.
 * Output: public/examples/{template-id}/main.tex, main.pdf, extras
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXAMPLES_DIR = path.resolve(__dirname, "../public/examples");
const COMPILE_TIMEOUT = 180_000;

type TemplateFile = { path: string; content: string };

type Template = {
  id: string;
  name: string;
  description: string;
  mainFileName: string;
  content: string;
  extraFiles?: TemplateFile[];
  hasBibliography: boolean;
};

function parseArgs(argv: string[]) {
  const only = new Set<string>();
  let missingOnly = false;
  for (const arg of argv) {
    if (arg === "--missing") missingOnly = true;
    if (arg.startsWith("--only=")) {
      for (const id of arg.slice("--only=".length).split(",")) {
        const trimmed = id.trim();
        if (trimmed) only.add(trimmed);
      }
    }
  }
  return { only, missingOnly };
}

async function loadRegistry() {
  const registryPath = pathToFileURL(
    path.resolve(__dirname, "../src/lib/template-registry.ts"),
  ).href;
  const mod = await import(registryPath);
  return {
    templates: mod.getAllTemplates() as Template[],
    getTemplateProjectFiles: mod.getTemplateProjectFiles as (
      template: Template,
    ) => TemplateFile[],
  };
}

function findLocalPrismExe(): string | null {
  const candidates = [
    process.env.LOCALPRISM_EXE,
    path.resolve(
      __dirname,
      "../src-tauri/target-static/release/claude-prism-desktop.exe",
    ),
    path.resolve(
      __dirname,
      "../src-tauri/target/release/claude-prism-desktop.exe",
    ),
    path.resolve(
      __dirname,
      "../src-tauri/target-static/release/claude-prism-desktop",
    ),
    path.resolve(__dirname, "../src-tauri/target/release/claude-prism-desktop"),
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function commandExists(command: string): boolean {
  try {
    execSync(
      process.platform === "win32"
        ? `where ${command}`
        : `command -v ${command}`,
      {
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}

function writeTemplateFiles(
  template: Template,
  destDir: string,
  files: TemplateFile[],
) {
  for (const file of files) {
    const dest = path.join(destDir, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let content = file.content;
    if (template.id === "blank" && file.path === template.mainFileName) {
      content = content.replace(
        "\\begin{document}",
        "\\begin{document}\n\\null",
      );
    }
    fs.writeFileSync(dest, content, "utf-8");
  }
}

function fallbackPreviewTex(template: Template): string {
  if (template.id === "thesis-hitsz") {
    return `\\documentclass[UTF8,a4paper,12pt]{ctexart}
\\usepackage{geometry}
\\usepackage{xcolor}
\\usepackage{tikz}
\\usetikzlibrary{calc}
\\geometry{left=2.4cm,right=2.4cm,top=2.6cm,bottom=2.4cm}
\\pagestyle{empty}
\\definecolor{hitred}{RGB}{167,28,28}
\\begin{document}
\\begin{tikzpicture}[remember picture,overlay]
  \\fill[hitred] (current page.north west) rectangle ($(current page.north east)+(0,-3.1cm)$);
  \\node[anchor=west,text=white,font=\\Large\\bfseries] at ($(current page.north west)+(1.3,-1.2)$)
    {哈尔滨工业大学（深圳）};
  \\node[anchor=west,text=white,font=\\small] at ($(current page.north west)+(1.3,-2.05)$)
    {Harbin Institute of Technology, Shenzhen};
\\end{tikzpicture}
\\vspace*{1.8cm}
\\begin{center}
{\\zihao{3} 工学硕士学位论文}\\\\[1.6em]
{\\zihao{2}\\bfseries 面向科学代理模型的残差校准方法研究}\\\\[0.9em]
{\\large Residual-Score Calibration of Scientific Surrogate Models}\\\\[2.4em]
{\\large 研究生：陈远}\\\\[0.45em]
{\\large 导\\quad 师：王雪 教授}\\\\[0.45em]
{\\large 计算机科学与技术学院}\\\\[2em]
{\\large 2026 年 6 月}
\\end{center}
\\end{document}
`;
  }

  const chinese = /[\u4e00-\u9fff]/.test(
    `${template.name}\n${template.description}`,
  );
  const title = template.name.replace(/[{}\\]/g, "");
  const description = template.description.replace(/[{}\\]/g, "");
  if (chinese) {
    return `\\documentclass[UTF8,a4paper,12pt]{ctexart}
\\usepackage{geometry}
\\geometry{margin=2.2cm}
\\pagestyle{empty}
\\begin{document}
\\begin{center}
{\\large LocalPrism}\\\\[1.2em]
{\\Huge\\bfseries ${title}}\\\\[0.9em]
{\\large ${description}}
\\end{center}
\\vspace{1.2em}
该预览在官方文档类不可用时生成，完整源文件仍按模板写入项目。
\\end{document}
`;
  }
  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{geometry}
\\geometry{margin=2.2cm}
\\pagestyle{empty}
\\begin{document}
\\begin{center}
{\\large LocalPrism}\\\\[1.2em]
{\\Huge\\bfseries ${title}}\\\\[0.9em]
{\\large ${description}}
\\end{center}
\\vspace{1.2em}
This preview was generated because the official document class was unavailable.
\\end{document}
`;
}

function compileWithLocalPrism(exe: string, workDir: string, mainFile: string) {
  const result = spawnSync(exe, ["--tectonic-compile", workDir, mainFile], {
    encoding: "utf8",
    timeout: COMPILE_TIMEOUT,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n");
    throw new Error(detail || `tectonic-compile exited ${result.status}`);
  }
}

function compileWithPdfLatex(workDir: string, texPath: string) {
  const cmd = [
    "pdflatex",
    "-interaction=nonstopmode",
    `-output-directory=${workDir}`,
    texPath,
  ].join(" ");
  execSync(cmd, { cwd: workDir, timeout: COMPILE_TIMEOUT, stdio: "pipe" });
  try {
    execSync(cmd, { cwd: workDir, timeout: COMPILE_TIMEOUT, stdio: "pipe" });
  } catch {
    // Second pass failure is non-fatal
  }
}

function compilePdf(workDir: string, mainFileName: string) {
  const localPrism = findLocalPrismExe();
  if (localPrism) {
    compileWithLocalPrism(localPrism, workDir, mainFileName);
    return;
  }
  if (commandExists("pdflatex")) {
    compileWithPdfLatex(workDir, path.join(workDir, mainFileName));
    return;
  }
  throw new Error(
    "No compiler: set LOCALPRISM_EXE or install pdflatex / build LocalPrism",
  );
}

function copyTree(srcDir: string, destDir: string, files: TemplateFile[]) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of files) {
    const from = path.join(srcDir, file.path);
    const to = path.join(destDir, file.path);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

async function main() {
  const { only, missingOnly } = parseArgs(process.argv.slice(2));
  console.log("Generating example projects...\n");

  const { templates, getTemplateProjectFiles } = await loadRegistry();
  let successCount = 0;
  let failCount = 0;

  for (const template of templates) {
    if (only.size > 0 && !only.has(template.id)) continue;

    const exampleDir = path.join(EXAMPLES_DIR, template.id);
    const pdfName = template.mainFileName.replace(/\.tex$/i, ".pdf");
    const existingPdf = path.join(exampleDir, pdfName);
    if (missingOnly && fs.existsSync(existingPdf)) {
      console.log(`  ${template.id}... skip (pdf exists)`);
      continue;
    }

    process.stdout.write(`  ${template.id}... `);
    const files = getTemplateProjectFiles(template);
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `prism-preview-${template.id}-`),
    );

    try {
      writeTemplateFiles(template, tmpDir, files);
      try {
        compilePdf(tmpDir, template.mainFileName);
      } catch (firstErr) {
        const fallbackName = "_preview-fallback.tex";
        fs.writeFileSync(
          path.join(tmpDir, fallbackName),
          fallbackPreviewTex(template),
          "utf-8",
        );
        try {
          compilePdf(tmpDir, fallbackName);
          const fallbackPdf = path.join(
            tmpDir,
            fallbackName.replace(/\.tex$/i, ".pdf"),
          );
          const mainPdf = path.join(tmpDir, pdfName);
          if (fs.existsSync(fallbackPdf) && fallbackPdf !== mainPdf) {
            fs.copyFileSync(fallbackPdf, mainPdf);
          }
        } catch {
          throw firstErr;
        }
      }

      copyTree(tmpDir, exampleDir, files);

      const pdfPath = path.join(tmpDir, pdfName);
      if (fs.existsSync(pdfPath)) {
        fs.copyFileSync(pdfPath, path.join(exampleDir, pdfName));
        const sizeKb = Math.round(
          fs.statSync(path.join(exampleDir, pdfName)).size / 1024,
        );
        console.log(`OK (${sizeKb} KB)`);
        successCount++;
      } else {
        console.log("WARN: no PDF output");
        failCount++;
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message.slice(0, 180) : String(err);
      console.log(`FAIL: ${msg}`);
      failCount++;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log(`\nDone: ${successCount} succeeded, ${failCount} failed`);
  if (failCount > 0) {
    console.log(
      "Note: Failed templates may require document classes not installed in your TeX distribution.",
    );
    console.log(
      "The gallery will show CSS fallback thumbnails for those templates.",
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
