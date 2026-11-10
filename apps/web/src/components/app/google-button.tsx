"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

type GoogleId = {
  initialize: (o: { client_id: string; callback: (r: { credential: string }) => void }) => void;
  renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
};

/** Renders Google's own sign-in button. Renders nothing unless NEXT_PUBLIC_GOOGLE_CLIENT_ID is set. */
export function GoogleButton({ onCredential }: { onCredential: (credential: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(
    () => typeof window !== "undefined" && !!(window as unknown as { google?: unknown }).google,
  );
  const cb = useRef(onCredential);
  useEffect(() => {
    cb.current = onCredential;
  });

  useEffect(() => {
    if (!CLIENT_ID || !ready || !ref.current) return;
    const g = (window as unknown as { google: { accounts: { id: GoogleId } } }).google.accounts.id;
    g.initialize({ client_id: CLIENT_ID, callback: (r) => cb.current(r.credential) });
    g.renderButton(ref.current, { theme: "outline", size: "large", width: 320, text: "continue_with" });
  }, [ready]);

  if (!CLIENT_ID) return null;
  return (
    <>
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={() => setReady(true)} />
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <div ref={ref} className="flex justify-center" />
    </>
  );
}
