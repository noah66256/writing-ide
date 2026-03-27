import { Navigate } from "react-router-dom";
import { getAccessToken } from "../api/client.ts";
import type { ReactNode } from "react";

export default function PrivateRoute({ children }: { children: ReactNode }) {
  if (!getAccessToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
