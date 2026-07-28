// UI copy (zh/en) and the language context.
import React from "react";

export const LANGUAGE_STORAGE_KEY = "lxe.window.main.language.v1";
const LEGACY_LANGUAGE_STORAGE_KEY = "agent-dashboard-language";

export type Language = "zh" | "en";

export const ZH_TEXT = {
  language: {
    label: "语言",
    zh: "中文",
    en: "EN"
  },
  app: {
    eyebrow: "本地智能工作台",
    title: "LXE Agent",
    subtitle: "查看会话、Agent 能力与运行活动。",
    apiOnline: "API 在线",
    apiOffline: "API 离线"
  },
  nav: {
    home: "首页",
    sessions: "会话",
    workbench: "工作台",
    capabilities: "能力",
    activity: "活动",
    models: "模型",
    tools: "工具",
    skills: "技能",
    connections: "连接",
    tasks: "任务",
    usage: "统计",
    aria: "Dashboard 区域"
  },
  sidebar: {
    collapse: "收起侧边栏",
    expand: "展开侧边栏",
    statusAndSettings: "设置"
  },
  home: {
    title: "欢迎使用 LXE Agent",
    subtitle: "查看历史会话，或管理 Agent 能力与运行活动。",
    greetingMorning: "早上好",
    greetingAfternoon: "下午好",
    greetingEvening: "晚上好",
    overviewHint: "这是最近 24 小时的运行情况",
    todayTurns: "回合",
    todayExecutions: "技能执行",
    todayFailures: "执行失败",
    todayTokens: "Token 消耗",
    runtimeStatusAria: "实时运行状态",
    runtimeStatus: "运行状态",
    openStatusSettings: "设置",
    openRuntimeStatus: "打开运行状态",
    closeRuntimeStatus: "关闭运行状态",
    currentModel: "当前模型",
    gateway: "Gateway",
    agent: "Agent",
    feishu: "飞书",
    companyCloud: "公司云端",
    lastChecked: (value: string) => `最近检查 ${value}`,
    runtimeTones: {
      healthy: "运行正常",
      progress: "正在处理",
      warning: "存在异常",
      neutral: "状态待确认"
    },
    componentStates: {
      ready: "运行中",
      starting: "启动中",
      stopped: "已停止",
      error: "异常"
    },
    channelStates: {
      connected: "已连接",
      connecting: "连接中",
      error: "异常",
      disabled: "已停用",
      unconfigured: "未配置",
      unavailable: "暂不可用"
    },
    cloudStates: {
      not_configured: "未配置",
      provisioning: "正在配置",
      connecting: "连接中",
      connected: "已连接",
      offline: "离线",
      error: "异常",
      unsupported: "当前平台不支持"
    },
    recentSessions: "最近会话",
    activeSkills: "活跃技能 · 近 7 天",
    viewAllSessions: "查看全部",
    viewStats: "查看统计",
    noSessions: "暂无会话记录",
    noSkills: "近 7 天暂无技能使用",
    executionsUnit: (count: string) => `${count} 次执行`,
    loadError: "总览数据加载失败"
  },
  workbench: {
    eyebrow: "工作台 · 媒体工具",
    title: "亚马逊 AI 人物标签",
    subtitle: "批量给图片和视频添加亚马逊要求的 AI 人物媒体标签。原文件不会被修改。",
    windowsOnly: "当前平台暂不支持",
    windowsOnlyHint: "这个工具目前只在 Windows 和 macOS 桌面应用中提供。",
    sourceTitle: "选择媒体",
    sourceHint: "可以一次选择多张媒体文件，也可以选择一个文件夹。支持 JPG、JPEG、PNG、MP4 和 MOV。",
    selectFiles: "选择媒体文件",
    selectFilesHint: "可多选图片和视频",
    selectFolder: "选择文件夹",
    selectFolderHint: "默认只处理这一层",
    selectionReady: "媒体来源已选择",
    includeSubfolders: "包含子文件夹",
    scanning: "正在扫描…",
    scan: "扫描标签",
    reviewTitle: "检查结果",
    reviewHint: "先看哪些文件需要添加标签，再决定是否生成副本。",
    preparing: "正在准备…",
    progress: (processed: number, total: number) => total > 0
      ? `已处理 ${processed} / ${total}`
      : "正在处理当前文件",
    cancel: "取消任务",
    statuses: {
      needs_tag: "需要添加",
      already_tagged: "已有标签",
      unsupported: "不支持",
      failed: "失败",
      tagged: "已添加",
      copied: "已复制"
    },
    file: "文件",
    kind: "类型",
    size: "大小",
    status: "状态",
    mediaTypes: {
      image: "图片",
      video: "视频"
    },
    noItems: "没有可显示的媒体文件。",
    outputTitle: "生成带标签的副本",
    outputHint: "选择保存位置后，应用会新建一个独立任务文件夹，不覆盖任何已有文件。",
    selectOutput: "选择输出目录",
    generating: "正在生成…",
    generate: "生成媒体副本",
    complete: "处理完成",
    completeHint: "带标签的媒体副本已经放入任务输出文件夹。",
    completeWithFailures: "处理结束，部分文件失败",
    completeWithFailuresHint: "成功文件已经生成。请查看上方失败原因，再处理剩余文件。",
    openOutput: "打开输出目录",
    disclaimer: "这个工具只负责添加并验证元数据，不会判断媒体是否真的包含 AI 生成人物，也不会检查视频分辨率、时长等其他亚马逊上传要求。"
  },
  stats: {
    sessions: "会话",
    toolCalls: "工具调用",
    tokens: "Token",
    messages: "原始消息",
    apiCalls: "API 调用"
  },
  common: {
    loading: "加载中",
    updating: "正在更新…",
    copied: "已复制",
    unknown: "unknown",
    unnamedSession: "未命名会话",
    previous: "上一页",
    next: "下一页",
    pageIndex: (current: string, total: string) => `第 ${current} / ${total} 页`,
    errorPrefix: (label: string, message: string) => `${label}：${message}`,
    countItems: (count: string, unit: string) => `${count} ${unit}`,
    yes: "是",
    no: "否",
    none: "无",
    notSupported: "不支持",
    fallbackTool: "工具",
    block: "块"
  },
  role: {
    user: "user",
    assistant: "assistant",
    tool: "tool",
    system: "system",
    unknown: "unknown"
  },
  sessions: {
    title: "会话",
    newConversation: "新对话",
    newConversationAria: "创建新对话",
    searchPlaceholder: "搜索 sessions",
    searchAria: "搜索 sessions",
    closeSearch: "关闭会话搜索",
    recent: "最近会话",
    selectPrompt: "选择一个会话查看详情。",
    searchResults: (count: string) => `搜索结果 ${count} 条`,
    total: (count: string) => `共 ${count} 条`,
    empty: "暂无 session 记录。",
    emptySearch: "没有匹配的 session。",
    loading: "正在加载 sessions...",
    errorLabel: "Sessions 错误",
    columnSession: "会话",
    tokenSuffix: "Token"
  },
  sessionDetail: {
    back: "会话",
    eyebrow: "Session 详情",
    details: "详情",
    hideDetails: "收起详情",
    sessionId: "Session ID",
    source: "初始来源",
    directory: "工作目录",
    worktree: "Git worktree 根目录",
    model: "历史模型",
    lastActive: "最后活跃",
    loading: "正在加载对话...",
    errorLabel: "Session 错误",
    empty: "该 session 暂无对话记录。",
    pageBlocks: (visible: string, total: string) => `当前页 ${visible} / 总 ${total} 对话块`,
    rawMessages: (count: string) => `原始消息 ${count} 条`,
    loadEarlier: "加载更早消息",
    loadingEarlier: "正在加载更早消息…",
    retryEarlier: "重试加载"
  },
  conversation: {
    newTitle: "新对话",
    newHint: "输入消息或添加文件，开始与 Agent 对话。",
    placeholder: "给 Agent 发送消息…",
    send: "发送",
    stop: "停止",
    stopping: "正在停止…",
    queued: "已排队",
    queuedCount: (count: string) => `${count} 条消息等待处理`,
    running: "Agent 正在处理",
    completed: "回答完成",
    cancelled: "已停止",
    error: "执行失败",
    unavailable: "Gateway 或 Agent 尚未就绪",
    inputHint: "Enter 发送，Shift + Enter 换行",
    characterCount: (count: string, maximum: string) => `${count} / ${maximum}`,
    preparingContext: "正在准备上下文",
    waitingModel: "等待模型响应",
    thinking: "正在思考",
    runningTool: "正在运行工具",
    generatingAnswer: "正在生成回答",
    process: "处理过程",
    workedFor: (duration: string) => `处理了 ${duration}`,
    processFailed: (duration: string) => duration ? `处理失败 · ${duration}` : "处理失败",
    processCancelled: (duration: string) => duration ? `已停止 · ${duration}` : "已停止",
    elapsedDuration: (milliseconds: number) => {
      const seconds = Math.max(0, Math.round(milliseconds / 1_000));
      if (seconds < 1) return "不足1秒";
      const hours = Math.floor(seconds / 3_600);
      const minutes = Math.floor((seconds % 3_600) / 60);
      const remainder = seconds % 60;
      return [hours ? `${hours}小时` : "", minutes ? `${minutes}分` : "", remainder ? `${remainder}秒` : ""]
        .filter(Boolean).join("");
    },
    sending: "正在发送…",
    jumpToLatest: "跳到最新",
    files: (count: string) => `产出文件 · ${count}`,
    attachments: "传入的文件",
    addFiles: "添加文件",
    dropFiles: "松开以添加到对话",
    tooManyAttachments: "每轮最多添加 5 个文件",
    removeAttachment: (name: string) => `移除 ${name}`,
    openFile: (name: string) => `打开 ${name}`,
    openFileFailed: (reason: string) => `打开文件失败：${reason}`
  },
  message: {
    thinking: "思考",
    redactedThinking: "部分思考已加密，无法展示",
    toolCalls: "工具调用",
    toolResult: "工具结果",
    toolResultError: "工具结果错误",
    toolResultTruncated: (preview: string, original: string) => `Dashboard 仅显示 ${preview} / ${original} 字节预览`,
    copyResult: "复制结果",
    toolActivity: "工具活动",
    toolOperation: "工具操作",
    toolContinuation: "工具操作续段",
    toolActions: {
      read: "读取",
      edit: "编辑",
      write: "写入",
      search: "搜索",
      list: "查看目录",
      run: "运行命令",
      send: "发送文件",
      web: "访问网页",
      tool: "调用工具"
    },
    toolBatchMore: (count: number) => `另 ${count} 项`,
    toolBatchFailures: (count: number) => `失败 ${count}`,
    calls: "调用",
    results: "结果",
    error: "错误"
  },
  models: {
    subtitle: "选择用于后续对话的模型与思考模式。",
    model: "模型",
    currentModel: "当前模型",
    current: "当前",
    switching: "切换中",
    setCurrent: "设为当前",
    effectiveNextTurn: "模型切换将在下一轮对话生效",
    context: "上下文",
    output: "输出",
    vision: "视觉",
    capabilities: "模型能力",
    thinking: "思考",
    providerManaged: "由模型自动管理",
    modelOptionUnavailable: "模型选项不可用",
    providerNotSelectable: "WebUI 暂不支持切换",
    missingApiKey: "缺少 API Key"
  },
  tools: {
    subtitle: "查看并管理可供 Agent 调用的工具集。",
    parameters: (count: string) => `${count} 个参数`,
    resource: (name: string) => `资源 · ${name}`,
    itemUnit: "个工具",
    emptyToolset: "该 toolset 暂无可展示工具。",
    servers: "MCP Servers",
    serverUnit: "个 server",
    mcpTools: "MCP Tools",
    status: "状态",
    enabled: "已启用",
    disabled: "已关闭",
    enable: "启用",
    disable: "关闭",
    saving: "保存中",
    noServers: "暂无 MCP server。"
  },
  tasks: {
    empty: "暂无后台任务。",
    itemUnit: "个任务",
    task: "任务",
    status: "状态",
    session: "Session",
    command: "命令",
    duration: "耗时",
    startedAt: "开始时间"
  },
  skills: {
    subtitle: "浏览 Agent 可加载的技能、命令与参考资料。",
    itemUnit: "个技能",
    empty: "当前 agent 暂无可用 skill。",
    refs: (count: string) => `${count} 个引用`,
    commands: (count: string) => `${count} 个命令`,
    commandUnit: "个命令",
    maintenanceCommands: "维护命令",
    maintenanceDescription: "系统维护与诊断入口",
    maintenanceNote: "由 Bun Maintenance 自动调度，也可手动执行；它不是模型 Tool。",
    defaultGroup: "默认",
    uncategorized: "未分类"
  },
  usage: {
    title: "使用统计",
    rangeAria: "统计时间范围",
    rangeDays: (days: string) => `${days} 天`,
    loading: "正在加载统计...",
    errorLabel: "统计错误",
    empty: "所选时间范围内暂无使用数据。",
    totalsTurns: "回合",
    totalsErrorTurns: "错误回合",
    totalsToolCalls: "工具调用",
    totalsExecutions: "技能执行",
    totalsFailures: "执行失败",
    totalsTokens: "Token",
    dailyTitle: "每日趋势",
    dailyLegendTurns: "回合",
    dailyLegendExecutions: "技能执行",
    chartModeAria: "图表形式",
    chartModeBars: "柱状",
    chartModeLine: "折线",
    modulesTitle: "模块",
    skillsTitle: "技能",
    toolsTitle: "工具",
    columnName: "名称",
    columnSkills: "技能数",
    columnTurns: "回合",
    columnActivations: "激活",
    columnExecutions: "执行",
    columnFailures: "失败",
    columnSuccessRate: "成功率",
    columnAvgDuration: "平均耗时",
    columnCalls: "调用",
    columnErrors: "错误",
    columnLastUsed: "最近使用",
    executionsBadge: (count: string) => `${count} 次执行`,
    successRateBadge: (pct: string) => `成功率 ${pct}`
  },
  connectors: {
    subtitle: "控制 agent 是否能看到平台 CLI skills。",
    businessConnections: "业务连接",
    businessConnectionsDescription: "管理平台能力及其对 Agent 的可见性。",
    mcpConnections: "MCP 服务",
    mcpConnectionsDescription: "管理向 Agent 提供工具的外部服务。",
    configureCredentials: "配置凭证",
    itemUnit: "个技能",
    empty: "暂无 connector。",
    enabled: "已启用",
    disabled: "已关闭",
    enable: "启用",
    disable: "关闭",
    saving: "保存中",
    kind: "类型",
    note: "关闭后 agent 不会看到该 connector 的 CLI skills；不会卸载 CLI，也不会清除认证。",
    healthUnavailable: "健康状态不可用",
    channelHealth: "飞书通道",
    wsConnected: "飞书已连接",
    wsDisconnected: "飞书未连接",
    wsRestarting: "飞书重启中",
    wsStopped: "飞书已停止",
    wsFailed: "飞书连接失败",
    wsUnknown: "飞书状态未知",
    monitorRunning: "自动重启监控运行中",
    monitorStopped: "自动重启监控已停止",
    nextRestart: "下次重启",
    lastRestart: "最近重启",
    lastError: "最近错误"
  },
  skillModal: {
    location: "位置",
    references: "引用文件",
    commands: "业务命令",
    loadingReference: "加载中...",
    copySource: "复制原文",
    loadingContent: "正在加载 skill 内容...",
    modeAria: "Skill 内容展示模式",
    preview: "预览",
    source: "原文"
  },
  detailModal: {
    tool: "工具",
    skill: "技能",
    task: "后台任务",
    close: "关闭",
    inputSchema: "输入结构",
    noParameters: "此工具没有参数。",
    paramOptional: "可选",
    paramRequired: "必填",
    status: "状态",
    sessionTitle: "会话标题",
    session: "Session",
    turn: "Turn",
    card: "Card",
    pid: "PID",
    started: "开始时间",
    ended: "结束时间",
    duration: "耗时",
    exitCode: "退出码",
    cwd: "CWD",
    command: "命令",
    outputTail: "输出尾部",
    noOutput: "无输出"
  },
  skillTypes: {
    default: "默认",
    amazon_fba: "Amazon FBA",
    amazon_replenish: "Amazon Replenish",
    amazon_operations: "Amazon Operations",
    uncategorized: "未分类"
  },
  mermaid: {
    renderError: (message: string) => `Mermaid 渲染错误：${message}`,
    rendering: "正在渲染 Mermaid 图..."
  },
  desktop: {
    loading: "正在加载 LXE Agent…",
    preloadUnavailable: "桌面 preload bridge 不可用，LXE Agent 无法在普通浏览器中运行。",
    settingsTitle: "设置",
    closeSettings: "关闭设置",
    menuAria: "设置菜单",
    unsavedChanges: "有未保存修改",
    closeNotice: "关闭提示",
    interfaceLanguage: "界面语言",
    importEnv: "从 .env 导入",
    importEnvHint: "读取本地配置文件",
    integrationsGroup: "业务集成",
    cancel: "取消",
    listSeparator: "、",
    keepBlankSuffix: "（留空则保持不变）",
    storedPlaceholder: "已安全保存",
    clearIntegration: "清除配置并停用",
    fontSizeStatus: (label: string) => `字体：${label}`,
    fontSizeOptions: {
      small: { label: "小", description: "更紧凑" },
      standard: { label: "标准", description: "默认" },
      large: { label: "大", description: "更易阅读" }
    },
    cloudStates: {
      connected: "已连接",
      connecting: "连接中",
      provisioning: "配置中",
      offline: "离线",
      error: "需处理",
      unsupported: "仅 Windows",
      not_configured: "未配置"
    },
    sectionStatus: {
      complete: "已完成",
      required: "必填",
      configured: "已配置",
      incomplete: "待补全",
      optional: "可选"
    },
    logProfiles: {
      off: "关闭",
      standard: "标准",
      diagnostic: "排障"
    },
    sinkStates: {
      writing: "写入中",
      disabled: "已关闭",
      missingConfig: "配置缺失",
      failed: "写入失败",
      notStarted: "未启动"
    },
    integrationNames: {
      ziniao: "紫鸟",
      mabang: "马帮",
      feishu: "飞书"
    },
    sectionTitles: {
      status: "运行状态",
      appearance: "外观",
      cloud: "公司云端",
      base: "基础设置",
      ziniao: "紫鸟自动化",
      mabang: "马帮",
      feishu: "飞书",
      logging: "日志与排障"
    },
    status: {
      description: "查看桌面核心组件、运行目录和当前后台状态。",
      maintenance: "运行维护",
      maintenanceHint: "查看目录或重新启动桌面后台。",
      restarting: "重启中…",
      restart: "重启后台",
      directories: "运行目录",
      resourceRoot: "资源目录",
      dataRoot: "数据目录",
      workspaceRoot: "新会话默认工作区"
    },
    appearance: {
      description: "调整整个界面的文字大小，选择后立即生效。",
      fontSizeAria: "字体大小"
    },
    cloud: {
      description: "连接公司内网并启用每小时云端同步。",
      connectedBadge: "已连接",
      configuredBadge: "已配置",
      unconfiguredBadge: "未配置",
      unsupportedBadge: "仅 Windows",
      unsupportedHint: "请在 Windows 10/11 x64 安装包中导入管理员提供的设备文件。",
      selectEnrollment: "选择 .lxe-enroll 设备文件",
      oneTimePassword: "一次性密码",
      passwordPlaceholder: "输入管理员单独发送的密码",
      activating: "正在配置…",
      activate: "激活",
      connected: "公司云端连接正常",
      checking: "正在检查公司网络",
      retry: "重试连接",
      activatedConnected: "公司云端已连接",
      activatedRetry: "公司云端已配置，将自动重试连接"
    },
    base: {
      badge: "必填",
      description: "启动 LXE Agent 所需的模型与本地工作区。",
      provider: "模型服务",
      apiKeySuffixRequired: "（必填）",
      apiKeyPlaceholder: "输入模型 API Key",
      apiKeyStoredPlaceholder: "已通过系统安全存储保存",
      workspace: "新会话默认工作区",
      selectFolder: "选择文件夹"
    },
    ziniao: {
      description: "整组留空即可跳过；开始填写后，所有字段都需要完整。",
      company: "公司名",
      account: "账号",
      accountPlaceholder: "紫鸟账号",
      password: "密码",
      passwordPlaceholder: "紫鸟密码",
      appVersion: "APP 版本",
      appPath: "紫鸟 APP 文件地址",
      appPathPlaceholderMac: "/Applications/紫鸟浏览器.app",
      appPathPlaceholderWindows: "C:\\Program Files\\ZiNiao\\ZiNiao.exe",
      selectApp: "选择紫鸟 APP",
      webdriverPath: "浏览器驱动安装目录",
      webdriverPlaceholder: "驱动可以在首次运行时自动下载",
      selectWebdriver: "选择驱动目录"
    },
    mabang: {
      description: "账号与密码必须成对填写；整组留空即可跳过。",
      account: "马帮账号",
      password: "马帮密码",
      passwordPlaceholder: "输入马帮密码"
    },
    feishu: {
      description: "App ID 与 App Secret 必须成对填写；整组留空即可跳过。",
      appSecret: "App Secret",
      appSecretPlaceholder: "输入 App Secret"
    },
    logging: {
      description: "标准日志适合长期运行，排障日志仅建议在复现问题时开启。",
      profile: "日志档位",
      retention: "保留周期",
      retentionDays: (days: string) => `${days} 天`,
      diagnosticWarning: "排障日志会记录模型通信、紫鸟诊断和飞书原始事件，可能包含消息正文与账号标识。",
      directory: "日志目录",
      openDirectory: "打开目录"
    },
    configImport: {
      eyebrow: "配置导入预览",
      title: (fileName: string) => `确认导入 ${fileName}`,
      hint: "这里只显示检测结果，API Key、密码和 App Secret 不会返回界面。",
      cancelAria: "取消导入",
      ready: "可应用",
      pending: "待补全",
      detected: (fields: string) => `检测到：${fields}`,
      overwrite: (fields: string) => `将覆盖：${fields}`,
      unknownVariables: (count: string) => `另有 ${count} 个无关变量会被忽略。`,
      diagnosticConfirm: "我了解排障日志可能包含飞书消息正文、账号标识和页面上下文。",
      applying: "正在导入…",
      apply: "确认导入并应用",
      progress: "正在导入配置并重启服务…",
      successImported: (groups: string) => `已导入：${groups}`,
      successProcessed: "配置文件已处理",
      successPending: (groups: string) => `；待补全：${groups}`,
      successSkipped: (count: string) => `；已跳过 ${count} 个未知变量`,
      successWarnings: (count: string) => `；${count} 项注意事项`
    },
    confirm: {
      diagnosticTitle: "开启排障日志？",
      clearTitle: (label: string) => `清除${label}配置？`,
      diagnosticDescription: "排障日志可能包含飞书消息正文、账号标识和页面上下文。仅建议在复现问题时开启，完成后请恢复为标准或关闭。",
      clearDescription: (label: string) => `保存的${label}密码也会被删除，相关集成将立即停用。`,
      diagnosticConfirm: "确认开启并保存",
      clearConfirm: "清除并停用"
    },
    onboarding: {
      eyebrow: "首次启动",
      title: "配置你的 LXE Agent",
      copy: "基础设置完成即可启动，业务集成也可以稍后在设置中补充。",
      footerAppearance: "外观选择会自动保存在当前设备",
      footerCloud: "公司云端可以稍后配置",
      footerBase: "基础设置完成后即可启动",
      applying: "正在应用配置…",
      starting: "正在启动…",
      submit: "保存并启动"
    },
    settings: {
      applying: "正在应用配置…",
      saving: "保存中…",
      submit: "保存设置"
    }
  },
  fatal: {
    title: "界面启动失败",
    description: "应用没有完成界面初始化。请重新加载；如果问题持续出现，请查看终端或应用日志。",
    reload: "重新加载"
  },
  errors: {
    dashboardLoad: "Dashboard 数据加载中...",
    api: "API 错误"
  }
};

