import { getSectorHeatmap, validateSectorDate } from "../../../lib/market/sectors";
import { requireApiUser } from "../../../lib/auth/auth";
import { shanghaiDate } from "../../../lib/utils/time";

export async function GET(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  const searchParams = new URL(request.url).searchParams;
  const date = searchParams.get("date")?.trim() ?? "";
  const limit = Number(searchParams.get("limit") ?? 10);
  const live = searchParams.get("live") === "1";
  const validationError = validateSectorDate(date);
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) {
    return Response.json({ error: "板块数量必须在1到40之间" }, { status: 400 });
  }

  try {
    const heatmap = await getSectorHeatmap(date, limit, live);
    const effective = heatmap.effectiveDate ?? date;
    const isToday = effective === shanghaiDate();
    // 实盘模式用极短缓存，保证盘中热力图逐次刷新跳动；普通模式按是否当日给 5 分钟/6 小时。
    const cacheControl = live
      ? "private, max-age=30"
      : isToday
        ? "private, max-age=300"
        : "private, max-age=21600";
    return Response.json(heatmap, {
      headers: {
        "cache-control": cacheControl,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "板块异动暂时无法读取";
    return Response.json({ error: message }, { status: 503 });
  }
}
