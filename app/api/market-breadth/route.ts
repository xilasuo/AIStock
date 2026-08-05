import { getMarketBreadth } from "../../../lib/market/breadth";
import { requireApiUser } from "../../../lib/auth/auth";

export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  try {
    const data = await getMarketBreadth();
    return Response.json(data, {
      headers: { "cache-control": "private, max-age=30" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "全市场涨跌分布暂时无法读取";
    return Response.json({ error: message }, { status: 503 });
  }
}
