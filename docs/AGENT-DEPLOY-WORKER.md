# MV Studio Worker 部署指南（给服务器 Cursor Agent 读）

> 方案：**B = 裸机 Ubuntu + Node/pnpm + PM2 + GitHub Self-hosted Runner**  
> 目标：让 agent 在最少人工干预下，把 `mv-studio-worker` 拉起来，并**按环境对接正确的 API**。  
> 本文档同时适用于人工照单执行。

---

## 〇、架构与环境（先读）

### 0.1 Worker 是什么

- **纯算力服务**：FFmpeg / Remotion / sharp，**无数据库、无 Redis、无队列进程**
- **Pull 模式**：主动 HTTPS 轮询主 API 的 `/internal/worker/*` 拉任务、回报进度
- **零云凭证**：上传用 API 下发的预签名 URL
- 主 API 必须已是 `COMPOSE_CONSUMER_MODE=worker`，且 `COMPOSE_WORKER_API_KEY` 与 Worker 一致

### 0.2 测试 vs 生产（必须分清）

| 维度 | 测试环境 (`test`) | 生产环境 (`prod`) |
|------|-------------------|-------------------|
| 对接 API（`mainApiBaseUrl`，**不要**带 `/api`） | 测试 API，例如 `http://<测试机IP>:4001` 或测试域名 | `https://api.aimv.video` |
| API Key | **测试 API** 的 `COMPOSE_WORKER_API_KEY` | **生产 API**（K8s secret / Admin）的 key |
| `workerId` | 如 `ubuntu-test-01`（全局唯一） | 如 `ubuntu-prod-01` |
| PM2 进程名 | `mv-studio-worker-test` | `mv-studio-worker-prod` |
| 代码目录（推荐） | `/opt/ai-studio/mv-studio-worker-test` | `/opt/ai-studio/mv-studio-worker-prod` |
| Runner 标签（若装自动部署） | `self-hosted,mv-studio-worker,test` | `self-hosted,mv-studio-worker,prod` |
| GitHub 仓库 | `msea-ai/mv-studio-work`（或用户指定的 fork） | 同左 |

**硬规则：**

1. **一台机器可以只跑 test、只跑 prod，或两个都跑**——但必须是**两套目录 + 两个 PM2 进程 + 两套配置**，禁止一个进程改来改去切环境。
2. **测试 Worker 绝对不要指向 `https://api.aimv.video`**，否则会抢走生产合成队列。
3. **生产 Worker 绝对不要指向测试 API**。
4. 当前仓库配置写在 `src/config/worker.constants.ts`（构建进 `dist`）。部署时由 secrets **改写该文件再 build**；不要把真实 Key commit 回 git。

```
用户触发合成
    │
    ▼
┌─────────────────┐     claim/progress/complete      ┌──────────────────────┐
│  测试 API        │◄────────────────────────────────│ Worker-test (PM2)     │
│  :4001 / 测试域  │                                  │ MAIN=测试 API         │
└─────────────────┘                                  └──────────────────────┘

┌─────────────────┐     claim/progress/complete      ┌──────────────────────┐
│ api.aimv.video  │◄────────────────────────────────│ Worker-prod (PM2)     │
│ (EKS)           │                                  │ MAIN=https://api...   │
└─────────────────┘                                  └──────────────────────┘
```

---

## 一、Agent 角色与禁令

### 1.1 目标（按 secrets 里的 `WORKER_ENV`）

对每个启用的环境，验收标准：

1. `pm2 describe mv-studio-worker-<env>` 状态 `online`，restart 次数稳定
2. claim 冒烟：`POST {MAIN_API_BASE_URL}/internal/worker/jobs/claim` 返回 **204**（无任务）或 **200**（有任务），**不是 401**
3. `ffmpeg` / `ffprobe` / `chromium` 可用
4. 日志里能看到定期 Claim / Heartbeat，无连不上 API 的刷屏错误

### 1.2 禁止事项

