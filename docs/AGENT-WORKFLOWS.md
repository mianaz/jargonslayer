# JargonSlayer × Agent 工作流

**设计立场**：JargonSlayer 不内置第三方 OAuth connector。它把数据用 agent 友好的格式送到**文件系统**和 **webhook**，编排发生在你自己的 harness 里（Claude Code、n8n、cron、任意 MCP 客户端）。内置 N 家 connector 意味着维护 N 套 API 和 token 生命周期，而 power user 的编排层本来就比我们做得好。数据格式契约见 [SCHEMA.md](SCHEMA.md)。

## 数据出口（四个，全部无账号）

| 出口 | 触发 | 形态 |
|---|---|---|
| 自动落盘 | 每次会话保存 | 指定文件夹里的 `{date}-jargonslayer.md`（frontmatter）+ `.json` |
| Webhook | 每次会话保存 | POST `{event: "meeting.saved", session}` 到自定义 URL |
| 手动导出 | 按钮 | Markdown 报告 / Anki TSV / JSON / 剪贴板 |
| 全量备份 | 设置页 | 单 JSON（sessions + 词库 + 设置） |

## 配方

### 1. Claude Code：会议纪要 → 周会 PPT

自动落盘目录设为某个仓库/文件夹后：

```bash
cd ~/meetings
claude "用 pptx skill 把 2026-07-06-1430-jargonslayer.md 做成 5 页周会汇报：
主题页、要点、决定、行动项（按负责人分组）、下周计划占位"
```

同理可做：多场会议横向对比（"这三场会里 action items 的完成闭环情况"）、给导师的月度进展摘要。

### 2. Obsidian：vault 即收件箱

自动落盘目录直接选 vault 子目录（如 `vault/Meetings/`）。frontmatter 天然可被 Dataview 查询：

```dataview
TABLE duration_min AS "分钟", length(expressions) AS "新表达"
FROM "Meetings" WHERE source = "jargonslayer" SORT date DESC
```

### 3. n8n / 自动化平台：webhook 分发

Webhook URL 指向 n8n 的 Webhook 节点，典型流：`Webhook → 提取 session.summary → Notion API 建页面 + 飞书机器人发卡片`。payload 结构见 SCHEMA.md §3；接收端应立即 200、异步处理（客户端 8s 超时不重试）。

### 4. 命令行批分析

```bash
# 跨会议高频表达 Top 20
jq -r '.session.cards[].expression' *.json | sort | uniq -c | sort -rn | head -20

# 某说话人的全部行动项
jq -r '.session.summary.summary.action_items[] | select(.owner=="Mike") | .en' *.json
```

### 5. Anki 重度复习

纪要页导出 TSV → Anki 文件-导入（Tab 分隔，字段 1=正面 2=背面，允许 HTML）。应用内练习模式只做轻量翻卡，间隔重复的正确工具是 Anki。

## Connector 设计蓝图（未实现，接口已备好）

给想扩展的人（或未来的我们）的施工图：

1. **MCP server（`jargonslayer-mcp`）**：一个 stdio MCP 读自动落盘目录——resources 暴露每场会议，tools 提供 `search_expressions(query)` / `get_summary(date)`。因为数据就是磁盘上的 JSON，全程无需碰应用本体；~150 行可成。Claude Desktop/Code 即插即用。
2. **实时云端 STT 适配器**：`STTEngine` 接口（src/lib/types.ts）就是扩展点——实现 `start(events, settings)/stop()`，把 Deepgram/AssemblyAI 的 ws 流映射到 `onInterim/onFinal` 即可注册进引擎工厂。上传路径的云端转录（OpenAI 兼容 `/audio/transcriptions`）已内置，可作参考实现。
3. **推送编排**：webhook → 飞书/钉钉/Slack 机器人。建议模板：卡片标题=会议主题 zh，字段=行动项列表，按钮=打开落盘的 .md。全部逻辑活在接收端。
4. **日历联动（roadmap）**：会前从 CalDAV/Google Calendar 取会议标题预填 session title；属于"读外部"而非"写外部"，若做进本体也不违反无账号原则（本地 ICS 文件即可起步）。
5. **社区词典包仓库**：按 SCHEMA.md §5 发布 JSON 到 GitHub，用户在设置 → 包源粘贴 raw 链接安装；版本号变更即可推送更新。建议仓库结构：`packs/<id>/pack.json` + PR 收录流程。

## 隐私提醒

自动落盘和 webhook 都会把会议内容送出浏览器沙箱（前者到本地磁盘，后者到你指定的服务器）。启用即视为知情；「仅词典模式 + 不配出口」= 数据永不离开浏览器。
