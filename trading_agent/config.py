"""交易 Agent MVP · 全局配置与可调参数

所有「用户可调参」集中在这里，对应架构文档第五节「用户调参接口」。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, "cache")
REPORT_DIR = os.path.join(BASE_DIR, "reports")

# 持久选股配置（YAML）。改这个文件 = 改默认；网页/CLI 的 --overrides 仍可在单次运行时覆盖它。
# 优先级：config.py 默认值 < strategy_config.yaml < prefetched 内嵌 config < 预设 < 显式 overrides。
STRATEGY_CONFIG_PATH = os.path.join(BASE_DIR, "strategy_config.yaml")

# 本地镜像目录：trading_agent 把扫描 JSON 写到这里供本地查看。
# 跨机器场景下，真正送达云端 AIStock 的是「云端推送」（见 PushConfig / cloud.push_scan_json），
# 共享目录不再作为两项目的桥（云服务器读不到本地路径）。
SCAN_SHARE_DIR = os.environ.get(
    "STRATEGY_SCAN_DIR",
    os.path.join(os.path.dirname(os.path.dirname(BASE_DIR)), "strategy-scan"),
)

# 云端推送目标（本地 PC -> 云端 AIStock 接收接口）。
# 可用环境变量 CLOUD_SCAN_URL / CLOUD_SCAN_TOKEN 在部署时填写，不写则跳过推送。
CLOUD_SCAN_URL = os.environ.get("CLOUD_SCAN_URL", "")
CLOUD_SCAN_TOKEN = os.environ.get("CLOUD_SCAN_TOKEN", "")

# ---- 连接器（对应架构图「WorkBuddy 中枢 · 桥接连接器」） ----
# 接入后填写端点与密钥；留空则对应连接器不启用，trading_agent 退回腾讯/东财直连。
# 腾讯自选股 westock-mcp：查询为主（行情/估值/K线/财务），无回写/推送能力。
WESTOCK_MCP_URL = os.environ.get("WESTOCK_MCP_URL", "")
WESTOCK_MCP_TOKEN = os.environ.get("WESTOCK_MCP_TOKEN", "")
# 通达信 tdx-connector：行情 + 条件选股 + 交易接口（下单/撤单，默认 dry-run）。
# 端点形如 https://mcp.tdx.com.cn:3001/mcp ，密钥取 TDX:xxxx 填到 TDX_API_KEY。
TDX_MCP_URL = os.environ.get("TDX_MCP_URL", "")
TDX_API_KEY = os.environ.get("TDX_API_KEY", "")
# 企业微信群机器人 Webhook（对应架构图「微信/腾讯自选股 App 提醒」）。
# 腾讯自选股 App 推送无公开工具，统一走企业微信机器人最稳妥；留空则不推送。
WECOM_WEBHOOK_URL = os.environ.get("WECOM_WEBHOOK_URL", "")
# trading_agent 作为可调度 Agent 时监听的端口（WorkBuddy 经 HTTP 调度）。
AGENT_BIND_HOST = os.environ.get("AGENT_BIND_HOST", "127.0.0.1")
AGENT_BIND_PORT = int(os.environ.get("AGENT_BIND_PORT", "8080"))

# 默认股票池：跨行业代表性标的（仅作示例，可在 AppConfig.universe 中修改）
DEFAULT_UNIVERSE = [
    "600519", "000858", "601318", "600036", "000333", "000651", "600276",
    "300750", "002594", "600900", "601012", "000725", "600030", "601888",
    "600887", "002415", "600585", "601166", "000001", "600009", "603288",
    "002475", "600309", "601398", "600000", "000002", "600104", "601857",
    "600028", "601628",
]


@dataclass
class ScreenerConfig:
    """选票（选股）参数

    因子权重（w_*）在运行时按"活跃因子"归一化求和，因此无需硬性等于 1。
    默认权重合计 = 1.0，偏向风险调整动量 + 趋势 + 估值，技术确认(RSI/MACD)
    与流动性/规模为辅。quality(质量) 默认 0：仅在行情快照提供 ROE/股息率时启用。

    行业分散约束（max_per_sector）：打分排序后做贪心选取，单一行业最多入选
    max_per_sector 只，避免一次选出 top_n 只同属一个板块。约束生效后实际入选
    数可能少于 top_n；设 >= top_n 即关闭约束。行业取自 quote["sector"]，
    缺失时回退 data.sectors 静态映射（默认覆盖蓝筹池）。
    """
    top_n: int = 8                      # 选出标的数量
    max_per_sector: int = 2             # 行业分散约束：单行业最多入选数量（>=top_n 即不约束）
    momentum_window: int = 20           # 动量回看窗口（交易日）
    # —— 因子权重（运行时归一化）——
    w_momentum: float = 0.30            # 风险调整动量（收益 ÷ 年化波动）
    w_value: float = 0.18               # 估值复合（1/PE 与 1/PB 各半）
    w_liquidity: float = 0.08           # 流动性（换手率）
    w_rsi: float = 0.12                 # RSI(14)：强势但未超买
    w_macd: float = 0.12                # MACD 动能（柱为正且放大）
    w_trend: float = 0.16               # 趋势强度（价 vs 长期均线）
    w_size: float = 0.04                # 规模（总市值对数，越大越稳）
    w_quality: float = 0.06             # 质量（默认 0.06；仅当行情快照提供 ROE/股息率时实际启用，否则权重自动归 0）
    w_fund_flow: float = 0.08           # 资金流（主力净流入占流通市值比；仅当行情快照提供时实际启用，否则权重自动归 0）
    # 策略专属硬过滤（需 K 线数据，非权重型；由 presets 设置）
    # 可选值："ma_momentum" | "oversold" | "dszn" | "limit_up" | "volume_breakout" | ""
    strategy_filter: str = ""
    # —— 因子计算参数 ——
    rsi_window: int = 14                # RSI 周期
    rsi_direction: str = "normal"       # RSI 因子方向："normal"(偏好强势 50~70) | "reversal"(超跌反转，偏好 30~50)
    macd_fast: int = 12                 # MACD 快线
    macd_slow: int = 26                 # MACD 慢线
    macd_signal: int = 9                # MACD 信号线
    vol_window: int = 20                # 年化波动率回看窗口
    # —— 硬性过滤 ——
    min_turnover_pct: float = 0.15      # 换手率下限，过低剔除（流动性过滤）
    max_pe_ttm: float = 200.0           # PE(TTM) 上限，过高剔除
    max_pb: float = 20.0                # PB 上限，过高剔除
    # —— 前置条件过滤（板块 / ST / 流通市值）——
    boards: list = field(default_factory=lambda: ["main", "cyb", "kc", "bj"])  # 允许的板块
    st_filter: str = "exclude_st"        # "all" | "include_st" | "exclude_st"
    mcap_min: float = 0.0               # 流通市值下限（亿元），0=不限制
    mcap_max: float = 10000.0           # 流通市值上限（亿元），0=不限制


@dataclass
class SignalConfig:
    """操作（信号）参数"""
    fast_ma: int = 5                    # 快线均线周期
    slow_ma: int = 20                   # 慢线均线周期
    use_breakout_filter: bool = True    # 是否要求突破 N 日新高才买入
    breakout_window: int = 20           # 突破窗口
    stop_loss_pct: float = -0.08        # 止损比例（基于买入价）
    max_positions: int = 8              # 最大持仓数（与选股 top_n 对齐）


@dataclass
class MarketStateConfig:
    """市场状态（风控前置）参数

    用宽基指数日线判断牛/中性/熊，给出仓位系数 position_factor：
      bull→1.0（满仓）、neutral→0.5（半仓）、bear→0.0（空仓）。
    选股阶段按 position_factor 缩放实际选股数（熊市可降至 0=空仓）。
    判定：价格站在 MA(ma_window) 上方且中期动量≥bull_mom → 牛市；
          价格跌破 MA 且中期动量≤bear_mom → 熊市；其余中性。

    领先指标（降低滞后）：在均线/中期动量之外，叠加「短期动量」与「波动率收缩」两个
    更灵敏的信号。short_mom 用短窗口捕捉拐点，vol_ratio 反映波动率是否在收窄（缩量
    整理往往先于方向选择）。领先信号用于：1) 中性态细分出「偏强/偏弱」；2) 帮助在
    指数尚未远离均线时提前下调/上调仓位系数，缓解纯均线判定的滞后。
    """
    enable: bool = True
    index_code: str = "000300"          # 宽基指数代码（沪深300；fetch_kline 复用）
    ma_window: int = 120                # 长期均线窗口（约半年）
    mom_window: int = 60                # 中期动量窗口（约一季）
    short_mom_window: int = 10          # 短期动量窗口（领先信号，捕捉拐点）
    bull_ma_gap: float = 0.0            # 价格≥MA*(1+bull_ma_gap) 视为站上长均线
    bear_ma_gap: float = -0.03          # 价格≤MA*(1+bear_ma_gap) 视为跌破长均线
    bull_mom: float = 0.08              # 中期动量≥此值视为上行
    bear_mom: float = -0.05             # 中期动量≤此值视为下行
    # 领先信号阈值：中性态内进一步细分
    strong_short_mom: float = 0.04      # 短期动量≥此值视为偏强（中性→上调仓位）
    weak_short_mom: float = -0.04       # 短期动量≤此值视为偏弱（中性→下调仓位）
    vol_shrink_threshold: float = 0.75  # 近期波动/长期波动≤此值视为「缩量整理」
    position: dict = field(default_factory=lambda: {
        "bull": 1.0, "neutral": 0.5, "bear": 0.0,
    })
    # 领先因子在仓位系数上的微调：中性态下，短期动量偏强时把 0.5 上调到 0.65，
    # 偏弱时下调到 0.35；仅作用在 neutral，不改变 bull/bear 的满仓/空仓决定。
    neutral_up_factor: float = 0.65
    neutral_down_factor: float = 0.35


@dataclass
class BacktestConfig:
    """回测参数"""
    initial_cash: float = 1_000_000.0   # 初始资金（仅用于展示金额量级）
    fee_rate: float = 0.0003            # 单边手续费（万三）
    slippage: float = 0.0005            # 滑点
    rebalance_days: int = 20            # 滚动再平衡周期（交易日，默认约一个月）
    risk_per_position: float = 0.02     # 单票风险预算（占净值比例）：单票最大亏损不超过净值 2%
    max_position_weight: float = 0.25   # 单票最大仓位上限（占净值比例），防止等权下过度集中


@dataclass
class OptimConfig:
    """优化策略参数"""
    enabled: bool = True
    fast_ma_grid: list = field(default_factory=lambda: [3, 5, 8, 10])
    slow_ma_grid: list = field(default_factory=lambda: [15, 20, 30, 60])
    metric: str = "sharpe"              # 优化目标指标
    rounds: int = 1                     # 迭代轮数（对应架构内循环）
    train_ratio: float = 0.7            # 样本外切分：前 70% 训练选参，后 30% 验证（防过拟合）


@dataclass
class PushConfig:
    """云端推送（本地 PC -> 云端 AIStock 接收接口）

    跨机器部署时，trading_agent 在本地 PC 运行，AIStock 在远程云服务器。
    闭环跑完后用 HTTP POST 把扫描 JSON 推到云端接收接口，存到云服务器 /data 卷。
    """
    url: str = CLOUD_SCAN_URL                  # 云端 /api/strategy-scan 完整地址
    token: str = CLOUD_SCAN_TOKEN              # 推送鉴权 token（与云端 STRATEGY_PUSH_TOKEN / CRON_SECRET 一致）


@dataclass
class ConnectorsConfig:
    """连接器（桥接 westock-mcp / tdx-connector）

    对应架构图「WorkBuddy 中枢 · 桥接连接器」。所有字段留空即不启用，
    trading_agent 退回腾讯/东财直连。接入连接器后填端点与密钥即可生效。
    """
    westock_url: str = WESTOCK_MCP_URL
    westock_token: str = WESTOCK_MCP_TOKEN
    tdx_url: str = TDX_MCP_URL
    tdx_api_key: str = TDX_API_KEY
    wecom_webhook: str = WECOM_WEBHOOK_URL
    enable_writeback: bool = False     # 是否把信号/选股写回通达信（dry-run 安全默认）
    enable_notify: bool = False        # 是否推送企业微信提醒


@dataclass
class AppConfig:
    """顶层配置"""
    universe: list = field(default_factory=lambda: list(DEFAULT_UNIVERSE))
    use_hot_universe: bool = False      # 是否用同花顺当日强势股作为候选池
    beg: str = "20250101"               # 行情起始
    end: str = "20500101"               # 行情结束
    screener: ScreenerConfig = field(default_factory=ScreenerConfig)
    market: MarketStateConfig = field(default_factory=MarketStateConfig)
    signal: SignalConfig = field(default_factory=SignalConfig)
    backtest: BacktestConfig = field(default_factory=BacktestConfig)
    optim: OptimConfig = field(default_factory=OptimConfig)
    notifier: str = "local"             # local（默认）| email
    push: PushConfig = field(default_factory=PushConfig)
    connectors: ConnectorsConfig = field(default_factory=ConnectorsConfig)


# ============================================================
# strategy_config.yaml 加载（零依赖；优先 pyyaml，回退内置子集解析器）
# ============================================================
def _strip_comment(line: str) -> str:
    """去掉行内注释；保留引号内的 #。"""
    out: list[str] = []
    in_q = False
    q = ""
    for i, c in enumerate(line):
        if in_q:
            out.append(c)
            if c == q:
                in_q = False
        elif c in ('"', "'"):
            in_q = True
            q = c
            out.append(c)
        elif c == "#" and (i == 0 or line[i - 1] in (" ", "\t")):
            break
        else:
            out.append(c)
    return "".join(out)


