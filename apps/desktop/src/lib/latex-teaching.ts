/**
 * Curated explanations for common LaTeX constructs and compiler messages.
 * The floating teach card reads this catalog locally. Ask AI is a separate
 * action and does not change these lessons.
 */
import type { UiLanguage } from "@/lib/i18n";

type Localized = { en: string; zh: string };

export type TeachLessonKind = "construct" | "error" | "guide";

export type TeachLessonRef =
  | { kind: "construct"; id: string; label: string }
  | { kind: "error"; id: string; label: string; detail: string }
  | { kind: "guide"; id: "empty-project" };

export interface TeachLesson {
  id: string;
  kind: TeachLessonKind;
  tone: "info" | "error";
  tag: string;
  title: string;
  banner: string;
  what: string;
  points: string[];
  snippet: string | null;
  insertable: boolean;
  source: string | null;
}

export interface SelectionTeachInput {
  selected: string;
  line: string;
  selectionStartInLine: number;
  selectionEndInLine: number;
}

export const EMPTY_PROJECT_LESSON: TeachLessonRef = {
  kind: "guide",
  id: "empty-project",
};

interface LessonCopy {
  title: Localized;
  banner: Localized;
  what: Localized;
  points: Localized[];
  snippet?: Localized;
  insertable?: boolean;
  tone?: "info" | "error";
  source?: Localized;
}

function L(en: string, zh: string): Localized {
  return { en, zh };
}

function points(...rows: Array<[string, string]>): Localized[] {
  return rows.map(([en, zh]) => L(en, zh));
}

const SELECTED = L("Selected {{tag}}", "已选中 {{tag}}");

function lesson(
  title: Localized,
  what: Localized,
  rows: Localized[],
  extra?: Partial<LessonCopy>,
): LessonCopy {
  return {
    title,
    banner: extra?.banner ?? SELECTED,
    what,
    points: rows,
    snippet: extra?.snippet,
    insertable: extra?.insertable,
    tone: extra?.tone,
    source: extra?.source,
  };
}