- **不要**安装 PostgreSQL / Redis（Worker 不需要）
- **不要**自己编造 `COMPOSE_WORKER_API_KEY`；必须与对应环境 API 一致
- **不要**把 secrets 文件 commit 进仓库
- **不要**用 root 跑业务进程与 GitHub Runner；用 `aistudio` 用户
- **不要**在未确认 `WORKER_ENV` 时默认连生产 API
- **不要**给海外机器配 `GLOBAL_AGENT_HTTP_PROXY`（除非用户明确要求）
- 破坏性操作（`rm -rf` 代码目录、卸载 runner）前先 echo 并征求确认

### 1.3 约定

- 需要 root 的步骤：`sudo` 单条执行
- 业务命令：`sudo -iu aistudio bash -lc '...'`
- 每完成一个 Phase 打印：`═══ Phase X ✅ ═══`
- 失败则停止，报告错误 + 最多 3 条修复建议

---

## 二、执行前必须具备的输入

### 2.1 文件

| 路径 | 说明 |
|------|------|
| `/tmp/worker-deploy-secrets.env` | 见 §2.2，`chmod 600` |
| （可选）已 clone 的代码 | 否则 agent 按 `REPO_WORKER` 自行 clone |

### 2.2 `/tmp/worker-deploy-secrets.env` 字段

```bash
# ── 本机要部署哪些环境（逗号分隔）：test / prod / test,prod ───────────────
WORKER_ENVS=test

# ── 仓库 ────────────────────────────────────────────────────────────────
REPO_WORKER=https://github.com/msea-ai/mv-studio-work.git
# 私有仓则用 SSH，并提供：
# GIT_DEPLOY_KEY_PATH=/path/to/id_deploy
WORKER_BRANCH=main

# ── 运行用户与目录 ──────────────────────────────────────────────────────
AI_USER=aistudio
AI_HOME=/opt/ai-studio

# ── 测试环境（WORKER_ENVS 含 test 时必填）────────────────────────────────
TEST_MAIN_API_BASE_URL=http://<测试API主机>:4001
TEST_COMPOSE_WORKER_API_KEY=<与测试 API .env 中 COMPOSE_WORKER_API_KEY 完全一致>
TEST_WORKER_ID=ubuntu-test-01
TEST_WORKER_MAX_SLOTS=2

# ── 生产环境（WORKER_ENVS 含 prod 时必填）────────────────────────────────
PROD_MAIN_API_BASE_URL=https://api.aimv.video
PROD_COMPOSE_WORKER_API_KEY=<与生产 API COMPOSE_WORKER_API_KEY 完全一致>
PROD_WORKER_ID=ubuntu-prod-01
PROD_WORKER_MAX_SLOTS=2

# ── GitHub Actions Runner（可选；要 push 自动部署时再填）────────────────
# 在 GitHub → 仓库 Settings → Actions → Runners → New runner 生成的 token（约 1h 有效）
RUNNER_TOKEN=
RUNNER_REPO=msea-ai/mv-studio-work
# 若本机只跑 test：RUNNER_LABELS=self-hosted,mv-studio-worker,test
# 若本机只跑 prod：RUNNER_LABELS=self-hosted,mv-studio-worker,prod
RUNNER_LABELS=self-hosted,mv-studio-worker,test
```

**Agent 启动前校验：**

```bash
set -a; source /tmp/worker-deploy-secrets.env; set +a
test -n "$WORKER_ENVS"
echo "$WORKER_ENVS" | grep -Eq 'test|prod' || exit 1
# 对每个 env 检查对应 MAIN_API_BASE_URL 与 KEY 非空、不含 <占位符>
# TEST_* 不得等于 https://api.aimv.video
```

若 `TEST_MAIN_API_BASE_URL` 指向生产域名 → **立即停止并问用户**。

### 2.3 对应 API 侧前置（人工/另一 agent 已完成）

对每个要对齐的 API 环境确认：

