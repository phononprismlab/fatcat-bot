# 肥肥风筝猫 🎏

> 最忠实的口嗨记录者。

一个跑在 QQ 上的 OC 口嗨记录机器人。你随口编的脑洞它全记下来（**连朋友接的话也记，并标好是谁说的**），口嗨完生成总结，过阵子再把旧口嗨像**回旋镖**一样甩回你脸上；你的 OC 长文、RP 记录也能直接上传让它替你收着，随时导出带走。

---

## 特性

- **口令记录**：喊「我要口嗨了！」开始，喊「我口嗨完了！」结束；记录窗口内**本群所有人的发言**都会被捕获，并标注说话者（昵称快照）。
- **口嗨总结**：结束时喂给大模型生成总结（可 `/总结 off` 关闭）。
- **回旋镖**：定时把旧口嗨推回给你，逼你想后续；间隔可 `/回旋镖 设置 <天数>` 自定义。
- **全文检索**：`/查询 <关键词>` 只做文本检索、不调模型（防幻觉）。
- **文件上传**：把 txt/md 直接发给 bot 收进个人库。
- **数据导出**：`/导出 txt|md [all|recent N]`，多篇自动打包 zip。数据永远属于用户本人。

## 技术特点

- **零依赖**：只用 Node 内置能力（`node:sqlite` + 全局 `WebSocket` + `fetch` + `zlib`），`git clone` 下来直接跑，无需 `npm install`。
- 数据全在本地 SQLite 单文件（`data/fatcat.db`），天然支持自托管。
- 检索用 SQLite **FTS5 trigram** 分词器，中文子串可搜。

## 环境要求

- Node.js **>= 22.5.0**（需要内置 `node:sqlite`）。
- 一个 OneBot 11 协议端，推荐 [NapCat](https://napneko.github.io/)（Docker 部署）。

## 快速开始

```bash
cp .env.example .env      # 按需修改
node --experimental-sqlite src/index.js
# 或 npm start
```

### 连接 NapCat（反向 WS）

1. 在 NapCat WebUI 里开启 OneBot 11 的 **WebSocket 服务器**（例如监听 `0.0.0.0:3001`），设置 access token。
2. 把 `.env` 里的 `ONEBOT_WS_URL` 指向该地址（如 `ws://127.0.0.1:3001`），token 填进 `ONEBOT_ACCESS_TOKEN`。
3. 启动本程序，看到「OneBot 已连接」即成功。

## 指令

| 指令 | 说明 |
|------|------|
| 我要口嗨了 / 我口嗨完了 | 开始 / 结束记录（记录本群所有发言） |
| `/查询 <关键词>` | 搜自己的口嗨与资料（纯文本检索） |
| `/导出 <txt\|md\|pdf> [all\|recent N]` | 导出并打包（多篇自动 zip） |
| `/回旋镖 [设置 <天数>]` | 手动回旋 / 设置间隔 |
| `/总结 on\|off` | 开关口嗨总结 |
| `/我的` | 我的统计 |
| `/帮助` | 指令列表 |

## 自测

```bash
npm run selftest
```

跑一遍 记录→捕获→存档→检索→导出→回旋镖 全链路（不连 QQ）。

## 目录结构

```
src/
  index.js           入口
  config.js          配置加载（.env）
  logger.js          日志
  db.js              SQLite 打开 + 建表（含 FTS5）
  repo.js            数据访问
  onebot/
    client.js        OneBot WS 客户端（echo + 重连）
    message.js       消息段构造 / 文本提取
  core/
    bot.js           事件处理：记录状态机 + 指令分发
    summary.js       LLM 总结
    export.js        导出 txt/md + zip
    boomerang.js     回旋镖调度
  utils/
    time.js, filenames.js, zip.js
```

## 说明

- **文件上传**：直接把 txt / md 发给 bot（群聊或私聊均可）即被收录，支持 ≤ 2MB；pdf/docx 等暂不支持（会提示）。
- **PDF 导出**：当前骨架未内置 PDF 生成（需嵌入中文字体），`/导出 pdf` 会回退为 txt；后续接入 `pdfkit` + 字体后启用。
- 数据归属用户本人；托管档必须提供导出能力。
