import type { TemplateDefinition } from "@/lib/template-registry";

const HIT_LETTER_HARBIN = `% !TEX program = XeLaTeX
\\documentclass[UTF8,a4paper,12pt]{ctexart}

% HIT recommendation letter (Harbin campus).
% Layout inspired by the Overleaf HIT LoR template (CC BY 4.0)
% https://www.overleaf.com/latex/templates/hit-letter-of-recommendation-template/cchwdhcrhjtv
% and the hitletter letterhead geometry (MIT). Official logos are not bundled.

\\usepackage{geometry}
\\geometry{left=3.17cm,right=3.17cm,top=3.4cm,bottom=2.6cm}
\\usepackage{xcolor}
\\usepackage{tikz}
\\usetikzlibrary{calc}
\\usepackage{setspace}
\\usepackage{hyperref}
\\usepackage{parskip}

\\definecolor{hitblue}{cmyk}{1,0.80,0,0}
\\definecolor{hitlightblue}{cmyk}{0.35,0.10,0,0}

\\pagestyle{empty}
\\setstretch{1.25}
\\hypersetup{colorlinks=true,urlcolor=hitblue}

\\newcommand{\\hitletterhead}{%
  \\begin{tikzpicture}[remember picture,overlay]
    \\fill[hitblue] (current page.north west) rectangle ($(current page.north east)+(0,-2.35)$);
    \\node[anchor=west,text=white,font=\\bfseries\\Large] at ($(current page.north west)+(1.15,-0.85)$)
      {哈尔滨工业大学};
    \\node[anchor=west,text=white,font=\\small] at ($(current page.north west)+(1.15,-1.45)$)
      {Harbin Institute of Technology};
    \\node[anchor=east,text=white,font=\\small\\bfseries] at ($(current page.north east)+(-1.15,-0.85)$)
      {LETTER OF RECOMMENDATION};
    \\node[anchor=east,text=white!90,font=\\scriptsize] at ($(current page.north east)+(-1.15,-1.45)$)
      {School of Computer Science and Technology};
    \\fill[hitblue] ($(current page.south west)$) rectangle ($(current page.south east)+(0,0.28)$);
    \\fill[hitlightblue] ($(current page.south west)+(0,0.28)$) rectangle ($(current page.south east)+(0,0.40)$);
    \\node[anchor=south,text=hitblue,font=\\scriptsize] at ($(current page.south)+(0,0.55)$)
      {92 West Dazhi Street, Harbin 150001, China \\quad Tel: +86-451-8641-2114};
  \\end{tikzpicture}%
}

\\begin{document}
\\hitletterhead
\\vspace*{0.4cm}

\\begin{flushright}
15 March 2026
\\end{flushright}

Admissions Committee\\\\
Department of Electrical Engineering and Computer Science\\\\
Massachusetts Institute of Technology\\\\
Cambridge, MA 02139\\\\
United States

\\vspace{0.4em}
\\textbf{Re: Recommendation for Ms.\\,Wei Zhang (张薇)}

Dear Members of the Committee,

I am Professor Li Ming, Chair of the Institute of Intelligent Systems at Harbin Institute of Technology. I write in the strongest terms to recommend Ms.\\,Wei Zhang for admission to your doctoral program. I have supervised Wei since 2023 as her undergraduate thesis advisor and as the principal investigator of the NSFC project on scientific surrogate calibration in which she is a student researcher.

Wei's work sits at the intersection of scientific machine learning and uncertainty quantification. In her thesis she designed a residual-score calibration procedure for frozen PDE emulators. The method estimates a monotone transport map on a small labeled holdout set and produces prediction intervals with near-nominal coverage on Burgers, Darcy, and reaction--diffusion benchmarks. A workshop paper based on this study was accepted at a national AI-for-science symposium; Wei was first author and presented the poster.

Beyond the technical results, Wei is unusually careful. She independently reproduced two baseline solvers, wrote a documented Python package for the calibration maps, and mentored two junior students through their first conference abstracts. In group meetings she is the person who notices when a coverage claim is being overstated.

I rank Wei in the top 3\\% of undergraduates I have taught in the last decade. She has the mathematical maturity, experimental discipline, and scientific taste to thrive in a competitive Ph.D.\\ program. I recommend her without reservation. Please contact me if I can provide any further information.

\\vspace{1.1em}
Sincerely,

\\vspace{1.4em}
\\textbf{Prof.\\,Li Ming}\\\\
Professor and Institute Chair\\\\
School of Computer Science and Technology\\\\
Harbin Institute of Technology\\\\
\\href{mailto:liming@hit.edu.cn}{liming@hit.edu.cn} \\quad +86-451-8641-3300

\\vfill
{\\small\\color{hitblue} Enclosures: curriculum vitae; unofficial transcript; list of publications.}

\\end{document}
`;