export type UiText = typeof ZH_TEXT;

export const UI_TEXT: Record<Language, UiText> = {
  zh: ZH_TEXT,
  en: {
    language: {
      label: "Language",
      zh: "中文",
      en: "EN"
    },
    app: {
      eyebrow: "Local Agent Workspace",
      title: "LXE Agent",
      subtitle: "Sessions, agent capabilities, and activity from the running gateway.",
      apiOnline: "API online",
      apiOffline: "API offline"
    },
    nav: {
      home: "Home",
      sessions: "Sessions",
      workbench: "Workbench",
      capabilities: "Capabilities",
      activity: "Activity",
      models: "Models",
      tools: "Tools",
      skills: "Skills",
      connections: "Connections",
      tasks: "Tasks",
      usage: "Stats",
      aria: "Dashboard sections"
    },
    sidebar: {
      collapse: "Collapse sidebar",
      expand: "Expand sidebar",
      statusAndSettings: "Settings"
    },
    home: {
      title: "Welcome to LXE Agent",
      subtitle: "Review session history or manage agent capabilities and activity.",
      greetingMorning: "Good morning",
      greetingAfternoon: "Good afternoon",
      greetingEvening: "Good evening",
      overviewHint: "Here is the last 24 hours at a glance",
      todayTurns: "Turns",
      todayExecutions: "Skill runs",
      todayFailures: "Failed runs",
      todayTokens: "Tokens",
      runtimeStatusAria: "Live runtime status",
      runtimeStatus: "Runtime status",
      openStatusSettings: "Settings",
      openRuntimeStatus: "Open runtime status",
      closeRuntimeStatus: "Close runtime status",
      currentModel: "Current model",
      gateway: "Gateway",
      agent: "Agent",
      feishu: "Feishu",
      companyCloud: "Company cloud",
      lastChecked: (value: string) => `Checked ${value}`,
      runtimeTones: {
        healthy: "Running normally",
        progress: "In progress",
        warning: "Needs attention",
        neutral: "Status pending"
      },
      componentStates: {
        ready: "Running",
        starting: "Starting",
        stopped: "Stopped",
        error: "Error"
      },
      channelStates: {
        connected: "Connected",
        connecting: "Connecting",
        error: "Error",
        disabled: "Disabled",
        unconfigured: "Not configured",
        unavailable: "Unavailable"
      },
      cloudStates: {
        not_configured: "Not configured",
        provisioning: "Provisioning",
        connecting: "Connecting",
        connected: "Connected",
        offline: "Offline",
        error: "Error",
        unsupported: "Unsupported on this platform"
      },
      recentSessions: "Recent sessions",
      activeSkills: "Active skills · 7 days",
      viewAllSessions: "View all",
      viewStats: "Open stats",
      noSessions: "No sessions yet",
      noSkills: "No skill usage in the last 7 days",
      executionsUnit: (count: string) => `${count} runs`,
      loadError: "Failed to load overview"
    },
    workbench: {
      eyebrow: "Workbench · Media tools",
      title: "Amazon AI performer tag",
      subtitle: "Add Amazon's AI performer media tag to images and videos in batches. Original files are never modified.",
      windowsOnly: "Not supported on this platform",
      windowsOnlyHint: "This tool is currently available only in the Windows and macOS desktop apps.",
      sourceTitle: "Select media",
      sourceHint: "Choose multiple media files or one folder. JPG, JPEG, PNG, MP4, and MOV are supported.",
      selectFiles: "Select media files",
      selectFilesHint: "Select multiple images and videos",
      selectFolder: "Select a folder",
      selectFolderHint: "Only the top level by default",
      selectionReady: "Media source selected",
      includeSubfolders: "Include subfolders",
      scanning: "Scanning…",
      scan: "Scan tags",
      reviewTitle: "Review results",
      reviewHint: "See which files need the tag before creating copies.",
      preparing: "Preparing…",
      progress: (processed: number, total: number) => total > 0
        ? `Processed ${processed} / ${total}`
        : "Processing the current file",
      cancel: "Cancel task",
      statuses: {
        needs_tag: "Needs tag",
        already_tagged: "Already tagged",
        unsupported: "Unsupported",
        failed: "Failed",
        tagged: "Tagged",
        copied: "Copied"
      },
      file: "File",
      kind: "Type",
      size: "Size",
      status: "Status",
      mediaTypes: {
        image: "Image",
        video: "Video"
      },
      noItems: "No media files to show.",
      outputTitle: "Create tagged copies",
      outputHint: "Choose a destination. The app creates a separate task folder and never overwrites an existing file.",
      selectOutput: "Select output folder",
      generating: "Generating…",
      generate: "Create media copies",
      complete: "Task complete",
      completeHint: "The tagged media copies are ready in the task output folder.",
      completeWithFailures: "Task finished with failures",
      completeWithFailuresHint: "Successful files are ready. Review the errors above before retrying the remaining files.",
      openOutput: "Open output folder",
      disclaimer: "This tool only adds and verifies metadata. It does not decide whether media contains an AI-generated performer, and it does not check resolution, duration, or other Amazon upload requirements."
    },
    stats: {
      sessions: "Sessions",
      toolCalls: "Tool Calls",
      tokens: "Tokens",
      messages: "Raw messages",
      apiCalls: "API Calls"
    },
    common: {
      loading: "loading",
      updating: "Updating…",
      copied: "Copied",
      unknown: "unknown",
      unnamedSession: "Untitled session",
      previous: "Previous",
      next: "Next",
      pageIndex: (current: string, total: string) => `Page ${current} / ${total}`,
      errorPrefix: (label: string, message: string) => `${label}: ${message}`,
      countItems: (count: string, unit: string) => `${count} ${unit}`,
      yes: "yes",
      no: "no",
      none: "none",
      notSupported: "not supported",
      fallbackTool: "tool",
      block: "block"
    },
    role: {
      user: "user",
      assistant: "assistant",
      tool: "tool",
      system: "system",
      unknown: "unknown"
    },
    sessions: {
      title: "Sessions",
      newConversation: "New chat",
      newConversationAria: "Start a new chat",
      searchPlaceholder: "Search sessions",
      searchAria: "Search sessions",
      closeSearch: "Close session search",
      recent: "Recent chats",
      selectPrompt: "Select a session to view details.",
      searchResults: (count: string) => `${count} search results`,
      total: (count: string) => `${count} total`,
      empty: "No sessions yet.",
      emptySearch: "No matching sessions.",
      loading: "Loading sessions...",
      errorLabel: "Sessions error",
      columnSession: "Session",
      tokenSuffix: "Token"
    },
    sessionDetail: {
      back: "Sessions",
      eyebrow: "Session Detail",
      details: "Details",
      hideDetails: "Hide details",
      sessionId: "Session ID",
      source: "Initial source",
      directory: "Working directory",
      worktree: "Git worktree root",
      model: "Historical model",
      lastActive: "Last active",
      loading: "Loading conversation...",
      errorLabel: "Session error",
      empty: "This session has no conversation records.",
      pageBlocks: (visible: string, total: string) => `${visible} / ${total} conversation blocks on this page`,
      rawMessages: (count: string) => `${count} raw messages`,
      loadEarlier: "Load earlier messages",
      loadingEarlier: "Loading earlier messages…",
      retryEarlier: "Retry loading"
    },
    conversation: {
      newTitle: "New chat",
      newHint: "Send a message or add files to start a conversation with the Agent.",
      placeholder: "Message the Agent…",
      send: "Send",
      stop: "Stop",
      stopping: "Stopping…",
      queued: "Queued",
      queuedCount: (count: string) => `${count} messages waiting`,
      running: "Agent is working",
      completed: "Response complete",
      cancelled: "Stopped",
      error: "Run failed",
      unavailable: "Gateway or Agent is not ready",
      inputHint: "Enter to send, Shift + Enter for a new line",
      characterCount: (count: string, maximum: string) => `${count} / ${maximum}`,
      preparingContext: "Preparing context",
      waitingModel: "Waiting for model",
      thinking: "Thinking",
      runningTool: "Running tools",
      generatingAnswer: "Generating response",
      process: "Process",
      workedFor: (duration: string) => `Worked for ${duration}`,
      processFailed: (duration: string) => duration ? `Failed after ${duration}` : "Process failed",
      processCancelled: (duration: string) => duration ? `Stopped after ${duration}` : "Stopped",
      elapsedDuration: (milliseconds: number) => {
        const seconds = Math.max(0, Math.round(milliseconds / 1_000));
        if (seconds < 1) return "<1s";
        const hours = Math.floor(seconds / 3_600);
        const minutes = Math.floor((seconds % 3_600) / 60);
        const remainder = seconds % 60;
        return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", remainder ? `${remainder}s` : ""]
          .filter(Boolean).join(" ");
      },
      sending: "Sending…",
      jumpToLatest: "Jump to latest",
      files: (count: string) => `Output files · ${count}`,
      attachments: "Attached files",
      addFiles: "Add files",
      dropFiles: "Drop to add files to this chat",
      tooManyAttachments: "You can attach at most 5 files per turn",
      removeAttachment: (name: string) => `Remove ${name}`,
      openFile: (name: string) => `Open ${name}`,
      openFileFailed: (reason: string) => `Could not open the file: ${reason}`
    },
    message: {
      thinking: "Thinking",
      redactedThinking: "Some thinking is encrypted and cannot be displayed",
      toolCalls: "tool calls",
      toolResult: "tool result",
      toolResultError: "tool result error",
      toolResultTruncated: (preview: string, original: string) => `Dashboard preview: ${preview} / ${original} bytes`,
      copyResult: "Copy result",
      toolActivity: "tool activity",
      toolOperation: "Tool activity",
      toolContinuation: "Tool activity continuation",
      toolActions: {
        read: "Read",
        edit: "Edit",
        write: "Write",
        search: "Search",
        list: "List",
        run: "Run command",
        send: "Send file",
        web: "Access web",
        tool: "Call tool"
      },
      toolBatchMore: (count: number) => `${count} more`,
      toolBatchFailures: (count: number) => `${count} failed`,
      calls: "calls",
      results: "results",
      error: "error"
    },
    models: {
      subtitle: "Choose the model and thinking mode for upcoming conversations.",
      model: "Model",
      currentModel: "Current model",
      current: "Current",
      switching: "Switching",
      setCurrent: "Set current",
      effectiveNextTurn: "Model changes take effect on the next turn",
      context: "Context",
      output: "Output",
      vision: "Vision",
      capabilities: "Model capabilities",
      thinking: "Thinking",
      providerManaged: "Managed automatically by the model",
      modelOptionUnavailable: "Model option is not available",
      providerNotSelectable: "Not selectable in WebUI",
      missingApiKey: "Missing API key"
    },
    tools: {
      subtitle: "View and manage the toolsets available to the agent.",
      parameters: (count: string) => `${count} parameters`,
      resource: (name: string) => `Resource · ${name}`,
      itemUnit: "tools",
      emptyToolset: "This toolset has no tools to show.",
      servers: "MCP Servers",
      serverUnit: "servers",
      mcpTools: "MCP Tools",
      status: "Status",
      enabled: "Enabled",
      disabled: "Disabled",
      enable: "Enable",
      disable: "Disable",
      saving: "Saving",
      noServers: "No MCP servers."
    },
    tasks: {
      empty: "No background tasks.",
      itemUnit: "tasks",
      task: "Task",
      status: "Status",
      session: "Session",
      command: "Command",
      duration: "Duration",
      startedAt: "Started"
    },
    skills: {
      subtitle: "Browse the skills, commands, and references available to the agent.",
      itemUnit: "skills",
      empty: "No skills are available for the current agent.",
      refs: (count: string) => `${count} refs`,
      commands: (count: string) => `${count} commands`,
      commandUnit: "commands",
      maintenanceCommands: "Maintenance commands",
      maintenanceDescription: "System maintenance and diagnostics",
      maintenanceNote: "Scheduled by Bun Maintenance and available for manual use; this is not a model Tool.",
      defaultGroup: "Default",
      uncategorized: "Uncategorized"
    },
    usage: {
      title: "Usage Stats",
      rangeAria: "Stats time range",
      rangeDays: (days: string) => `${days} days`,
      loading: "Loading stats...",
      errorLabel: "Stats error",
      empty: "No usage data in the selected range.",
      totalsTurns: "Turns",
      totalsErrorTurns: "Error Turns",
      totalsToolCalls: "Tool Calls",
      totalsExecutions: "Skill Runs",
      totalsFailures: "Failed Runs",
      totalsTokens: "Tokens",
      dailyTitle: "Daily Trend",
      dailyLegendTurns: "Turns",
      dailyLegendExecutions: "Skill runs",
      chartModeAria: "Chart type",
      chartModeBars: "Bars",
      chartModeLine: "Line",
      modulesTitle: "Modules",
      skillsTitle: "Skills",
      toolsTitle: "Tools",
      columnName: "Name",
      columnSkills: "Skills",
      columnTurns: "Turns",
      columnActivations: "Activations",
      columnExecutions: "Runs",
      columnFailures: "Failures",
      columnSuccessRate: "Success",
      columnAvgDuration: "Avg Duration",
      columnCalls: "Calls",
      columnErrors: "Errors",
      columnLastUsed: "Last Used",
      executionsBadge: (count: string) => `${count} runs`,
      successRateBadge: (pct: string) => `${pct} success`
    },
    connectors: {
      subtitle: "Control whether agents can see platform CLI skills.",
      businessConnections: "Business connections",
      businessConnectionsDescription: "Manage platform capabilities and their visibility to the agent.",
      mcpConnections: "MCP services",
      mcpConnectionsDescription: "Manage external services that provide tools to the agent.",
      configureCredentials: "Configure credentials",
      itemUnit: "skills",
      empty: "No connectors.",
      enabled: "Enabled",
      disabled: "Disabled",
      enable: "Enable",
      disable: "Disable",
      saving: "Saving",
      kind: "Kind",
      note: "Disabling hides this connector's CLI skills from agents; it does not uninstall the CLI or clear auth.",
      healthUnavailable: "Health unavailable",
      channelHealth: "Feishu channel",
      wsConnected: "Feishu connected",
      wsDisconnected: "Feishu disconnected",
      wsRestarting: "Feishu restarting",
      wsStopped: "Feishu stopped",
      wsFailed: "Feishu connection failed",
      wsUnknown: "Feishu status unknown",
      monitorRunning: "Auto-restart monitor running",
      monitorStopped: "Auto-restart monitor stopped",
      nextRestart: "Next restart",
      lastRestart: "Last restart",
      lastError: "Last error"
    },
    skillModal: {
      location: "Location",
      references: "References",
      commands: "Business commands",
      loadingReference: "loading...",
      copySource: "Copy source",
      loadingContent: "Loading skill content...",
      modeAria: "Skill content display mode",
      preview: "Preview",
      source: "Source"
    },
    detailModal: {
      tool: "Tool",
      skill: "Skill",
      task: "Background Task",
      close: "Close",
      inputSchema: "Input schema",
      noParameters: "This tool has no parameters.",
      paramOptional: "Optional",
      paramRequired: "Required",
      status: "Status",
      sessionTitle: "Session title",
      session: "Session",
      turn: "Turn",
      card: "Card",
      pid: "PID",
      started: "Started",
      ended: "Ended",
      duration: "Duration",
      exitCode: "Exit code",
      cwd: "CWD",
      command: "Command",
      outputTail: "Output tail",
      noOutput: "no output"
    },
    skillTypes: {
      default: "Default",
      amazon_fba: "Amazon FBA",
      amazon_replenish: "Amazon Replenish",
      amazon_operations: "Amazon Operations",
      uncategorized: "Uncategorized"
    },
    mermaid: {
      renderError: (message: string) => `Mermaid render error: ${message}`,
      rendering: "Rendering Mermaid diagram..."
    },
    desktop: {
      loading: "Loading LXE Agent…",
      preloadUnavailable: "The desktop preload bridge is unavailable; LXE Agent cannot run in a regular browser.",
      settingsTitle: "Settings",
      closeSettings: "Close settings",
      menuAria: "Settings menu",
      unsavedChanges: "Unsaved changes",
      closeNotice: "Dismiss notice",
      interfaceLanguage: "Interface language",
      importEnv: "Import from .env",
      importEnvHint: "Read a local config file",
      integrationsGroup: "Integrations",
      cancel: "Cancel",
      listSeparator: ", ",
      keepBlankSuffix: " (leave blank to keep it unchanged)",
      storedPlaceholder: "Saved securely",
      clearIntegration: "Clear configuration and disable",
      fontSizeStatus: (label: string) => `Font: ${label}`,
      fontSizeOptions: {
        small: { label: "Small", description: "More compact" },
        standard: { label: "Standard", description: "Default" },
        large: { label: "Large", description: "Easier to read" }
      },
      cloudStates: {
        connected: "Connected",
        connecting: "Connecting",
        provisioning: "Provisioning",
        offline: "Offline",
        error: "Needs attention",
        unsupported: "Windows only",
        not_configured: "Not configured"
      },
      sectionStatus: {
        complete: "Complete",
        required: "Required",
        configured: "Configured",
        incomplete: "Needs completion",
        optional: "Optional"
      },
      logProfiles: {
        off: "Off",
        standard: "Standard",
        diagnostic: "Diagnostic"
      },
      sinkStates: {
        writing: "Writing",
        disabled: "Off",
        missingConfig: "Missing config",
        failed: "Write failed",
        notStarted: "Not started"
      },
      integrationNames: {
        ziniao: "ZiNiao",
        mabang: "Mabang",
        feishu: "Feishu"
      },
      sectionTitles: {
        status: "Runtime status",
        appearance: "Appearance",
        cloud: "Company cloud",
        base: "Basic settings",
        ziniao: "ZiNiao automation",
        mabang: "Mabang",
        feishu: "Feishu",
        logging: "Logs & diagnostics"
      },
      status: {
        description: "View the desktop core components, runtime directories, and current background status.",
        maintenance: "Maintenance",
        maintenanceHint: "Open directories or restart the desktop background services.",
        restarting: "Restarting…",
        restart: "Restart services",
        directories: "Runtime directories",
        resourceRoot: "Resource directory",
        dataRoot: "Data directory",
        workspaceRoot: "Default workspace for new sessions"
      },
      appearance: {
        description: "Adjust the text size across the interface; changes apply immediately.",
        fontSizeAria: "Font size"
      },
      cloud: {
        description: "Connect to the company intranet and enable hourly cloud sync.",
        connectedBadge: "Connected",
        configuredBadge: "Configured",
        unconfiguredBadge: "Not configured",
        unsupportedBadge: "Windows only",
        unsupportedHint: "Import the device file from your admin with the Windows 10/11 x64 installer.",
        selectEnrollment: "Choose a .lxe-enroll device file",
        oneTimePassword: "One-time password",
        passwordPlaceholder: "Enter the password sent separately by your admin",
        activating: "Provisioning…",
        activate: "Activate",
        connected: "Company cloud connection is healthy",
        checking: "Checking the company network",
        retry: "Retry connection",
        activatedConnected: "Company cloud connected",
        activatedRetry: "Company cloud configured; the connection will retry automatically"
      },
      base: {
        badge: "Required",
        description: "The model service and local workspace required to start LXE Agent.",
        provider: "Model provider",
        apiKeySuffixRequired: " (required)",
        apiKeyPlaceholder: "Enter the model API key",
        apiKeyStoredPlaceholder: "Saved in the system secure storage",
        workspace: "Default workspace for new sessions",
        selectFolder: "Choose folder"
      },
      ziniao: {
        description: "Leave the whole group blank to skip; once you start filling it in, every field is required.",
        company: "Company name",
        account: "Account",
        accountPlaceholder: "ZiNiao account",
        password: "Password",
        passwordPlaceholder: "ZiNiao password",
        appVersion: "App version",
        appPath: "ZiNiao app file path",
        appPathPlaceholderMac: "/Applications/紫鸟浏览器.app",
        appPathPlaceholderWindows: "C:\\Program Files\\ZiNiao\\ZiNiao.exe",
        selectApp: "Choose the ZiNiao app",
        webdriverPath: "Browser driver install directory",
        webdriverPlaceholder: "The driver can be downloaded automatically on first run",
        selectWebdriver: "Choose the driver directory"
      },
      mabang: {
        description: "Account and password must be filled in together; leave the whole group blank to skip.",
        account: "Mabang account",
        password: "Mabang password",
        passwordPlaceholder: "Enter the Mabang password"
      },
      feishu: {
        description: "App ID and App Secret must be filled in together; leave the whole group blank to skip.",
        appSecret: "App Secret",
        appSecretPlaceholder: "Enter the App Secret"
      },
      logging: {
        description: "Standard logs suit long-term use; enable diagnostic logs only while reproducing an issue.",
        profile: "Log level",
        retention: "Retention",
        retentionDays: (days: string) => `${days} days`,
        diagnosticWarning: "Diagnostic logs record model traffic, ZiNiao diagnostics, and raw Feishu events, and may include message content and account identifiers.",
        directory: "Log directory",
        openDirectory: "Open directory"
      },
      configImport: {
        eyebrow: "Config import preview",
        title: (fileName: string) => `Import ${fileName}`,
        hint: "Only detection results are shown here; API keys, passwords, and app secrets never return to the interface.",
        cancelAria: "Cancel import",
        ready: "Ready to apply",
        pending: "Needs completion",
        detected: (fields: string) => `Detected: ${fields}`,
        overwrite: (fields: string) => `Will overwrite: ${fields}`,
        unknownVariables: (count: string) => `${count} unrelated variables will be ignored.`,
        diagnosticConfirm: "I understand diagnostic logs may include Feishu message content, account identifiers, and page context.",
        applying: "Importing…",
        apply: "Confirm import and apply",
        progress: "Importing configuration and restarting services…",
        successImported: (groups: string) => `Imported: ${groups}`,
        successProcessed: "Config file processed",
        successPending: (groups: string) => `; pending: ${groups}`,
        successSkipped: (count: string) => `; skipped ${count} unknown variables`,
        successWarnings: (count: string) => `; ${count} warnings`
      },
      confirm: {
        diagnosticTitle: "Enable diagnostic logs?",
        clearTitle: (label: string) => `Clear ${label} settings?`,
        diagnosticDescription: "Diagnostic logs may include Feishu message content, account identifiers, and page context. Enable them only while reproducing an issue, then switch back to standard or off.",
        clearDescription: (label: string) => `The saved ${label} password will also be deleted and the integration will stop immediately.`,
        diagnosticConfirm: "Enable and save",
        clearConfirm: "Clear and disable"
      },
      onboarding: {
        eyebrow: "First launch",
        title: "Set up your LXE Agent",
        copy: "Finish the basic settings to start; business integrations can be added later in Settings.",
        footerAppearance: "Appearance choices are saved automatically on this device",
        footerCloud: "Company cloud can be configured later",
        footerBase: "Finish the basic settings to start",
        applying: "Applying configuration…",
        starting: "Starting…",
        submit: "Save and start"
      },
      settings: {
        applying: "Applying configuration…",
        saving: "Saving…",
        submit: "Save settings"
      }
    },
    fatal: {
      title: "Failed to start the interface",
      description: "The app did not finish initializing the interface. Reload to try again; if the problem persists, check the terminal or app logs.",
      reload: "Reload"
    },
    errors: {
      dashboardLoad: "Loading dashboard data...",
      api: "API error"
    }
  }
};

export const I18nContext = React.createContext<UiText>(ZH_TEXT);

export function useUiText(): UiText {
  return React.useContext(I18nContext);
}

export function isLanguage(value: string | null): value is Language {
  return value === "zh" || value === "en";
}

export function initialLanguage(
  storage?: Pick<Storage, "getItem" | "setItem">,
): Language {
  try {
    const target = storage ?? window.localStorage;
    const stored = target.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(stored)) return stored;
    const legacy = target.getItem(LEGACY_LANGUAGE_STORAGE_KEY);
    if (!isLanguage(legacy)) return "zh";
    target.setItem(LANGUAGE_STORAGE_KEY, legacy);
    return legacy;
  } catch {
    return "zh";
  }
}
