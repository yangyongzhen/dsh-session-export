# dsh 插件开发实战：从零实现一个会话导出插件

> 本文以 `dsh-session-export`（会话导出与复盘插件）为完整案例，讲解 DeepSeek Harness（dsh）插件的机制、研究方法和实现模式。读完你可以照着写自己的插件：从包结构、patch 层、事件订阅，到构建、安装、端到端验证。
>
> 配套源码：`../`（dsh-session-export 项目根目录）；运行环境：dsh 0.1.0-rc.6，Node 24，Windows。

---

## 1. 为什么写这个插件

dsh 的官方 `headless` 模式跑完一次性任务后只打印"最后一条 assistant 文本"，**没有完整的会话导出**。而"复盘 agent 干了什么"是所有人的刚需：

- 写技术博客（agent 怎么一步步完成任务）
- 任务复盘（在哪一步烧了多少钱、哪个工具出错）
- 审计（长任务 10 小时级的完整轨迹）
- 喂给另一个模型做分析

这个插件做的事情：监听 dsh 的会话事件流，`turn/end` 后静默片刻，把整个会话（消息、工具调用、token 统计、任务清单、错误）渲染成 Markdown 落到磁盘。进程退出时同步 flush，headless 一次性任务也不丢记录。

选择它作为教程案例的原因：**规模适中**（两个源文件）、**纯 JS/TS 无原生依赖**、**不依赖 UI 层**（事件层是插件最通用的接入点）、**能完整走通"研究 → 设计 → 实现 → 安装 → 验证"全流程**。

---

## 2. dsh 插件机制速览

### 2.1 一切皆插件

