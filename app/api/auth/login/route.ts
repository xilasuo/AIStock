import { authenticate, sessionCookie } from "../../../../lib/auth/auth";
import {
  checkLoginAllowed,
  clientIpFrom,
  recordLoginFailure,
  recordLoginSuccess,
} from "../../../../lib/auth/login-throttle";

export async function POST(request: Request) {
  const form = await request.formData();
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const clientIp = clientIpFrom(request.headers);

  // 先查限流再验密码：被锁定时直接拒绝，既避免无谓的 PBKDF2 计算，
  // 也不会因「账号存在与否」的耗时差异泄露账号枚举信息。
  const decision = checkLoginAllowed(username, clientIp);
  if (!decision.allowed) {
    return new Response(null, {
      status: 303,
      headers: {
        location: new URL("/login?error=locked", request.url).toString(),
        "retry-after": String(decision.retryAfterSeconds),
        "cache-control": "no-store",
      },
    });
  }

  const token = await authenticate(username, password);

  if (!token) {
    recordLoginFailure(username, clientIp);
    return Response.redirect(new URL("/login?error=1", request.url), 303);
  }

  recordLoginSuccess(username, clientIp);
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL("/", request.url).toString(),
      "set-cookie": sessionCookie(token, new URL(request.url).protocol === "https:"),
      "cache-control": "no-store",
    },
  });
}
