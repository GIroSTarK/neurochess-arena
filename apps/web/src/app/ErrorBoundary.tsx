import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";

import { FullPageNotice } from "./FullPageNotice";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

/**
 * Replaces a subtree that threw while rendering with the localized failure screen instead of a
 * blank page. The exception is never rendered; React reports it through the root's caught-error
 * handler. Reloading recovers, and an unfinished game reopens paused.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? <FailureScreen /> : this.props.children;
  }
}

function FailureScreen() {
  const { t } = useTranslation();
  return (
    <FullPageNotice title={t("failure.title")} description={t("failure.description")}>
      <Button variant="primary" onClick={() => window.location.reload()}>
        {t("failure.reload")}
      </Button>
    </FullPageNotice>
  );
}
