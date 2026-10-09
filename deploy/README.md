# 部署手册

从一台空服务器到「群里能用」，按顺序走一遍即可。**代码本身不需要改**，这里全是运维配置。

---

## 0. 先选路线

| | 路线 A · systemd | 路线 B · Docker |
|---|---|---|
| 适合 | 已经装了 Node 22.5+ 的机器 | 干净的新机器 |
| NapCat | 自己按官方文档装 | 由 compose 一起拉起来 |
| 机器人 | `deploy/install-systemd.sh` 一键装 | `docker compose up -d` |
| 升级 | `git pull && systemctl restart fatcat-bot` | `git pull && docker compose up -d --build` |
| 备份 | `deploy/backup.sh` + systemd timer | 同样用 `deploy/backup.sh`（在宿主机上跑） |

两条路的管理台、备份、监控配置完全一样，只有「进程怎么被拉起」不同。

---

## 1. 上线前必须先准备好的四样东西

这些东西**代码代替不了**，得你自己去弄。

### 1.1 一台云服务器

- **2 核 2G 是底线**，1 核 1G 跑不动（NapCat 吃内存）。
- **国内地域**（QQ 登录最稳；海外 IP 风控高）。
- 40G 盘够用。腾讯云轻量 2核2G：入门型 ¥35/月（2Mbps / 100GB 流量），锐驰型 ¥45/月（200Mbps / 无限流量）。
  **锐驰型只贵 10 块，SSH 和拉镜像的体验好得多。**
- **先买月付跑通再考虑年付。**

**创建方式必须选「基于操作系统镜像」**（Ubuntu 24.04 LTS），不要选「使用 Docker 镜像」——
后者是腾讯云替你 `docker run` 一个镜像，你拿到的**是一个容器而不是一台机器**：
没有完整 systemd（`systemctl` 不可用），也不能在里面再跑 `docker compose`（嵌套容器）。

**Ubuntu 镜像的默认用户是 `ubuntu`，不是 root**（root 默认没密码、也不允许密码登录）。
所以本文所有命令要么用 `ubuntu` 登录后加 `sudo`，要么先在控制台给 root 设一个密码。
腾讯云轻量控制台自带的「免密连接（TAT）」可以直接开网页终端，不用配 SSH。

### 1.2 一个 QQ 号（小号）

- 新注册的号直接挂机器人**极易触发风控**，建议先正常用几天：加几个好友、进一两个群、正常聊天。
- 号会被封/被限制是**常态**，心里要有数，也建议备一个备用号。

### 1.3 NapCat

路线 B 由 compose 自动拉镜像，跳过这步。路线 A 按官方文档装：
<https://github.com/NapNeko/NapCat-Docker>

装完后要在 NapCat 里开一个 **OneBot 11 的 WebSocket 服务器**（不是 HTTP，也不是客户端）：

| 配置项 | 值 |
|---|---|
| 监听地址 | `0.0.0.0`（机器人同机时 `127.0.0.1` 更安全） |
| 端口 | `3001` |
| token | 可留空（**端口不对外**的前提下）；对外必须设 |

> ⚠️ **NapCat 的 WebUI（6099 端口）绝对不能暴露公网** —— 官方明确警告。
> `docker-compose.yml` 里已经默认把它绑到宿主机回环地址，首次登录走 SSH 隧道（见第 4 节）。
> 自建安装（路线 A）的也一样：WebUI 只监听 `127.0.0.1:6099`，或直接在安全组里封掉。

### 1.4 大模型 API（可选）

配齐 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 三项才开启口嗨总结。
**不配也能跑**，只是口嗨结束时不给总结（不会报错、不消耗 token）。

---

## 2. 配置 `.env`

```bash
cd <项目目录>
cp .env.example .env
```

上线前**必须**确认的几项：

```ini
ADMIN_TOKEN=<自己设一个强口令>     # 不设会每次重启随机生成，你会登不进去
ONEBOT_ACCESS_TOKEN=<与 NapCat 一致>  # NapCat 没设 token 就留空
ALERT_WEBHOOK_URL=<告警出口>       # 强烈建议配，见第 5 节
```

---

## 3. 路线 A：systemd 部署

> 下面命令假设你用 `ubuntu` 用户登录（腾讯云轻量默认），所以都带 `sudo`；用 root 登录就去掉 `sudo`。

