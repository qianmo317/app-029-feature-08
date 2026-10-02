# 招牌字排版与材料清单 · Signage Letter Layout

> 类型：前端 Web 应用（纯前端）｜难度：★★★★｜技术栈：**Vue 3 + TypeScript + Vite**（`<script setup>` 单文件组件；字体轮廓解析 + 笔画分析；禁用 UI 组件库与图表库，见 README §5.1）

## 1. 一句话简介
广告店做门头招牌：按门头宽度把字排开（字号、字距、留边都算准），并据此算出亚克力板用量、LED 模组数量与电源功率，直接出一张材料和报价单。

## 2. 真实场景与痛点
- 排字靠眼估：字距大了显得散、小了笔画粘连；两边留边不对称，客户一眼就能看出来。
- 发光字要算 LED：模组排太稀中间发暗，排太密浪费又发热；**电源功率配小了会烧、配大了浪费**，这是最容易返工的一环。
- 亚克力板材是按张买的（1220×2440mm 常见），一批字的用量只能估，常常剩一大堆废料。
- 报价靠经验，材料明细说不清楚，客户砍价时没有依据。

## 3. 目标用户
- 广告制作店、标识标牌厂（接门头/店招/导视牌）。
- 门店老板（自己算个大概，用来比价）。
- 设计工作室（出方案时同步出材料量）。

## 4. 核心功能（MVP）
1. **门头参数**：总宽 × 总高（mm），有效安装区（扣除铝塑板边框），安装方式（贴墙/挂板/立牌）。
2. **文字与字体**：输入文字（含多行），从本地字库选字体（黑体/宋体/楷体/圆体/艺术体），字号（字高 mm）、字重；支持逐字微调字距与上下偏移。
3. **排版（核心）**：水平排布、居中、两端对齐、垂直居中；实时显示：
   - 实际占宽/占高、左右留边是否对称、是否超出安装区（超出直接标红并给出建议字号）；
   - 视觉间距（按相邻字的字形轮廓最近距离计算，不是靠文本框宽度）。
4. **字形分析**：把一个字的轮廓拆成连通域（笔画块）与外部轮廓，给出：
   - 笔画块数量（决定需要几块亚克力/几段发光区）；
   - 每条轮廓的周长（决定 LED 布点长度）；
   - 最细笔画宽度（低于工艺下限如 8mm 时警告：太细做不出/易断）。
5. **LED 与电源计算**：输入模组间距、单模组功率/亮度、电源效率与安全系数 → 算出模组数量、总功率、建议电源规格（按标准功率档位向上取）。
6. **材料清单与报价**：亚克力板用量（按板材规格做面积拼版）、LED 模组数、电源数、胶与配件、加工费；导出报价单（PDF/Excel）与工艺卡。

## 5. 进阶功能
- 多材质对比（亚克力发光字 / 钛金字 / PVC 字 / 贴膜字 / 不锈钢边条）成本对照。
- 导视牌批量：一组牌子的字统一排布与材料汇总。
- 亚克力板材拼版图（板材利用率、裁切尺寸清单）。
- 效果预览（简单正面渲染 + 夜间发光模拟，仅示意不做 3D）。

## 6. 页面结构
```
/                 新建门头（尺寸 + 文字）
/edit/:id         排版编辑（预览 + 字号/字距微调 + 字形分析）
/light/:id        LED 与电源计算
/materials/:id    材料清单与板材拼版
/quote/:id        报价单（可打印）
/fonts            本地字库管理
/presets          材质与工艺预设
```

## 7. 数据模型
```ts
type SignPanel = { wMm: number; hMm: number; mounting: 'wall'|'board'|'freestanding' };
type Glyph = {
  char: string; fontId: string; sizeMm: number;
  bboxMm: { x: number; y: number; w: number; h: number };
  contours: { areaMm2: number; perimeterMm: number; isHole: boolean }[];
  strokeBlocks: number;        // 连通域（笔画块）数量
  minStrokeMm: number;         // 最细笔画宽度
};
type CharItem = { char: string; trackMm: number; offsetYMm: number; mode: 'solid'|'outline' };
type Layout = { panel: SignPanel; items: CharItem[]; align: 'left'|'center'|'right'|'justify';
                baseSizeMm: number; fontId: string; strokeLimitMm: number };
type LedCfg = { moduleSpacingMm: number; modulePowerW: number; moduleLumen: number;
                safetyFactor: number; psuEfficiency: number };
type LedResult = { perimeterTotalMm: number; modules: number; ratedW: number; recommendedW: number;
                   suggestedPsu: string; note: string };
type Material = { kind: 'acrylic'|'led_module'|'psu'|'glue'|'labor'; spec: string; qty: number;
                  unit: string; unitPriceCents: number; amountCents: number };
```

