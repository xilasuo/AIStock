// 操作模式（个人风格）——前端唯一事实源，与 trading_agent/trade_mode.py 的
// MODE_PROFILES 保持一致。用于：
//  1. 「系统设置 → 风险偏好与交易纪律」里选择个人操作风格；
//  2. 前端所有 LLM 调用（个股解读 / 操盘手对话 / 策略卡）注入 system prompt，
//     让 AI 按「决策者是谁」调整时间框架与输出侧重。
// 背景（2026-08-06）：某 AI 把历史泡沫顶 66.39 当目标位算出「110.8% 空间」，
// 根因是没定义决策者——超短看 J 值/量价，长线看基本面/估值，结论可完全相反。

export type TradeMode = "ultra_short" | "short" | "swing" | "long";

export const TRADE_MODE_LABELS: Record<TradeMode, string> = {
  ultra_short: "超短",
  short: "短线",
  swing: "波段",
  long: "长线",
};

export type TradeModeInfo = {
  key: TradeMode;
  label: string;
  /** 持仓周期 */
  holding: string;
  /** 决策时间框架 */
  frame: string;
  /** 买入依据 */
  buy: string;
  /** 止损/止盈规则 */
  sellStop: string;
  /** 仓位上限 */
  position: string;
  /** 该模式应忽略的噪音（避免时间框架错配） */
  ignore: string[];
  /** 报告/回答要求 */
  note: string;
  /** 设置页下拉的简短提示 */
  hint: string;
};

export const TRADE_MODES: TradeModeInfo[] = [
  {
    key: "ultra_short",
    label: "超短",
    holding: "1-3 天",
    frame: "60分钟 - 日线",
    buy: "量价配合、分时强度、题材情绪、突破/回踩结构",
    sellStop: "止损 -3%~-5% 硬止损；止盈按目标位/破位",
    position: "≤10-15% 试错仓（高波动个股更小）",
    ignore: ["历史目标位空间", "半年以上估值锚", "长期基本面叙事"],
    note: "只回答 1-3 天能否参与：给出明确买卖价位与止损，不做中长期目标价预测",
    hint: "1-3天 · 量价/分时/情绪，给买卖价位与止损剧本",
  },
  {
    key: "short",
    label: "短线",
    holding: "3-10 天",
    frame: "日线",
    buy: "均线形态（MA5/10/20）、板块轮动、放量突破站稳",
    sellStop: "止损 -7% 或跌破关键均线；止盈按压力位分批",
    position: "≤20-30%",
    ignore: ["分钟级噪音", "超远期目标位"],
    note: "回答 3-10 天波段：等趋势信号确认（如站稳 MA20 放量），不做日内择时",
    hint: "3-10天 · 均线形态/板块轮动，等趋势确认",
  },
  {
    key: "swing",
    label: "波段",
    holding: "1-3 个月",
    frame: "日线 + 周线",
    buy: "中期趋势、估值修复、行业景气、回调到关键支撑",
    sellStop: "止损 -10% 或逻辑破坏；止盈按趋势目标/估值上沿",
    position: "≤30-50%",
    ignore: ["日线 J 值超买超卖", "单日量比波动"],
    note: "回答 1-3 月波段：以中期趋势与估值为主，忽略日内噪音",
    hint: "1-3月 · 中期趋势+估值修复",
  },
  {
    key: "long",
    label: "长线",
    holding: "6 个月以上",
    frame: "周线 + 月线 + 基本面",
    buy: "基本面、估值安全边际、行业周期、现金流与分红",
    sellStop: "基本面恶化/逻辑证伪时退出，不设价格止损",
    position: "按组合配置，单票 ≤10-20%",
    ignore: ["KDJ/RSI 短线指标", "单日量价", "技术形态噪音"],
    note: "只回答长期持有价值：以估值与基本面为准绳，短期波动不构成买卖依据",
    hint: "6月+ · 只认基本面与估值安全边际",
  },
];

const MODE_ALIASES: Record<string, TradeMode> = {
  ultra_short: "ultra_short",
  ultrashort: "ultra_short",
  超短: "ultra_short",
  short: "short",
  短线: "short",
  swing: "swing",
  波段: "swing",
  long: "long",
  长线: "long",
};

export const DEFAULT_TRADE_MODE: TradeMode = "short";

export function resolveTradeMode(value: unknown): TradeMode {
  if (typeof value === "string") {
    const hit = MODE_ALIASES[value.trim().toLowerCase()];
    if (hit) return hit;
  }
  return DEFAULT_TRADE_MODE;
}

/** 一行紧凑摘要（设置页副标题 / 报告头部用） */
export function tradeModeSummaryLine(mode: TradeMode): string {
  const info = TRADE_MODES.find((m) => m.key === mode) ?? TRADE_MODES[1];
  return (
    `${info.label}（${info.holding}｜${info.frame}）· 买入：${info.buy}` +
    ` · 忽略噪音：${info.ignore.join("、")}`
  );
}

/**
 * 生成注入 LLM system prompt 的操作模式角色卡（纯文本）。
 * 分两类用途：
 *  - promptType="read"：解读类（analyze，不荐股），决定「解读视角与详略」；
 *  - promptType="act" ：操盘手类（assistant / trading-strategy，给买卖动作），
 *    决定「决策时间框架」，作为硬约束。
 */
export function tradeModePrompt(mode: TradeMode, promptType: "read" | "act" = "read"): string {
  const info = TRADE_MODES.find((m) => m.key === mode) ?? TRADE_MODES[1];
  const lines: string[] = [
    `【用户操作模式（个人风格）】`,
    `trade_mode=${info.label}（持仓 ${info.holding}｜决策框架 ${info.frame}）`,
    `- 买入依据：${info.buy}`,
    `- 止损/止盈：${info.sellStop}`,
    `- 仓位上限：${info.position}`,
    `- 必须忽略的噪音（不得作为依据）：${info.ignore.join("、")}`,
  ];
  if (promptType === "act") {
    lines.push(
      "- 【硬约束】所有结论必须落在上述持仓周期的决策维度：给明确价位/仓位/止损动作；",
      `  不讨论与持仓周期无关的目标（如「距历史高点还有多少空间」这类与本次决策无关的远景数字），`,
      "  不做超出周期的长期预测；缺失数据直说「数据缺失」，不编造。",
    );
  } else {
    lines.push(
      "- 【解读要求】站在上述持仓周期的视角组织解读：优先该模式关注的指标，",
      "  忽略项不作展开；不改变「不荐股、不出现确定性买卖措辞」的硬约束。",
    );
  }
  lines.push(`- 报告要求：${info.note}`);
  return lines.join("\n");
}
