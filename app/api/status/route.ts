import { getAiConfig } from "../../../lib/ai/ai-config";
import { requireApiUser } from "../../../lib/auth/auth";
import { isMairuiEnabled, mairuiCircuit } from "../../../lib/market/mairui";

export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  const ai = getAiConfig();
  const mairuiEnabled = await isMairuiEnabled();
  const circuit = mairuiCircuit();
  // 熔断中：即使已配置 token 也暂时不可用，明确告知用户原因而非静默降级
  const mairuiStatus = circuit.tripped
    ? "限流冷却中"
    : mairuiEnabled
      ? "正常"
      : "未启用";
  return Response.json({
    deepseekConfigured: ai.configured,
    aiProvider: ai.provider,
    // 麦蕊优先（原生 A 股源：营收/利润/负债率/PE/PB/ROE/行业/简介），
    // 未配置 token 时自动回退到腾讯/东方财富免费多源。
    dataSource: mairuiEnabled
      ? "麦蕊智数(优先) + 腾讯/东方财富"
      : "腾讯证券 / 东方财富 免费多源",
    mairuiEnabled,
    mairuiStatus,
    reminderMode: "页面打开期间每5分钟检查",
  });
}
