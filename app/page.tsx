import { Suspense } from "react";
import { Dashboard } from "./views/Dashboard";
import { requireAuthenticatedUser } from "../lib/auth/auth";
import { LoadingScreen } from "./components/LoadingScreen";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireAuthenticatedUser();
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Dashboard user={user} signOutUrl="/api/auth/logout" />
    </Suspense>
  );
}