```bash
# 1) 把代码放到服务器（推荐 /opt）
sudo git clone https://github.com/phononprismlab/fatcat-bot.git /opt/fatcat-bot
cd /opt/fatcat-bot

# 2) 建配置
sudo cp .env.example .env && sudo nano .env

# 3) 安装（会建 fatcat 系统账号、装单元、开机自启并立刻启动）
sudo bash deploy/install-systemd.sh
```

脚本做的事：检查 Node ≥ 22.5 → 建服务账号 `fatcat` → 建 `data/` 与 `backups/` 并改属主 →
渲染并安装 `fatcat-bot.service` + `fatcat-backup.service` + `fatcat-backup.timer` →
`systemctl enable --now`。

想先看看它会写什么，加 `--dry-run`（不碰系统、不需要 root）：

```bash
bash deploy/install-systemd.sh --dry-run
```

常用选项：`--user <账号>`（用已有账号跑）、`--dir <路径>`、`--no-backup-timer`。

### 单元文件里几个「故意的」决定

| 决定 | 原因 |
|---|---|
| **不写 `EnvironmentFile`** | systemd 的 `.env` 解析比程序自己读更严，值里有空格就会让 unit 起不来。配置交给程序读更稳。 |
| `RestartPreventExitStatus=1` | 退出码 1 是程序自己的「启动失败」（如端口占用）。这种重启一万次也没用，别当崩溃拉起。 |
| **没有 `MemoryDenyWriteExecute`** | 开了它 V8 的 JIT 会直接崩，报错还很难懂。**不要加。** |
| `ProtectHome` 按路径自适应 | 项目装在 `/home` 或 `/root` 下时用 `read-only`，否则服务读不到自己的代码。 |
| `UMask=0077` | 数据库和上传的用户资料默认只有服务账号可读。 |

---

## 4. 路线 B：Docker 部署

```bash
cd /opt/fatcat-bot          # 项目根目录
cp .env.example .env && nano .env
#   ↑ 别忘了设 NAPCAT_WEBUI_TOKEN，compose 读不到会直接报错

docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f fatcat
#   看到「OneBot 已连接」就成了
```

### 首次登录 QQ

WebUI 只绑宿主机回环地址（官方警告不能暴露公网），所以走 SSH 隧道：

```bash
# 在你自己电脑上执行，保持这个终端不关
ssh -N -L 6099:127.0.0.1:6099 ubuntu@<服务器IP>

# 然后本地浏览器打开 http://127.0.0.1:6099/webui
# 口令是 .env 里的 NAPCAT_WEBUI_TOKEN，进去扫码登录 QQ
```

### compose 里几个关键设计

- **`MODE=ws`**：NapCat 镜像支持用模板预置配置，这一项会把「OneBot 11 WebSocket 服务器，监听 `0.0.0.0:3001`」写进 `config/onebot11.json`，省掉进 WebUI 手点。
  ⚠️ **它每次启动都会覆盖这个文件。** 等你在 WebUI 里按自己需要改过网络配置后，把 `MODE=ws` 这一行删掉。
- **管理台只发布到 `127.0.0.1:8787`**，容器内绑 `0.0.0.0` 只是为了端口映射能进来。对外访问走第 6 节。
- **NapCat WebUI 也只发布到 `127.0.0.1:6099`**：它默认是 `6099:6099`（全接口），一旦服务器安全组没锁死就等于把 QQ 登录态交出去。这里改成回环，登录走 SSH 隧道。
- **`mac_address` 固定**：QQ 风控会看设备指纹，MAC 漂移容易触发验证。
- **NapCat 的 QQ 登录态必须持久化**（`docker-data/ntqq`），否则每次重建容器都要重新登录。
- **镜像装了 `fonts-noto-cjk`**：不装的话 `/导出 pdf` 会静默降级成 txt，等于 PDF 功能白做。

---

## 5. 备份与恢复

**为什么不能直接 `cp fatcat.db`**：库跑在 WAL 模式下，直接拷主文件会漏掉 `-wal` 里尚未 checkpoint 的事务，
拷出来的可能是一份「旧的且内部不一致」的库。

正确做法是让 SQLite 自己导出一致性快照 —— `scripts/backup.js` 用 `VACUUM INTO` 实现：
对正在写入的库安全、产出单文件完整库、不需要装 `sqlite3` 命令行。

### 备份内容

```
backups/20261009-043001/
  fatcat.db        ← VACUUM INTO 出来的一致性快照
  uploads/         ← 用户上传的原始文件（用户数据，必须备）
  manifest.json    ← 记录数 + PRAGMA integrity_check 结果，用来验证这份备份可用
```

`exports/` **不备** —— 那是导出产物，随时能重新生成。

### 跑备份

