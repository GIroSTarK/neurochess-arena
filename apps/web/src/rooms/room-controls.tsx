import { useState } from "react";
import { useTranslation } from "react-i18next";

import { resignationConfirmation } from "../arena/resignation";
import { isTerminal } from "../gameplay/snapshot";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";

import type { RoomController } from "./controller";
import type { RoomState } from "./state";

type Action = "resign" | "close" | "replace" | "revoke";
interface RoomControlsProps {
  readonly controller: RoomController;
  readonly state: RoomState;
}

export function RoomControls(props: RoomControlsProps) {
  const capabilities = props.state.room?.capabilities;
  return (
    <RoomActions
      {...props}
      actions={[
        ...(capabilities?.canResign ? (["resign"] as const) : []),
        ...(capabilities?.canClose ? (["close"] as const) : []),
      ]}
    />
  );
}

export function RoomInvitationControls(props: RoomControlsProps) {
  const room = props.state.room;
  return (
    <RoomActions
      {...props}
      actions={
        room?.capabilities.canManageInvitation
          ? ["replace", ...(room.invitationAvailable ? (["revoke"] as const) : [])]
          : []
      }
    />
  );
}

function RoomActions({
  controller,
  state,
  actions,
}: RoomControlsProps & { readonly actions: readonly Action[] }) {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<{
    action: Action;
    version: number;
    epoch: number;
  } | null>(null);
  const room = state.room;
  if (!room || isTerminal(room.snapshot) || actions.length === 0) return null;
  const blocked = state.connection !== "synchronized" || state.busy || state.pendingMove !== null;
  const current =
    decision?.version === room.snapshot.version &&
    decision.epoch === state.interactionRevision &&
    !blocked
      ? decision
      : null;
  return (
    <div className="flex flex-wrap gap-3">
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
