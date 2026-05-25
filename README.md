# pi-mcp-bridge

把任意 **MCP (Model Context Protocol) server** 接入 [pi](https://github.com/earendil-works/pi-coding-agent) 的通用桥接扩展。一次安装，按项目自由启用/禁用，不用为每个 MCP 写一个独立扩展。

- 支持任意基于 **stdio** 的 MCP server（Playwright、Chrome DevTools、filesystem、自写 server……）
- **项目级开关**：同一份全局配置，每个项目可独立决定启用哪些 server
- 工具名自动加前缀 `<serverKey>__<toolName>`，多个 server 同名工具不冲突
- 透传 **进度通知** 与 **取消信号**（pi 的 `Esc` 能中断到 MCP server）
- 内置 `/mcp` 运维命令：查看状态、列工具、看 stderr、一键 enable/disable
- 兼容 Windows（自动处理 `npx` → `npx.cmd`）

> pi 核心 [刻意不内置 MCP](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)。本扩展把 MCP 当作"可选的重型外设接口"，按需挂载，避免污染 system prompt。

---

## 安装

### 方式一（推荐）：通过 `pi install`

pi 会自动 clone 仓库并执行 `npm install`：

```bash
# 全局安装（所有项目可用）
pi install git:github.com/Ginkgoooo/pi-mcp-bridge

# 仅安装到当前项目
pi install -l git:github.com/Ginkgoooo/pi-mcp-bridge
```

安装完成后重启 pi，输入 `/mcp` 应能看到（暂时为空的）服务列表。

### 方式二：手动放进扩展目录

```bash
git clone https://github.com/Ginkgoooo/pi-mcp-bridge ~/.pi/agent/extensions/pi-mcp-bridge
cd ~/.pi/agent/extensions/pi-mcp-bridge
npm install      # ⚠️ 必须执行，仓库不携带 node_modules
```

> 单文件复制不行：本扩展依赖 `@modelcontextprotocol/sdk`，必须连同 `package.json` 和 `node_modules/` 一起放到 `~/.pi/agent/extensions/pi-mcp-bridge/` 子目录中。

### （可选）预装常用 MCP server 提升启动速度

`npx -y` 首次拉取会慢 1～3 秒。可以预装：

```bash
npm i -g @playwright/mcp chrome-devtools-mcp
npx playwright install     # Playwright 首次需要装浏览器
```

---

## 配置

MCP server 配置写在 pi 的 `settings.json` 的 `mcpServers` 字段下。pi 会**深合并**全局与项目配置。

### Schema

```jsonc
{
  "mcpServers": {
    "<serverKey>": {
      "command": "string",          // 必填：可执行文件
      "args":    ["string", ...],   // 可选
      "env":     { "K": "V" },      // 可选：合并到子进程 env
      "cwd":     "string",          // 可选：~ 会展开为 home
      "enabled": false,             // 默认 false，安全起见全局默认不启
      "toolAllowlist": ["..."],     // 可选：只暴露这些工具
      "toolDenylist":  ["..."],     // 可选：屏蔽这些工具
      "timeoutMs": 60000,           // 可选：单次 callTool 超时，默认 60s
      "label": "string"             // 可选：覆盖 UI 显示名
    }
  }
}
```

`serverKey` 只能包含 `A-Z a-z 0-9 _ -`，会作为工具前缀（`<serverKey>__<toolName>`）。

### 全局示例

`~/.pi/agent/settings.json`：

```json
{
  "mcpServers": {
    "pw": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "enabled": false
    },
    "cdp": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--user-data-dir", "~/.cache/cdp-profile"],
      "enabled": false
    }
  }
}
```

### 项目级覆盖

**项目 A** 只用 Playwright：`.pi/settings.json`

```json
{ "mcpServers": { "pw": { "enabled": true } } }
```

**项目 B** 两个都开，并裁剪 cdp 的工具集：

```json
{
  "mcpServers": {
    "pw":  { "enabled": true },
    "cdp": {
      "enabled": true,
      "toolAllowlist": ["navigate_page", "take_screenshot", "performance_start_trace"]
    }
  }
}
```

**项目 C** 不写就是不启。

### 内置快捷默认（pw / cdp）

如果你只想快速试用 Playwright 或 Chrome DevTools，**全局 settings 都不用写**，直接：

```
/mcp enable pw
/mcp enable cdp
```

扩展会自动把 `command: npx -y @playwright/mcp@latest`（或 `chrome-devtools-mcp@latest`）写入项目 `.pi/settings.json` 并触发 `/reload`。

---

## `/mcp` 命令

| 子命令 | 作用 |
|---|---|
| `/mcp` | 列出所有连接：`pid`、工具数、状态、错误信息 |
| `/mcp tools [serverKey]` | 列出（指定 server 的）所有已注册工具 |
| `/mcp logs [serverKey]` | 查看子进程 stderr（最近 80 行，排查首选）|
| `/mcp enable <serverKey>` | 在项目 `.pi/settings.json` 里启用并 `/reload` |
| `/mcp disable <serverKey>` | 在项目 `.pi/settings.json` 里禁用并 `/reload` |

工具暴露给 LLM 的名字形如：

```
pw__browser_click
pw__browser_navigate
cdp__navigate_page
cdp__take_screenshot
```

---

## 工作原理简述

```
pi 启动
  └─► extension async factory
        ├─► 读 ~/.pi/agent/settings.json + <cwd>/.pi/settings.json，深合并 mcpServers
        ├─► 过滤 enabled: true 的条目
        ├─► 对每个 server:
        │     spawn 子进程 (StdioClientTransport)
        │     MCP client.connect() → listTools()
        │     for tool in tools: pi.registerTool({ name: `${key}__${tool.name}`, ... })
        └─► 注册 /mcp 命令 + session_shutdown 清理钩子

pi session_shutdown / /reload / 退出
  └─► 关闭所有 MCP client、kill 所有子进程
```

- **异步 factory** 保证 `session_start` 之前所有连接就绪，LLM 第一轮就能看到工具
- **参数类型** 使用 `Type.Any()` 透传，由 MCP server 自己校验（最大兼容性）
- **内容映射**：MCP 的 `text` / `image` / `resource` / `resource_link` / `structuredContent` 都会被映射成 pi 的 content blocks，未识别类型保底转为 text + JSON
- **取消传递**：pi 的 `Esc`（`AbortSignal`）会透传到 `client.callTool({ signal })`
- **进度通知**：MCP `notifications/progress` 通过 `onUpdate` 显示百分比和 message

---

## 上下文污染控制

挂两个 MCP 加起来可能注册 30+ 工具，会显著占用 system prompt。建议：

1. **白名单收敛**：用 `toolAllowlist` 只暴露真正会用到的工具
2. **项目级按需启用**：不同项目只开当前任务必需的 server
3. **运行时切换**：在不同任务阶段用 `pi.setActiveTools()` 动态启停（高级用法）

---

## Windows 兼容性

| 问题 | 处理 |
|---|---|
| spawn `npx` 报 ENOENT | 扩展已自动改写为 `npx.cmd`（仅在 `process.platform === "win32"` 时）|
| 路径反斜杠 | settings.json 里用 `/` 或转义 `\\`；`~/` 会自动展开 |
| 子进程不退出 | `session_shutdown` 钩子里先 `client.close()` 再 `transport.close()` |

---

## 安全注意

> ⚠️ 扩展和 MCP server 都以**你的完整系统权限**运行。

- MCP server 多数来自 npm，等同于安装第三方包，请自行评估信任度
- `chrome-devtools-mcp` 会驱动真实 Chrome，**能访问你已登录的会话**。强烈建议传 `--user-data-dir` 用独立 profile：
  ```json
  "args": ["-y", "chrome-devtools-mcp@latest", "--user-data-dir", "~/.cache/cdp-profile"]
  ```
- `@playwright/mcp` 同理，避免误用浏览器持久态

---

## 故障排查

### `/mcp` 命令不存在

| 检查项 | 命令 |
|---|---|
| 扩展目录与入口存在 | `ls ~/.pi/agent/extensions/pi-mcp-bridge/index.ts` |
| 依赖装好了 | `ls ~/.pi/agent/extensions/pi-mcp-bridge/node_modules/@modelcontextprotocol/sdk` |
| 重启或 `/reload` 过了 | 在 pi 里执行 `/reload` |
| 没有同名命令冲突 | `/help` 看是否出现 `mcp:1`、`mcp:2` |
| 加载报错 | 启动时加 `--debug`，或查看 `~/.pi/agent/logs/` |

最常见原因：**直接 git clone 后没跑 `npm install`**。仓库 `.gitignore` 排除了 `node_modules/`。

### `/mcp` 能用但工具列表为空

- 没启用任何 server：`/mcp enable pw` 或编辑项目 `.pi/settings.json`
- server 启动失败：`/mcp` 看 `status=error`，`/mcp logs <key>` 看子进程 stderr
- `command` 找不到：检查 `npx` 是否在 PATH，或改成绝对路径

### MCP server 启动很慢

- 预装到全局：`npm i -g @playwright/mcp`
- 改用绝对路径替代 `npx`，可省 1～3 秒解析时间

---

## 许可证

参见仓库 LICENSE。

## 致谢

- [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) — 优雅的 TUI Agent 框架
- [Model Context Protocol](https://modelcontextprotocol.io/) — 标准化的工具协议
