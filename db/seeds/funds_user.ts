// 用户自定义基金登记表。
// 在这里登记你持有的基金（ETF/LOF），重新部署后即可：
//   1) 录入交易/关注/提醒时，自动带出正确的基金名称；
//   2) 分析时走精细文案（而非通用基金文案）。
// 内置示例基金见 lib/stocks.ts 的 BUILTIN_FUND_PROFILES；用户登记与内置同名时，此处优先。
//
// 字段说明（除标注可选外均需填写）：
//   name          基金全称，如 "华夏上证50ETF"
//   manager       基金管理人，如 "华夏基金管理有限公司"
//   trackingIndex 跟踪标的指数，如 "上证50指数"
//   exchange      交易所，如 "上海证券交易所" / "深圳证券交易所"
//   category      基金类别，如 "股票型指数ETF" / "跨境股票指数ETF（QDII）"
//   inceptionDate 基金合同生效日，格式 YYYY-MM-DD
//   sourceName?   资料来源名称（可选，用于分析文案引用）
//   sourceUrl?    资料来源链接（可选）
//
// 类型定义见 lib/stocks.ts 的 FundProfile。
import type { FundProfile } from "../../lib/domain/stocks";

export const USER_FUND_PROFILES: Record<string, FundProfile> = {
  // 示例（取消注释并改成你的基金即可）：
  // "510050": {
  //   name: "华夏上证50ETF",
  //   manager: "华夏基金管理有限公司",
  //   trackingIndex: "上证50指数",
  //   exchange: "上海证券交易所",
  //   category: "股票型指数ETF",
  //   inceptionDate: "2004-12-30",
  //   sourceName: "华夏基金",
  //   sourceUrl: "https://www.chinaamc.com.cn/",
  // },
};