const HIT_LETTER_SHENZHEN = `% !TEX program = XeLaTeX
\\documentclass[UTF8,a4paper,12pt]{ctexart}

% HITSZ recommendation letter (Shenzhen campus).
% Adapted from the HIT LoR layout for Shenzhen University Town
% https://www.overleaf.com/latex/templates/hit-letter-of-recommendation-template/cchwdhcrhjtv

\\usepackage{geometry}
\\geometry{left=3.17cm,right=3.17cm,top=3.4cm,bottom=2.6cm}
\\usepackage{xcolor}
\\usepackage{tikz}
\\usetikzlibrary{calc}
\\usepackage{setspace}
\\usepackage{hyperref}
\\usepackage{parskip}

\\definecolor{hitblue}{cmyk}{1,0.80,0,0}
\\definecolor{hitlightblue}{cmyk}{0.35,0.10,0,0}

\\pagestyle{empty}
\\setstretch{1.28}
\\hypersetup{colorlinks=true,urlcolor=hitblue}

\\newcommand{\\hitszletterhead}{%
  \\begin{tikzpicture}[remember picture,overlay]
    \\fill[hitblue] (current page.north west) rectangle ($(current page.north east)+(0,-2.35)$);
    \\node[anchor=west,text=white,font=\\bfseries\\Large] at ($(current page.north west)+(1.15,-0.85)$)
      {哈尔滨工业大学（深圳）};
    \\node[anchor=west,text=white,font=\\small] at ($(current page.north west)+(1.15,-1.45)$)
      {Harbin Institute of Technology, Shenzhen};
    \\node[anchor=east,text=white,font=\\small\\bfseries] at ($(current page.north east)+(-1.15,-0.85)$)
      {推荐信 / Recommendation};
    \\node[anchor=east,text=white!90,font=\\scriptsize] at ($(current page.north east)+(-1.15,-1.45)$)
      {计算机科学与技术学院};
    \\fill[hitblue] ($(current page.south west)$) rectangle ($(current page.south east)+(0,0.28)$);
    \\fill[hitlightblue] ($(current page.south west)+(0,0.28)$) rectangle ($(current page.south east)+(0,0.40)$);
    \\node[anchor=south,text=hitblue,font=\\scriptsize] at ($(current page.south)+(0,0.55)$)
      {深圳市南山区深圳大学城哈工大校区 518055 \\quad Tel: +86-755-2603-3483};
  \\end{tikzpicture}%
}

\\begin{document}
\\hitszletterhead
\\vspace*{0.35cm}

\\begin{flushright}
2026年3月18日
\\end{flushright}

尊敬的招生委员会：

我是哈尔滨工业大学（深圳）计算机科学与技术学院教授王雪，现担任科学机器学习实验室负责人。我怀着十分肯定的态度，推荐陈远同学申请贵校博士研究生。自2024年春季起，陈远作为我的硕士研究生，全程参与国家自然科学基金面上项目“科学代理模型的残差校准与可信外推”。

陈远的研究工作把共形推断与可微物理代理结合起来。他在较小的标注校准集上估计单调运输映射，使 Burgers 方程、Darcy 流与反应--扩散系统上的区间覆盖率回到名义水平，并给出了当代理模型错过分岔时的失效检测方法。相关结果已整理为一篇中英双语预印本，陈远为第一作者。

在实验室日常工作中，陈远负责维护可复现实验流水线，并为两位本科生开放了校准模块的接口文档。他表达严谨，从不夸大覆盖率数字，这在数据驱动科学计算方向尤为难得。

综合学术潜力、工程能力与科研态度，我将陈远列为本实验室近五年硕士研究生中的前 5\\%。我毫无保留地推荐他。如需补充材料，请随时与我联系。

\\vspace{1.0em}
此致\\\\
敬礼

\\vspace{1.3em}
\\textbf{王雪 教授}\\\\
哈尔滨工业大学（深圳）计算机科学与技术学院\\\\
科学机器学习实验室\\\\
\\href{mailto:wangxue@hit.edu.cn}{wangxue@hit.edu.cn} \\quad +86-755-2603-3600

\\vspace{1.4em}
\\noindent\\rule{\\textwidth}{0.4pt}

\\noindent\\textbf{English summary.} I recommend Mr.\\,Yuan Chen without reservation for doctoral study. He led a residual-score calibration project for scientific emulators, restored nominal interval coverage on three PDE families, and maintains a reproducible experimental pipeline. I rank him in the top 5\\% of M.S.\\ students I have supervised in the last five years.

\\end{document}
`;

