export type UiLanguage = "en" | "zh";

const en = {
  "language.label": "Language",
  "language.zh": "中文",
  "language.en": "English",

  "settings.title": "Settings",
  "settings.description": "Configure providers, skills, and custom agents.",
  "settings.providers": "Providers",
  "settings.skills": "Skills",
  "settings.agents": "Agents",

  "chrome.settings": "Settings",
  "chrome.gettingStarted": "Getting Started",
  "chrome.files": "Files",
  "chrome.refresh": "Refresh",
  "chrome.add": "Add",
  "chrome.newLatexFile": "New LaTeX File",
  "chrome.newFolder": "New Folder",
  "chrome.importFile": "Import File",
  "chrome.layout": "Layout",
  "chrome.code": "Code",
  "chrome.chat": "Chat",
  "chrome.pdf": "PDF",
  "chrome.sidebar": "Sidebar",
  "chrome.resetLayout": "Reset layout",
  "chrome.renameProject": "Rename project folder",
  "chrome.hideChat": "Hide chat",
  "chrome.hide": "Hide",
  "chrome.backHome": "Back to home",
  "chrome.chapters": "Chapters",
  "chrome.missingFile": "Not in this project yet",

  "onboarding.progress": "Project setup progress",
  "onboarding.step.template": "Template",
  "onboarding.step.details": "Details",
  "onboarding.step.references": "References",
  "onboarding.step.create": "Create",
  "onboarding.welcomeSubtitle": "Welcome — guided setup",
  "onboarding.skip": "Skip",
  "onboarding.getStarted": "Get started",
  "onboarding.gettingStartedTitle": "Getting Started",
  "onboarding.gettingStartedBody":
    "A short map of the workspace. You can open the setup guide again any time.",
  "onboarding.stepCreate":
    "Create a project from a template, or open an existing folder.",
  "onboarding.stepSettings":
    "In Settings, an API key is the recommended way to chat. Official login is optional.",
  "onboarding.stepPanes":
    "Drag the pane splitters to resize the file tree, editor, chat, and PDF. Reset layout restores the default widths.",
  "onboarding.leavesProject":
    "Open setup guide closes this project and returns to the home screen.",
  "onboarding.stopFirst":
    "Stop the current chat turn before opening the setup guide.",
  "onboarding.close": "Close",
  "onboarding.openGuide": "Open setup guide",
  "onboarding.envBody":
    "Paste an API key from DeepSeek, Kimi, Qwen, or another provider. Official Claude or ChatGPT browser sign-in is optional. You can skip model setup and configure this later in Settings.",
  "onboarding.done": "Done",
  "onboarding.skipModel": "Skip model setup",

  "providers.useApiKey": "Use an API key",
  "providers.apiKeyHelp":
    "Pick a preset and paste a key. Official Claude or ChatGPT sign-in is not required.",
  "providers.apiKey": "API key",
  "providers.model": "Model",
  "providers.name": "Name",
  "providers.baseUrl": "Base URL",
  "providers.saveDefault": "Save and set default",
  "providers.setDefault": "Set default",
  "providers.delete": "Delete",
  "providers.officialTitle": "Official Claude / ChatGPT login",
  "providers.officialHelp": "Optional browser sign-in. An API key is enough.",
  "providers.hide": "Hide",
  "providers.show": "Show",
  "providers.signedIn": "Signed in",
  "providers.browserSignIn": "Browser sign-in. Tokens stay in LocalPrism.",
  "providers.setAsDefault": "Set as default",
  "providers.signOut": "Sign out",
  "providers.waitingBrowser": "Waiting for browser…",
  "providers.signInTo": "Sign in to {{name}}",
  "providers.oauthFallback":
    "If the browser did not open, copy this authorization link: {{url}}",
  "providers.apiKeyEnough": "{{badge}}. An API key is enough.",
  "providers.modelCount": "{{count}} models from {{name}}.",
  "providers.activeFallback": "the active provider",
  "providers.gitRequired":
    "Git for Windows is required before installing Claude Code CLI.",
  "providers.installingCli": "Installing Claude Code CLI…",
  "providers.cliNeeded":
    "Claude Code CLI is needed before a provider can send chat.",
  "providers.installing": "Installing…",
  "providers.installCli": "Install Claude Code CLI",
  "providers.status.notConnected": "Not connected",
  "providers.status.connected": "Connected",
  "providers.status.active": "Active",
  "providers.status.activeNoModel": "Active · no model",
  "providers.engineOn": "Engine on",
  "providers.engineOff": "Engine off",
  "providers.connectedWord": "connected",
  "providers.modelSet": "Model set",
  "providers.noModel": "No model",

  "skills.destination": "Import destination",
  "skills.destinationHelp":
    "Skills and subagents live next to the LocalPrism install, not ~/.claude or %APPDATA%. User skills go to claude-home/skills and subagents to claude-home/agents in the install folder (for example D:\\LocalPrism\\claude-home\\skills). Project skills go to .localprism in the current paper. If the install folder is read-only, LocalPrism falls back to its app data folder.",
  "skills.importFolder": "Import folder",
  "skills.importing": "Importing…",
  "skills.refresh": "Refresh",
  "skills.addUrl": "Add from URL",
  "skills.addUrlHelp":
    "GitHub repo, skill folder tree URL, .tar.gz archive, or a raw SKILL.md link.",
  "skills.addUrlAction": "Add URL",
  "skills.loading": "Loading skills…",
  "skills.empty": "No skills found.",
  "skills.remove": "Remove",
  "skills.userTarget": "LocalPrism / user",
  "skills.projectTarget": "LocalPrism / project",
  "skills.managed": "managed",
  "skills.unmanaged": "unmanaged",
  "skills.enabled": "enabled",
  "skills.disabled": "disabled",
  "skills.importTitle": "Select skill folder",

  "agents.storage":
    "Custom subagents are stored in claude-home/agents next to the LocalPrism install folder, not ~/.claude.",
  "agents.new": "New agent",
  "agents.loading": "Loading agents…",
  "agents.empty": "No custom agents yet.",
  "agents.emptyHint": "Start from a writing preset, or create a custom agent.",
  "agents.custom": "Create custom agent",
  "agents.checkingSkills": "Checking installed skills…",
  "agents.edit": "Edit",
  "agents.delete": "Delete",

  "approvals.label": "Runtime approval",
  "approvals.kind": "{{runtime}} approval",
  "approvals.select": "Select…",
  "approvals.deny": "Deny",
  "approvals.cancelTurn": "Cancel turn",
  "approvals.allowSession": "Allow for session",
  "approvals.allowOnce": "Allow once",
  "approvals.thread": "Thread: {{id}}",

  "errors.somethingWrong": "Something went wrong",
  "errors.unexpected":
    "An unexpected error occurred. You can try again or reload the app.",
  "errors.tryAgain": "Try again",
  "errors.reload": "Reload",
  "errors.retry": "Retry",
  "errors.details": "Details",
  "errors.hideDetails": "Hide details",
  "errors.clearConversation": "Clear conversation",
  "errors.dismiss": "Dismiss",
  "errors.rateLimited": "Rate limited by the API. {{detail}}",
  "errors.contextLimit":
    "The request exceeded the model context limit (often from a huge skill such as PaperSpine). Narrow the request and retry. {{detail}}",
  "errors.auth":
    "Authentication failed. Check the provider API key or official account sign-in. {{detail}}",
  "errors.http400": "The provider rejected the request (HTTP 400). {{detail}}",
  "errors.gitBash":
    "Claude Code requires git-bash on Windows. Please install Git for Windows or set the CLAUDE_CODE_GIT_BASH_PATH environment variable.",
  "errors.providerStart":
    "AI provider request failed to start. Check the provider API key, Base URL, model name, and model access.",
  "errors.claudeStartWindows":
    "Claude process failed to start. Check that Claude Code CLI is installed and git-bash is available.",
  "errors.claudeStart":
    "Claude process failed to start. Check that Claude Code CLI is installed.",
  "errors.providerStopped":
    "AI provider request stopped unexpectedly.{{exit}}{{detail}} Check the API key, model access, Base URL, tool-call support, or rate limits.",
  "errors.claudeStopped":
    "Claude process stopped unexpectedly.{{exit}}{{detail}}",
  "errors.claudeExited":
    "Claude process exited unexpectedly.{{exit}}{{detail}} Check the process output above; this is often an API, skill, or spawn error rather than a rate limit.",
  "errors.noProject": "No project open",
  "errors.projectChanging":
    "The project is being changed. Wait for it to finish.",
  "errors.waitingStop": "Waiting for the previous runtime turn to stop.",
  "errors.installingEngine":
    "Installing the writing engine. You can send once it finishes.",
  "errors.needProvider":
    "Install the writing engine and activate a provider in Settings → Providers before sending.",
  "errors.readOnly":
    "This conversation is read-only. Start a new chat with the active provider.",
  "errors.compressFailed":
    "Couldn't compress earlier messages. {{detail}} Earlier messages were kept.",
  "errors.compressFailed400":
    "Couldn't compress earlier messages (HTTP 400). {{detail}} Earlier messages were kept.",

  "chat.newChat": "New Chat",
  "chat.newTab": "New tab",
  "chat.startNew": "Start a new chat",
  "chat.search": "Search chats",
  "chat.noSessions": "No previous sessions",
  "chat.noMatches": "No matching chats",
  "chat.readOnly": "Read-only",
  "chat.sessionHistory": "Session history",
  "chat.ask": "Ask about this paper",
  "chat.compress": "Compress earlier messages",
  "chat.compressing": "Compressing…",
  "chat.summaryTitle": "Earlier messages summarized",
  "chat.summaryMeta": "{{count}} earlier messages kept below",
  "chat.showOriginals": "Show original messages",
  "chat.hideOriginals": "Hide original messages",
  "chat.copied": "Copied",
  "chat.copy": "Copy",
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "language.label": "语言",
  "language.zh": "中文",
  "language.en": "English",

  "settings.title": "设置",
  "settings.description": "配置服务商、技能和自定义智能体。",
  "settings.providers": "服务商",
  "settings.skills": "技能",
  "settings.agents": "智能体",

  "chrome.settings": "设置",
  "chrome.gettingStarted": "入门指南",
  "chrome.files": "文件",
  "chrome.refresh": "刷新",
  "chrome.add": "添加",
  "chrome.newLatexFile": "新建 LaTeX 文件",
  "chrome.newFolder": "新建文件夹",
  "chrome.importFile": "导入文件",
  "chrome.layout": "布局",
  "chrome.code": "代码",
  "chrome.chat": "对话",
  "chrome.pdf": "PDF",
  "chrome.sidebar": "侧边栏",
  "chrome.resetLayout": "重置布局",
  "chrome.renameProject": "重命名项目文件夹",
  "chrome.hideChat": "隐藏对话",
  "chrome.hide": "隐藏",
  "chrome.backHome": "返回主页",
  "chrome.chapters": "章节",
  "chrome.missingFile": "项目中还没有这个文件",

  "onboarding.progress": "项目创建进度",
  "onboarding.step.template": "模板",
  "onboarding.step.details": "详情",
  "onboarding.step.references": "参考文献",
  "onboarding.step.create": "创建",
  "onboarding.welcomeSubtitle": "欢迎 — 引导设置",
  "onboarding.skip": "跳过",
  "onboarding.getStarted": "开始使用",
  "onboarding.gettingStartedTitle": "入门指南",
  "onboarding.gettingStartedBody":
    "工作区的简要说明。之后可以随时再次打开设置引导。",
  "onboarding.stepCreate": "从模板新建项目，或打开已有文件夹。",
  "onboarding.stepSettings":
    "在设置中，推荐使用 API 密钥来对话。官方登录是可选的。",
  "onboarding.stepPanes":
    "拖动分隔条可调整文件树、编辑器、对话和 PDF 的宽度。重置布局会恢复默认宽度。",
  "onboarding.leavesProject": "打开设置引导会关闭当前项目并回到主页。",
  "onboarding.stopFirst": "请先停止当前对话回合，再打开设置引导。",
  "onboarding.close": "关闭",
  "onboarding.openGuide": "打开设置引导",
  "onboarding.envBody":
    "粘贴 DeepSeek、Kimi、Qwen 或其他服务商的 API 密钥。Claude 或 ChatGPT 官方浏览器登录是可选的。也可以先跳过模型设置，之后在设置里配置。",
  "onboarding.done": "完成",
  "onboarding.skipModel": "跳过模型设置",

  "providers.useApiKey": "使用 API 密钥",
  "providers.apiKeyHelp":
    "选择一个预设并粘贴密钥。不需要登录官方 Claude 或 ChatGPT。",
  "providers.apiKey": "API 密钥",
  "providers.model": "模型",
  "providers.name": "名称",
  "providers.baseUrl": "Base URL",
  "providers.saveDefault": "保存并设为默认",
  "providers.setDefault": "设为默认",
  "providers.delete": "删除",
  "providers.officialTitle": "官方 Claude / ChatGPT 登录",
  "providers.officialHelp": "可选的浏览器登录。API 密钥就够用。",
  "providers.hide": "收起",
  "providers.show": "展开",
  "providers.signedIn": "已登录",
  "providers.browserSignIn": "浏览器登录。令牌保存在 LocalPrism 内。",
  "providers.setAsDefault": "设为默认",
  "providers.signOut": "退出登录",
  "providers.waitingBrowser": "等待浏览器…",
  "providers.signInTo": "登录 {{name}}",
  "providers.oauthFallback": "如果浏览器没有打开，复制这个授权链接：{{url}}",
  "providers.apiKeyEnough": "{{badge}}。API 密钥就够用。",
  "providers.modelCount": "来自 {{name}} 的 {{count}} 个模型。",
  "providers.activeFallback": "当前服务商",
  "providers.gitRequired": "安装 Claude Code CLI 之前需要 Git for Windows。",
  "providers.installingCli": "正在安装 Claude Code CLI…",
  "providers.cliNeeded": "发送对话前需要 Claude Code CLI。",
  "providers.installing": "正在安装…",
  "providers.installCli": "安装 Claude Code CLI",
  "providers.status.notConnected": "未连接",
  "providers.status.connected": "已连接",
  "providers.status.active": "使用中",
  "providers.status.activeNoModel": "使用中 · 无模型",
  "providers.engineOn": "引擎已开",
  "providers.engineOff": "引擎未开",
  "providers.connectedWord": "个已连接",
  "providers.modelSet": "已设模型",
  "providers.noModel": "无模型",

  "skills.destination": "导入位置",
  "skills.destinationHelp":
    "技能和子智能体放在 LocalPrism 安装目录旁边，而不是 ~/.claude 或 %APPDATA%。用户技能在安装目录的 claude-home/skills，子智能体在 claude-home/agents（例如 D:\\LocalPrism\\claude-home\\skills）。项目技能放在当前文稿的 .localprism。如果安装目录只读，会回退到应用数据目录。",
  "skills.importFolder": "导入文件夹",
  "skills.importing": "正在导入…",
  "skills.refresh": "刷新",
  "skills.addUrl": "从 URL 添加",
  "skills.addUrlHelp":
    "GitHub 仓库、技能目录树 URL、.tar.gz 压缩包，或 SKILL.md 原始链接。",
  "skills.addUrlAction": "添加 URL",
  "skills.loading": "正在加载技能…",
  "skills.empty": "没有找到技能。",
  "skills.remove": "移除",
  "skills.userTarget": "LocalPrism / 用户",
  "skills.projectTarget": "LocalPrism / 项目",
  "skills.managed": "托管",
  "skills.unmanaged": "非托管",
  "skills.enabled": "已启用",
  "skills.disabled": "已停用",
  "skills.importTitle": "选择技能文件夹",

  "agents.storage":
    "自定义子智能体保存在 LocalPrism 安装目录旁的 claude-home/agents，而不是 ~/.claude。",
  "agents.new": "新建智能体",
  "agents.loading": "正在加载智能体…",
  "agents.empty": "还没有自定义智能体。",
  "agents.emptyHint": "可以从写作预设开始，或新建自定义智能体。",
  "agents.custom": "新建自定义智能体",
  "agents.checkingSkills": "正在检查已安装的技能…",
  "agents.edit": "编辑",
  "agents.delete": "删除",

  "approvals.label": "运行时批准",
  "approvals.kind": "{{runtime}} 批准",
  "approvals.select": "请选择…",
  "approvals.deny": "拒绝",
  "approvals.cancelTurn": "取消本回合",
  "approvals.allowSession": "本会话允许",
  "approvals.allowOnce": "仅此一次",
  "approvals.thread": "会话：{{id}}",

  "errors.somethingWrong": "出了点问题",
  "errors.unexpected": "发生了意外错误。可以重试，或重新加载应用。",
  "errors.tryAgain": "重试",
  "errors.reload": "重新加载",
  "errors.retry": "重试",
  "errors.details": "详情",
  "errors.hideDetails": "隐藏详情",
  "errors.clearConversation": "清空对话",
  "errors.dismiss": "关闭",
  "errors.rateLimited": "API 触发了速率限制。{{detail}}",
  "errors.contextLimit":
    "请求超出了模型上下文上限（常见于 PaperSpine 这类很大的技能）。缩小请求后再试。{{detail}}",
  "errors.auth": "认证失败。请检查服务商 API 密钥或官方账号登录。{{detail}}",
  "errors.http400": "服务商拒绝了请求（HTTP 400）。{{detail}}",
  "errors.gitBash":
    "在 Windows 上 Claude Code 需要 git-bash。请安装 Git for Windows，或设置 CLAUDE_CODE_GIT_BASH_PATH 环境变量。",
  "errors.providerStart":
    "AI 服务商请求未能启动。请检查 API 密钥、Base URL、模型名称和模型权限。",
  "errors.claudeStartWindows":
    "Claude 进程未能启动。请确认已安装 Claude Code CLI，并且 git-bash 可用。",
  "errors.claudeStart": "Claude 进程未能启动。请确认已安装 Claude Code CLI。",
  "errors.providerStopped":
    "AI 服务商请求意外停止。{{exit}}{{detail}} 请检查 API 密钥、模型权限、Base URL、工具调用支持或速率限制。",
  "errors.claudeStopped": "Claude 进程意外停止。{{exit}}{{detail}}",
  "errors.claudeExited":
    "Claude 进程意外退出。{{exit}}{{detail}} 请查看上面的进程输出；这通常是 API、技能或启动错误，而不一定是速率限制。",
  "errors.noProject": "没有打开的项目",
  "errors.projectChanging": "项目正在切换，请等待完成。",
  "errors.waitingStop": "正在等待上一回合停止。",
  "errors.installingEngine": "正在安装写作引擎。完成后即可发送。",
  "errors.needProvider":
    "请先安装写作引擎，并在设置 → 服务商中启用一个服务商，然后再发送。",
  "errors.readOnly": "这段对话是只读的。请用当前服务商开始新对话。",
  "errors.compressFailed": "无法压缩更早的消息。{{detail}} 原始消息已保留。",
  "errors.compressFailed400":
    "无法压缩更早的消息（HTTP 400）。{{detail}} 原始消息已保留。",

  "chat.newChat": "新对话",
  "chat.newTab": "新标签",
  "chat.startNew": "开始新对话",
  "chat.search": "搜索对话",
  "chat.noSessions": "没有历史会话",
  "chat.noMatches": "没有匹配的对话",
  "chat.readOnly": "只读",
  "chat.sessionHistory": "会话历史",
  "chat.ask": "问问这篇文稿",
  "chat.compress": "压缩更早的消息",
  "chat.compressing": "正在压缩…",
  "chat.summaryTitle": "更早的消息已摘要",
  "chat.summaryMeta": "下方保留了 {{count}} 条更早的消息",
  "chat.showOriginals": "查看原始消息",
  "chat.hideOriginals": "收起原始消息",
  "chat.copied": "已复制",
  "chat.copy": "复制",
};

function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    vars[key] == null ? "" : String(vars[key]),
  );
}

export function translate(
  language: UiLanguage,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const table = language === "zh" ? zh : en;
  return interpolate(table[key] ?? en[key], vars);
}

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "en" || value === "zh";
}
