# 部署记录：Hub + Edge

当前部署：Hub `139.224.131.201`，Edge `gpu2`。密钥/密码见密码管理器，不写入本文档。

## Hub（139.224.131.201）

- 二进制：**现场 `cd gateway && make linux-amd64` 编译**，再 → `/opt/claude-simple-hub/claude-gateway`。⚠️ 不要直接用仓库里可能已存在的 `gateway/dist/*`——踩过坑：那份是旧构建，缺 `/api/auth/status` 等路由（导致登录 404）、且没有 CSS Content-Type 修复（导致浏览器拒绝加载 `.css`，MIME 检查报错）。
- 替换二进制前必须先 `systemctl stop claude-simple-hub`，否则 `scp` 会因为 `ETXTBSY`（文件正被进程占用）失败。
- 静态资源：仓库 `public/` → `/opt/claude-simple-hub/public`
- systemd：`claude-simple-hub`（内部监听 `127.0.0.1:18080`）
- nginx：`/etc/nginx/conf.d/claude-simple-hub.conf`，`7030` 端口用自签证书反代到 `18080`
  - 证书：`/etc/nginx/ssl/claude-simple-hub/{cert,key}.pem`（`openssl req -x509 ... -days 3650`，无域名，浏览器会提示不受信任）
- 访问：`https://139.224.131.201:7030`，登录用户名/密码见密码管理器
- 自签证书后果（不是前端 bug，也不需要做成原生 App）：
  - Safari/Chrome 底栏会显示「不安全 / Not Secure」+ IP
  - Service Worker 注册会失败（`An SSL certificate error occurred when fetching the script`）。前端已跳过 IP 主机上的 SW 注册，聊天功能不受影响
  - iOS 键盘上方的「↑↓ ✓」是系统输入条，网页和「加到主屏幕」都去不掉
  - 要消掉「不安全」横幅：给机器绑一个域名，用 Let's Encrypt 换正式证书。Safari 分享 → 加到主屏幕 可以去掉浏览器外壳，体验接近 App

## Edge（gpu2）

- Node 版本：用 `nvm install 20`（该机器系统 apt 源有 arm64/amd64 混淆问题，装出来的是 Node 10，不可用；系统 apt 也没有 npm）
- 包：`npm install -g claude-simple`（发布在公共 npm，包名 `claude-simple`）
- systemd：`claude-simple-edge`
  - **注意**：`ExecStart` 不能用 `claude-simple-client`（它的 shebang `#!/usr/bin/env node` 会走 systemd 默认 PATH 解析到系统旧 Node），必须写绝对路径：
    ```
    ExecStart=<nvm node 路径>/bin/node <nvm node 路径>/lib/node_modules/claude-simple/client.js
    ```
  - 因为 hub 用自签证书，Edge 设置了 `NODE_TLS_REJECT_UNAUTHORIZED=0` 跳过证书校验（生产环境不安全，等 hub 换成正式域名 + Let's Encrypt 证书后应去掉）
  - `GATEWAY_URL=wss://139.224.131.201:7030/machine-connect`，`MACHINE_TOKEN` 需与 hub 一致

## 更新流程

### 更新 Hub（Go 网关代码变了）

```bash
cd gateway && make linux-amd64        # 生成 dist/claude-gateway-linux-amd64
ssh root@139.224.131.201 "systemctl stop claude-simple-hub"   # 先停，否则 scp 会 ETXTBSY
scp dist/claude-gateway-linux-amd64 root@139.224.131.201:/opt/claude-simple-hub/claude-gateway
ssh root@139.224.131.201 "systemctl start claude-simple-hub"
```

若前端（`public/`）也改了，同步 `scp -r public/* root@139.224.131.201:/opt/claude-simple-hub/public/`。

### 更新 Edge（Node 代码变了）

先发新版 npm 包：

```bash
# package.json 里 bump version
npm publish --otp=xxxxxx
```

再在 edge 机器上更新并重启：

```bash
ssh gpu2 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; npm update -g claude-simple'
ssh gpu2 "sudo systemctl restart claude-simple-edge"
```

多台 edge 时对每台重复后半段即可。

### 加一台新 Edge

1. 该机器装 Node ≥ 18（推荐 nvm，避免踩 apt 源的坑）
2. `npm install -g claude-simple`
3. 参考 `/etc/systemd/system/claude-simple-edge.service`（gpu2 上那份）改 `MACHINE_ID`，其余环境变量（`MACHINE_TOKEN`、`GATEWAY_URL`）保持一致
4. `systemctl enable --now claude-simple-edge`，看 hub 日志 `journalctl -u claude-simple-hub` 里出现 `Machine registered: <id>` 即成功

### Edge 自动更新（≥0.2.1）

`client.js` / `server.js` 默认启用 npm 自检更新：

| 变量 | 默认 | 说明 |
|------|------|------|
| `AUTO_UPDATE` | 开 | `0`/`false` 关闭 |
| `AUTO_UPDATE_INTERVAL_HOURS` | `12` | 检查间隔（半天） |
| `AUTO_UPDATE_APPLY` | 开 | `0` 只日志不安装 |
| `AUTO_UPDATE_CHANNEL` | `latest` | dist-tag |
| `AUTO_UPDATE_IDLE_WAIT_MS` | `1800000` | 有任务时最多等多久再更新 |

发现 registry 上有更高版本时：`npm install -g claude-simple@…`，idle 后 `process.exit(0)`。  
**systemd 需要 `Restart=on-success` 或 `Restart=always`**，否则退了不会起来。  
从 **git 源码目录** 直接跑不会覆盖源码树，只会提示用 global 安装。

## 排障

- Edge 连不上：`journalctl -u claude-simple-edge -n 50`，常见是证书校验失败（漏设 `NODE_TLS_REJECT_UNAUTHORIZED=0`）或 `MACHINE_TOKEN` 不一致
- Hub 没监听：`journalctl -u claude-simple-hub -n 50`，检查 `18080` 端口是否被别的服务占用（本次部署时 `8080` 已被占用，改用了 `18080`）
- 健康检查：`curl -sk https://139.224.131.201:7030/healthz` 应返回 `ok`
