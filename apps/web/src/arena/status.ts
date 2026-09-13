interface FeedbackLabel {
  readonly id: string;
  readonly label: string;
}

export interface StatusPresentation {
  readonly title: string;
  readonly titleVariants: readonly string[];
  readonly feedback: {
    readonly activeId: string | null;
    readonly activities: readonly FeedbackLabel[];
    readonly notices: readonly (FeedbackLabel & { readonly visible: boolean })[];
  } | null;
  readonly notice: string | null;
  readonly followUp: string | null;
}
