import { clearSessionCookie } from "../../../../lib/auth/auth";

export async function GET(request: Request) {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL("/login", request.url).toString(),
      "set-cookie": clearSessionCookie(new URL(request.url).protocol === "https:"),
      "cache-control": "no-store",
    },
  });
}