```bash
# 测试 API 示例（在测试 API 机器或可访问处）
grep COMPOSE_CONSUMER_MODE /opt/ai-studio/mv-studio-api/.env.production   # = worker
grep COMPOSE_WORKER_API_KEY /opt/ai-studio/mv-studio-api/.env.production # 与 secrets 一致

# 生产：K8s / Admin 配置里 COMPOSE_CONSUMER_MODE=worker，且 Key 已下发
curl -sS "https://api.aimv.video/health"   # 期望 ok
```

Internal 路由在全局 prefix 之外：路径是 `{MAIN}/internal/worker/...`，不是 `{MAIN}/api/internal/...`。

---

## 三、Phase 0 — 系统基线（root）

```bash
sudo bash -c '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
AI_USER=aistudio
AI_HOME=/opt/ai-studio

apt-get update -y
apt-get install -y \
  git curl ca-certificates gnupg build-essential python3 pkg-config \
  ffmpeg libass9 fontconfig fonts-noto-cjk fonts-liberation \
  libvips-dev chromium \
  htop tmux jq unzip rsync ufw

# Node 20
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm install -g pnpm@9 pm2
corepack enable || true

id -u "$AI_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$AI_USER"
mkdir -p "$AI_HOME"/{logs,backups} /var/cache/mv-worker
chown -R "$AI_USER:$AI_USER" "$AI_HOME" /var/cache/mv-worker

pm2 startup systemd -u "$AI_USER" --hp "/home/$AI_USER" >/dev/null || true
systemctl enable "pm2-${AI_USER}.service" 2>/dev/null || true

# 防火墙：Worker 只需入站 SSH；出站默认放行（拉 API + 预签名上传）
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

ffmpeg -version | head -1
ffprobe -version | head -1
chromium --version | head -1 || true
node -v; pnpm -v; pm2 -v
'

echo "═══ Phase 0 ✅ ═══"
```

**不要**装 Postgres/Redis。

---

## 四、Phase 1 — 拉取代码并按环境写配置

### 4.1 先写 patch 脚本到磁盘（避免嵌套引号）

```bash
cat > /tmp/patch-worker-constants.py <<'PY'
#!/usr/bin/env python3
import re, sys
path, main, key, wid, slots = sys.argv[1:6]

def sub_str(src, field, val):
    return re.sub(
        rf"({field}:\s*)'[^']*'",
        lambda m: m.group(1) + "'" + val.replace("\\", "\\\\").replace("'", "\\'") + "'",
        src,
        count=1,
    )

text = open(path, encoding="utf-8").read()
text = sub_str(text, "mainApiBaseUrl", main)
text = sub_str(text, "workerApiKey", key)
text = sub_str(text, "workerId", wid)
text = re.sub(r"(workerMaxSlots:\s*)\d+", r"\g<1>" + str(int(slots)), text, count=1)
open(path, "w", encoding="utf-8").write(text)
print("patched", path)
print("mainApiBaseUrl =", main)
print("workerId =", wid)
PY
chmod +x /tmp/patch-worker-constants.py
```

### 4.2 对 secrets 里每个 env 执行（示例：test；prod 改 ENV_NAME 与变量前缀）

