import { Suspense } from "react";
import { BigScreenView } from "../views/BigScreenView";
import { requireAuthenticatedUser } from "../../lib/auth/auth";

export const dynamic = "force-dynamic";

export default async function Screen() {
  await requireAuthenticatedUser();
  return (
    <Suspense fallback={<div className="boot-loading">正在加载大屏…</div>}>
      <BigScreenView />
    </Suspense>
  );
}
