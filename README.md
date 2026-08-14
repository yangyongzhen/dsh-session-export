# dsh-session-export

DeepSeek Harness 会话导出与复盘插件：把 agent 会话自动导出为 Markdown 文件，供复盘、写博客、审计使用。

- 监听 `session/event` 事件流，turn 结束并静默 `debounceMs` 后自动导出
- 输出 `$DSH_HOME/exports/session-<id>.md`（默认 `~/.dsh/exports/`）
- 进程退出（含 headless 一次性任务）时同步 flush 未导出的会话，不丢记录
- 渲染纯函数模块化导出，其他插件可复用

## 安装

```sh
# 本地 checkout 安装（推荐，免构建）
dsh plugin --profile <web|tui|headless> add file:/path/to/dsh-session-export

# 或从 Git 仓库直接安装
dsh plugin --profile <web|tui|headless> add https://gitcode.com/qq8864/dsh-session-export.git
```

## 配置

通过 profile 的 `cordis.patch.yml` 或 `--patch` overlay 覆盖：

```yaml
- id: session-export
  config:
    enabled: true            # 总开关，false 关闭自动导出
    outDir: ~/exports        # 导出目录，默认 $DSH_HOME/exports
    debounceMs: 1000         # turn/end 后的静默等待（毫秒）
    maxResultChars: 2000     # 工具参数/结果的截断长度
    includeInjected: false   # true 时包含注入消息（上下文快照、skill 目录等）
```

## 导出内容

```
# 会话导出
- 会话 ID / 创建时间 / 工作目录 / Agent 预设 / 导出时间
- 模型（provider/model）与统计：turn/step/工具调用次数、token 消耗（含缓存读写）、耗时

## Turn N / Step N.t      回合与步骤结构
### 用户 / 目标            直接提示词与目标延续（注入消息默认过滤）
#### 工具调用：name        工具名 + 参数 JSON
#### 工具结果              返回内容（截断）
### 助手                   模型文本 + 该步 token 明细
> Turn N 结束：完成        回合结束原因（完成/出错/被中断/达到上限…）
## 错误记录                全部回合错误汇总
```

## 作为库使用

渲染管线独立于运行时，其他插件可直接复用：

```ts
import { renderSessionMarkdown, summarizeStats } from 'dsh-session-export';
// 或按包路径导入：dsh-session-export 的 lib/markdown.js

const md = renderSessionMarkdown(session.events, { sessionId: session.id }, 2000, false);
```

## 开发

```sh
pnpm install
pnpm run build        # tsc -> lib/
```

## 验证

- `dsh --profile <name> --dump-config` 确认插件进入配置树
- headless 冒烟：`dsh --profile headless "一句话介绍你自己"` 后检查 `$DSH_HOME/exports/`
