import type { ReactNode } from "react";

import { DocumentMetadata } from "./document-metadata";

export function FullPageNotice({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <main className="grid min-h-screen content-center justify-items-center gap-6 p-6 text-center">
      <DocumentMetadata />
      <h1 className="font-display text-title font-medium">{title}</h1>
      <p className="max-w-2xl text-text-secondary">{description}</p>
      {children}
    </main>
  );
}
