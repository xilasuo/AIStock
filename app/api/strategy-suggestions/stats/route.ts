import { getCurrentUser } from "../../../../lib/auth/auth";
import { ensureSchema } from "../../../../db";
import { getSuggestionStats } from "../../../../lib/strategy-suggestions";

export async function GET() {
  const user = await getCurrentUser();
  await ensureSchema();
  const stats = await getSuggestionStats(user.id);
  return Response.json({ code: 0, data: stats });
}
