import type { GameState } from "@neurochess/contracts";

interface FeedbackLabel {
  readonly id: string;
  readonly label: string;
}

export interface StatusPresentation {
  readonly title: string;
  readonly titleVariants: readonly string[];
  readonly lifecycle: {
    readonly state: GameState;
    readonly label: string;
    readonly variants: readonly string[];
  } | null;
  readonly result: { readonly reason: string; readonly score: string } | null;
  readonly description: string | null;
  readonly feedback: {
    readonly activeId: string | null;
    readonly activities: readonly FeedbackLabel[];
    readonly notices: readonly (FeedbackLabel & { readonly visible: boolean })[];
  } | null;
  readonly notice: string | null;
  readonly followUp: string | null;
}