def _parse_scalar(s: str):
    s = s.strip()
    if s == "":
        return None
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    low = s.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("null", "none", "~"):
        return None
    # 内联列表 [a, b, c]
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(x.strip()) for x in inner.split(",")]
    # 数字
    try:
        if "." in s or "e" in s.lower():
            return float(s)
        return int(s)
    except ValueError:
        return s


def _mini_yaml_load(text: str) -> dict:
    """极简 YAML 子集解析：仅支持嵌套映射 + 内联列表 + 标量（不含块序列）。

    足以覆盖 strategy_config.yaml 的结构；若环境装了 pyyaml 则优先用 yaml.safe_load。
    """
    root: dict = {}
    stack: list[tuple[int, dict]] = [(-1, root)]
    for raw in text.splitlines():
        stripped = _strip_comment(raw)
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        content = stripped.strip()
        while stack and stack[-1][0] >= indent:
            stack.pop()
        parent = stack[-1][1]
        if ":" not in content:
            continue
        key, _, val = content.partition(":")
        key = key.strip()
        val = val.strip()
        if val == "":
            child: dict = {}
            parent[key] = child
            stack.append((indent, child))
        else:
            parent[key] = _parse_scalar(val)
    return root


def load_strategy_yaml(path: str | None = None) -> dict:
    """读取 strategy_config.yaml，返回嵌套 dict（文件缺失返回 {}）。"""
    p = path or STRATEGY_CONFIG_PATH
    if not os.path.exists(p):
        return {}
    try:
        import yaml  # type: ignore

        with open(p, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except ImportError:
        with open(p, "r", encoding="utf-8") as f:
            data = _mini_yaml_load(f.read()) or {}
    if not isinstance(data, dict):
        return {}
    return data


# 各 section 的字段名 → 摊平后交给 run_hub.apply_config 的键
_FLAT_MAP = {
    "screener": [
        "top_n", "max_per_sector", "momentum_window", "w_momentum", "w_value",
        "w_liquidity", "w_rsi", "w_macd", "w_trend", "w_size", "w_quality",
        "w_fund_flow",
        "rsi_window", "macd_fast", "macd_slow", "macd_signal", "vol_window",
        "rsi_direction", "strategy_filter",
        "min_turnover_pct", "max_pe_ttm", "max_pb", "boards", "st_filter",
        "mcap_min", "mcap_max",
    ],
    "market": {
        "enable": "market_enable", "index_code": "index_code", "ma_window": "ma_window",
        "mom_window": "mom_window", "short_mom_window": "short_mom_window",
        "bull_ma_gap": "bull_ma_gap", "bear_ma_gap": "bear_ma_gap",
        "bull_mom": "bull_mom", "bear_mom": "bear_mom",
        "strong_short_mom": "strong_short_mom", "weak_short_mom": "weak_short_mom",
        "vol_shrink_threshold": "vol_shrink_threshold",
        "neutral_up_factor": "neutral_up_factor", "neutral_down_factor": "neutral_down_factor",
    },
    "signal": [
        "fast_ma", "slow_ma", "use_breakout_filter", "breakout_window",
        "stop_loss_pct", "max_positions",
    ],
    "optim": {"enabled": "optim_enabled"},
}


def flatten_config(data: dict) -> dict:
    """把嵌套 YAML 摊平成 run_hub.apply_config 兼容的扁平键集合。"""
    out: dict = {}
    for section, mapping in _FLAT_MAP.items():
        sec = data.get(section) or {}
        if isinstance(mapping, list):
            for k in mapping:
                if k in sec:
                    out[k] = sec[k]
        else:
            for src, dst in mapping.items():
                if src in sec:
                    out[dst] = sec[src]
    return out


def load_strategy_config() -> dict:
    """返回摊平后的策略配置（供 run_hub / 前端读取）。"""
    return flatten_config(load_strategy_yaml())
