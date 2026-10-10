import { useState } from "react";
import { useTranslation } from "react-i18next";

import { resignationConfirmation } from "../arena/resignation";
import { isTerminal } from "../gameplay/snapshot";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";

import type { RoomController } from "./controller";
import type { RoomState } from "./state";

type Action = "resign" | "close" | "replace" | "revoke";
export function RoomControls({
  controller,
  state,
}: {
  readonly controller: RoomController;
  readonly state: RoomState;
}) {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<{
    action: Action;
    version: number;
    epoch: number;
  } | null>(null);
  const room = state.room;
  if (!room || isTerminal(room.snapshot)) return null;
  const blocked = state.connection !== "synchronized" || state.busy || state.pendingMove !== null;
  const actions: Action[] = [
    ...(room.capabilities.canManageInvitation
      ? (["replace", ...(room.invitationAvailable ? ["revoke"] : [])] as Action[])
      : []),
    ...(room.capabilities.canResign ? (["resign"] as const) : []),
    ...(room.capabilities.canClose ? (["close"] as const) : []),
  ];
  const current =
    decision?.version === room.snapshot.version &&
    decision.epoch === state.interactionRevision &&
    !blocked
      ? decision
      : null;
  return (
    <div className="mt-4 flex flex-wrap gap-3">
      {actions.map((action) => (
        <Button
          key={action}
          variant={action === "close" || action === "resign" ? "danger" : "secondary"}
          aria-disabled={blocked}
          onClick={() =>
            setDecision({
              action,
              version: room.snapshot.version,
              epoch: state.interactionRevision,
            })
          }
        >
          {t(`rooms.${action}`)}
        </Button>
      ))}
      {current ? (
        <ConfirmDialog
          {...(current.action === "resign"
            ? resignationConfirmation(room.viewer.color, t)
            : {
                title: t(`rooms.${current.action}`),
                description: t(`rooms.confirmations.${current.action}`),
                confirmLabel: t(`rooms.confirmLabels.${current.action}`),
              })}
          cancelLabel={t("rooms.cancel")}
          onCancel={() => setDecision(null)}
          onConfirm={() => {
            setDecision(null);
            if (current.action === "replace" || current.action === "revoke") {
              void controller.invitation(current.action, current.version);
            } else {
              void controller.lifecycle(
                current.action === "close" ? "abort" : "resign",
                current.version,
              );
            }
          }}
        />
      ) : null}
    </div>
  );
}