const HITSZ_POSTER = `% !TEX program = XeLaTeX
\\documentclass[final,t]{beamer}

% HITSZ academic poster. Layout follows the Overleaf HITSZ poster template
% https://www.overleaf.com/latex/templates/harbin-institute-of-technology-shenzhen-hitsz-poster-template/pmfzwyhbsnth
% (LPPL 1.3c). Compile with XeLaTeX or LuaLaTeX.

\\usepackage[orientation=portrait,size=a0,scale=1.24]{beamerposter}
\\usepackage{ctex}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{amsmath,amssymb}
\\usepackage{tikz}
\\usetikzlibrary{calc}
\\usepackage{multicol}
\\usefonttheme{serif}

\\definecolor{hitblue}{cmyk}{1,0.80,0,0}
\\definecolor{hitlightblue}{cmyk}{0.35,0.10,0,0}
\\definecolor{hitnavy}{RGB}{11,31,75}
\\definecolor{hitpanel}{RGB}{244,247,251}

\\setbeamercolor{background canvas}{bg=white}
\\setbeamercolor{headline}{fg=white,bg=hitnavy}
\\setbeamercolor{block title}{fg=white,bg=hitblue}
\\setbeamercolor{block body}{fg=black,bg=hitpanel}
\\setbeamertemplate{navigation symbols}{}

\\newlength{\\colwidth}
\\setlength{\\colwidth}{0.30\\textwidth}
\\setlength{\\columnsep}{0.8cm}

\\begin{document}
\\begin{frame}[t]
\\begin{tikzpicture}[remember picture,overlay]
  \\fill[hitnavy] (current page.north west) rectangle ($(current page.north east)+(0,-11.2cm)$);
\\end{tikzpicture}

\\vspace*{-0.4cm}
\\begin{center}
  {\\color{white}\\fontsize{56}{64}\\selectfont\\bfseries
  面向科学代理模型的残差校准方法}\\\\[0.55cm]
  {\\color{white}\\fontsize{32}{40}\\selectfont
  Residual-Score Calibration of Scientific Surrogate Models}\\\\[0.7cm]
  {\\color{white}\\fontsize{24}{30}\\selectfont
  陈远\\,\\textsuperscript{1} \\quad 王雪\\,\\textsuperscript{1} \\quad 李明\\,\\textsuperscript{2}}\\\\[0.35cm]
  {\\color{white!88}\\fontsize{20}{26}\\selectfont
  \\textsuperscript{1}哈尔滨工业大学（深圳）计算机科学与技术学院 \\quad
  \\textsuperscript{2}哈尔滨工业大学计算学部}\\\\[0.2cm]
  {\\color{hitlightblue}\\fontsize{18}{22}\\selectfont
  联系：yuan.chen@stu.hit.edu.cn \\quad|\\quad 中国计算机大会 2026 海报}
\\end{center}

\\vspace{1.5cm}

\\begin{columns}[t]
\\begin{column}{\\colwidth}
\\begin{block}{研究动机}
高保真 PDE 求解器在反问题与不确定性量化中代价高昂。数据驱动代理模型可以缩短计算时间，但残差分布常随工况漂移，导致区间覆盖率明显低于名义水平。

\\vspace{0.35em}
本海报给出一种\\textbf{事后、单调、可复现}的残差校准流程：不改动冻结代理 $f_\\theta$，只在较小的标注校准集上估计运输映射。
\\end{block}

\\begin{block}{方法}
对校准样本 $\\{(x_i,y_i)\\}_{i=1}^{n}$ 定义分数
\\[
  s_i=\\|y_i-f_\\theta(x_i)\\|_2.
\\]
记 $\\hat F$ 为经验分布。查询点 $x$ 处 $1-\\alpha$ 对称区间为
\\[
  f_\\theta(x)\\pm \\hat F^{-1}(1-\\alpha).
\\]
若校准分数与测试分数可交换，则覆盖率至少为 $1-\\alpha$，并带有 $1/(n+1)$ 的有限样本修正。当分数膨胀超过阈值时回退到数值求解器。
\\end{block}
\\end{column}

\\begin{column}{\\colwidth}
\\begin{block}{实验设置}
\\begin{itemize}
  \\setlength{\\itemsep}{6pt}
  \\item Burgers 方程、Darcy 流、反应--扩散
  \\item 冻结 Fourier Neural Operator 作为 $f_\\theta$
  \\item 校准集 $n=200$，目标覆盖率 $90\\%$
  \\item 对照：未校准残差、分位回归
\\end{itemize}
\\end{block}

\\begin{block}{主要结果}
\\renewcommand{\\arraystretch}{1.25}
{\\small
\\begin{tabular}{@{}lccc@{}}
\\toprule
问题 & 校准前 & 本方法 & 宽度比 \\\\
\\midrule
Burgers & 0.71 & 0.91 & 1.31 \\\\
Darcy & 0.64 & 0.89 & 1.55 \\\\
反应--扩散 & 0.77 & 0.92 & 1.29 \\\\
\\bottomrule
\\end{tabular}}

\\vspace{0.45em}
覆盖率回到名义水平；宽度增加可控。当代理错过分岔时，分数膨胀检测触发求解器回退。
\\end{block}
\\end{column}

\\begin{column}{\\colwidth}
\\begin{block}{结论}
残差校准是科学代理模型的低成本保险：不训练新权重，只要求带标注的校准集。该流程已在三类 PDE 上验证，并作为哈工深学位论文与预印本的共享基线。
\\end{block}

\\begin{block}{致谢与资料}
感谢国家自然科学基金与哈尔滨工业大学（深圳）的支持。\\\\[0.3em]
模板结构参考 Overleaf \\emph{HITSZ Poster Template}（LPPL 1.3c）。\\\\[0.3em]
{\\footnotesize 预印本 / 代码二维码可替换为实际链接。}
\\end{block}
\\end{column}
\\end{columns}

\\end{frame}
\\end{document}
`;

