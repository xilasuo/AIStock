import { getSectorHeatmap, validateSectorDate } from "../../../lib/market/sectors";
import { requireApiUser } from "../../../lib/auth/auth";
import { shanghaiDate } from "../../../lib/utils/time";

export async function GET(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  const searchParams = new URL(request.url).searchParams;
  const date = searchParams.get("date")?.trim() ?? "";
  const limit = Number(searchParams.get("limit") ?? 10);
  const validationError = validateSectorDate(date);
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    return Response.json({ error: "板块数量必须在1到10之间" }, { status: 400 });
  }

  try {
    const heatmap = await getSectorHeatmap(date, limit);
    const isToday = date === shanghaiDate();
    return Response.json(heatmap, {
      headers: {
        "cache-control": isToday ? "private, max-age=300" : "private, max-age=21600",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "板块异动暂时无法读取";
    return Response.json({ error: message }, { status: 503 });
  }
}