```bash
set -a; source /tmp/worker-deploy-secrets.env; set +a

# ---- 按环境改这 5 行 ----
ENV_NAME=test
APP_DIR="${AI_HOME}/mv-studio-worker-${ENV_NAME}"
MAIN_URL="${TEST_MAIN_API_BASE_URL}"
KEY="${TEST_COMPOSE_WORKER_API_KEY}"
WID="${TEST_WORKER_ID}"
SLOTS="${TEST_WORKER_MAX_SLOTS}"
# prod 时：
# ENV_NAME=prod
# APP_DIR="${AI_HOME}/mv-studio-worker-prod"
# MAIN_URL="${PROD_MAIN_API_BASE_URL}"
# KEY="${PROD_COMPOSE_WORKER_API_KEY}"
# WID="${PROD_WORKER_ID}"
# SLOTS="${PROD_WORKER_MAX_SLOTS}"

if [[ "$ENV_NAME" == "test" && "$MAIN_URL" == *"api.aimv.video"* ]]; then
  echo "❌ test Worker 禁止指向生产 API: $MAIN_URL" >&2
  exit 1
fi

sudo -iu aistudio bash -lc "
set -euo pipefail
REPO_WORKER='${REPO_WORKER}'
WORKER_BRANCH='${WORKER_BRANCH:-main}'
APP_DIR='${APP_DIR}'
if [ ! -d \"\$APP_DIR/.git\" ]; then
  git clone --branch \"\$WORKER_BRANCH\" \"\$REPO_WORKER\" \"\$APP_DIR\"
else
  cd \"\$APP_DIR\" && git fetch origin && git checkout \"\$WORKER_BRANCH\" && git reset --hard \"origin/\$WORKER_BRANCH\"
fi
"

CONST="${APP_DIR}/src/config/worker.constants.ts"
python3 /tmp/patch-worker-constants.py "$CONST" "$MAIN_URL" "$KEY" "$WID" "$SLOTS"
grep -nE 'mainApiBaseUrl|workerId|workerMaxSlots' "$CONST"

# 若刚被 git reset 冲掉，可从备份恢复；首次则写入备份
sudo -iu aistudio mkdir -p /opt/ai-studio/secrets
sudo cp "$CONST" "/opt/ai-studio/secrets/worker-${ENV_NAME}.constants.ts"
sudo chown aistudio:aistudio "/opt/ai-studio/secrets/worker-${ENV_NAME}.constants.ts"
sudo chmod 600 "/opt/ai-studio/secrets/worker-${ENV_NAME}.constants.ts"
```

可选：把 `clipCacheDir` 设为 `/var/cache/mv-worker/<env>`，避免 test/prod 缓存互相污染。

对 `WORKER_ENVS` 中每个环境重复 §4.2，然后：

```
═══ Phase 1 ✅ ═══
```

---

## 五、Phase 2 — 安装依赖、构建、PM2 启动

仍以每个 env 循环：

```bash
sudo -iu aistudio bash -lc '
set -euo pipefail
APP_DIR=/opt/ai-studio/mv-studio-worker-test   # 或 -prod
PM2_NAME=mv-studio-worker-test                 # 或 -prod
cd "$APP_DIR"
corepack enable || true
pnpm install --frozen-lockfile
pnpm build
test -f dist/main.js

export REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium
export NODE_ENV=production

# 用 ecosystem 或直接 pm2 start
cat > /tmp/ecosystem-worker.json <<EOF
{
  "apps": [{
    "name": "'$PM2_NAME'",
    "cwd": "'$APP_DIR'",
    "script": "dist/main.js",
    "instances": 1,
    "exec_mode": "fork",
    "autorestart": true,
    "max_memory_restart": "3500M",
    "env": {
      "NODE_ENV": "production",
      "REMOTION_BROWSER_EXECUTABLE": "/usr/bin/chromium"
    },
    "out_file": "/opt/ai-studio/logs/'$PM2_NAME'-out.log",
    "error_file": "/opt/ai-studio/logs/'$PM2_NAME'-err.log",
    "time": true
  }]
}
EOF

if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 delete "$PM2_NAME" || true
fi
pm2 start /tmp/ecosystem-worker.json
pm2 save
pm2 status
'
```

```
═══ Phase 2 ✅ ═══
```

---

## 六、Phase 3 — 冒烟（claim / heartbeat）

从 secrets 取该环境的 `MAIN_URL` 与 `KEY`：

```bash
MAIN_URL="http://<测试API>:4001"   # 或 https://api.aimv.video
KEY="..."
WID="ubuntu-test-01-smoke"

curl -sS -o /tmp/claim.json -w "claim HTTP %{http_code}\n" \
  -X POST "${MAIN_URL%/}/internal/worker/jobs/claim" \
  -H "Authorization: Bearer ${KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"workerId\":\"${WID}\",\"maxSlots\":1}"

curl -sS -o /tmp/hb.json -w "heartbeat HTTP %{http_code}\n" \
  -X POST "${MAIN_URL%/}/internal/worker/heartbeat" \
  -H "Authorization: Bearer ${KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"workerId\":\"${WID}\",\"runningJobs\":0,\"capacity\":1,\"version\":\"smoke\"}"

# 期望 claim: 200 或 204；401 = Key 错误；连接失败 = URL/防火墙/API 未起
```