const HITSZ_THESIS_MAIN = `% !TEX program = XeLaTeX
% HITSZ dissertation starter using the official hitszthesis class
% https://www.overleaf.com/latex/templates/hitszthesis/hckkkdvywfbc
% https://github.com/YangLaTeX/hitszthesis
% Compile: XeLaTeX → BibTeX → XeLaTeX × 2
%
% gbt7714 v2 loads natbib before hitszthesis.cls requests
% [sort&compress], which otherwise raises an option clash at
% \\RequirePackage{subeqnarray}.
\\PassOptionsToPackage{sort&compress,numbers}{natbib}
\\documentclass[type=master]{hitszthesis}
\\usepackage{hitszthesis}

\\graphicspath{{figures/}{pictures/}}

\\begin{document}

\\frontmatter
\\input{front/coverinformation}
\\makecover
\\tableofcontents

\\mainmatter
\\input{body/chapter01}
\\input{body/chapter02}

\\backmatter
\\input{back/conclusion}

\\bibliographystyle{hitszthesis}
\\bibliography{reference}

\\begin{appendix}
\\input{back/appendixA}
\\end{appendix}

\\input{back/publications}
\\authorization
\\input{back/acknowledgements}
\\input{back/resume}

\\end{document}
`;

const HITSZ_COVER = `% !TEX root = ../main.tex
\\hitszsetup{
 statesecrets={公开},
 natclassifiedindex={TP181},
 intclassifiedindex={004.8},
 ctitleone={面向科学代理模型的},
 ctitletwo={残差校准方法研究},
 ctitlecover={面向科学代理模型的残差校准方法研究},
 ctitle={面向科学代理模型的残差校准方法研究},
 cxueke={工学},
 cpostgraduatetype={学术},
 csubject={计算机科学与技术},
 caffil={计算机科学与技术学院},
 cauthor={陈远},
 csupervisor={王雪 教授},
 cdate={2026年6月},
 cdatesecond={2026年06月12日},
 cstudentid={22S151234},
 etitle={Residual-Score Calibration of Scientific Surrogate Models},
 exueke={Engineering},
 esubject={Computer Science and Technology},
 eaffil={Harbin Institute of Technology, Shenzhen},
 eauthor={Yuan Chen},
 esupervisor={Prof. Xue Wang},
 edate={June, 2026},
 estudenttype={Master of Engineering},
 ckeywords={科学机器学习, 不确定性量化, 残差校准, 代理模型, hitszthesis},
 ekeywords={scientific machine learning, uncertainty quantification, residual calibration, surrogate model, hitszthesis},
}

\\begin{cabstract}
 科学计算中的代理模型能够显著降低数值模拟成本，但在分布偏移下往往出现残差误校准。本文研究一种基于残差分数的事后校准方法：在较小的标注校准集上估计单调运输映射，并据此构造预测区间。方法在 Burgers 方程、Darcy 流与反应--扩散系统上使区间覆盖率接近名义水平，同时给出代理模型错过分岔时的失效检测规则。全文使用哈尔滨工业大学（深圳）学位论文模板 \\texttt{hitszthesis} 排版。
\\end{cabstract}

\\begin{eabstract}
 Surrogate models reduce the cost of scientific simulation but are often miscalibrated under distribution shift. This thesis studies a post-hoc calibration procedure that estimates a monotone transport map on residual scores and forms prediction intervals from a small labeled holdout set. The method restores near-nominal coverage on three PDE families and includes a fallback rule when the emulator misses a bifurcation. The dissertation is typeset with the official HITSZ class \\texttt{hitszthesis}.
\\end{eabstract}
`;

