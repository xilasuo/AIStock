import { getIndexQuotes } from "../../../lib/market/indices";
import { requireApiUser } from "../../../lib/auth/auth";

export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  try {
    const data = await getIndexQuotes();
    return Response.json(data, {
      headers: { "cache-control": "private, max-age=300" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "大盘指数暂时无法读取";
    return Response.json({ error: message }, { status: 503 });
  }
}
