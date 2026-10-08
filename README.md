# 肥肥风筝猫 🎏

> 最忠实的口嗨记录者。

一个跑在 QQ 上的 OC 口嗨记录机器人。你随口编的脑洞它全记下来（**连朋友接的话也记，并标好是谁说的**），口嗨完生成总结，过阵子再把旧口嗨像**回旋镖**一样甩回你脸上；你的 OC 长文、RP 记录也能直接上传让它替你收着，随时导出带走。

---

## 特性

- **口令记录**：喊「我要口嗨了！」开始，喊「我口嗨完了！」结束；记录窗口内**本群所有人的发言**都会被捕获，并标注说话者（昵称快照）。
- **口嗨总结**：结束时喂给大模型生成总结（可 `/总结 off` 关闭）。
- **回旋镖**：定时把旧口嗨推回给你，逼你想后续；间隔可 `/回旋镖 设置 <天数>` 自定义。
- **全文检索**：`/查询 <关键词>` 只做文本检索、不调模型（防幻觉）；结果走私聊，不贴群。
- **文件上传**：把 txt/md 直接发给 bot 收进个人库，自动识别 GBK 编码。
- **数据导出**：`/导出 txt|md|pdf [all|recent N]`，多篇自动打包 zip。数据永远属于用户本人。
- **Web 管理台**：浏览器里看数据、管用户、查日志、补总结、手动回旋、导出下载。NapCat 挂了也能单独开（`ADMIN_ONLY=1`）。
- **掉线监控**：定时探活（不只是 WS 连着没，还会问 `get_login_info` 确认**账号本身**在线），
  异常时经 webhook 告警（企业微信 / 钉钉 / 飞书 / Server 酱 / 通用 JSON），恢复时发恢复通知。
- **自动备份**：`VACUUM INTO` 一致性快照 + 上传文件 + 计数校验，systemd timer 每日跑，可选异地同步。

## 技术特点

- **零依赖**：只用 Node 内置能力（`node:sqlite` + 全局 `WebSocket` + `fetch` + `zlib`），`git clone` 下来直接跑，无需 `npm install`。
- 数据全在本地 SQLite 单文件（`data/fatcat.db`），天然支持自托管。
- 检索用 SQLite **FTS5 trigram** 分词器，中文子串可搜。
- **自研 PDF 生成**：不依赖 pdfkit / 字体包。运行时解析系统里的中文 TTF/TTC，
  **只把文档实际用到的字形子集化**后以 `Type0/CIDFontType2 + Identity-H` 嵌入，
  并附带 ToUnicode 表（文本可复制、可搜索）。一份聊天记录导出通常只有几十 KB，
  在任何阅读器（含浏览器内置）都能正确显示中文。

## 环境要求