const HITSZ_CH01 = `% !TEX root = ../main.tex
\\chapter{绪\\hspace{1em}论}[Introduction]

\\section{课题背景及研究的目的和意义}[Background, objective and significance]

高保真偏微分方程求解器在反问题、最优控制与不确定性量化中仍然昂贵。数据驱动代理模型把求解过程近似为一次前向推断，使大规模参数扫描成为可能。然而，当运行工况离开训练分布时，残差不再服从训练阶段观察到的规律，名义置信区间会系统性地低估风险。

本课题的目标是：在\\textbf{不重新训练}冻结代理模型的前提下，利用较小的标注校准集恢复区间覆盖率，并为明显失效的工况提供回到数值求解器的判据。

\\section{国内外研究现状}[Related work]

物理信息神经网络与神经算子为科学代理提供了可微的函数类。共形推断与分位回归则从统计侧给出有限样本覆盖保证。将二者结合的工作仍然较少：多数科学机器学习论文报告点误差，而不是校准后的区间。本文把残差分数上的单调映射作为连接两者的最小接口。

\\section{本文的主要研究内容}[Main research contents]

本文的工作组织如下：第2章给出残差分数、经验分布与覆盖率命题；结论章汇总创新点与后续工作。附录给出补充表格与符号说明。
`;

const HITSZ_CH02 = `% !TEX root = ../main.tex
\\chapter{残差校准方法}[Residual-score calibration]

\\section{问题表述}[Problem formulation]

设 $f_\\theta$ 为已训练并冻结的代理模型。对查询 $x$ 与真值 $y$，定义残差分数
\\begin{equation}
  s(x,y)=\\|y-f_\\theta(x)\\|_2.
\\end{equation}
给定校准集 $\\{(x_i,y_i)\\}_{i=1}^{n}$，记 $\\hat F$ 为 $\\{s(x_i,y_i)\\}$ 的经验分布函数。对目标误覆盖率 $\\alpha$，标量输出的对称区间为
\\begin{equation}
  f_\\theta(x)\\pm \\hat F^{-1}(1-\\alpha).
\\end{equation}

\\section{覆盖率}[Coverage]

若校准分数与测试分数可交换，则上述区间的覆盖率至少为 $1-\\alpha$，并带有 $1/(n+1)$ 的离散化修正。当分数序列出现显著膨胀时，判定代理模型离开可信流形，并回退到数值求解器。

\\section{数值实验}[Numerical experiments]

在 Burgers 方程、Darcy 流与反应--扩散系统上，未校准覆盖率分别为 0.71、0.64 与 0.77；校准后为 0.91、0.89 与 0.92（目标 90\\%）。区间平均宽度分别增加 31\\%、55\\% 与 29\\%。
`;