dsh 的架构一句话：**Everything is a Plugin**。底层由 [Cordis](https://github.com/cordiverse/cordis) 驱动——一个极小的运行时，其中模型适配器、工具、文件访问、agent loop 本身都是挂载到共享上下文（`Context`，即 `ctx`）上的插件。

配置模型是三层叠加：

```
profile（~/.dsh/profiles/<name>）
 ├─ bundle 层   ← dsh.profile.bundles 里声明的组合包，按顺序叠加
 ├─ 用户层       ← profile 的 cordis.patch.yml
 └─ 覆盖层       ← $DSH_HOME/cordis.patch.yml + --patch overlays
```

每个 bundle 包通过 `package.json` 里的 `dsh.bundle.patch` 声明自己的配置补丁，dsh 启动时把补丁打进配置树，然后由 Loader 逐个挂载插件。

### 2.2 插件是什么

一个插件 = 一个 `apply(ctx)` 函数（另有对象形态和 Service 类形态）：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello'
export const inject = ['sessions']  // 依赖就绪后才执行 apply

export function apply(ctx: Context) {
  // 通过 ctx 注册的一切，在插件卸载时自动撤销（含 HMR 热替换）
  ctx.on('session/event', (session, event) => { ... })
  ctx.effect(() => {
    const connection = open()
    return () => connection.close()  // 卸载时执行的清理
  })
}
```

生命周期是一个 Fiber 状态机：`PENDING → LOADING → ACTIVE / FAILED → UNLOADING → DISPOSED`。声明了 `inject` 的插件会等依赖服务全部就绪再执行；依赖消失会自动卸载，恢复后重新加载。

### 2.3 关键扩展点

| 能力 | API |
|---|---|
| 注册工具 | `ctx.tools.register(tool)` |
| 注册模型适配器 | `ctx.llm.registerAdapter(names, adapter)` |
| 订阅事件 | `ctx.on(event, handler)` |
| 获取服务 | `ctx.get('sessions')`（或 `inject` 声明后直接 `ctx.sessions`） |
| 注册服务 | Service 子类 + `ctx.plugin(MyService)` |
| 配置校验 | schemastery 的 `z.object({...})` |
| 自定义资源清理 | `ctx.effect(() => () => cleanup())` |

**事件模型（会话层）**：会话是一个 append-only 的事件日志（event-sourced），每个事件 `{ type, seq, time, data }`。核心事件类型：

| 类型 | data | 说明 |
|---|---|---|
| `turn/start` / `turn/end` | `{turn}` / `{turn, reason}` | 回合边界，reason 有 completed/error/max-tokens/aborted/blocked/interrupted |
| `step/start` / `step/end` | `{turn, step}` | 一步 = 一次模型调用 + 它发起的工具执行 |
| `user/message` | `UserMessage` | 用户提示词 / 注入上下文 / 目标延续（`source.kind` 区分） |
| `assistant/message` | `{message, usage?}` | 模型输出 + token 消耗（input/output/cacheRead/cacheWrite） |
| `tool/call` / `tool/result` | `{name, arguments}` / `{message, error?}` | 工具调用与结果 |
| `todo/write` | `{todos}` | 任务清单快照 |
| `request/header` | `{header}` | 请求配置（provider/model、system prompt、工具 schema） |

**事件流订阅**：`ctx.on('session/event', (session, event) => ...)` 是 post-commit 的追加流——所有会话的所有事件都会到这里，这是导出/遥测类插件的标准接入点。

### 2.4 一个 bundle 包的最小结构

```
my-plugin/
├── package.json          # name + dsh.bundle.patch 声明 + 依赖
├── cordis.patch.yml      # 补丁：把插件行插入配置树
├── src/                  # TypeScript 源码
├── lib/                  # tsc 构建产物（提交入库，安装免构建）
└── README.md
```

`cordis.patch.yml` 用 `insert` 把插件行追加进配置树（参考 dsh-headless 的做法）：

```yaml
- insert:
    - id: session-export
      name: 'dsh-session-export'
      inject: [sessions]
```

安装后 dsh 把 `dsh-session-export` 加入 profile 的 `dsh.profile.bundles`，每次启动自动叠加该层。

---

## 3. 开发前的研究方法：怎么从安装包里摸清 API

dsh 官方文档（[Quickstart](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)、[Cordis 教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/)、[框架文档](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)）讲原理，但**具体 API 的权威来源是安装包里编译后的 `lib/` 与 `.d.ts` 文件**。研究顺序：

1. **找现成例子**：`dsh-headless` 就是"创建 agent → 驱动任务 → 读会话结果"的完整实现，`dsh-session` 定义会话数据模型。它们都在 npm 全局安装目录的依赖闭包里：

   ```
   <node_prefix>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/
   ├── dsh-headless/lib/index.js      # 一次性任务驱动（读结果）
   ├── dsh-session/lib/types/         # 会话服务与事件类型（.d.ts 最权威）
   └── dsh-session-persistence-jsonl/ # 持久化格式
   ```

2. **读 .d.ts 而不是猜**：`SessionEvent` 是判别联合（switch `event.type` 自动收窄 `data`）；`SessionStore` 提供 `list()/get()/flush()`；`Session` 暴露 `events/seq/header/id`。`TokenUsage = { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`——字段名和直觉不同，不看类型必踩坑。

3. **验证数据格式**：持久化文件在 `~/.dsh/sessions/<项目key>/<sessionId>/session.jsonl.zstd`，Node 24 原生支持 `node:zlib` 的 zstd 解压：

   ```js
   const { zstdDecompressSync } = require('node:zlib')
   const record = JSON.parse(zstdDecompressSync(fs.readFileSync(file)).toString('utf8'))
   // { type:'session', version, id, createdAt, cwd, delegationDepth, agentPreset, ... }
   ```

---

## 4. 插件设计

### 4.1 功能

1. **自动导出**：订阅 `session/event`，`turn/end` 后防抖 `debounceMs`（默认 1s），把该会话渲染成 Markdown 写到 `$DSH_HOME/exports/`。
2. **dispose flush**：插件卸载（进程退出）时，把防抖窗口内还没导出的会话立即同步写出——headless 跑完就退出进程，靠这个不丢记录。
3. **渲染管线独立成纯函数**：`events → Markdown`，不依赖 dsh 运行时，可单测、可被其他插件 import 复用。

### 4.2 配置项（schemastery Schema）

```ts
const Config = z.object({
  enabled: z.boolean().default(true),   // 总开关
  outDir: z.string(),                   // 导出目录，缺省用 $DSH_HOME/exports
  debounceMs: z.number().default(1000),
  maxResultChars: z.number().default(2000),  // 工具结果截断
  includeInjected: z.boolean().default(false) // 是否包含注入消息
})
```

### 4.3 设计决策

- **事件层接入而非 UI 层**：不依赖 TUI/Web，任何 profile（web/headless/tui）装上就能用。
- **防抖而非立即导出**：一个会话可能有多个 turn（用户继续追问），防抖让"这一轮对话"稳定后再落盘，避免碎片文件。
- **同步写文件**：`writeFileSync`——文件几十 KB，同步写毫秒级完成，且让 dispose flush 可靠（异步 promise 在进程退出时可能等不到）。
- **注入消息默认过滤**：agent 的系统注入（运行时上下文快照、skill 目录）是给模型看的，不是给人复盘的。只保留 `source.kind === 'user' | 'goal'`。

---

## 5. 实现详解

### 5.1 包结构

```jsonc
// package.json
{
  "name": "dsh-session-export",
  "version": "0.1.0",
  "type": "module",                     // ESM
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": { ".": "./lib/index.js", "./cordis.patch.yml": "./cordis.patch.yml" },
  "engines": { "node": "^22.19 || >=24" },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-session": "^0.1.0-rc.6",   // 版本与 dsh 闭包一致
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "devDependencies": { "@types/node": "^22.20.0", "typescript": "^6.0.3" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }   // ← bundle 声明
}
```

```jsonc
// tsconfig.json（关键项）
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",               // ESM：相对导入要写 .js 后缀
    "moduleResolution": "NodeNext",
    "outDir": "lib",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "types": ["node"],                  // 显式指定，避免 @types 自动包含问题
    "verbatimModuleSyntax": true        // type 导入必须 import type
  }
}
```

### 5.2 渲染管线（`src/markdown.ts`）——纯函数，可独立复用

核心是一个按 `seq` 顺序遍历事件流的 switch：

```ts
export function renderSessionMarkdown(events, meta, maxResultChars = 2000, includeInjected = false): string {
  const stats = summarizeStats(events)          // 预先聚合：turns/steps/tokens/耗时/错误
  // 头部：会话 ID、创建时间、cwd、模型、统计摘要
  // 然后按 seq 渲染每个事件……
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':    out.push(`## Turn ${event.data.turn}`, '') ; break
      case 'turn/end':      out.push(`> Turn ${event.data.turn} 结束：**${label}**`, ''); break
      case 'user/message': {
        const kind = event.data.source?.kind as string | undefined
        // source.kind 是跨包可扩展的联合类型，必须宽化成 string 再过滤
        if (!includeInjected && kind !== 'user' && kind !== 'goal') break
        const text = textOf(event.data.content)
        out.push(`### ${userLabel(kind)}`, '', text, '')
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data.message.content)
        out.push('### 助手', '', text, '')
        if (event.data.usage) out.push(`> tokens: in=${usage.inputTokens} · out=${usage.outputTokens} ...`, '')
        break
      }
      case 'tool/call':     out.push(`#### 工具调用：${event.data.name}`, '```json', clip(args), '```', ''); break
      case 'tool/result':   out.push('#### 工具结果', '```', clip(textOf(event.data.message.content)), '```', ''); break
      case 'todo/write':    // 渲染为 checkbox 列表
      case 'request/header':// 记录 provider/model（只在统计里取第一个）
      default: break
    }
  }
  // 尾部：错误记录汇总
}
```

关键细节：

- **工具结果递归提取**：`tool/result` 的消息内容是 `ToolResultBlock { type:'tool-result', content: ContentBlock[], isError? }`——文本嵌在**嵌套**的 `content` 里。渲染要递归：

  ```ts
  type TextBlockLike = { type: string; text?: string; content?: readonly TextBlockLike[] }
  function textOf(content: readonly TextBlockLike[], withReasoning = false): string {
    const parts: string[] = []
    for (const block of content) {
      if (block.type === 'text' && block.text !== undefined) parts.push(block.text)
      else if (block.type === 'tool-result' && block.content !== undefined) parts.push(textOf(block.content, withReasoning))
      else if (withReasoning && block.type === 'reasoning' && block.text !== undefined) parts.push(`[思考] ${block.text}`)
    }
    return parts.join('\n\n')
  }
  ```

- **统计聚合**：`summarizeStats` 遍历一次事件流，累计 turn/step/tool 数量、从 `assistant/message.usage` 汇总 token（含 cacheRead/cacheWrite——DeepSeek 缓存命中的成本关键）、从 `turn/end.reason` 收集错误、首尾事件时间差算耗时、从 `request/header.config` 取 `provider/model`。

### 5.3 插件主体（`src/index.ts`）——事件订阅 + 防抖 + flush

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { renderSessionMarkdown } from './markdown.js'   // ESM 相对导入必须带 .js

const name = 'session-export'
const inject = ['sessions']

// ... Config schema（见 4.2）...

export function exportSession(session: Session, config: SessionExportConfig): string | undefined {
  const events = session.events
  if (!hasContent(events)) return undefined          // 空会话（只有系统注入）不导出
  const markdown = renderSessionMarkdown(events, { sessionId: session.id, ...metaFromHeader(session.header) },
    config.maxResultChars, config.includeInjected)
  const dir = config.outDir ?? join(dshHome(), 'exports')
  mkdirSync(dir, { recursive: true })
  const stem = sanitizeId(session.id).replace(/^session-/, '')   // SessionId 自带 session- 前缀，去掉避免双前缀
  const file = join(dir, `session-${stem}.md`)
  writeFileSync(file, markdown, 'utf8')             // 同步写：dispose flush 可靠
  return file
}

function apply(ctx: Context, config: SessionExportConfig) {
  if (!config.enabled) return

  const timers = new Map<string, NodeJS.Timeout>()
  const pending = new Map<string, Session>()

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/end') return
    const id = session.id
    pending.set(id, session)                        // 记录待导出（dispose 时兜底）
    clearTimeout(timers.get(id))                    // 防抖：重置窗口
    timers.set(id, setTimeout(() => {
      timers.delete(id); pending.delete(id)
      try {
        const file = exportSession(session, config)
        if (file !== undefined) ctx.logger.info(`session-export: wrote ${file}`)
      } catch (error) {
        ctx.logger.warn(`session-export: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, config.debounceMs))
  })

  ctx.effect(() => () => {                          // 插件卸载（进程退出/HMR）时：
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const session of pending.values()) {       // 把窗口内未导出的立即同步写出
      try { exportSession(session, config) } catch { /* 不阻塞 dispose */ }
    }
    pending.clear()
  })
}

