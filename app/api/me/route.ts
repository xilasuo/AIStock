import { getCurrentUser, requireApiUser } from "../../../lib/auth/auth";

export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    return Response.json({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    });
  } catch {
    return Response.json({ error: "读取用户信息失败" }, { status: 500 });
  }
}