const HITSZ_CONCLUSION = `% !TEX root = ../main.tex
\\begin{conclusions}
本文围绕科学代理模型的残差误校准问题，完成了以下工作：

（1）建立了以残差分数经验分布为核心的事后校准流程，不修改冻结代理的可训练参数。

（2）在三类偏微分方程算例上验证了名义覆盖率可以恢复，并量化了区间宽度的代价。

（3）给出了分数膨胀检测与求解器回退规则，避免在代理模型错过分岔时继续输出虚假区间。

后续工作将把该方法扩展到时变场输出，并与主动采样结合以降低校准集规模。
\\end{conclusions}
`;

const HITSZ_ACK = `% !TEX root = ../main.tex
\\begin{acknowledgements}
衷心感谢导师王雪教授的指导，以及实验室同学在实验复现上的帮助。感谢哈尔滨工业大学（深圳）提供的计算资源。学位论文使用开源模板 \\texttt{hitszthesis}（杨敬轩，LPPL 1.3c）。
\\end{acknowledgements}
`;

const HITSZ_PUBS = `% !TEX root = ../main.tex
\\begin{publication}
 \\noindent\\songti\\textbf{（一）发表的学术论文}
 \\begin{publist}
 \\item 陈远，王雪. 面向科学代理模型的残差校准方法［C］. 中国计算机大会，2026.（海报）
 \\end{publist}

 \\noindent\\songti\\textbf{（二）参与的科研项目}
 \\begin{publist}
 \\item 王雪，陈远. 科学代理模型的残差校准与可信外推. 国家自然科学基金面上项目.
 \\end{publist}
\\end{publication}
`;

const HITSZ_RESUME = `% !TEX root = ../main.tex
\\begin{resume}
2000年8月出生于广东省深圳市。

2018年9月考入哈尔滨工业大学（深圳）计算机科学与技术专业，2022年6月本科毕业并获得工学学士学位。

2022年9月——2026年6月在哈尔滨工业大学（深圳）计算机科学与技术学科学习并获得工学硕士学位。
\\end{resume}
`;

const HITSZ_APPENDIX = `% !TEX root = ../main.tex
\\chapter{补充实验与符号}[Supplementary experiments and notation]

\\section{符号表}[Notation]

$f_\\theta$ 表示冻结代理，$s$ 表示残差分数，$\\hat F$ 表示校准集上的经验分布，$\\alpha$ 表示目标误覆盖率。

\\section{补充覆盖率}[Additional coverage]

将校准集规模从 $n=100$ 增至 $n=400$ 时，三类问题上的覆盖率波动小于 $0.03$，说明映射估计对中等样本已经稳定。
`;

const HITSZ_STY = `% Extra packages for the LocalPrism hitszthesis starter.
% The official class comes from CTAN / TeX Live (hitszthesis).
\\ProvidesPackage{hitszthesis}[2026/09/21 LocalPrism starter extras]
\\RequirePackage{bm,siunitx,booktabs}
\\endinput
`;

const HITSZ_BIB = `@article{raissi2019,
  author  = {Raissi, M. and Perdikaris, P. and Karniadakis, G. E.},
  title   = {Physics-informed neural networks},
  journal = {Journal of Computational Physics},
  volume  = {378},
  pages   = {686--707},
  year    = {2019}
}

@article{karniadakis2021,
  author  = {Karniadakis, G. E. and Kevrekidis, I. G. and Lu, L. and Perdikaris, P. and Wang, S. and Yang, L.},
  title   = {Physics-informed machine learning},
  journal = {Nature Reviews Physics},
  volume  = {3},
  pages   = {422--440},
  year    = {2021}
}
`;

