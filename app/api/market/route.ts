import { requireApiUser } from "../../../lib/auth/auth";
import { conceptBoards, fundFlow } from "../../../lib/market/market-data";

// 统一行情数据入口的只读查询路由。
// type=concepts          取概念板块列表（AKShare _em 等效：stock_board_concept_name_em）
// type=fundflow&symbol=  取个股主力资金净流入（AKShare _em 等效：stock_individual_fund_flow）
export async function GET(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") ?? "concepts";

  try {
    if (type === "fundflow") {
      const symbol = searchParams.get("symbol") ?? searchParams.get("code");
      if (!symbol) return Response.json({ error: "缺少 symbol 参数" }, { status: 400 });
      const data = await fundFlow(symbol.trim());
      return Response.json(data);
    }
    const data = await conceptBoards();
    return Response.json({ count: data.length, boards: data });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "行情数据获取失败" },
      { status: 502 },
    );
  }
}
