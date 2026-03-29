# MOLT 技术方案设计文档

> 版本：v3.2 | 更新日期：2026-03-29
> 本文档基于 Hackathon 路演交付版本更新，反映实际落地的技术架构。

## 1. 目标

本方案用于支撑 MOLT 求职节点社交平台的 Hackathon 阶段最小可演示版本，优先保证核心链路稳定、部署简单、降级清晰。

核心链路：三张卡片路径选择 → 记忆导入（可选）→ 脱壳三幕卡片选择 → 画像合成 + 语义聚类 → 节点匹配 → 信号连接

## 2. 技术选型

- **前端框架：** `React + TypeScript + Tailwind CSS`
- **服务端：** `Supabase Edge Functions`（无服务器，替代 Next.js Route Handlers）
- **数据库：** `PostgreSQL（Supabase 托管）`
- **会话状态：** `LocalStorage`（替代 Redis，Hackathon 阶段足够）
- **AI 服务：** `Claude Sonnet / OpenAI`（通过 `.env` 双兼容）
- **向量引擎：** `text-embedding-3-small`（1536维向量）
- **种子数据：** 静态 JSON 文件（31个灯塔节点 + 预计算特征向量 + 兜底卡片池）

> **v3.2 架构变更说明：**
> - 移除 Redis：会话状态改由 LocalStorage 承载，Hackathon 阶段不引入 Redis 依赖
> - 移除 Next.js：服务端迁移至 Supabase Edge Functions，部署更简单
> - 新增向量引擎：text-embedding-3-small 实现语义聚类与异时态匹配
> - API 端点完全重新设计（见第4节）

## 3. 系统边界

```text
Browser (React + TypeScript + Tailwind CSS)
  -> HTTPS
  -> Supabase Edge Functions
     -> /api/memory-import    （记忆解析）
     -> /api/molt-cards       （动态出题）
     -> /api/profile-synth    （画像合成 + 向量嵌入）
     -> /api/match            （节点匹配引擎）
  -> LLM Adapter (Claude Sonnet / OpenAI)
  -> Embedding Service (text-embedding-3-small)
  -> PostgreSQL (Supabase)
     -> user_profiles         （用户画像 + 向量）
     -> lighthouse_nodes      （灯塔节点）
     -> signals               （信号记录）
     -> connections           （连接关系）
  -> 种子数据 (静态 JSON)
     -> lighthouses.json      （31个灯塔节点 + 预计算向量）
     -> fallback_cards.json   （三幕兜底卡片池）
     -> career_timelines.json （职业发展时间轴）
  -> LocalStorage (会话状态)
     -> 脱壳进度
     -> 已选卡片 + profileFields
     -> 记忆导入缓存
```

## 4. 核心 API 模块

### 4.1 记忆导入模块 `POST /api/memory-import`

**职责：** 接收用户从 AI 助手粘贴的自由文本，解析为结构化 MOLT Profile

**LLM 调用：**
- 调用次数：0-1次（有文本才调用）
- Token 消耗：~800
- 输出约束：严格 JSON，包含置信度评分

**接口定义：**
```ts
interface MemoryImportRequest {
  sessionId: string;
  pathType: 'A' | 'B';
  rawText: string;
}

interface MemoryImportResponse {
  sessionId: string;
  profileFields: Partial<MOLTProfile>;
  confidenceScores: Record<string, number>;
  fallbackUsed: boolean;
}
```

**降级：** AI 解析失败时返回空 profileFields，用户无感知，直接进入脱壳三幕

---

### 4.2 动态出题模块 `POST /api/molt-cards`

**职责：** 根据前序选择 + 记忆导入结果，为每一幕动态生成5-6张卡片

**LLM 调用：**
- 调用次数：每幕1次，共3次
- Token 消耗：~1,200/次，合计~3,600
- 输出包含两类指令结果：叙事文案 + profileFields 映射

**卡片设计规则：**
- 每张卡片：两行≤12字的短句，语气是猜测而非诊断
- 每张卡片背后携带 `profileFields` 映射（anxiety_type、major_field 等）
- 用户在感受层面是"在别人的话里认出自己"，在数据层面是"完成画像字段采集"

