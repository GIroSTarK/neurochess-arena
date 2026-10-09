import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHref } from "react-router";

import { Button } from "../ui/button";

export function InvitationShare({ invitation }: { readonly invitation: string }) {
  const { t } = useTranslation();
  const joinPath = useHref("/rooms/join");
  const link = new URL(joinPath, window.location.origin).href + "#invite=" + invitation;
  const [copied, setCopied] = useState<"success" | "failed" | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const copy = async () => {
    let result: "success" | "failed" = "failed";
    try {
      await navigator.clipboard.writeText(link);
      result = "success";
    } catch {
      /* The selectable link remains available without clipboard permission. */
    }
    if (active.current) setCopied(result);
  };
  return (
    <div className="grid min-w-0 gap-3">
      <label htmlFor="room-invitation" className="text-label font-semibold">
        {t("rooms.invitation")}
      </label>
      <textarea
        id="room-invitation"
        value={link}
        readOnly
        rows={3}
        autoComplete="off"
        spellCheck={false}
        onFocus={(event) => event.target.select()}
        onClick={(event) => event.currentTarget.select()}
        className="min-h-target w-full min-w-0 resize-y rounded-control border border-control-border bg-canvas px-3 py-2 font-mono text-label text-text"
      />
      <Button
        variant="secondary"
        onClick={() => {
          void copy();
        }}
      >
        {t("rooms.copy")}
      </Button>
      {copied ? (
        <p role="status">{t(copied === "success" ? "rooms.copied" : "rooms.copyFallback")}</p>
      ) : null}
    </div>
  );
}
