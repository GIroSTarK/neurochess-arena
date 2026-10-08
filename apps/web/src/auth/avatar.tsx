import type { ProfileResponse } from "@neurochess/contracts";
import { useState } from "react";

export function Avatar({ avatar }: { readonly avatar: ProfileResponse["avatar"] }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-target shrink-0 items-center justify-center overflow-hidden rounded-control border border-divider bg-surface-raised font-mono text-label text-text"
    >
      {avatar.source !== "initials" && avatar.url !== failedUrl ? (
        <img
          className="size-full object-cover"
          src={avatar.url}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatar.url)}
        />
      ) : (
        avatar.initials
      )}
    </span>
  );
}
