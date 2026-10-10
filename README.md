# Papertrade × Hyperliquid Monitor

只读网站、终端采集器与对冲成本计算器。预算默认 Paper 1000 USDC，HL 对冲保证金另计。不会连接钱包、签名或者提交订单。

## 数据存放

| 内容 | 位置 | 持续采集 |
| --- | --- | --- |
| 源码、静态网页、迁移、检查 | GitHub 仓库 | 不保存运行数据 |
| 云端历史 | Cloudflare D1，`snapshots` 表 | Worker Cron 每分钟一次，关电脑也继续 |
| 云端实时行情 | Worker 读取公开 API，边缘缓存 8 秒 | 打开网页每 10 秒刷新，不因访客刷新写入历史 |
| 本地网页历史 | `data/history.sqlite` | `npm run dev` 启动期间每分钟记录 |
| 终端原始记录 | `data/monitor.jsonl` | `npm run monitor` 每 15 秒记录 |
| 自定义参数 | 浏览器当前页面内存 | 不上传个人仓位、资金或钱包信息 |

每分钟最多一条历史记录；云端保留约 90 天明细，每天 UTC 00:17 清理过期记录。历史曲线对长区间按时间桶取最后一条，缺失样本不插值为零。CSV 按 UTC 日期导出，一天最多 1440 条，可导出保留区间内各天。数据库没有绑定时会明确显示历史不可用，实时行情仍可查询。

## 已接入指标

- Hyperliquid BTC / ETH / HYPE：买一、卖一、订单簿深度、标记价、预言机价、资金费、数量精度、最大杠杆、保证金档位原始数据。
- Paper BTC / ETH：通过 `0x...080e` BBO 预编译读取同一 HyperEVM 区块的报价，使用官方每个市场的价格精度；HYPE 不是当前 Paper 对冲交易市场。
- Paper 协议：TVL、可用 LP、保证金、PAPER 供应、质押、待分配奖励、发行曲线、高水位、累计分红指数、最近一次分配事件、交易开关和最小仓位。
- 兑付队列：总债务、笔数与队首原始信息。个人交易提交排名需要钱包与 intent，当前显示未接入。兑付队列为空不等于交易提交没有等待。
- PAPER 交易市场价尚未核实，显示不可用；铸币成本和分红份额不充当市场价格。

每个来源标记自己的成功状态、时间和区块。HL context 与 Paper trading 的时间是收到响应的时间；Paper 协议、BBO 和 HL 订单簿有来源时间。数据超过 30 秒、参数落后 30 个区块、兑付队列非空、开平仓被禁止、深度不足或清算距离太近时，阻止复制方案。

## 收益模型与限制

先匹配同一币种、相同数量，再考虑价格方向。Paper 的亏损可能铸出 PAPER，HL 相反方向的收益补偿一部分亏损；Paper 的盈利会折扣，HL 相反方向的亏损仍线性发生。不能只用拿到 PAPER 的那个分支判断收益。

- 普通亏损：空兑付队列下，铸币基数是原始损失的 98%；非空时文档规定按完整损失基数。全额硬清算按保证金计算，不能假定 HL 只靠当时线性涨跌就能覆盖损失。
- 盈利：先扣 0.2 bps 死区，再使用官方交易参数计算非线性 impact，最后收 2% 盈利费用。
- HL：用当前订单簿 VWAP 算进场价，退出价偏差使用用户输入预算；开平手续费和按当前小时费率外推的资金费分别列出。
- 默认费率 4.5 bps 是公开基础 Taker 费率假设，未读取你的实际费率。实际 maker / taker、HYPE 折扣、账户成交量、GAS、操作延迟、资金转移费可能改变结果。
- 默认 50% Paper 亏损概率只是用户可修改的试算假设。重复试验平均成本为组合平均亏损除以平均铸币数量，不是经验证的方向概率或收益预测。
- HL 初始保证金显示 `quantity × max(entry, mark) / leverage` 估计值，另需浮亏、维持保证金及保证金档位缓冲；当前仅作资金需求参考，未核实个人账户状态。
- 质押分红指数采用官方 `1e27` 精度。区间分配按指数差乘固定持币量计算，假设该区间始终质押。待分配奖励、已分配、已领取和已提现是不同口径；没有账户领取流水，不能证明个人现金回本。
- 回本外推只在历史分红指数确实增长后显示，并明确假设未来速度等于观测区间。启动后的短时分红不能年化为可靠 APY。
- 两腿不可能原子成交；Paper 提交队列、价格移动、触发硬清算和 HL 标记价清算可能留下敞口。手动方案不能保证止损价成交。