再看日志：

```bash
sudo -iu aistudio pm2 logs mv-studio-worker-test --lines 80 --nostream
```

业务冒烟（推荐）：在对应环境的 Admin/Web 触发一次 compose / editor 渲染，确认任务被该 Worker claim 并完成。

```
═══ Phase 3 ✅ ═══
```

---

## 七、Phase 4 — GitHub Self-hosted Runner（可选，用于 push 自动部署）

仅当 secrets 提供了 `RUNNER_TOKEN` 时执行。

```bash
sudo -iu aistudio bash -lc '
set -euo pipefail
source /tmp/worker-deploy-secrets.env
test -n "$RUNNER_TOKEN"
RUNNER_DIR="$HOME/actions-runner"
mkdir -p "$RUNNER_DIR" && cd "$RUNNER_DIR"
VER=2.329.0
if [ ! -f ./config.sh ]; then
  curl -fsSL -o actions-runner-linux-x64.tar.gz \
    "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-linux-x64-${VER}.tar.gz"
  tar xzf actions-runner-linux-x64.tar.gz && rm actions-runner-linux-x64.tar.gz
fi
if [ ! -f .runner ]; then
  ./config.sh --unattended \
    --url "https://github.com/${RUNNER_REPO}" \
    --token "$RUNNER_TOKEN" \
    --name "$(hostname)-mv-worker" \
    --labels "$RUNNER_LABELS" \
    --work _work \
    --replace
fi
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
'
```

仓库侧需有 workflow（若尚未合入，先手动 Phase 1–3；workflow 合入后示例如下）：

```yaml
# .github/workflows/deploy-worker.yml
name: Deploy Worker
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      target:
        description: test or prod
        required: true
        default: test
jobs:
  deploy-test:
    if: github.event_name == 'push' || inputs.target == 'test'
    runs-on: [self-hosted, mv-studio-worker, test]
    steps:
      - name: Redeploy test worker
        run: |
          set -euo pipefail
          APP=/opt/ai-studio/mv-studio-worker-test
          # 保留本机已 patch 的 worker.constants.ts：只更新代码时用 stash/备份策略
          # 推荐：constants 从 /opt/ai-studio/secrets/worker-test.env 生成，勿被 git reset 覆盖
          cd "$APP"
          cp src/config/worker.constants.ts /tmp/worker.constants.ts.bak
          git fetch origin main && git reset --hard origin/main
          cp /tmp/worker.constants.ts.bak src/config/worker.constants.ts
          # 更好：每次从 /opt/ai-studio/secrets/worker-test.constants.ts 覆盖
          if [ -f /opt/ai-studio/secrets/worker-test.constants.ts ]; then
            cp /opt/ai-studio/secrets/worker-test.constants.ts src/config/worker.constants.ts
          fi
          pnpm install --frozen-lockfile
          pnpm build
          pm2 restart mv-studio-worker-test
          pm2 save
```

**配置防丢失（强烈建议 Phase 1 末尾做）：**

```bash
sudo -iu aistudio mkdir -p /opt/ai-studio/secrets
sudo -iu aistudio cp /opt/ai-studio/mv-studio-worker-test/src/config/worker.constants.ts \
  /opt/ai-studio/secrets/worker-test.constants.ts
chmod 600 /opt/ai-studio/secrets/worker-test.constants.ts
# prod 同理 → worker-prod.constants.ts
```

之后每次 `git reset --hard` 后先从 secrets 拷回再 build。

```
═══ Phase 4 ✅ ═══
```

---

## 八、验收清单

