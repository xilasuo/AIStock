import { eq } from "drizzle-orm";
import { ensureSchema, getDb } from "../../../db";
import {
  alertRules,
  accountSettings,
  analysisReports,
  announcementNotes,
  capitalFlows,
  reviews,
  tradeRecords,
  watchDetails,
  watchItems,
} from "../../../db/schema";
import { getCurrentUser, requireApiUser } from "../../../lib/auth/auth";
import { shanghaiDate, shanghaiIso } from "../../../lib/utils/time";

export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    await ensureSchema();
    const db = getDb();
    const [trades, watchlist, watchDetailRows, alerts, reviewRows, analysisHistory, announcements, account, flows] = await Promise.all([
      db.select().from(tradeRecords).where(eq(tradeRecords.userId, user.id)),
      db.select().from(watchItems).where(eq(watchItems.userId, user.id)),
      db.select().from(watchDetails).where(eq(watchDetails.userId, user.id)),
      db.select().from(alertRules).where(eq(alertRules.userId, user.id)),
      db.select().from(reviews).where(eq(reviews.userId, user.id)),
      db.select().from(analysisReports).where(eq(analysisReports.userId, user.id)),
      db.select().from(announcementNotes).where(eq(announcementNotes.userId, user.id)),
      db.select().from(accountSettings).where(eq(accountSettings.userId, user.id)),
      db.select().from(capitalFlows).where(eq(capitalFlows.userId, user.id)),
    ]);
    const body = JSON.stringify({
      exportedAt: shanghaiIso(),
      trades,
      watchlist,
      watchDetails: watchDetailRows,
      alerts,
      reviews: reviewRows,
      analysisHistory,
      announcements,
      accountSettings: account,
      capitalFlows: flows,
    }, null, 2);
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="stock-assistant-backup-${shanghaiDate()}.json"`,
      },
    });
  } catch {
    return Response.json({ error: "数据导出失败" }, { status: 500 });
  }
}