**接口定义：**
```ts
interface MoltCardsRequest {
  sessionId: string;
  actIndex: 1 | 2 | 3;
  previousSelections?: CardSelection[];
  memoryProfile?: Partial<MOLTProfile>;
}

interface MoltCardsResponse {
  cards: Array<{
    text: string;
    profileFields: Record<string, string>;
  }>;
  fallbackUsed: boolean;
}
```

**降级：** 使用 `fallback_cards.json` 中的静态卡片池，按 actIndex 分组选取

**幕间叙事动画：**
- "裂缝正在扩大..." 动画遮盖 LLM 出题的1-2秒延迟
- 叙事节奏的一部分，非 loading spinner

---

### 4.3 画像合成模块 `POST /api/profile-synth`

**职责：** 将脱壳三幕的 profileFields + 记忆导入结果合成为自然语言画像，生成1536维向量，执行语义聚类

**LLM 调用：**
- 调用次数：1次（画像合成）
- Token 消耗：~600

**向量嵌入：**
- 模型：text-embedding-3-small
- 维度：1536
- 调用次数：1次
- Token 消耗：~200

**ARG 推理架构（Agent Reasoning Graph）：**
```text
检索已有 MOLT Profile
  -> 画像完整度 & 置信度判断
  -> 已足够?
     是 -> 直接进入聚类与匹配
     否 -> 弱信号推断（卡片点击行为）
          -> 仍不足 -> 外部信息补全（LLM 推断）
          -> 合成自然语言描述
          -> 向量嵌入
          -> 语义聚类
```

**语义聚类：**
- 将用户向量与预计算的群体中心向量比较
- 找到最近语义节点群（如"文科 × AI焦虑 × 产品方向"）
- 输出群体规模 + 已走出来的人数

**接口定义：**
```ts
interface ProfileSynthRequest {
  sessionId: string;
  selections: CardSelection[];
  memoryProfile?: Partial<MOLTProfile>;
}

interface ProfileSynthResponse {
  sessionId: string;
  naturalLanguageProfile: string;
  embeddingVector: number[];          // 1536维，存入数据库
  clusterInfo: {
    clusterLabel: string;
    clusterSize: number;
    landedCount: number;
  };
  fallbackUsed: boolean;
}
```

---

### 4.4 节点匹配模块 `POST /api/match`

**职责：** 三维评分引擎，实现异时态语义匹配，找到"曾经和你相似、现在已走出来"的灯塔用户

**匹配核心逻辑：**
```text
load_profile (检索用户 MOLT Profile)
  -> filter_candidates (过滤：公开、字段完整、可展示)
  -> build_ranking_features (计算三维特征)
  -> rank_candidates (三维加权评分)
  -> select_top_k
  -> generate_match_reason (LLM，约400 tokens)
  -> return result
```

**三维评分引擎：**
```ts
matchScore =
  cosineSimilarity(userVector, lighthouseHistoricalVector) * 0.50  // 语义相似度
  + temporalScore(lighthouse.exitDate) * 0.30                       // 时序匹配度
  + directionMatch(user.direction, lighthouse.direction) * 0.20;    // 方向匹配度

// 时序评分：走出 crisis 节点的时间越近分越高
function temporalScore(exitDate: Date): number {
  const monthsAgo = monthsBetween(exitDate, now);
  return monthsAgo <= 3 ? 1.0 : Math.max(0, 1 - (monthsAgo - 3) / 12);
}
```

**关键区别（异时态语义匹配）：**
- 普通推荐：比较用户"现在"vs候选人"现在"
- MOLT匹配：比较用户"现在"vs候选人"过去（历史节点向量）"
- 灯塔节点在 Path C 建档时同时存储当时的历史画像向量

**LLM 调用：**
- `generate_match_reason`：调用1次，约400 tokens
- `filter_candidates`、`rank_candidates`：不调用 LLM，规则 + 向量计算

**接口定义：**
```ts
interface MatchRequest {
  sessionId: string;
  pathType: 'A' | 'B';
  userVector: number[];
  explorationDirection?: string;
}

interface MatchResponse {
  sessionId: string;
  targetNodeId: string;
  matchScore: number;
  semanticScore: number;
  temporalScore: number;
  directionScore: number;
  matchReason: string;
  lighthouseMessage: string;   // 灯塔 Q3 原话
  fallbackUsed: boolean;
}
```