- [ ] `WORKER_ENVS` 中每个环境 PM2 `online`
- [ ] claim 冒烟 204/200，非 401
- [ ] test 的 `mainApiBaseUrl` ≠ `https://api.aimv.video`
- [ ] prod（若部署）的 `mainApiBaseUrl` = `https://api.aimv.video`
- [ ] `/opt/ai-studio/secrets/worker-*.constants.ts` 已备份且权限 600
- [ ] （可选）Runner online，标签与环境一致
- [ ] 触发一笔合成任务，日志出现 Claim → Complete

---

## 九、故障排查

| 现象 | 原因 | 处理 |
|------|------|------|
| claim 401 | Key 与 API 不一致 | 对齐两边 `COMPOSE_WORKER_API_KEY`，重建 Worker |
| claim 连不上 | URL 错 / 测试 API 未起 / 安全组拦出站 | `curl {MAIN}/health`；查 ufw 出站、云安全组 |
| claim 404 | 打到了 `/api/internal/...` | 必须用 `{MAIN}/internal/worker/...`（无 `/api` 前缀） |
| 有任务但不跑 | API 仍是 `COMPOSE_CONSUMER_MODE=local` | API 改为 `worker` 并重启 |
| Remotion 失败 | 无 chromium | `apt install chromium`，设 `REMOTION_BROWSER_EXECUTABLE` |
| 字幕乱码 | 缺中文字体 | `fonts-noto-cjk` |
| 测试任务进了生产 | Worker 指错 API | 立刻停错环境 PM2，检查 constants |
| `git reset` 后连错环境 | 配置被覆盖 | 从 `/opt/ai-studio/secrets/` 恢复再 build |

---

## 十、回滚

```bash
# 停 Worker（API 可临时改回 local 自己吃队列）
sudo -iu aistudio pm2 stop mv-studio-worker-test
# 测试 API：
# COMPOSE_CONSUMER_MODE=local && pm2 restart mv-studio-api
```

生产回滚同理：停 `mv-studio-worker-prod`，必要时把生产 API `COMPOSE_CONSUMER_MODE` 改回 `local`（需评估 API 机器算力）。

---

## 十一、给用户的交卷摘要（Agent 完成后打印）

```
WORKER_ENVS=...
test: MAIN=...  PM2=mv-studio-worker-test  claim=...
prod: MAIN=...  PM2=mv-studio-worker-prod  claim=...（若有）
secrets backup: /opt/ai-studio/secrets/
runner: online/skipped
```

---

## 附录 A — 最小 secrets 示例（仅测试机）

```bash
WORKER_ENVS=test
REPO_WORKER=https://github.com/msea-ai/mv-studio-work.git
WORKER_BRANCH=main
AI_USER=aistudio
AI_HOME=/opt/ai-studio

TEST_MAIN_API_BASE_URL=http://43.135.185.239:4001
TEST_COMPOSE_WORKER_API_KEY=请填写与测试API一致的密钥
TEST_WORKER_ID=ubuntu-test-01
TEST_WORKER_MAX_SLOTS=2

# 本机暂不装 runner 可留空
RUNNER_TOKEN=
RUNNER_REPO=msea-ai/mv-studio-work
RUNNER_LABELS=self-hosted,mv-studio-worker,test
```

> `43.135.185.239` 仅为历史测试机 IP 示例；以你当前测试 API 实际地址为准。若 Worker 与测试 API **同机**，用 `http://127.0.0.1:4001`。

## 附录 B — 最小 secrets 示例（仅生产算力机）

```bash
WORKER_ENVS=prod
REPO_WORKER=https://github.com/msea-ai/mv-studio-work.git
WORKER_BRANCH=main
AI_USER=aistudio
AI_HOME=/opt/ai-studio

PROD_MAIN_API_BASE_URL=https://api.aimv.video
PROD_COMPOSE_WORKER_API_KEY=请填写与生产API一致的密钥
PROD_WORKER_ID=ubuntu-prod-01
PROD_WORKER_MAX_SLOTS=2

RUNNER_TOKEN=
RUNNER_REPO=msea-ai/mv-studio-work
RUNNER_LABELS=self-hosted,mv-studio-worker,prod
```