默认 1000U、20x、原始止损 100U 的目标名义仓位约 20000U；HL 用 10x 时初始保证金约 2000U，另留缓冲。拿 PAPER 的成本需要用之后真实分红或真实卖出收入覆盖；存入 1000U 保证金不是先亏掉 1000U。

## 本地运行

Node.js >=22；已用 Node v22.20.0 验证。Cloudflare CLI 锁定 Wrangler 4.149.0。

```powershell
npm ci
npm run build
npm run dev
```

打开 `http://127.0.0.1:8787`。服务只监听本机地址。Node 22 的原生 SQLite 仍会显示实验特性提示。

```powershell
npm run monitor
npm run monitor -- --once
npm run check
npm test
npx wrangler deploy --dry-run
```

## Cloudflare 部署

先由账户本人完成 Cloudflare 授权；不要在聊天里粘贴 API token 或密码。Wrangler 配置初版没有虚构的数据库 ID，只有创建真实 D1 后才添加绑定。

```powershell
npm run cf:login
npm run cf:whoami
npm run cloud:setup
npm run deploy
```

`cloud:setup` 为本项目创建 `papertrade-monitor` D1，绑定名 `DB`，区域提示 `apac`，并运行首次迁移。生产与本地 SQLite 是两份独立数据；本地样本不会自动上传云端。

部署后检查 `/api/health` 与 `/api/live`；等待至少两个 Cron 周期，再检查 `/api/history` 有持续样本。看到首页或者部署成功不等于后台已持续采集。

GitHub 检查工作流只运行测试与打包，不保存 Cloudflare OAuth 凭据、不自动发布。可用 Cloudflare 的 GitHub Builds 连接仓库，或在本地使用 `npm run deploy` 发布；连接新的 GitHub 应用需要账户本人授权。

## 验收和恢复

测试覆盖普通亏损、盈利折扣、硬清算、发行衰减、资金费方向、订单簿深度、数量舍入、旧数据、队列未知、交易暂停、记录去重、CSV 日期与 90 天保留。实盘接口验证不验证下单、余额、钱包领取或盈利能力。

停止后台采集：在 Cloudflare 移除 Cron Trigger；停止本地服务：终止启动 `scripts/server.mjs` 的那个进程。网站可回退到上一 Worker deployment；回退时保留 D1。导出需要的 CSV 或使用 D1 数据库导出后再考虑删除；本项目没有自动删除数据库的操作。

## 官方来源（2026-10-10 核实）

- [Paper 盈亏与铸币](https://docs.papertrade.xyz/#/learn/wins-losses)、[盈利 impact](https://docs.papertrade.xyz/#/how/asymmetric-impact)、[BBO](https://docs.papertrade.xyz/#/how/pricing-bbo)、[队列](https://docs.papertrade.xyz/#/how/solvency-queue)、[发行曲线](https://docs.papertrade.xyz/#/how/mint-curve)。
- Paper 当前前端公开 `/query/protocol/summary`、`/query/protocol/queue-summary`、`/query/protocol/paper/activity`、`/state/trading`，字段和 tuple 来自官方部署页面的公开脚本。这些未版本化接口可能改变；遇到未知 schema 需修复解析器，不能当作零。
- [HL API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)、[手续费](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees)、[资金费](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)、[HyperEVM 预编译](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore)。
- [Cloudflare 静态网页](https://developers.cloudflare.com/workers/static-assets/)、[D1](https://developers.cloudflare.com/d1/get-started/)、[Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[免费额度](https://developers.cloudflare.com/d1/platform/pricing/)。每分钟一行约 1440 行/天；索引也计入写入额度，历史查询与访问量也消耗额度。先使用免费计划，未授权升级付费方案。