- Node.js **>= 22.5.0**（需要内置 `node:sqlite`）。
- 一个 OneBot 11 协议端，推荐 [NapCat](https://napneko.github.io/)（Docker 部署）。

## 快速开始

```bash
cp .env.example .env      # 按需修改
node --experimental-sqlite src/index.js
# 或 npm start
```

懒人版：直接跑一键启动脚本（会自动检查 Node 版本、没有 `.env` 就复制一份）。

```bash
./start.sh        # Linux / macOS / Git Bash
start.bat         # Windows
```

> 零依赖：`git clone` 下来就能跑，**不需要 `npm install`**。唯一要求是 Node >= 22.5.0。

### 连接 NapCat（反向 WS）

1. 在 NapCat WebUI 里开启 OneBot 11 的 **WebSocket 服务器**（例如监听 `0.0.0.0:3001`），设置 access token。
2. 把 `.env` 里的 `ONEBOT_WS_URL` 指向该地址（如 `ws://127.0.0.1:3001`），token 填进 `ONEBOT_ACCESS_TOKEN`。
3. 启动本程序，看到「OneBot 已连接」即成功。

## 部署上线

上面是「本机跑起来」。要**正式挂到服务器上给人用**，看 **[deploy/README.md](deploy/README.md)**，里面是从空服务器到上线的完整流程，含上线自检清单。

两条路二选一：

```bash
# A · systemd（已装 Node 22.5+ 的机器）
sudo bash deploy/install-systemd.sh

# B · Docker（干净的新机器，连 NapCat 一起拉起来）
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

配套齐了的东西：

| 能力 | 位置 |
|---|---|
| 开机自启 + 崩溃自动拉起 | `deploy/fatcat-bot.service` |
| 每日备份（含轮转、完整性校验、可选异地同步） | `deploy/backup.sh` + `fatcat-backup.timer` |
| 健康检查（供外部探活，OneBot 掉线返回 503） | `GET /healthz` |
| 掉线告警（账号掉线也能通知到你） | `src/monitor.js` + `ALERT_WEBHOOK_URL` |
| 管理台 HTTPS 反代 | `deploy/Caddyfile` / `deploy/nginx.conf.example` |
| 容器化（含中文字体） | `deploy/Dockerfile` / `deploy/docker-compose.yml` |

## 指令

| 指令 | 说明 |
|------|------|
| 我要口嗨了 / 我口嗨完了 | 开始 / 结束记录（记录本群所有发言） |
| 直接发文件（或 `/上传` 看说明） | 收录 txt / md 资料 |
| `/查询 <关键词>` | 搜自己的口嗨与资料（**结果走私聊**，不贴群） |
| `/导出 <txt\|md\|pdf> [范围]` | 导出并打包（多篇自动 zip） |
| `/回旋镖 [设置 <天数>]` | 手动回旋 / 设置间隔 |
| `/总结 on\|off` | 开关口嗨总结 |
| `/我的` | 我的统计 |
| `/撤回我的发言` | 删掉自己在本群被记录的全部发言 |
| `/帮助` | 指令列表 |

`/导出` 的范围语法：

| 范围 | 含义 |
|------|------|
| `all` | 全部（默认） |
| `recent 5` | 最近 5 篇 |
| `3` | 最近 3 篇口嗨 |
| `#12` | 编号 12 的片段（片段与资料 ID 同号时优先片段） |
| `片段12` / `资料12` | 明确指定某一篇 |

## Web 管理台

随机器人一起启动，默认 `http://127.0.0.1:8787/`（端口见 `ADMIN_PORT`）。零依赖单页，无构建步骤。

```bash
node --experimental-sqlite src/index.js     # 机器人和管理台一起起
ADMIN_ONLY=1 node --experimental-sqlite src/index.js   # 只开管理台，不连 OneBot
```

首次启动若 `.env` 里没填 `ADMIN_TOKEN`，程序会**随机生成一个口令并打印在日志里**（重启即变）。
生产环境请在 `.env` 里固定一个强口令。

十个视图：

| 分组 | 视图 | 能干什么 |
|------|------|----------|
| 运行 | 概览 | 计数卡片、运行状态（连接时长 / 最后事件 / 累计重连 / 掉线监控）、最近口嗨/资料、活跃群 |
| 数据 | 记录会话 | 按状态筛选，看完整对话，**强制结束进行中会话并当场生成片段** |
| 数据 | 口嗨片段 | 看总结与原始对话，**手动回旋给本人**，重新生成总结，删除 |
| 数据 | 上传资料 | 看正文，删除（同时清磁盘文件与检索索引） |
| 数据 | 用户 | 改昵称、回旋间隔、总结开关；删除用户（级联清会话/消息/片段/资料/索引） |
| 数据 | 全局检索 | 跨口嗨与资料的关键词检索 |
| 运营 | 回旋镖 | 预览完整待回旋积压（不是调度器那种每轮一条）、**发送历史**、手动触发一轮 |
| 运营 | 导出 | 按用户导出 txt/md/pdf，浏览器直接下载 zip |
| 系统 | 配置 | 查看生效配置（密钥一律打码）、**强制重连 OneBot**、**立即探活** |
| 系统 | 日志 | 最近 500 条运行日志（内存环形缓冲，重启清空） |

外部探活直接打 `GET /healthz`（免登录，只回 `ok` / 运行时长 / OneBot 连接状态，**不含任何业务数据**）：
机器人模式下 OneBot 未连接返回 **503**，`ADMIN_ONLY=1` 时恒为 200。

### 安全默认值

管理台握着所有人的数据，所以默认是保守的：

- **只绑 `127.0.0.1`**。要对外暴露必须显式改 `ADMIN_HOST`，启动时会打告警。
- 登录走 **HttpOnly + SameSite=Strict** Cookie 会话，口令比较用 `crypto.timingSafeEqual`（等时比较）。
- 连续 8 次口令错误触发**登录限速**（返回 429 并加入延迟）。
- `/api/config` 里所有 token / 密钥**只回打码值**。
- 删除上传资料时校验路径必须落在 `uploads/` 内，**防目录穿越**。
- 所有来自数据库的文本在渲染前统一 HTML 转义，**昵称/消息里塞 `<script>` 也不会执行**。
- 会话过期时间由 `ADMIN_SESSION_TTL_HOURS` 控制（默认 12 小时）。

> ⚠️ 管理台本身不带 HTTPS。要公网访问，请在前面套一层反向代理（Caddy / Nginx）并开 TLS。

## 自测

```bash
npm run selftest      # 记录→捕获→存档→检索→导出→回旋镖 全链路（不连 QQ）
npm run admintest     # 管理台 API 全量测试（登录/权限/各视图/删除级联/限速）
npm run deploycheck   # 部署配置自检（/healthz 两条路径、备份产物与轮转、单元文件静态校验）
npm run pdf:build     # 生成样例 PDF 与子集字体到 data/pdftest/
npm run pdf:validate  # 校验 PDF 结构 + 用 FreeType 比对子集字形（需 Python + Pillow）
npm run pdf:verify    # 用 pdf.js 解析 PDF，校验文本可被正确提取（首次运行会拉取 pdf.js）
```

浏览器端到端（可选，需要本机有 Chrome）：

```bash
npm run admindemo                                    # 起一个塞满假数据的管理台（:8799，口令 demo）
chrome --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/cdp about:blank
npm run admine2e                                     # 登录→10 个视图→弹层→XSS 断言，截图到 data/adminshots/
```

## 目录结构

```
src/
  index.js           入口
  config.js          配置加载（.env）+ 中文字体自动探测
  logger.js          日志
  monitor.js         掉线监控 + webhook 告警（进程活着但账号掉线的唯一发现手段）
  db.js              SQLite 打开 + 建表（含 FTS5）
  repo.js            数据访问
  onebot/
    client.js        OneBot WS 客户端（echo + 重连 + 连接状态统计）
    message.js       消息段构造 / 文本提取
  core/
    bot.js           事件处理：记录状态机 + 指令分发
    session.js       会话归档 → 生成总结 → 落片段 → 建索引（bot 与管理台共用）
    summary.js       LLM 总结
    export.js        导出 txt/md/pdf + zip
    upload.js        上传文件解析入库（编码探测 / 配额 / 格式校验）
    boomerang.js     回旋镖调度 + 单条推送（bot 与管理台共用）
  admin/
    server.js        管理台 HTTP 服务（node:http，路由 + 会话鉴权 + /healthz）
    ui.html          管理台单页前端（零依赖，无构建）
  utils/
    time.js, filenames.js, zip.js
    ttf.js           TrueType/TTC 解析
    ttf-subset.js    字形子集化（输出可嵌入 PDF 的 SFNT）
    pdf.js           零依赖 PDF 排版与生成
deploy/
  README.md          部署手册（从空服务器到上线）
  install-systemd.sh 一键装 systemd（幂等，--dry-run 可预览）
  fatcat-bot.service 主服务单元模板
  fatcat-backup.service / .timer   每日备份
  backup.sh          备份包装（轮转 / 校验 / 可选异地同步）
  Caddyfile, nginx.conf.example    管理台 HTTPS 反代
  Dockerfile, docker-compose.yml, docker-healthcheck.js
scripts/
  selftest.js        全链路自测
  admincheck.js      管理台 API 测试
  admindemo.js       本地起一个塞满假数据的管理台（演示/截图用）
  admine2e.mjs       浏览器端到端（CDP 驱动 Chrome，可选）
  backup.js          VACUUM INTO 一致性快照 + manifest
  deploycheck.js     部署配置自检
  pdfcheck.js        生成 PDF 样例
  pdfvalidate.py     结构与字体校验
  pdftext.mjs        pdf.js 文本提取校验
```

## 说明

- **文件上传**：直接把 txt / md 发给 bot（群聊或私聊均可）即被收录，支持 ≤ 2MB。
  自动探测编码：优先 UTF-8（含 BOM），失败回退 **GB18030**——所以 Windows 记事本存的 GBK 中文 txt 不会变乱码。
  pdf/docx 等暂不支持（会提示）。
- **存储配额**：单用户资料库字符总量默认上限 200 万字，超出会被拒收并提示先导出清理。
  用 `USER_QUOTA_CHARS=0` 可关闭。
- **PDF 导出**：`/导出 pdf` 会把每篇口嗨/资料渲染成一份带标题、说话人、时间与总结的 PDF。
  **不同说话者的名字会自动分配不同颜色**，多人 RP 记录翻页也能一眼认出谁在说。
  字体从系统自动探测（Windows `simhei.ttf`、macOS `PingFang.ttc`、Linux `NotoSansCJK` 等）；
  也可在 `.env` 里用 `FONT_PATH` 显式指定。**探测不到字体时自动回退成 txt 并在回复里说明**。
- 数据归属用户本人；托管档必须提供导出能力。

## 隐私

- **开启记录时会先在群里发一次知情同意公告**（每个群只发一次）：说明记录范围、归属、用途，以及撤回方式。
  记录窗口会捕获群内**其他人**的发言，托管档因此持有第三方数据，必须明示。
- **任何人**都可以在群里发 `/撤回我的发言`，删掉自己在该群被记录的全部发言——是**真删**，
  同时会重建相关片段的检索索引，之后 `/查询` 不会再搜到。删除动作会留一条审计记录（谁、哪个群、删了几条）。
- `/查询`、`/我的` 的结果一律**走私聊**，群里只留一句「已发到你的私聊」，避免把「你口嗨过什么」贴在群上。
- 回旋镖同样只走私聊。
- 想彻底不过托管方的手，走自托管档——数据只在你自己的机器上。

## License

[MIT](LICENSE)。随便用、随便改、随便分发，保留版权声明即可。