const CONSTRUCTS: Record<string, LessonCopy> = {
  figure: lesson(
    L("Floating figure", "浮动图片环境"),
    L(
      "figure keeps an image, its caption, and a cross-reference label together. LaTeX places this float nearby so a large graphic does not slice a paragraph in half.",
      "figure 把图片、说明文字（caption）和交叉引用标签绑在一起。它是浮动体：排版引擎会在附近找位置，避免大图把段落从中间截断。",
    ),
    points(
      [
        "[htbp] is a placement preference: here, top, bottom, or a float page. It is not a guarantee, so the figure may drift.",
        "[htbp] 是位置偏好：h 当前位置、t 页顶、b 页底、p 单独成页。这只是偏好，图可能会「漂」到附近。",
      ],
      [
        "Use \\centering inside the float. A center environment adds extra vertical space.",
        "浮动体里用 \\centering 居中。再套一层 center 环境会多出垂直空白。",
      ],
      [
        "\\includegraphics needs \\usepackage{graphicx} in the preamble.",
        "\\includegraphics 需要在导言区写 \\usepackage{graphicx}。",
      ],
      [
        "Put \\caption before \\label, or \\ref may point at the wrong number.",
        "先 \\caption 再 \\label，否则 \\ref 可能指到别的编号。",
      ],
    ),
    {
      snippet: L(
        "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{fig.pdf}\n  \\caption{Example plot.}\n  \\label{fig:demo}\n\\end{figure}",
        "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{fig.pdf}\n  \\caption{示意说明。}\n  \\label{fig:demo}\n\\end{figure}",
      ),
      source: L("graphicx", "graphicx"),
    },
  ),
  table: lesson(
    L("Floating table", "浮动表格"),
    L(
      "table is the floating wrapper. The grid itself is a tabular (or similar) environment inside it, usually with a caption and a label.",
      "table 是浮动外壳。真正的网格写在里面的 tabular（或同类环境）里，通常再加 caption 和 label。",
    ),
    points(
      [
        "[htbp] is the same placement hint used by figure.",
        "[htbp] 和 figure 一样，只是放置偏好。",
      ],
      [
        "Caption above the grid is the usual table convention.",
        "表格习惯把 \\caption 放在网格上方。",
      ],
      [
        "A wide table can use \\small or a smaller column spec, not a smaller font for the whole document.",
        "表太宽时，缩小表格本身（例如 \\small 或更紧的列格式），不必改全文的字号。",
      ],
    ),
    {
      snippet: L(
        "\\begin{table}[htbp]\n  \\centering\n  \\caption{Sample rows.}\n  \\label{tab:demo}\n  \\begin{tabular}{ll}\n    \\hline\n    Item & Value \\\\\n    \\hline\n    A & 1 \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}",
        "\\begin{table}[htbp]\n  \\centering\n  \\caption{示例数据。}\n  \\label{tab:demo}\n  \\begin{tabular}{ll}\n    \\hline\n    项目 & 数值 \\\\\n    \\hline\n    A & 1 \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}",
      ),
    },
  ),
  tabular: lesson(
    L("Aligned columns", "表格网格"),
    L(
      "tabular builds the rows and columns. It does not float by itself; put it in table when it should move with a caption.",
      "tabular 负责行列。它自己不会浮动；需要标题并允许挪位置时，再放进 table。",
    ),
    points(
      [
        "The argument such as {llr} is one letter per column: l, c, r, or p{width}.",
        "{llr} 这类参数每个字母是一列：l 左、c 中、r 右，p{宽度} 是定宽段落。",
      ],
      [
        "& separates cells. \\\\ ends a row. A literal percent sign in a cell must be written \\%.",
        "& 分隔单元格，\\\\ 结束一行。单元格里的百分号要写成 \\%。",
      ],
      [
        "hline or booktabs rules (\\toprule, \\midrule, \\bottomrule) draw the lines.",
        "横线用 \\hline，或 booktabs 的 \\toprule、\\midrule、\\bottomrule。",
      ],
    ),
  ),
  equation: lesson(
    L("Displayed equation", "单行公式"),
    L(
      "equation puts one formula on its own line and numbers it. The starred form equation* (amsmath) has no number.",
      "equation 把一条公式单独成行并编号。带星号的 equation*（需要 amsmath）不编号。",
    ),
    points(
      [
        "Inside the environment you are already in math mode. Do not add another pair of $.",
        "环境内部已经是数学模式，不要再套一层 $。",
      ],
      [
        "\\label goes inside the environment, after the formula.",
        "\\label 放在环境内部、公式之后。",
      ],
      [
        "For several aligned lines, use align instead of stacking equation environments.",
        "多行需要对齐时用 align，不要叠好几个 equation。",
      ],
    ),
    {
      snippet: L(
        "\\begin{equation}\n  E = mc^{2}\n  \\label{eq:energy}\n\\end{equation}",
        "\\begin{equation}\n  E = mc^{2}\n  \\label{eq:energy}\n\\end{equation}",
      ),
      source: L("amsmath", "amsmath"),
    },
  ),
  align: lesson(
    L("Aligned equations", "多行对齐公式"),
    L(
      "align (amsmath) lines up several formulas at &. Each row ends with \\\\. It numbers every row unless you use align* or \\notag.",
      "align（amsmath）用 & 对齐多行公式，行末写 \\\\。默认每行都编号；不编号用 align*，或在某一行加 \\notag。",
    ),
    points(
      [
        "Put & immediately before the relation you want aligned, often =.",
        "& 放在要对齐的关系符前面，通常是 =。",
      ],
      [
        "Do not leave a blank line inside align. A blank line ends a paragraph and breaks math mode.",
        "align 里面不要空行。空行会结束段落，数学模式会断掉。",
      ],
      [
        "Load amsmath in the preamble: \\usepackage{amsmath}.",
        "导言区需要 \\usepackage{amsmath}。",
      ],
    ),
    {
      snippet: L(
        "\\begin{align}\n  a &= b + c \\label{eq:sum} \\\\\n  d &= e \\notag\n\\end{align}",
        "\\begin{align}\n  a &= b + c \\label{eq:sum} \\\\\n  d &= e \\notag\n\\end{align}",
      ),
      source: L("amsmath", "amsmath"),
    },
  ),
  includegraphics: lesson(
    L("Including an image", "插入图片"),
    L(
      "\\includegraphics inserts a picture file. The width is usually a fraction of \\linewidth so the graphic follows the current column.",
      "\\includegraphics 插入图片文件。宽度通常写成 \\linewidth 的比例，这样图片会跟着当前栏宽走。",
    ),
    points(
      [
        "The file path is relative to the main TeX file, unless \\graphicspath says otherwise.",
        "路径相对主 tex 文件，除非用 \\graphicspath 另指定。",
      ],
      [
        "You may omit the extension and let graphicx try pdf, png, and jpg. If you write an extension, that file must exist.",
        "扩展名可以省略，graphicx 会尝试 pdf、png、jpg。写了扩展名就必须真实存在。",
      ],
      [
        "This command belongs in the document body, most often inside figure.",
        "这条命令写在正文里，最常见是放在 figure 中。",
      ],
    ),
    {
      snippet: L(
        "\\includegraphics[width=0.8\\linewidth]{fig.pdf}",
        "\\includegraphics[width=0.8\\linewidth]{fig.pdf}",
      ),
      source: L("graphicx", "graphicx"),
    },
  ),
  caption: lesson(
    L("Caption", "图表标题"),
    L(
      "\\caption sets the numbered title of a figure or table. The number is what \\ref prints.",
      "\\caption 是图或表的编号标题。\\ref 印出来的就是这个编号。",
    ),
    points(
      [
        "Use it inside figure or table, not in ordinary paragraphs.",
        "写在 figure 或 table 里面，不要写在普通段落里。",
      ],
      [
        "Place \\label after \\caption in the same float.",
        "在同一个浮动体里，\\label 放在 \\caption 之后。",
      ],
      [
        "A short optional argument, \\caption[list entry]{full text}, is what the list of figures stores.",
        "可选参数 \\caption[目录短题]{完整标题} 会进入图表目录。",
      ],
    ),
  ),
  label: lesson(
    L("Cross-reference label", "交叉引用标签"),
    L(
      "\\label records the current number so \\ref can print it later. The label name is for you; readers never see it.",
      "\\label 记下当前位置的编号，供后面的 \\ref 使用。标签名只给你自己看，不会印出来。",
    ),
    points(
      [
        "Put it after the command that creates the number: \\caption, \\section, or an equation.",
        "放在产生编号的命令之后：\\caption、\\section 或公式环境。",
      ],
      [
        "A prefix such as fig:, tab:, eq:, or sec: keeps names from colliding.",
        "用 fig:、tab:、eq:、sec: 这类前缀，避免重名。",
      ],
      [
        "A new label often needs a second compile before the number appears.",
        "新建的标签常常要再编译一次，编号才会出现。",
      ],
    ),
  ),
  ref: lesson(
    L("Cross-reference", "交叉引用"),
    L(
      "\\ref prints the number stored by \\label. \\eqref adds parentheses and is meant for equations.",
      "\\ref 印出 \\label 记下的编号。\\eqref 会带括号，适合公式。",
    ),
    points(
      [
        "The name must match the label exactly, including the prefix.",
        "名字必须和 label 完全一致，包括前缀。",
      ],
      [
        "Undefined references usually mean a typo, a missing label, or that you still need another compile.",
        "引用未定义，多半是拼写不一致、没有 label，或还需要再编译一次。",
      ],
      [
        "Write Figure~\\ref{fig:demo} so the number does not break onto the next line alone.",
        "写成「图~\\ref{fig:demo}」，避免编号单独掉到下一行。",
      ],
    ),
    {
      snippet: L(
        "See Figure~\\ref{fig:demo} and equation~\\eqref{eq:energy}.",
        "见图~\\ref{fig:demo} 与式~\\eqref{eq:energy}。",
      ),
    },
  ),
  cite: lesson(
    L("Citation", "引用文献"),
    L(
      "\\cite{key} points at an entry in the bibliography. The key is the name you chose in the .bib file, not the title.",
      "\\cite{key} 指向参考文献里的一条。key 是 .bib 里你起的名字，不是文章标题。",
    ),
    points(
      [
        "Several keys can share one command: \\cite{alpha,beta}.",
        "多个文献可以写在一起：\\cite{alpha,beta}。",
      ],
      [
        "BibTeX needs \\bibliography{refs} (no .bib extension) and a style. biblatex uses \\addbibresource{refs.bib}.",
        "BibTeX 用 \\bibliography{refs}（不要写 .bib 后缀）和参考文献样式。biblatex 则用 \\addbibresource{refs.bib}。",
      ],
      [
        "A new citation often needs one extra compile before the number or author appears.",
        "新加的引用常常要再编译一次，编号或作者名才会出现。",
      ],
    ),
    {
      snippet: L("\\cite{knuth1984}", "\\cite{knuth1984}"),
    },
  ),
  bibliography: lesson(
    L("Bibliography", "参考文献"),
    L(
      "The bibliography is the list of works you cite. BibTeX reads a .bib file; a thebibliography environment is a hand-written list.",
      "参考文献是你引用的文献列表。BibTeX 读取 .bib 文件；thebibliography 环境则是手写列表。",
    ),
    points(
      [
        "For BibTeX, \\bibliographystyle and \\bibliography belong near the end of the document.",
        "用 BibTeX 时，\\bibliographystyle 和 \\bibliography 放在文末附近。",
      ],
      [
        "The .bib file lives in the project. Citation keys must match \\cite.",
        ".bib 文件放在工程里，条目的 key 要和 \\cite 一致。",
      ],
      [
        "If the list stays empty, compile again so the citation data can be picked up.",
        "列表仍是空的话，再编译一次，让引用数据被读进来。",
      ],
    ),
  ),
  section: lesson(
    L("Section heading", "章节标题"),
    L(
      "\\section, \\subsection, and \\chapter start a numbered part of the document. The starred form, such as \\section*, has no number and does not go in the table of contents.",
      "\\section、\\subsection、\\chapter 开始文档里带编号的一部分。带星号的 \\section* 不编号，也不进目录。",
    ),
    points(
      [
        "article has sections, not chapters. report and book have chapters.",
        "article 用 section，没有 chapter。report 和 book 才有 chapter。",
      ],
      [
        "Put \\label immediately after the heading when you want to refer to it.",
        "需要引用这一节时，把 \\label 紧挨着标题写在后面。",
      ],
      [
        "A fragile command inside a heading sometimes needs \\protect, or a short optional argument for the table of contents.",
        "标题里如果有易碎命令，可以加 \\protect，或给目录写一个可选短标题。",
      ],
    ),
    {
      snippet: L(
        "\\section{Methods}\n\\label{sec:methods}",
        "\\section{方法}\n\\label{sec:methods}",
      ),
    },
  ),
  documentclass: lesson(
    L("Document class", "文档类"),
    L(
      "\\documentclass is the first line that matters. It chooses the skeleton: article for a short paper, report or book for chapters, or a publisher class.",
      "\\documentclass 是真正起作用的第一行。它决定骨架：短文用 article，有章的文稿用 report 或 book，期刊则用出版社的类。",
    ),
    points(
      [
        "Options sit in brackets: \\documentclass[12pt]{article}.",
        "选项写在方括号里：\\documentclass[12pt]{article}。",
      ],
      [
        "It belongs at the top, before \\usepackage.",
        "放在文件最上方，位于 \\usepackage 之前。",
      ],
      [
        "A class file that cannot be found usually means the name is misspelled or the class is not installed.",
        "找不到类文件时，多半是名字拼错，或本机没有安装这个类。",
      ],
    ),
  ),
  usepackage: lesson(
    L("Loading a package", "加载宏包"),
    L(
      "\\usepackage loads extra commands. It belongs in the preamble, after \\documentclass and before \\begin{document}.",
      "\\usepackage 用来加载额外命令。它写在导言区：\\documentclass 之后、\\begin{document} 之前。",
    ),
    points(
      [
        "Options go in brackets: \\usepackage[utf8]{inputenc}.",
        "选项写在方括号里：\\usepackage[utf8]{inputenc}。",
      ],
      [
        "You can load several packages at once, but options then apply to each of them.",
        "可以一次写多个宏包，但方括号里的选项会作用到其中每一个。",
      ],
      [
        "hyperref is usually loaded late, after packages that it needs to patch.",
        "hyperref 通常较晚加载，放在它需要改写的宏包之后。",
      ],
    ),
    {
      snippet: L(
        "\\usepackage{graphicx}\n\\usepackage{amsmath}",
        "\\usepackage{graphicx}\n\\usepackage{amsmath}",
      ),
    },
  ),
  itemize: lesson(
    L("Bullet list", "无序列表"),
    L(
      "itemize is a list of bullet points. Each entry starts with \\item.",
      "itemize 是圆点列表。每一条都以 \\item 开头。",
    ),
    points(
      [
        "\\item is only valid inside itemize, enumerate, or description.",
        "\\item 只能写在 itemize、enumerate 或 description 里面。",
      ],
      [
        "Lists can nest. The bullet style changes at each level.",
        "列表可以嵌套，每一层的符号会变。",
      ],
      [
        "Leave the list with \\end{itemize} before ordinary paragraphs.",
        "回到普通段落后之前，要先 \\end{itemize}。",
      ],
    ),
    {
      snippet: L(
        "\\begin{itemize}\n  \\item First point\n  \\item Second point\n\\end{itemize}",
        "\\begin{itemize}\n  \\item 第一点\n  \\item 第二点\n\\end{itemize}",
      ),
    },
  ),
  enumerate: lesson(
    L("Numbered list", "编号列表"),
    L(
      "enumerate numbers its items. The counter is automatic; you do not type the numbers.",
      "enumerate 会给条目编号。编号是自动的，不用自己写数字。",
    ),
    points(
      ["Each entry still starts with \\item.", "每一条仍然以 \\item 开头。"],
      [
        "The enumitem package can change the label, for example to (1) or Step 1.",
        "enumitem 宏包可以改编号样式，例如 (1) 或「步骤 1」。",
      ],
      [
        "Do not use enumerate when the order does not matter; that is what itemize is for.",
        "顺序无所谓时用 itemize，不要用 enumerate。",
      ],
    ),
    {
      snippet: L(
        "\\begin{enumerate}\n  \\item First\n  \\item Second\n\\end{enumerate}",
        "\\begin{enumerate}\n  \\item 第一步\n  \\item 第二步\n\\end{enumerate}",
      ),
    },
  ),
  centering: lesson(
    L("Centering", "居中"),
    L(
      "\\centering centers the following material until the group or environment ends. Inside figure and table it is the usual choice.",
      "\\centering 会让后面的内容居中，直到当前分组或环境结束。在 figure 和 table 里通常用它。",
    ),
    points(
      [
        "It is a declaration, not a command that takes the text as an argument.",
        "它是一条声明，不是把正文当成参数的命令。",
      ],
      [
        "Prefer it to the center environment inside floats.",
        "浮动体内部优先用它，而不是 center 环境。",
      ],
      [
        "A following blank line or paragraph still starts at the left after the group ends.",
        "分组结束后，下一段会回到左对齐。",
      ],
    ),
  ),
  center: lesson(
    L("Center environment", "center 环境"),
    L(
      "center centers a block and adds vertical space around it. For a float, \\centering is usually tighter.",
      "center 环境把一块内容居中，并在上下加垂直空白。浮动体里通常更适合 \\centering。",
    ),
    points(
      [
        "Use it for a short centered paragraph, title block, or similar.",
        "适合一小段需要居中的文字或标题块。",
      ],
      [
        "Do not wrap every figure in center.",
        "不必给每个 figure 再包一层 center。",
      ],
    ),
  ),
  footnote: lesson(
    L("Footnote", "脚注"),
    L(
      "\\footnote{text} prints a marker in the line and the note at the bottom of the page.",
      "\\footnote{文字} 在行内放一个标记，并把注文印在页底。",
    ),
    points(
      [
        "The argument can hold several sentences, but not a blank line.",
        "参数里可以有好几句，但不能有空行。",
      ],
      [
        "Footnotes inside tables and headings are fragile. A \\footnotemark / \\footnotetext pair is the usual escape.",
        "表格和标题里的脚注很容易出问题。常用的办法是 \\footnotemark 配 \\footnotetext。",
      ],
    ),
  ),
  textbf: lesson(
    L("Bold text", "粗体"),
    L(
      "\\textbf{...} sets its argument in bold. It is for a word or a short phrase, not a whole section.",
      "\\textbf{...} 把参数设成粗体。适合一个词或短语，不适合整节。",
    ),
    points(
      [
        "Section headings are already styled by the class. You rarely need \\textbf there.",
        "章节标题的字重由文档类决定，标题里很少需要再加 \\textbf。",
      ],
      [
        "In math, \\mathbf or \\boldsymbol is the bold command, not \\textbf.",
        "数学模式里用 \\mathbf 或 \\boldsymbol，而不是 \\textbf。",
      ],
    ),
  ),
  textit: lesson(
    L("Italic text", "斜体"),
    L(
      "\\textit{...} sets its argument in italics and corrects the space after the italic word.",
      "\\textit{...} 把参数设成斜体，并修正斜体后面的间距。",
    ),
    points(
      [
        "Use \\emph when you mean emphasis. The class can redefine emphasis; \\textit always means italic.",
        "表示强调时用 \\emph。文档类可以重定义强调；\\textit 则始终是斜体。",
      ],
      [
        "Nested \\emph switches back to upright. Nested \\textit does not.",
        "嵌套的 \\emph 会变回正体。嵌套的 \\textit 不会。",
      ],
    ),
  ),
  emph: lesson(
    L("Emphasis", "强调"),
    L(
      "\\emph{...} emphasizes its argument. In running text that is usually italic, and a nested emphasis returns to upright.",
      "\\emph{...} 强调参数。在正文里通常是斜体；再嵌套一层会回到正体。",
    ),
    points(
      [
        "Prefer it to \\textit when the point is emphasis rather than a type style.",
        "目的是强调而不是指定字体时，优先用它，而不是 \\textit。",
      ],
      ["It takes one argument in braces.", "它只有一个花括号参数。"],
    ),
  ),
  input: lesson(
    L("Input another file", "插入另一个文件"),
    L(
      "\\input{chapters/methods} pastes that file in place, as if you had typed it here. It does not start a new page.",
      "\\input{chapters/methods} 把那个文件插到当前位置，效果和直接写在这里一样。它不会另起一页。",
    ),
    points(
      [
        "The path is relative to the main file. The .tex extension is optional.",
        "路径相对主文件。.tex 扩展名可以省略。",
      ],
      [
        "The included file should not repeat \\documentclass or \\begin{document}.",
        "被插入的文件不要再写 \\documentclass 或 \\begin{document}。",
      ],
      [
        "Use \\include when you want a chapter that can be compiled alone with \\includeonly.",
        "希望按章单独编译（\\includeonly）时，用 \\include。",
      ],
    ),
  ),
  include: lesson(
    L("Include a chapter file", "按章引入文件"),
    L(
      "\\include{chapter1} inserts a file and starts it on a new page. It is meant for chapters, not for a sentence or a figure.",
      "\\include{chapter1} 会引入文件，并让它从新的一页开始。它适合章节，不适合一句话或一张图。",
    ),
    points(
      [
        "\\includeonly{chapter1,chapter2} in the preamble compiles just those chapters.",
        "导言区的 \\includeonly{chapter1,chapter2} 可以只编译列出的章。",
      ],
      [
        "Do not \\include a file that itself \\include others. Nested includes are not allowed.",
        "不要在被 include 的文件里再 \\include。嵌套是不允许的。",
      ],
      [
        "For a fragment with no page break, use \\input.",
        "不需要分页的片段用 \\input。",
      ],
    ),
  ),
  newcommand: lesson(
    L("New command", "自定义命令"),
    L(
      "\\newcommand{\\name}{expansion} defines a shortcut. If the name already exists, use \\renewcommand.",
      "\\newcommand{\\名字}{展开内容} 定义一个简写。名字已经存在时用 \\renewcommand。",
    ),
    points(
      [
        "An optional argument count, \\newcommand{\\cmd}[1]{#1}, creates parameters #1, #2, and so on.",
        "\\newcommand{\\cmd}[1]{#1} 里的 [1] 表示有一个参数，正文里写成 #1。",
      ],
      [
        "Define commands in the preamble so the whole document can see them.",
        "定义写在导言区，全文才能使用。",
      ],
      [
        "Names are letters only. \\newcommand{\\my cmd} is not a valid name.",
        "命令名只能是字母。\\newcommand{\\my cmd} 这种带空格的名字是无效的。",
      ],
    ),
    {
      snippet: L(
        "\\newcommand{\\R}{\\mathbb{R}}",
        "\\newcommand{\\R}{\\mathbb{R}}",
      ),
    },
  ),
  item: lesson(
    L("List item", "列表项"),
    L(
      "\\item starts one entry of itemize, enumerate, or description. Outside a list it is an error.",
      "\\item 开始 itemize、enumerate 或 description 里的一条。写在列表外面会报错。",
    ),
    points(
      [
        "description uses an optional label: \\item[Term] explanation.",
        "description 用可选标签：\\item[术语] 解释。",
      ],
      [
        "The text of the item can hold paragraphs and even a nested list.",
        "条目里可以有段落，也可以再嵌套一个列表。",
      ],
    ),
  ),
  maketitle: lesson(
    L("Title block", "标题区"),
    L(
      "\\maketitle prints the title block from \\title, \\author, and \\date. It does not invent those fields.",
      "\\maketitle 把 \\title、\\author 和 \\date 排成标题区。这些字段需要你自己先写好。",
    ),
    points(
      [
        "Set \\title and \\author in the preamble or just before \\maketitle.",
        "\\title 和 \\author 写在导言区，或紧挨在 \\maketitle 之前。",
      ],
      [
        "\\maketitle itself goes after \\begin{document}.",
        "\\maketitle 本身要写在 \\begin{document} 之后。",
      ],
      [
        "article prints the title at the top of the first page. A titlepage class option uses a separate page.",
        "article 把标题放在首页上方。类选项 titlepage 会单独占一页。",
      ],
    ),
    {
      snippet: L(
        "\\title{A Short Note}\n\\author{Ada Lovelace}\n\\date{\\today}\n\\maketitle",
        "\\title{一份短文}\n\\author{作者}\n\\date{\\today}\n\\maketitle",
      ),
    },
  ),
  abstract: lesson(
    L("Abstract", "摘要"),
    L(
      "abstract is the summary environment used by article and similar classes. It sits just after the title block.",
      "abstract 是 article 等文档类的摘要环境。它紧挨在标题区之后。",
    ),
    points(
      [
        "Write it after \\maketitle and before the first \\section.",
        "写在 \\maketitle 之后、第一个 \\section 之前。",
      ],
      [
        "Some publisher classes rename or replace this environment. Follow the template if you are using one.",
        "有的期刊模板会换掉这个环境。如果工程来自模板，就按模板来。",
      ],
    ),
    {
      snippet: L(
        "\\begin{abstract}\n  One paragraph on the result.\n\\end{abstract}",
        "\\begin{abstract}\n  用一段话说明结果。\n\\end{abstract}",
      ),
    },
  ),
  document: lesson(
    L("Document body", "正文环境"),
    L(
      "\\begin{document} starts the text readers see. Everything before it is the preamble: the class, packages, and settings.",
      "\\begin{document} 之后才是读者看见的正文。在它之前是导言区：文档类、宏包和设置。",
    ),
    points(
      [
        "There is exactly one document environment, closed by \\end{document}.",
        "全文只有一对，用 \\end{document} 结束。",
      ],
      [
        "Text before \\begin{document} is an error, not a hidden preface.",
        "写在 \\begin{document} 之前的正文不是隐藏前言，而是错误。",
      ],
      [
        "Nothing after \\end{document} is read.",
        "\\end{document} 之后的内容不会被读入。",
      ],
    ),
  ),
  quote: lesson(
    L("Quotation", "引文"),
    L(
      "quote indents a short quotation. It is ordinary text, not a citation command.",
      "quote 把一小段引文缩进排版。它是正文环境，不是 \\cite。",
    ),
    points(
      [
        "Use it for a paragraph you are quoting, then continue in the normal margin.",
        "用来放引用的一段话，结束后回到正常页边。",
      ],
      [
        "A bibliographic citation is still \\cite, not this environment.",
        "文献引用仍然用 \\cite，不是这个环境。",
      ],
    ),
  ),
  verbatim: lesson(
    L("Verbatim text", "原样输出"),
    L(
      "verbatim prints its body exactly, including backslashes and spaces. Commands inside it are not executed.",
      "verbatim 会原样印出里面的内容，包括反斜杠和空格。里面的命令不会执行。",
    ),
    points(
      [
        "You cannot hide the end of the environment inside a macro. \\end{verbatim} must appear as itself.",
        "不能把结束标记藏进宏里。\\end{verbatim} 必须原样出现。",
      ],
      [
        "For code with highlighting, listings or minted are the usual packages.",
        "需要语法高亮时，常用 listings 或 minted。",
      ],
    ),
  ),
  minipage: lesson(
    L("Minipage", "小页"),
    L(
      "minipage is a box of a fixed width that can hold paragraphs, a graphic, or a small table. It does not float.",
      "minipage 是一个固定宽度的盒子，里面可以有段落、图片或小表。它不会浮动。",
    ),
    points(
      [
        "The width argument is required: \\begin{minipage}{0.45\\linewidth}.",
        "必须写宽度：\\begin{minipage}{0.45\\linewidth}。",
      ],
      [
        "Two minipages side by side can place a figure next to text.",
        "两个 minipage 并排，可以把图和文字放在同一行。",
      ],
      [
        "Footnotes inside a minipage stay in that box unless you use \\footnotemark.",
        "minipage 里的脚注默认留在盒子底部，除非改用 \\footnotemark。",
      ],
    ),
  ),
  href: lesson(
    L("Hyperlink", "超链接"),
    L(
      "\\href{url}{text} and \\url{url} come from hyperref. The first shows different text; the second prints the address.",
      "\\href{网址}{文字} 和 \\url{网址} 来自 hyperref。前者显示另一段文字，后者把地址本身印出来。",
    ),
    points(
      [
        "Load hyperref in the preamble, usually after other packages.",
        "在导言区加载 hyperref，通常放在其他宏包之后。",
      ],
      [
        "Special characters in a raw URL are safer in \\url than typed by hand.",
        "网址里的特殊字符用 \\url 比手写更稳妥。",
      ],
    ),
    {
      snippet: L(
        "\\href{https://example.edu}{the lab page}",
        "\\href{https://example.edu}{实验室主页}",
      ),
      source: L("hyperref", "hyperref"),
    },
  ),
  math: lesson(
    L("Math mode", "数学模式"),
    L(
      "$...$ is inline math. \\[...\\] or equation is display math, on its own line. Commands such as \\frac and \\alpha only work in math mode.",
      "$...$ 是行内公式。\\[...\\] 或 equation 是独立成行的展示公式。\\frac、\\alpha 这类命令只在数学模式里有效。",
    ),
    points(
      [
        "Every $ must have a partner. A missing dollar is a very common error.",
        "每个 $ 都要有配对。漏掉美元符号是很常见的错误。",
      ],
      [
        "Do not leave a blank line inside display math.",
        "展示公式里面不要留空行。",
      ],
      [
        "Use \\text{...} (amsmath) for a word inside a formula.",
        "公式里的文字用 \\text{...}（amsmath）。",
      ],
    ),
    {
      snippet: L(
        "Inline $a^{2}+b^{2}=c^{2}$.\n\\[\n  \\frac{1}{2}mv^{2}\n\\]",
        "行内 $a^{2}+b^{2}=c^{2}$。\n\\[\n  \\frac{1}{2}mv^{2}\n\\]",
      ),
      source: L("amsmath", "amsmath"),
    },
  ),
  environment: lesson(
    L("Environment", "环境"),
    L(
      "{{tag}} begins or ends an environment. The body sits between \\begin{name} and \\end{name}, and the two names must match.",
      "{{tag}} 用来开始或结束一个环境。内容写在 \\begin{名字} 和 \\end{名字} 之间，两边的名字必须一致。",
    ),
    points(
      [
        "A star is part of the name: figure* and figure are different.",
        "星号也是名字的一部分：figure* 和 figure 不是同一个环境。",
      ],
      [
        "If the name is unknown, a package is probably missing from the preamble.",
        "如果提示环境未定义，多半是导言区少加载了宏包。",
      ],
      [
        "Floats (figure, table) may move. Boxes such as minipage stay where you wrote them.",
        "figure、table 会浮动。minipage 这类盒子则留在你写的位置。",
      ],
    ),
  ),
  command: lesson(
    L("Command", "宏命令"),
    L(
      "{{tag}} is a LaTeX command. Commands start with a backslash. Optional arguments use brackets, and required arguments use braces.",
      "{{tag}} 是一条 LaTeX 命令。命令以反斜杠开头。可选参数用方括号，必选参数用花括号。",
    ),
    points(
      [
        "A command name is letters only. The next non-letter ends the name.",
        "命令名只含字母，遇到第一个非字母就结束。",
      ],
      [
        "If LaTeX says the command is undefined, check the spelling and the package that should define it.",
        "如果提示命令未定义，先核对拼写，再看该不该加载某个宏包。",
      ],
      [
        "Spaces after a command name are swallowed. \\LaTeX document needs a \\  or {} when you want a space.",
        "命令名后面的空格会被吃掉。想保留空格时写成 \\LaTeX{} 或加一个控制空格。",
      ],
    ),
  ),
};