装 systemd 时会自动带上 `fatcat-backup.timer`（每天 04:30，`Persistent=true` 所以关机错过的会在开机后补跑）。

```bash
systemctl start fatcat-backup.service      # 手动跑一次
journalctl -u fatcat-backup -n 50          # 看结果
```

不装 timer 的机器直接跑脚本：

```bash
bash deploy/backup.sh
# 或只做快照：node --experimental-sqlite scripts/backup.js --keep 14
```

备份失败会**非零退出**，systemd 记为 failed，`systemctl --failed` 一眼能看到。

### 异地备份（强烈建议）

本地备份挡不住「整机故障 / 误删整个目录」。在 `.env` 里配一条同步命令：

```ini
BACKUP_OFFSITE_CMD=rclone sync "$BACKUP_DIR/latest" oss:fatcat-backup
# 或
BACKUP_OFFSITE_CMD=rsync -az --delete "$BACKUP_DIR/latest" backup@10.0.0.9:/srv/fatcat/
```

`backups/latest` 是指向最新一份的相对软链，直接同步它就行。

### 恢复

```bash
systemctl stop fatcat-bot                      # Docker: docker compose ... stop fatcat

cp -a backups/latest/fatcat.db data/fatcat.db
rm -f data/fatcat.db-wal data/fatcat.db-shm    # 关键：清掉旧 WAL，否则会和快照打架
cp -a backups/latest/uploads/. data/uploads/   # 恢复用户上传的文件

chown -R fatcat:fatcat data
systemctl start fatcat-bot
```

恢复后打开管理台「概览」，核对用户/会话/片段计数与备份 `manifest.json` 里的一致。

---

## 6. 远程访问管理台

管理台默认只绑 `127.0.0.1`，而且**自身不带 HTTPS**。三条路，按安全性排序：

### ① SSH 隧道（最安全，不经过公网）

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@your-server
# 然后本地浏览器开 http://127.0.0.1:8787/
```

### ② 反向代理 + TLS

- **Caddy**：把 `deploy/Caddyfile` 拷到 `/etc/caddy/Caddyfile`，改域名，`systemctl reload caddy`。证书自动申请续期。
- **Nginx**：参考 `deploy/nginx.conf.example`，证书用 `certbot --nginx -d admin.example.com`。

两份配置都已带上 HSTS / `X-Frame-Options` / `X-Robots-Tag: noindex` 等安全头，
并且把反代超时放宽到 300s（按用户导出多篇 PDF 时渲染会比较慢）。

### ③ 只对特定 IP 开放

两份配置里都留了注释掉的 IP 白名单片段，按需启用。

---

## 7. 掉线监控

**要分两层看，因为两种故障的发现方式不一样：**

| 故障 | 表现 | 谁来发现 |
|---|---|---|
| 进程挂了 / 机器重启 | 服务没了 | **外部探活**：打 `GET /healthz` |
| 进程活着但 QQ 掉线 | 收不到任何消息，群里 @ 它没反应 | **进程内监控**：`src/monitor.js` |

外部探活**发现不了**第二种 —— 进程还好好的，`/healthz` 之外的接口都正常。这就是内置监控存在的理由。

### 健康检查端点

```
GET /healthz        （免登录，故意不含任何业务数据）
```

```json
{"ok":true,"mode":"bot","uptimeMs":86400000,
 "bot":{"connected":true,"connectedMs":86400000,"lastEventAt":...,"reconnects":0}}
