import { Suspense } from "react";
import { BigScreenView } from "../views/BigScreenView";
import { requireAuthenticatedUser } from "../../lib/auth/auth";
import { LoadingScreen } from "../components/LoadingScreen";

export const dynamic = "force-dynamic";

export default async function Screen() {
  await requireAuthenticatedUser();
  return (
    <Suspense fallback={<LoadingScreen label="正在加载大屏展示…" />}>
      <BigScreenView />
    </Suspense>
  );
}
