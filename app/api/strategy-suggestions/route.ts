import { getCurrentUser } from "../../../lib/auth/auth";
import { ensureSchema } from "../../../db";
import { listSuggestions, updateSuggestionOutcome, getLinkedReviewsMap, type Outcome } from "../../../lib/strategy-suggestions";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  await ensureSchema();
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const rawOutcome = url.searchParams.get("outcome");
  const outcome: Outcome | undefined = rawOutcome ? (["pending","correct","wrong","uncertain"].includes(rawOutcome) ? rawOutcome as Outcome : undefined) : undefined;
  const symbol = url.searchParams.get("symbol") || undefined;
  const suggestions = await listSuggestions({ userId: user.id, limit, offset, outcome, symbol });

  // 批量查关联复盘
  const linkedMap = await getLinkedReviewsMap(suggestions.map(s => s.id), user.id);
  const data = suggestions.map(s => ({
    ...s,
    linkedReview: linkedMap.get(s.id) || null,
  }));

  return Response.json({ code: 0, data });
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  await ensureSchema();
  const { id, outcome: raw, outcomeNote, outcomePrice } = (await request.json()) as {
    id?: number;
    outcome?: string;
    outcomeNote?: string;
    outcomePrice?: number;
  };
  if (!id || !raw || !["correct", "wrong", "uncertain"].includes(raw)) {
    return Response.json({ code: 1, message: "缺少必填参数 id/outcome，或 outcome 取值非法" }, { status: 400 });
  }
  const outcome = raw as Outcome;
  await updateSuggestionOutcome({
    id,
    userId: user.id,
    outcome,
    outcomeNote: outcomeNote || "",
    outcomePrice: outcomePrice ?? undefined,
  });
  return Response.json({ code: 0, data: { ok: true } });
}
