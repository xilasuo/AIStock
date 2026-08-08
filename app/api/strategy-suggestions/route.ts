import { withAuth } from "../../../lib/auth/auth";
import { listSuggestions, updateSuggestionOutcome, getLinkedReviewsMap, deleteSuggestions, type Outcome } from "../../../lib/strategy-suggestions";

export const GET = withAuth(async (request, { user }) => {
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
}, "策略建议读取暂时不可用");

export const PATCH = withAuth(async (request, { user }) => {
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
}, "策略建议更新暂时不可用");

/**
 * 删除建议记录。请求体三选一：
 * - { ids: number[] }        删除指定记录
 * - { outcome: "pending" }   按标注状态批量删除
 * - { all: true }            清空全部
 */
export const DELETE = withAuth(async (request, { user }) => {
  const body = (await request.json().catch(() => ({}))) as {
    ids?: unknown;
    outcome?: string;
    all?: boolean;
  };

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
    : undefined;
  const outcome =
    typeof body.outcome === "string" && ["pending", "correct", "wrong", "uncertain"].includes(body.outcome)
      ? (body.outcome as Outcome)
      : undefined;
  const all = body.all === true;

  if ((!ids || ids.length === 0) && outcome === undefined && !all) {
    return Response.json(
      { code: 1, message: "需提供 ids / outcome / all 之一" },
      { status: 400 },
    );
  }

  const deleted = await deleteSuggestions({ userId: user.id, ids, outcome, all });
  return Response.json({ code: 0, data: { deleted } });
}, "策略建议删除暂时不可用");
