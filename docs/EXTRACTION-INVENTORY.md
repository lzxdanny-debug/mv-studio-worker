# 主服务待抽离代码清单（Extraction Inventory）

标记规则：
- 🟢 **纯逻辑**：无 DB/无业务依赖，可直接复制进 Worker
- 🟡 **半耦合**：含 DB 读写/项目状态，需拆成「纯计算」+「主服务编排」两部分
- 🔴 **留主服务**：不进 Worker

---

## P0 视频合成 — `mv/services/mv-composition.service.ts`

| 方法 | 行(约) | 标记 | 拆分说明 |
|------|--------|------|----------|
| `composeFinalMv` | 421 | 🟡 | 编排(读project/下载/上传/写库)留主服务；FFmpeg 合成核心 → Worker |
| `recomposeSubtitleOnly` | 859 | 🟡 | 同上，字幕重渲核心 → Worker |
| `renderEditorConfig` | 1020 | 🟡 | 编辑器渲染核心 → Worker |
| `cutShotAudioClip` | 368 | 🟢 | 音频切片，纯 FFmpeg → Worker |
| `spawnFfmpeg` | 2098 | 🟢 | spawn + `time=` 进度解析 → Worker `ffmpeg-runner` |
| `getCanvasSize` | 1687 | 🟢 | 纯函数（宽高计算）→ Worker `canvas.ts` |
| 调色/转场/scale-crop 滤镜构造 | 1826+ | 🟢 | → Worker `filters.ts` |
| 抽帧缩略图 | — | 🟢 | → Worker `editor.handler` |
| 内存任务追踪(AbortController) | 141 | 🔴 | 被 compose_jobs 队列取代 |

## P0 字幕 — `mv/services/subtitle.service.ts`
| 能力 | 标记 | 说明 |
|------|------|------|
| `burnSubtitleOntoVideo` | 🟢 | ASS 烧录 → Worker |
| ASS 样式构造 | 🟢 | → Worker `ass-builder.ts` |
| `diagnose`(字体/滤镜自检) | 🟢 | → Worker 启动自检 |

## P1 音频
| 文件 | 能力 | 标记 |
|------|------|------|
| `mountsea/services/audio-compression.service.ts` | `compress` | 🟢 → Worker `audio.handler` |
| `mountsea/services/gemini-audio.service.ts` | `downloadAndClipFirstNSeconds` | 🟡 推荐路径截取，见下方决策 |
| `mv/services/wan-video.service.ts` | `extractAndUploadAudioSegment` | 🟢 → Worker |

## P2 图片 — `storage/cos.service.ts`
| 能力 | 标记 | 说明 |
|------|------|------|
| `uploadImageFromUrlOptimized`(sharp) | 🟢 | 优化转码 → Worker `image.handler`（上传仍走预签名）|
| `getObjectUrl` / `putObject` / 签名 | 🔴 | 持云凭证，留主服务 → 演进为 StorageProvider |

---

## 🔴 明确留在主服务

| 项 | 原因 |
|----|------|
| AI 生成编排 Step2–9(`mv-generation.service.ts`) | 业务编排，无 FFmpeg |
| 计费/通知/鉴权/项目状态机 | 业务与数据源 |
| COS 凭证与签名 | 安全边界（Worker 零凭证） |
| **推荐路径音频截取** | 见决策 |

### 决策：推荐路径的音频截取不进 Worker
`mv-recommendation.service.ts` → `lightweightRecommendWithAudio` 需先截取音频再喂 Gemini。
若走 Worker 队列会引入「排队+跨网络往返」延迟，破坏推荐的同步体验。

**结论**：保留主服务一处最小 ffmpeg（仅音频截取，几百 ms，CPU 极小），
或改为「上传原音 → 主服务只做轻量 seek 截取」。K8s 主服务镜像仍装 ffmpeg，
但只用于此轻量场景，不参与重合成。这样主服务基本无重 FFmpeg 负载。

---

## 复制 vs 共享包结论
- 🟢 纯逻辑：**复制进 Worker**（最终主服务删除，不存在长期双份维护）
- 契约类型：初期**手抄同步**；漂移频繁再抽 `@mv-studio/media-core`（仅类型，不含逻辑）
- ❌ 不建 media-core 放 FFmpeg 逻辑：主服务终态无此逻辑，共享无意义