**配置项：**
```ts
interface MatchConfig {
  topK: number;                // 进入 LLM 的候选数量
  semanticWeight: number;      // 0.50
  temporalWeight: number;      // 0.30
  directionWeight: number;     // 0.20
  temporalDecayMonths: number; // 3（3个月内=满分）
}
```

**Fallback：**
- 无合适候选：返回默认灯塔节点（从种子数据选）
- LLM 失败：使用预生成 matchReason 模板
- 每次 fallback 必须打印明确原因到终端，禁止静默降级

---

### 4.5 AI Provider Router

- 启动时读取 `.env`
- 根据 `AI_PROVIDER` 选择 Claude 或 OpenAI 适配器
- 对上层模块暴露统一的 `generateText()` 能力
- 所有调用链路输出详细终端日志：step、provider、model、输入摘要、耗时、重试次数、fallback 原因

---

### 4.6 信号与连接模块

- 用户发送信号：写入 `signals` 表，记录 `from_user_id`、`to_node_id`
- 检查双向信号：查询是否存在对向信号记录
- 解锁同频：双向信号存在时更新 `connections` 状态为 `unlocked`
- 前端用 LocalStorage 缓存信号发送状态，发送失败时保留并支持重试

---

## 5. 数据模型

### 5.1 user_profiles

```sql
id               uuid primary key
session_id       uuid
path_type        text                      -- 'A' | 'B' | 'C'
profile_fields   jsonb                     -- 六层画像字段（结构化）
natural_language text                      -- 合成的自然语言描述
embedding_vector vector(1536)              -- text-embedding-3-small 向量
cluster_label    text                      -- 语义节点群标签
confidence_score jsonb                     -- 各字段置信度
memory_imported  boolean default false
created_at       timestamptz
updated_at       timestamptz
```

### 5.2 lighthouse_nodes

```sql
id               uuid primary key
node_type        text                      -- 'seed' | 'user_generated'
path_type        text                      -- 固定 'C'
start_point      text                      -- 过渡前状态（Q1）
turning_point    text                      -- 转折（Q2）
current_state    text                      -- 现状（推断）
light_message    text                      -- 那句话（Q3 原话）
direction        text                      -- 探索方向
historical_embedding vector(1536)          -- Path C 建档时的历史画像向量（关键！）
exit_date        timestamptz               -- 走出 crisis 节点的时间（时序评分依据）
visibility       text                      -- 'full' | 'partial' | 'minimal'
is_public        boolean default true
is_seed          boolean default false
created_at       timestamptz
```

### 5.3 molt_selections

```sql
id               uuid primary key
session_id       uuid
act_index        int                       -- 1 | 2 | 3
card_text        text
profile_fields   jsonb                     -- 该卡片携带的字段映射
created_at       timestamptz
```

### 5.4 signals

```sql
id               uuid primary key
from_session_id  uuid
to_node_id       uuid
status           text                      -- 'sent' | 'received'
created_at       timestamptz
```

### 5.5 connections

```sql
id               uuid primary key
session_a_id     uuid
session_b_id     uuid
status           text                      -- 'signaled' | 'unlocked'
created_at       timestamptz
```

---

## 6. 种子数据规范

### 6.1 lighthouses.json（31个灯塔节点）

```json
{
  "lighthouses": [
    {
      "id": "lh_001",
      "startPoint": "英语翻译专业应届生",
      "turningPoint": "看到 AI 翻译工具后开始自学产品",
      "currentState": "已入职某互联网公司产品岗",
      "lightMessage": "你现在会的东西，比你以为的更有价值",
      "direction": "产品",
      "exitDateMonthsAgo": 2,
      "historicalEmbedding": [...],      // 预计算，1536维
      "visibility": "partial"
    }
    // ... 30 more
  ]
}
```

### 6.2 fallback_cards.json（兜底卡片池）

```json
{
  "act1": [
    { "text": "我学的东西好像突然没人要了", "profileFields": { "anxiety_type": "skill_obsolete", "major_field": "humanities" } },
    { "text": "AI做的事和我做的事越来越像了", "profileFields": { "anxiety_type": "ai_replacement", "major_field": "unknown" } }
    // ... per act
  ],
  "act2": [...],
  "act3": [...]
}
```

---

## 7. 用户画像字段体系（MOLTProfile）