## 8. 关键实现点
- **字形几何必须从字体解析得到，不能靠 canvas 测文本框宽度**：用 `opentype.js`（或同类）解析本地 TTF/OTF → 取每个 glyph 的 path → 转 mm 坐标；**字体必须本地打包**（禁止外网字体 CDN，否则断网就废）。字体解析失败要明确提示「该字体不可用」，不能静默退化。
- **视觉间距**：字距按 `相邻两个字形轮廓的最小水平距离` 计算（而不是 `advanceWidth` 相减）；两端对齐时按视觉间距平均分配，避免「看起来不匀」——同一句话在两种算法下结果不同，必须按视觉间距。
- **连通域与笔画块**：对字形轮廓做连通域标记（扫描线并查集），`strokeBlocks` 即连通域数量；同时按「沿轮廓法线方向的局部宽度」估算 `minStrokeMm`（用多边形内切圆近似）；**低于 `strokeLimitMm` 的笔画必须警告**（工艺做不出来，太细易断），并给出「加粗/换字体/减小字高比例」的建议。
- **LED 模组数计算**（要能复算，公式写在界面上）：
  ```
  总布点长度 L = Σ 每个连通域的轮廓周长（取外轮廓，不含内孔）
  模组数 N = ceil(L / moduleSpacingMm)
  额定功率 P = N × modulePowerW × safetyFactor        // safetyFactor 默认 1.2
  电源功率 = P / psuEfficiency，再按标准档位（60/100/150/200/300/400W…）向上取
  ```
  **不许静默取整**：模组数向上取整要显示「因布点不足补足 N 个」；电源功率若超出常用档位要提示「需多电源并联/分区供电」。
- **板材用量**：亚克力按标准板（如 1220×2440）做**矩形拼版**（与 app-028 同一套 guillotine 思路，但这里是同尺寸重复件，用分层装箱即可），输出所需板数与利用率；异形字按外接矩形计算，**不能用轮廓面积**（板材是按矩形切出来的）。
- **单位**：内部全 mm（1 位小数）；金额整数「分」；`Σ材料金额 = 合计`（断言）。
- **性能**：12 个字的排版与字形分析 < 200ms；调整字距时只重算受影响的相邻对（增量），避免整句重解析。

## 9. 交互与视觉要点
- 预览区按真实比例显示门头，带尺寸标注与留边指示线；超出安装区时边框变红并显示超出量。
- 字距微调用键盘（`←/→` 调 1mm，`Shift` 调 5mm），并实时显示视觉间距数值。
- 字形分析面板可点选单个字，叠加显示笔画块着色与最细笔画位置。
- 报价单可打印（含材料明细、工艺说明、有效期），页脚带「本报价基于当前材料单价」声明。

## 10. 验收标准
- 排版正确性：给定门头 3000mm 与 6 个字，自动字号下左右留边差 ≤ 1mm（断言）；超出安装区时给出建议字号且建议值确实不超出。
- 视觉间距：两端对齐后相邻字视觉间距的极差 ≤ 0.5mm（断言，验证用的是轮廓距离而非文本框宽度）。
- 字形分析：对 20 个测试字（含「一」「十」「赢」「疆」等）的连通域数量与人工核对一致；`minStrokeMm` 与人工测量误差 ≤ 0.5mm。
- 最细笔画低于工艺下限时必须警告并可拦截（用例断言）。
- LED 计算：给定周长与模组间距，模组数与向上取整逻辑一致；电源功率含安全系数与效率，档位选择正确；超档位时给出多电源提示。
- 板材拼版：利用率计算与手工核算一致；板数正确（构建 3 组用例）。
- `Σ材料金额 = 合计`，无浮点误差（金额用整数分）。
- 断网可用（字体与数据本地）；12 字排版 < 200ms。

## 11. 边界（刻意不做）
不做在线下单与在线支付、不做客户管理与 CRM、不做 3D 夜景渲染与实景合成、不做地图导视位置管理——核心只做**排版 + 字形工艺分析 + 材料用量与报价**，避开黑名单中的 CRM、支付、订单方向。

## 12. 容器化与构建（Docker）

- **Dockerfile（多阶段）**：`node:20-alpine` 构建 → `nginx:1.27-alpine` 只拷 `dist/` 与 `nginx.conf`
- **docker-compose.yml**：服务名 `app-029`，端口 **`8109:80`**，`restart: unless-stopped`；`HEALTHCHECK` 请求 `/healthz`
- **nginx.conf**：SPA 回退；哈希资源 `immutable`；`index.html` no-cache；gzip
- 无后端依赖，断网可用；**字体文件必须随镜像打包**（放 `public/fonts/`，注意只放可商用字体并在 README 标注授权）
- 导出 PDF 用浏览器打印或纯前端 PDF 库（不引入需要编译的依赖）

```bash
cd frontend/app-029
docker compose up -d --build
curl http://localhost:8109/healthz
docker compose down
```

- **验收**：`http://localhost:8109` 完成「填门头尺寸 → 排版调字距 → 看笔画分析 → 算 LED 与电源 → 出材料报价单」；镜像 < 60MB。

### 忽略文件（.dockerignore / .gitignore）

- **`.dockerignore`**：`node_modules`、`dist`、`.git`、`.gitignore`、`.env`、`.env.*`、`*.log`、`coverage`、`.vscode`、`.idea`、`Dockerfile`、`nginx.conf`、`README.md`
  - `node_modules` 必须排除；**保留** `package-lock.json`、`public/fonts/`（字体，绝不能忽略）、`src/data/materials.json`（材料与工艺参数库）
- **`.gitignore`**：`node_modules/`、`dist/`、`.env*`、`*.log`、`coverage/`、`.DS_Store`、`.vscode/`、`.idea/`，另排**客户报价单与门头照片** `quotes/`、`clients/`、`photos/`、`exports/`
- **自检**：构建上下文 < 5MB（字体较大时单独确认不超过 10MB）；`git status` 不出现客户报价单与门头照片