export { Config, apply, inject, name }
```

要点：

- `pending` map 是**防抖兜底**：`turn/end` 到防抖到期之间进程退出时，dispose 钩子把未导出的会话直接写出。没有它，headless 一次任务 90% 的导出都会丢（防抖 1s 还没到进程就退了）。
- `ctx.effect(() => cleanup)` 是 cordis 标准的资源清理点（比 `ctx.on('dispose')` 更符合框架语义，后者不在类型化事件表里）。
- 事件回调里所有导出失败都 try/catch + logger，绝不让插件崩溃拖垮 agent。

### 5.4 构建

```sh
pnpm install      # 装 dependencies + typescript
pnpm run build    # tsc → lib/
```

构建产物 `lib/index.js`、`lib/markdown.js` 连同 `.d.ts` 提交入库（和 dsh-TUI 的做法一致），这样 `dsh plugin add file:...` 安装**无需任何构建步骤**。

---

## 6. 安装与端到端验证

### 6.1 安装进 profile

```sh
dsh plugin --profile tui add file:C:/Users/yang/dsh-session-export
```

成功标志：profile 的 `package.json` 里 `dsh.profile.bundles` 出现该包：

```json
"bundles": ["@deepseek-ai/dsh-base", "dsh-cc-tui", "dsh-session-export"]
```

### 6.2 配置树验证（不启动）

```sh
dsh --profile tui --dump-config
# # == dsh-session-export
# - id: session-export
#   name: dsh-session-export
#   inject:
#     - sessions
```

### 6.3 端到端（真实任务 → 导出文件）

把插件装进 headless profile，跑一个真实任务（需要 API key）：

```sh
dsh plugin --profile headless add file:C:/Users/yang/dsh-session-export
dsh --profile headless "列出当前目录下的所有文件"
ls ~/.dsh/exports/
# session-c60dc5a8-635a-4724-8727-c08f6400382b.md
```

导出文件内容节选：

````markdown
# 会话导出
- **会话 ID**：`session-c60dc5a8-...`  ·  **模型**：`deepseek-official/deepseek-v4-flash`
- **统计**：1 个 turn · 4 个 step · 3 次工具调用 · 2820 in / 797 out tokens（缓存读 36992）

## Turn 1
### 用户
列出当前目录下的所有文件
#### 工具调用：glob
```json
{ "pattern": "*" }
```
#### 工具调用：pwsh
```json
{ "command": "Get-ChildItem -Force ..." }
```
### 助手
当前目录 `C:\Users\yang\dsh-session-export` 下的内容如下：...
> Turn 1 结束：**完成**
````

---

## 7. 实战坑与经验（Windows / 无管理员环境）

这些坑是真实踩过的，贡献插件时大概率会遇到：

1. **符号链接被拦截**：Windows 无管理员 + 安全软件（如 360）会拦截一切 reparse point（junction/symlink）创建。影响面：
   - pnpm 默认 **isolated** 布局在 `.pnpm/` 里用符号链接 → 项目根加 `pnpm-workspace.yaml` 配 `nodeLinker: hoisted`（硬链接布局，无符号链接）。
   - pnpm 11 的 store 会给项目建注册符号链接 → 换 **pnpm 10**（无此机制）。
   - dsh 启动本身会为依赖闭包建 junction → 需给安装的 `dsh-app-boot` 打补丁降级为复制（详见环境部署记录，正常环境不需要）。

2. **npm registry 上子包版本滞后**：`npm view @deepseek-ai/dsh-session version` 显示 latest tag 是旧版，但 `0.1.0-rc.6` 确实存在。声明依赖时**版本要与 dsh 闭包一致**（`^0.1.0-rc.6`）。

3. **schemastery 没有 `.optional()`**：`z.string().optional()` 不存在；字段默认就是可选的，用 `.required(true)` 强制必填、`.default(v)` 给默认值。也别用 `z.infer`——直接写显式接口 + 运行时 Schema 最省事。

4. **Service 类插件 vs 函数插件**：`ctx.plugin(serviceInstance)` 类型上要求对象形态（有 `apply`）。第一版用函数插件最稳；要暴露服务给其他插件时用 Service 子类 + `ctx.plugin(MyServiceClass)`。

5. **`source.kind` 是跨包扩展联合**：dsh-llm 的类型里只有 `user|model|tool`，但 dsh-session/agent 运行时会产生 `inject|goal|plugin|skill-catalog` 等扩展值。比较前先 `as string | undefined` 宽化，否则 TS 报"类型无重叠"。

6. **`ctx.on('dispose')` 不在类型化事件表**：用 `ctx.effect(() => () => cleanup)` 做卸载清理。

7. **dispose 时序**：headless 进程跑完立刻退出，防抖窗口内的导出会丢。兜底方案是 dispose 钩子里同步 flush `pending`。

8. **@types/node 找不到**：tsconfig 显式 `"types": ["node"]`，避免 pnpm 布局下自动包含失效。

---

## 8. 给贡献者的建议

**选题方向**（生态现状 2026-08，GitHub topic `dsh-plugin` 约 1386 个仓库，真正相关十几个）：

- 已有人做：Web UI 皮肤合集（dsh-web-ui）、视觉桥接 OCR（modlens）、内容发现（OpenBiliClaw）、Skill 编排（Vibe-Skills）。
- 空缺且实用：会话导出/复盘（本文）、任务完成通知（Server酱/钉钉/webhook 推送）、成本报表、垂直工具集、日程/IM 集成。

**插件开发清单**：

1. 从官方文档读 [Cordis 教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/)（7 章可运行示例）和 [框架文档](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)；
2. 在安装闭包里找同类现成实现，**先读 .d.ts 再写代码**；
3. 保持无原生依赖（node-pty/koffi 之类在受限环境安装是灾难）；
4. 渲染/计算逻辑抽成纯函数，便于单测和复用；
5. `lib/` 构建产物入库，`file:` 安装免构建；
6. 用 `--dump-config` 验证配置树，用 headless 跑真实任务做端到端；
7. 发布到 GitHub 并打 `dsh-plugin` topic，便于生态发现。

**参考链接**：

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- [Cordis 教程（中文）](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/)
- [插件与生命周期](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)
- [dsh-plugin topic](https://github.com/topics/dsh-plugin)
- [dsh-TUI（社区插件范例）](https://github.com/ccch1mneyyy/dsh-TUI)
