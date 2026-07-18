# 合成压测服务器 — Cursor Agent 部署说明

> 用途：在新服务器上**只测 FFmpeg 合成性能**（时长 × 并发矩阵），不依赖 API / 数据库 / COS。
> 压测脚本：`scripts/benchmark-compose.mjs`

---

## 1. 要装哪些依赖

### 1.1 仅跑 FFmpeg 压测（最小集）

| 依赖 | 用途 | 安装命令（Ubuntu 24.04） |
|------|------|--------------------------|
| **ffmpeg** | 合成 trim / concat / mix / 字幕 | `sudo apt update && sudo apt install -y ffmpeg` |
| **Node.js ≥ 18** | 运行压测脚本 | 见下方 Node 安装 |
| **git**（可选） | 拉代码 | `sudo apt install -y git` |

验证：

```bash
ffmpeg -version | head -1
ffprobe -version | head -1
node -v    # 建议 v20+
```

Node 20 安装（若无）：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

**压测脚本零 npm 依赖**，不需要 `pnpm install`。

### 1.2 后续部署真实 Worker（压测通过后再做）

| 依赖 | 用途 |
|------|------|
| node 20 + pnpm | 运行 `mv-studio-worker` |
| ffmpeg + libass + fontconfig | 字幕烧录 |
| fonts-noto-cjk | 中文字幕 |
| chromium | Remotion 歌词渲染（editor/subtitle 任务） |

Docker 方式见仓库根目录 `Dockerfile`（已包含上述系统包）。

---

## 2. 数据盘（推荐，48 核大并发必做）

若服务器有独立数据盘（如 `/dev/vdb1` 300G），挂载后用作压测临时目录：

```bash
# 仅首次：格式化并挂载（确认 vdb1 无重要数据再执行）
sudo mkfs.ext4 /dev/vdb1
sudo mkdir -p /data/mv-bench
echo '/dev/vdb1 /data/mv-bench ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
sudo chown -R "$USER":"$USER" /data/mv-bench
df -h /data/mv-bench
```

压测时使用 `--tmp-dir /data/mv-bench`。

---

## 3. 获取压测脚本

```bash
# 方式 A：克隆 worker 仓库
git clone git@github.com:lzxdanny-debug/mv-studio-worker.git
cd mv-studio-worker

# 方式 B：只拷贝脚本（无 git）
mkdir -p ~/mv-bench/scripts
# 将 scripts/benchmark-compose.mjs 放到 ~/mv-bench/scripts/
```

---

## 4. 运行压测

### 4.1 快速冒烟（约 1~2 分钟）

```bash
cd mv-studio-worker   # 或脚本所在目录
node scripts/benchmark-compose.mjs \
  --duration 60 \
  --concurrency 1 \
  --report /data/mv-bench/smoke.md
```

### 4.2 标准矩阵（推荐：时长 × 并发）

**2 核测试机参考：**

```bash
node scripts/benchmark-compose.mjs \
  --durations 60 \
  --concurrency 1,2,3 \
  --report /tmp/mv-bench-2c.md
```

**48 核新机器参考：**

```bash
node scripts/benchmark-compose.mjs \
  --durations 60,180 \
  --concurrency 1,5,10,15 \
  --tmp-dir /data/mv-bench \
  --report /data/mv-bench/report-$(date +%Y%m%d).md
```

### 4.3 带字幕 / 调色（更接近生产）

```bash
node scripts/benchmark-compose.mjs \
  --durations 180 \
  --concurrency 1,5,10 \
  --with-subtitle \
  --tmp-dir /data/mv-bench \
  --report /data/mv-bench/report-subtitle.md
```

### 4.4 一键脚本

```bash
bash scripts/run-benchmark.sh
# 或自定义：
DURATIONS=60,180 CONCURRENCY=1,5,10,15 TMP_DIR=/data/mv-bench bash scripts/run-benchmark.sh
```

---

## 5. CLI 参数说明

| 参数 | 含义 | 示例 |
|------|------|------|
| `--durations` | MV 成片时长档位（秒，逗号分隔） | `60,180,480` |
| `--duration` | 单一时长（等价 `--durations 180`） | `180` |
| `--concurrency` | 并发合成路数（逗号分隔） | `1,5,10,15` |
| `--clip-sec` | 每镜时长（默认 5s） | `5` |
| `--aspect` | 画幅 `16:9` / `9:16` / `1:1` | `16:9` |
| `--with-subtitle` | 增加字幕烧录 pass | — |
| `--with-grade` | 增加调色 pass | — |
| `--tmp-dir` | 临时文件根目录 | `/data/mv-bench` |
| `--report` | Markdown 报告路径 | `/data/mv-bench/report.md` |
| `--keep-workdir` | 不删临时目录（排错用） | — |

环境变量（可选）：

- `FFMPEG_PATH` / `FFPROBE_PATH`
- `MV_BENCH_TMP_DIR`（等同 `--tmp-dir`）

---

## 6. 输出文件

运行结束后生成：

- `*.md` — 人类可读报告（汇总矩阵 + 阶段拆解 + 容量建议）
- `*.json` — 同路径同名 JSON（机器可读）

### 关键指标

| 指标 | 含义 |
|------|------|
| **编码墙钟 / 合成时间** | trim + mix 等编码阶段耗时（不含本地 gen 素材） |
| **实时因子** | 编码墙钟 ÷ 成片时长；0.89 = 60s 片编码约 54s |
| **CPU 因子** | 编码 CPU 秒 ÷ 成片时长；容量规划核心 |
| **争抢因子** | 单路墙钟之和 ÷ 并发总墙钟；≈并发数 = 线性扩展 |
| **整机 CPU** | 压测期间平均 CPU；>80% 说明接近瓶颈 |

### 定 WORKER_MAX_SLOTS

从报告中取 **并发 = 1** 的 **CPU 因子**（记为 `F`），机器逻辑核数 `C`：

```
安全并发 ≈ floor(C × 0.8 / F)
```

例：48 核、`F=1.7` → 约 **22**，建议先设 **15~20**，再压测 `--concurrency 15` 看整机 CPU 是否 <80%。

---

## 7. Agent 执行检查清单

- [ ] `ffmpeg` / `ffprobe` / `node -v` 可用
- [ ] 数据盘已挂载到 `/data/mv-bench`（大并发）
- [ ] 跑 `--duration 60 --concurrency 1` 冒烟成功
- [ ] 跑完整 `--durations` × `--concurrency` 矩阵
- [ ] 保存 `.md` + `.json` 报告
- [ ] 根据 CPU 因子给出 `WORKER_MAX_SLOTS` 建议

---

## 8. 常见问题

| 问题 | 处理 |
|------|------|
| `找不到 ffmpeg` | `apt install ffmpeg` |
| `/tmp` 空间不足 | 使用 `--tmp-dir /data/mv-bench` |
| 高并发 OOM | 降 `--concurrency`；61G 内存一般可支撑 15+ 路 |
| 压测与生产不一致 | 生产还有 COS 下载/上传；压测只测 FFmpeg 算力 |