```

机器人模式下 OneBot 未连接时返回 **503**，所以 Uptime Kuma / 云监控 / 容器 HEALTHCHECK 都能直接用。
`ADMIN_ONLY=1` 时永远返回 200。

### 内置监控

每 `MONITOR_INTERVAL_MIN`（默认 2 分钟）探活一次：先看 WS 连着没，再调 `get_login_info` 确认**账号本身**在线。
状态从「正常」翻到「异常」时发告警，持续故障按 `ALERT_COOLDOWN_MIN`（默认 30 分钟）冷却，恢复时再发一条恢复通知。

告警出口用 `ALERT_WEBHOOK_URL`，**按域名自动识别报文格式**，直接贴群机器人的 webhook 即可：

| 出口 | 域名 |
|---|---|
| 企业微信 | `qyapi.weixin.qq.com` |
| 钉钉 | `oapi.dingtalk.com` |
| 飞书 | `open.feishu.cn` |
| Server 酱 | `sctapi.ftqq.com` |
| 其它 | 发通用 JSON `{title, text, level, ts}` |

**为什么必须走带外通道**：账号都掉线了，机器人自己没法用 QQ 通知你。

不配 `ALERT_WEBHOOK_URL` 时监控**照常运行、照常写日志**，只是不会推消息 —— 你能在管理台「概览 → 掉线监控」看到状态。

管理台「配置」页有个「立即探活」按钮，不用等下一个周期就能拿到结论。

---

## 8. 上线自检清单

逐条打勾，全过了再拉人进群。

- [ ] `node --version` ≥ 22.5.0（或镜像已带）
- [ ] `.env` 里 `ADMIN_TOKEN` 是强口令，不是随机生成的
- [ ] `journalctl -u fatcat-bot -n 50` 里能看到「OneBot 已连接」
- [ ] `curl -s localhost:8787/healthz` 返回 `"ok":true`
- [ ] 管理台能登录，10 个视图都能打开
- [ ] 管理台**没有**直接暴露公网（`ss -lntp | grep 8787` 应显示 `127.0.0.1:8787`）
- [ ] NapCat WebUI 没有暴露公网（`ss -lntp | grep 6099` 应显示 `127.0.0.1:6099`）
- [ ] `bash deploy/backup.sh` 跑通，`backups/latest/manifest.json` 里 `"integrity": "ok"`
- [ ] 备份的异地同步已配（或明确接受只有本地备份）
- [ ] `ALERT_WEBHOOK_URL` 配好，并**手动验证过能收到消息**
- [ ] 外部探活已挂上 `/healthz`（Uptime Kuma / 云监控 / 容器 HEALTHCHECK）
- [ ] 服务器安全组只放行必要端口（22 + 反代用的 80/443）
- [ ] 云服务器是**月付**，不是一上来就年付

跑完再加一条：**在测试群里真跑一遍完整闭环** ——
喊「我要口嗨了」→ 聊几句 → 喊「我口嗨完了」→ 看到总结 → `/导出 pdf` 能下载 → 管理台能看到这条记录。

---

## 9. 排障

| 现象 | 先看这里 |
|---|---|
| 一直「连接 OneBot…」 | NapCat 里开的是 **WebSocket 服务器**吗？端口/token 对得上吗？`ss -lntp \| grep 3001` |
| 连上了但群里 @ 它没反应 | NapCat 里 QQ 是否在线（WebUI 能看）；管理台「概览 → 掉线监控」点「立即探活」 |
| 服务起不来 | `journalctl -u fatcat-bot -n 100 --no-pager`；`.env` 是否有语法错误；8787 是否被占用 |
| 反复重启 | `systemctl status fatcat-bot` 看退出码。退出码 1 是启动失败（`RestartPreventExitStatus` 挡住了无限重启），要去看日志而不是等它自愈 |
| `/导出 pdf` 出来是 txt | 系统没探测到中文字体。装 `fonts-noto-cjk`，或在 `.env` 里指定 `FONT_PATH` |
| 管理台登录口令一直不对 | 没设 `ADMIN_TOKEN` 时会每次重启随机生成，口令在启动日志里。设一个固定的。 |
| 导出的中文是乱码/空白 | 同上，字体问题。管理台「概览」会显示当前用的字体文件。 |
| 备份脚本报 integrity 不 ok | 立刻停下排查，**别再让机器人写这个库**；从更早的一份备份恢复。 |
| 容器 unhealthy | 说明 `/healthz` 返回 503 —— 也就是 OneBot 没连上，不是进程挂了。看 `docker compose logs napcat`。 |

---

## 10. 目录速查

```
deploy/
  README.md                  ← 本文件
  install-systemd.sh         一键装 systemd（幂等，支持 --dry-run）
  fatcat-bot.service         主服务单元模板
  fatcat-backup.service      备份单元模板
  fatcat-backup.timer        每日备份定时器
  backup.sh                  备份包装脚本（轮转 + 校验 + 可选异地同步）
  Caddyfile                  管理台反代（Caddy，自动 TLS）
  nginx.conf.example         管理台反代（Nginx 片段）
  Dockerfile                 镜像（含中文字体）
  docker-compose.yml         机器人 + NapCat 一体化
  docker-healthcheck.js      容器 HEALTHCHECK 用的探活脚本
scripts/
  backup.js                  VACUUM INTO 一致性快照 + manifest
  deploycheck.js             部署配置自检（见下）
```

自检：

```bash
npm run deploycheck
```

它会真实拉起管理台验 `/healthz` 的 200/503 两条路径、跑一次备份并校验产物、校验轮转，
再静态检查所有单元文件 / compose / shell 脚本。
