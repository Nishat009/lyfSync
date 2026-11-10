import { AppGate } from "@/components/app/app-gate";

// The signed-in area is a client-rendered app: the session cookie is checked by the API, so there
// is nothing meaningful to prerender into a shell. Let these routes block instead of streaming.
export const instant = false;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppGate>{children}</AppGate>;
}