const ERROR_BANNER = L("{{tag}}", "{{tag}}");

const ERRORS: Record<string, LessonCopy> = {
  "file-not-found": lesson(
    L("Missing file", "找不到文件"),
    L(
      "The compiler looked for {{detail}} and did not find it. The figure environment is often fine; the path, extension, or capitalization is not.",
      "编译器没有找到 {{detail}}。figure 环境本身常常没问题，对不上的是路径、扩展名或大小写。",
    ),
    points(
      [
        "Put the file in the project, or on a path listed in \\graphicspath{{figures/}}.",
        "把文件放进工程，或放进 \\graphicspath{{figures/}} 列出的目录。",
      ],
      [
        "If you wrote an extension, that exact file must exist. Linux treats Miss.png and miss.png as different names.",
        "写了扩展名就必须有这个文件。在 Linux 上，Miss.png 和 miss.png 不是同一个名字。",
      ],
      [
        "An error is only one way to open this panel. Selecting the command explains it too.",
        "报错只是打开讲解的入口之一。选中命令同样会讲。",
      ],
    ),
    {
      banner: L("Cannot find {{detail}}", "找不到 {{detail}}"),
      tone: "error",
      snippet: L(
        "\\includegraphics[width=0.8\\linewidth]{figures/plot.pdf}",
        "\\includegraphics[width=0.8\\linewidth]{figures/plot.pdf}",
      ),
      source: L("graphicx", "graphicx"),
    },
  ),
  "package-not-found": lesson(
    L("Missing package", "找不到宏包"),
    L(
      "LaTeX could not open the package file {{detail}}. \\usepackage asks for a .sty file by that name.",
      "LaTeX 打不开宏包文件 {{detail}}。\\usepackage 会按这个名字去找 .sty 文件。",
    ),
    points(
      ["Check the package name for a typo.", "先看宏包名字有没有拼写错误。"],
      [
        "A minimal TeX install may not include every package. The name still has to match a file TeX can see.",
        "精简的 TeX 安装未必带齐所有宏包。名字必须对应 TeX 能找到的文件。",
      ],
      [
        "Package options that the package does not know also stop the run, but those say “unused option” or “unknown option”, not “not found”.",
        "宏包不认识的选项也会让编译停下来，但那种提示是未知选项，不是找不到文件。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  "undefined-control": lesson(
    L("Undefined command", "未定义的命令"),
    L(
      "LaTeX reached a command it does not know{{detail}}. The usual causes are a typo or a package that was never loaded.",
      "LaTeX 遇到了不认识的命令{{detail}}。最常见的原因是拼写错误，或忘了 \\usepackage。",
    ),
    points(
      [
        "Compare the spelling with the real command. \\incldegraphics is missing a letter; the command is \\includegraphics.",
        "对照正确拼写。\\incldegraphics 少了字母，正确命令是 \\includegraphics。",
      ],
      [
        "If the command comes from a package, load that package in the preamble.",
        "命令若来自宏包，就在导言区加载那个宏包。",
      ],
      [
        "A command you invented must be defined with \\newcommand before it is used.",
        "自己起的命令要先 \\newcommand，再使用。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  "missing-dollar": lesson(
    L("Missing math shift", "数学模式不配对"),
    L(
      "TeX inserted a $ because math and text got mixed. A subscript, a Greek command, or a \\frac appeared outside math mode, or a $ was left open.",
      "TeX 补了一个 $，因为数学和正文混在一起了。下标、希腊字母或 \\frac 出现在数学模式之外，或者有一个 $ 没有闭上。",
    ),
    points(
      [
        "Wrap inline math in a pair of dollar signs.",
        "行内公式用成对的美元符号包起来。",
      ],
      [
        "Display math uses \\[ ... \\] or an equation environment, not a single $.",
        "独立公式用 \\[ ... \\] 或 equation，不要只写一个 $。",
      ],
      [
        "A money amount in text can be written \\$ so it is not read as math.",
        "正文里的金额写成 \\$，才不会被当成数学模式。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  "env-mismatch": lesson(
    L("Mismatched environment", "环境没有成对"),
    L(
      "A \\begin and its \\end use different names. {{detail}}",
      "\\begin 和 \\end 的名字不一致。{{detail}}",
    ),
    points(
      [
        "The names must match exactly, including a star.",
        "名字必须完全一致，星号也要一致。",
      ],
      [
        "Close the inner environment before the outer one.",
        "先结束里面的环境，再结束外面的。",
      ],
      [
        "An extra \\end{document} usually means some earlier environment was never closed.",
        "多出来的 \\end{document} 通常说明前面有环境没关上。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  "undefined-environment": lesson(
    L("Unknown environment", "未定义的环境"),
    L(
      "\\begin asked for an environment that is not defined. {{detail}}",
      "\\begin 使用了一个还没有定义的环境。{{detail}}",
    ),
    points(
      ["Check the environment name for a typo.", "先核对环境名字的拼写。"],
      [
        "align, equation*, and similar names need \\usepackage{amsmath}.",
        "align、equation* 这类名字需要 \\usepackage{amsmath}。",
      ],
      [
        "A custom environment is defined with \\newenvironment before use.",
        "自定义环境要先 \\newenvironment，再使用。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  "missing-begin-document": lesson(
    L("Missing document body", "缺少正文开始"),
    L(
      "LaTeX saw text that belongs in the document body, but \\begin{document} has not appeared yet.",
      "LaTeX 看见了属于正文的文字，但 \\begin{document} 还没有出现。",
    ),
    points(
      [
        "Packages and \\newcommand stay above \\begin{document}. Paragraphs stay below it.",
        "宏包和 \\newcommand 放在 \\begin{document} 上面。段落放在它下面。",
      ],
      [
        "A stray character in the preamble is enough to trigger this.",
        "导言区里多出来的一个字符就足以触发这条错误。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  "citation-undefined": lesson(
    L("Unknown citation", "引用未定义"),
    L(
      "No bibliography entry matches this key. {{detail}}",
      "参考文献里没有这个 key。{{detail}}",
    ),
    points(
      [
        "The key in \\cite must match the .bib entry exactly.",
        "\\cite 里的 key 必须和 .bib 条目完全一致。",
      ],
      [
        "The project needs a bibliography command that actually loads that file.",
        "工程里要有真正加载该文件的参考文献命令。",
      ],
      [
        "Run compile again. Citation numbers are filled in on a later pass.",
        "再编译一次。引用编号要到后面一轮才会填上。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  "reference-undefined": lesson(
    L("Unknown reference", "交叉引用未定义"),
    L(
      "\\ref found no \\label with this name. {{detail}}",
      "\\ref 没有找到同名的 \\label。{{detail}}",
    ),
    points(
      [
        "The label name must match, including fig: or sec:.",
        "标签名必须一致，包括 fig: 或 sec: 这类前缀。",
      ],
      [
        "Place \\label after \\caption or the heading, not before it.",
        "\\label 要放在 \\caption 或标题之后，不要放在前面。",
      ],
      [
        "A brand-new label needs another compile.",
        "刚写上的 label 需要再编译一次。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  "emergency-stop": lesson(
    L("Emergency stop", "紧急停止"),
    L(
      "TeX gave up. This line is usually the consequence of an earlier error, not a separate mistake.",
      "TeX 停止继续处理了。这一行通常是前面某条错误的结果，而不是另一处独立的笔误。",
    ),
    points(
      [
        "Read the first error above this one. Fixing that often clears the stop.",
        "先看这条上面的第一条错误。修好它，停止提示常常会一起消失。",
      ],
      [
        "A missing file or a missing \\begin{document} is a common cause.",
        "找不到文件，或缺少 \\begin{document}，都是常见原因。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  runaway: lesson(
    L("Runaway argument", "参数没有结束"),
    L(
      "A command kept reading because a closing brace never arrived. TeX then swallowed far more text than you intended.",
      "某个命令一直读下去，是因为右花括号没有出现。TeX 会把后面远远多出来的文字都吞进参数。",
    ),
    points(
      [
        "Count the braces in the command named by the log.",
        "按日志里点名的那条命令，数一数花括号。",
      ],
      [
        "A blank line inside a short argument, such as \\section or \\caption, often starts this.",
        "\\section 或 \\caption 这类短参数里如果出现空行，经常会变成这条错误。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  "misplaced-alignment": lesson(
    L("Alignment tab outside a table", "对齐符号用错了地方"),
    L(
      "& separates cells in tabular and formulas in align. Outside those environments it is an error.",
      "& 在 tabular 里分隔单元格，在 align 里对齐公式。写在这些环境外面就会报错。",
    ),
    points(
      [
        "A literal ampersand in a sentence is \\&.",
        "句子里的 & 符号要写成 \\&。",
      ],
      [
        "If you meant a table, the & has to sit inside tabular.",
        "如果本意是表格，& 必须写在 tabular 里面。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  "extra-brace": lesson(
    L("Extra closing brace", "多余的右花括号"),
    L(
      "There is a } with no matching opening brace. An earlier { may also be missing, so the counts no longer agree.",
      "出现了一个没有左花括号与之配对的 }。也可能是更早的地方少了一个 {，两边的数量对不上。",
    ),
    points(
      [
        "Check the command just above the reported line.",
        "先看报错行上面那条命令的花括号。",
      ],
      [
        "Environments use \\begin and \\end, not an extra } to close them.",
        "环境用 \\begin 和 \\end 关闭，不是多写一个 }。",
      ],
    ),
    { banner: ERROR_BANNER, tone: "error" },
  ),
  generic: lesson(
    L("Compiler message", "编译器提示"),
    L(
      "The message is: {{detail}}. It comes from the compiler or the editor check. Start at the reported line, then look at braces, environments, and packages.",
      "提示原文是：{{detail}}。它来自编译器或编辑器检查。先看它指出的那一行，再核对花括号、环境是否成对，以及宏包有没有加载。",
    ),
    points(
      [
        "The first error in a log is the one to fix. Later lines are often fallout.",
        "日志里的第一条错误才是要先修的。后面的行常常是连锁反应。",
      ],
      [
        "Selecting the nearby command opens a separate explanation of that construct.",
        "选中附近的命令，会另外讲解那个写法。",
      ],
      [
        "This panel does not send the message to AI chat.",
        "这个面板不会把提示发给 AI 对话。",
      ],
    ),
    { banner: L("{{detail}}", "{{detail}}"), tone: "error" },
  ),
};

const GUIDES: Record<string, LessonCopy> = {
  "empty-project": lesson(
    L("A minimal document", "一份最小的文稿"),
    L(
      "A LaTeX file has a preamble and a body. The preamble holds \\documentclass and \\usepackage. The body, between \\begin{document} and \\end{document}, is what you are writing.",
      "一份 LaTeX 文稿分成导言区和正文。导言区放 \\documentclass 和 \\usepackage。正文在 \\begin{document} 和 \\end{document} 之间，那才是你要写的内容。",
    ),
    points(
      [
        "article fits a short note. A journal template replaces the class with its own.",
        "短文用 article 就够。期刊模板会换成它自己的文档类。",
      ],
      [
        "Do not put paragraphs in the preamble. Do not put \\usepackage in the body.",
        "段落不要写进导言区，\\usepackage 也不要写进正文。",
      ],
      [
        "Compile to see the PDF. Select a command, or open an error, when you want an explanation beside the editor.",
        "编译后在旁边看 PDF。想看讲解时，选中一条命令，或点开一条报错。",
      ],
    ),
    {
      banner: L("The file is still almost empty", "这份文稿几乎还是空的"),
      snippet: L(
        "\\section{Introduction}\n\\label{sec:intro}\n\nStart the first paragraph here.",
        "\\section{引言}\n\\label{sec:intro}\n\n从这里写下第一段。",
      ),
    },
  ),
};

const ENV_TO_ID: Record<string, string> = {
  figure: "figure",
  table: "table",
  tabular: "tabular",
  tabularx: "tabular",
  longtable: "table",
  equation: "equation",
  displaymath: "equation",
  gather: "equation",
  multline: "equation",
  align: "align",
  aligned: "align",
  flalign: "align",
  eqnarray: "align",
  itemize: "itemize",
  enumerate: "enumerate",
  description: "itemize",
  abstract: "abstract",
  document: "document",
  center: "center",
  quote: "quote",
  quotation: "quote",
  verbatim: "verbatim",
  lstlisting: "verbatim",
  thebibliography: "bibliography",
  minipage: "minipage",
};

const CMD_TO_ID: Record<string, string> = {
  includegraphics: "includegraphics",
  graphicspath: "includegraphics",
  caption: "caption",
  label: "label",
  ref: "ref",
  eqref: "ref",
  pageref: "ref",
  autoref: "ref",
  cite: "cite",
  citep: "cite",
  citet: "cite",
  citeauthor: "cite",
  parencite: "cite",
  textcite: "cite",
  bibliography: "bibliography",
  bibliographystyle: "bibliography",
  addbibresource: "bibliography",
  printbibliography: "bibliography",
  section: "section",
  subsection: "section",
  subsubsection: "section",
  chapter: "section",
  paragraph: "section",
  part: "section",
  documentclass: "documentclass",
  usepackage: "usepackage",
  centering: "centering",
  footnote: "footnote",
  textbf: "textbf",
  textit: "textit",
  emph: "emph",
  input: "input",
  include: "include",
  newcommand: "newcommand",
  renewcommand: "newcommand",
  newenvironment: "environment",
  item: "item",
  maketitle: "maketitle",
  title: "maketitle",
  author: "maketitle",
  date: "maketitle",
  href: "href",
  url: "href",
};

const MATH_COMMANDS = new Set([
  "frac",
  "dfrac",
  "tfrac",
  "sqrt",
  "sum",
  "prod",
  "int",
  "iint",
  "oint",
  "lim",
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "theta",
  "lambda",
  "mu",
  "pi",
  "sigma",
  "omega",
  "phi",
  "psi",
  "infty",
  "partial",
  "nabla",
  "cdot",
  "times",
  "leq",
  "geq",
  "neq",
  "approx",
  "equiv",
  "left",
  "right",
  "mathbf",
  "mathrm",
  "mathbb",
  "mathcal",
  "overline",
  "hat",
  "bar",
  "vec",
  "sin",
  "cos",
  "tan",
  "log",
  "ln",
  "exp",
  "text",
]);

const ERROR_TAGS: Record<string, string> = {
  "file-not-found": "! File not found",
  "package-not-found": "! Package not found",
  "undefined-control": "! Undefined control sequence",
  "missing-dollar": "! Missing $ inserted",
  "env-mismatch": "! Environment mismatch",
  "undefined-environment": "! Undefined environment",
  "missing-begin-document": "! Missing \\begin{document}",
  "citation-undefined": "! Citation undefined",
  "reference-undefined": "! Reference undefined",
  "emergency-stop": "! Emergency stop",
  runaway: "! Runaway argument",
  "misplaced-alignment": "! Misplaced alignment tab",
  "extra-brace": "! Extra }",
};

const ERROR_RULES: Array<{ id: string; test: (message: string) => boolean }> = [
  {
    id: "package-not-found",
    test: (message) =>
      /\.(?:sty|cls)\b/i.test(message) && /not found|找不到/i.test(message),
  },
  {
    id: "citation-undefined",
    test: (message) => /citation/i.test(message) && /undefined/i.test(message),
  },
  {
    id: "reference-undefined",
    test: (message) =>
      /\breference\b/i.test(message) && /undefined/i.test(message),
  },
  {
    id: "undefined-control",
    test: (message) => /undefined control sequence/i.test(message),
  },
  {
    id: "missing-dollar",
    test: (message) => /missing \$ inserted/i.test(message),
  },
  {
    id: "env-mismatch",
    test: (message) =>
      /\\begin\{[^}]+\} ended by|ended by \\end/i.test(message),
  },
  {
    id: "undefined-environment",
    test: (message) => /environment .+ undefined/i.test(message),
  },
  {
    id: "missing-begin-document",
    test: (message) => /missing \\begin\{document\}/i.test(message),
  },
  {
    id: "runaway",
    test: (message) => /runaway argument/i.test(message),
  },
  {
    id: "misplaced-alignment",
    test: (message) => /misplaced alignment tab/i.test(message),
  },
  {
    id: "extra-brace",
    test: (message) => /too many ['’}]|extra ['’]?\}/i.test(message),
  },
  {
    id: "file-not-found",
    test: (message) =>
      /not found|cannot find|no such file|找不到/i.test(message),
  },
  {
    id: "emergency-stop",
    test: (message) => /emergency stop/i.test(message),
  },
];

function constructPattern(): RegExp {
  return /\\begin\{([A-Za-z@*]+)\}(?:\[[^\]]*\])?|\\end\{([A-Za-z@*]+)\}|\\([A-Za-z@]+)/g;
}

function bareName(name: string): string {
  return name.endsWith("*") ? name.slice(0, -1) : name;
}

function refForEnvironment(name: string, closing: boolean): TeachLessonRef {
  const id = ENV_TO_ID[bareName(name)] ?? "environment";
  const label = `${closing ? "\\end" : "\\begin"}{${name}}`;
  return { kind: "construct", id, label };
}

function refForCommand(name: string): TeachLessonRef {
  if (name === "begin" || name === "end") {
    return { kind: "construct", id: "environment", label: `\\${name}` };
  }
  const id = MATH_COMMANDS.has(name) ? "math" : (CMD_TO_ID[name] ?? "command");
  return { kind: "construct", id, label: `\\${name}` };
}

function matchConstructText(text: string): TeachLessonRef | null {
  const match = constructPattern().exec(text);
  if (match) {
    if (match[1]) return refForEnvironment(match[1], false);
    if (match[2]) return refForEnvironment(match[2], true);
    if (match[3]) return refForCommand(match[3]);
  }
  if (/\\\[|\\\]|\\\(|\\\)/.test(text)) {
    return { kind: "construct", id: "math", label: "\\[...\\]" };
  }
  if (text.includes("$") && text.trim().length <= 80) {
    return { kind: "construct", id: "math", label: "$...$" };
  }
  return null;
}

export function lessonRefForSelection(
  input: SelectionTeachInput,
): TeachLessonRef | null {
  if (!input.selected.trim() || input.selected.length > 4000) return null;
  const direct = matchConstructText(input.selected);
  if (direct) return direct;
  if (input.selected.trim().length > 240) return null;

  const start = input.selectionStartInLine;
  const end = input.selectionEndInLine;
  if (!(end > start)) return null;

  let fallback: TeachLessonRef | null = null;
  for (const match of input.line.matchAll(constructPattern())) {
    const index = match.index ?? 0;
    const tokenEnd = index + match[0].length;
    if (tokenEnd <= start || index >= end) continue;
    if (match[1]) return refForEnvironment(match[1], false);
    if (match[2]) return refForEnvironment(match[2], true);
    if (match[3]) fallback = refForCommand(match[3]);
  }
  return fallback;
}

function quotedName(message: string): string {
  const quoted = message.match(/[`']([^`']+)[`']/);
  if (quoted?.[1]) return quoted[1];
  const file = message.match(
    /\b([\w./-]+\.(?:png|jpe?g|pdf|eps|svg|tex|bib|sty|cls))\b/i,
  );
  return file?.[1] ?? "";
}

function shortMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 42) return oneLine;
  return `${oneLine.slice(0, 41)}…`;
}

function detailForError(id: string, message: string): string {
  if (id === "file-not-found" || id === "package-not-found") {
    return quotedName(message);
  }
  if (id === "undefined-control") {
    const command = message.match(/\\[A-Za-z@]+/);
    return command?.[0] ? ` ${command[0]}` : "";
  }
  if (
    id === "env-mismatch" ||
    id === "undefined-environment" ||
    id === "citation-undefined" ||
    id === "reference-undefined"
  ) {
    const named =
      message.match(/\\(?:begin|end)\{[^}]+\}/)?.[0] ?? quotedName(message);
    return named ? ` ${named}` : "";
  }
  if (id === "generic") {
    return message.length > 180 ? `${message.slice(0, 177)}…` : message;
  }
  return "";
}

export function lessonRefForDiagnostic(message: string): TeachLessonRef {
  const text = message.trim();
  const id = ERROR_RULES.find((rule) => rule.test(text))?.id ?? "generic";
  const label =
    id === "generic"
      ? shortMessage(text)
      : (ERROR_TAGS[id] ?? shortMessage(text));
  return {
    kind: "error",
    id,
    label,
    detail: detailForError(id, text),
  };
}

export function sameTeachLesson(a: TeachLessonRef, b: TeachLessonRef): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  if (a.kind === "guide" || b.kind === "guide") return true;
  if (a.kind === "construct" && b.kind === "construct") {
    return a.label === b.label;
  }
  if (a.kind === "error" && b.kind === "error") {
    return a.label === b.label && a.detail === b.detail;
  }
  return false;
}

export function shouldShowTeachEntry(enabled: boolean): boolean {
  return enabled === true;
}

export function shouldShowTeachPanel(enabled: boolean, open: boolean): boolean {
  return enabled === true && open === true;
}

export function isStarterTex(content: string): boolean {
  if (!content.trim()) return true;
  let text = content.replace(/(^|[^\\])%[^\n]*/gm, "$1");
  text = text.replace(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, "");
  text = text.replace(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, "");
  text = text.replace(/\\begin\s*\{document\}/g, "");
  text = text.replace(/\\end\s*\{document\}/g, "");
  text = text.replace(/\s+/g, "");
  return text.length === 0;
}

export function shouldOfferEmptyGuide(
  enabled: boolean,
  content: string,
): boolean {
  return shouldShowTeachEntry(enabled) && isStarterTex(content);
}

export function teachActionForDiagnostic(
  enabled: boolean,
  message: string,
): { ref: TeachLessonRef; sourceKey: string } | null {
  if (!shouldShowTeachEntry(enabled)) return null;
  const ref = lessonRefForDiagnostic(message);
  return { ref, sourceKey: `diag:${ref.id}:${message}` };
}

function localize(copy: Localized, language: UiLanguage): string {
  return language === "zh" ? copy.zh : copy.en;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => vars[key] ?? "",
  );
}

function fallbackDetail(id: string, language: UiLanguage): string {
  if (id === "file-not-found" || id === "package-not-found") {
    return language === "zh" ? "目标文件" : "the file";
  }
  if (id === "undefined-control") {
    return language === "zh" ? "" : "";
  }
  return language === "zh" ? "这条提示" : "this message";
}

function catalogEntry(ref: TeachLessonRef): LessonCopy {
  if (ref.kind === "guide") {
    return GUIDES[ref.id] ?? GUIDES["empty-project"];
  }
  if (ref.kind === "error") return ERRORS[ref.id] ?? ERRORS.generic;
  return CONSTRUCTS[ref.id] ?? CONSTRUCTS.command;
}

export function resolveLesson(
  ref: TeachLessonRef,
  language: UiLanguage,
): TeachLesson {
  const copy = catalogEntry(ref);
  const rawDetail = ref.kind === "error" ? ref.detail.trim() : "";
  const detail =
    rawDetail || (ref.kind === "error" ? fallbackDetail(ref.id, language) : "");
  const tag =
    ref.kind === "guide"
      ? language === "zh"
        ? "空白文稿"
        : "blank file"
      : ref.label;
  const vars = { tag, detail };
  const tone = copy.tone ?? "info";
  const snippet = copy.snippet
    ? fill(localize(copy.snippet, language), vars)
    : null;
  return {
    id: ref.id,
    kind: ref.kind,
    tone,
    tag,
    title: fill(localize(copy.title, language), vars),
    banner: fill(localize(copy.banner, language), vars),
    what: fill(localize(copy.what, language), vars),
    points: copy.points.map((point) => fill(localize(point, language), vars)),
    snippet,
    insertable: copy.insertable ?? (tone !== "error" && Boolean(copy.snippet)),
    source: copy.source ? localize(copy.source, language) : null,
  };
}
