import type { ProfileResponse } from "@neurochess/contracts";
import { useState } from "react";

export function Avatar({ profile }: { readonly profile: ProfileResponse }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = profile.avatar.source === "initials" ? null : profile.avatar.url;
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-panel border border-control-border bg-surface-raised font-semibold text-text"
    >
      {url && url !== failedUrl ? (
        <img
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(url)}
          className="size-full object-cover"
        />
      ) : (
        (profile.avatar.initials ?? "?")
      )}
    </span>
  );
}