export const HIT_TEMPLATES: TemplateDefinition[] = [
  {
    id: "letter-hit-recommendation",
    name: "HIT Recommendation Letter",
    description:
      "Harbin campus letter of recommendation with HIT blue letterhead",
    category: "professional",
    subcategory: "letters",
    tags: [
      "hit",
      "harbin",
      "recommendation",
      "letter",
      "推荐信",
      "哈工大",
      "lor",
    ],
    icon: "Mail",
    documentClass: "ctexart",
    mainFileName: "main.tex",
    accentColor: "#003399",
    hasBibliography: false,
    aspectRatio: "3/4",
    packages: [
      { name: "ctex", description: "Chinese typesetting" },
      { name: "tikz", description: "HIT letterhead rules" },
      { name: "geometry", description: "Official-style page margins" },
    ],
    content: HIT_LETTER_HARBIN,
  },
  {
    id: "letter-hitsz-recommendation",
    name: "HITSZ Recommendation Letter",
    description:
      "Shenzhen campus bilingual recommendation letter with HIT letterhead",
    category: "professional",
    subcategory: "letters",
    tags: [
      "hitsz",
      "shenzhen",
      "recommendation",
      "letter",
      "推荐信",
      "哈工深",
      "lor",
    ],
    icon: "Mail",
    documentClass: "ctexart",
    mainFileName: "main.tex",
    accentColor: "#0B1F4B",
    hasBibliography: false,
    aspectRatio: "3/4",
    packages: [
      { name: "ctex", description: "Chinese typesetting" },
      { name: "tikz", description: "HITSZ letterhead rules" },
      { name: "geometry", description: "Official-style page margins" },
    ],
    content: HIT_LETTER_SHENZHEN,
  },
  {
    id: "poster-hitsz",
    name: "HITSZ Academic Poster",
    description: "A0 HITSZ conference poster with HIT blue blocks",
    category: "academic",
    subcategory: "posters",
    tags: [
      "hitsz",
      "poster",
      "beamerposter",
      "a0",
      "海报",
      "哈工深",
      "conference",
    ],
    icon: "Layout",
    documentClass: "beamer",
    mainFileName: "main.tex",
    accentColor: "#1d4ed8",
    hasBibliography: false,
    aspectRatio: "3/4",
    packages: [
      { name: "beamerposter", description: "A0 poster canvas" },
      { name: "ctex", description: "Chinese typesetting" },
      { name: "booktabs", description: "Result table" },
    ],
    content: HITSZ_POSTER,
  },
  {
    id: "thesis-hitsz",
    name: "HITSZ Thesis (hitszthesis)",
    description:
      "HITSZ dissertation (hitszthesis). Compile with XeLaTeX / TeX Live.",
    category: "academic",
    subcategory: "theses",
    tags: [
      "hitszthesis",
      "hitsz",
      "thesis",
      "dissertation",
      "中文",
      "哈工深",
      "硕士学位论文",
    ],
    icon: "GraduationCap",
    documentClass: "hitszthesis",
    mainFileName: "main.tex",
    accentColor: "#b91c1c",
    hasBibliography: true,
    aspectRatio: "3/4",
    packages: [
      { name: "hitszthesis", description: "Official HITSZ dissertation class" },
    ],
    extraFiles: [
      { path: "hitszthesis.sty", content: HITSZ_STY },
      { path: "front/coverinformation.tex", content: HITSZ_COVER },
      { path: "body/chapter01.tex", content: HITSZ_CH01 },
      { path: "body/chapter02.tex", content: HITSZ_CH02 },
      { path: "back/conclusion.tex", content: HITSZ_CONCLUSION },
      { path: "back/acknowledgements.tex", content: HITSZ_ACK },
      { path: "back/publications.tex", content: HITSZ_PUBS },
      { path: "back/resume.tex", content: HITSZ_RESUME },
      { path: "back/appendixA.tex", content: HITSZ_APPENDIX },
      { path: "reference.bib", content: HITSZ_BIB },
    ],
    content: HITSZ_THESIS_MAIN,
  },
];
