import { authenticate, sessionCookie } from "../../../../lib/auth/auth";

export async function POST(request: Request) {
  const form = await request.formData();
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const token = await authenticate(username, password);

  if (!token) {
    return Response.redirect(new URL("/login?error=1", request.url), 303);
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: new URL("/", request.url).toString(),
      "set-cookie": sessionCookie(token, new URL(request.url).protocol === "https:"),
      "cache-control": "no-store",
    },
  });
}