```ts
interface MOLTProfile {
  // 身份基础层
  educationStage?: string;       // '大三' | '大四' | '应届' | '在职'
  majorField?: string;           // 专业领域
  careerStatus?: string;         // 当前职业状态

  // 焦虑图谱层
  anxietyType?: string;          // 核心焦虑类型（来自第一幕）
  anxietyDuration?: string;      // 焦虑持续时长

  // 能力资产层
  hardSkills?: string[];         // 硬技能
  softSkills?: string[];         // 软实力
  undervaluedSkills?: string[];  // 被低估能力

  // 方向意图层
  explorationDirection?: string; // 探索方向（来自第三幕）
  actionStage?: string;          // 行动阶段
  helpNeeded?: string;           // 期望获得的帮助类型

  // 人格特质层（来自记忆导入推断）
  decisionStyle?: string;
  socialPreference?: string;
  communicationStyle?: string;

  // 时序轨迹层（全流程累积）
  nodeSequence?: string[];       // ['crisis', 'exploring', 'landed']
  currentNode?: string;
}
```

---

## 8. 降级与容错

- AI Provider 超时阈值：`8 秒`
- 每个 AI 节点最多重试：`1 次`
- 超时后优先回退模板，不阻塞主流程
- **降级卡片池**：三幕使用 `fallback_cards.json` 静态卡片，核心流程不中断
- **叙事性加载**：LLM 出题耗时1-2秒，用"裂缝正在扩大..."动画遮盖
- **向量预计算**：种子灯塔数据的画像向量部署前离线生成，运行时只计算当前用户向量
- PostgreSQL 不可用时：路演模式使用内置 mock 数据继续展示
- 每次 fallback 必须打印：step、触发原因、替代输出来源；禁止静默降级

---

## 9. 部署建议

- **前端：** Vercel / Netlify
- **服务端：** Supabase Edge Functions（自动部署）
- **数据库：** Supabase 托管 PostgreSQL（包含 pgvector 扩展）
- **向量存储：** pgvector（PostgreSQL 扩展，无需额外服务）

**环境变量：**
```env
AI_PROVIDER=claude
AI_API_URL=https://api.anthropic.com/v1/messages
AI_API_KEY=your_provider_key
AI_MODEL=claude-sonnet-4-5
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
OPENAI_API_KEY=your_openai_key        # 向量嵌入（text-embedding-3-small）
APP_ENV=demo
DEMO_MODE=false
```

**配置读取规范：**
- 统一通过 `config.ts` 读取 `.env`
- `AI_PROVIDER` 只接受 `claude` 与 `openai`
- 缺失关键环境变量时，启动阶段直接报错
- 匹配评分权重通过 `config.ts` 内部配置维护，不通过 `.env`

---

## 10. 算力成本

| 环节 | 模型 | 调用次数 | Token消耗/次 | 小计 |
|------|------|---------|-------------|------|
| 记忆解析 | Claude Sonnet | 0-1 | ~800 | 0-800 |
| 三幕出题 | Claude Sonnet | 3 | ~1,200 | ~3,600 |
| 画像合成 | Claude Sonnet | 1 | ~600 | ~600 |
| 匹配理由 | Claude Sonnet | 1 | ~400 | ~400 |
| 向量嵌入 | text-embedding-3-small | 1 | ~200 | ~200 |
| **合计** | | **5-7次** | | **~4,800-5,600** |

单用户约5,000 tokens，远低于通用对话类产品（10,000-50,000 tokens/会话）。

---

## 11. 开发优先级

1. **Landing + 三张卡片 Onboarding**（路径分流）
2. **脱壳三幕**（卡片选择 + profileFields 采集）
3. **画像合成 + 向量嵌入**（`/api/profile-synth`）
4. **节点匹配引擎**（`/api/match` + 三维评分）
5. **匹配结果展示**（匹配理由 + 灯塔留言）
6. **信号功能**（发送 + 双向检测 + 同频解锁）
7. **记忆导入**（可选，`/api/memory-import`）
8. **Path C 灯塔建档流程**
9. **地图可视化**（31个种子节点静态展示）

---

## 12. 非目标

以下内容不进入本轮技术实现：

- 即时通讯系统
- 复杂推荐算法（三维评分已足够）
- 多角色权限系统
- 多端同步
- Redis 缓存层
- DISPLACE 置换压力指数（已合并入画像合成结果）
