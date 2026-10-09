import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { Chessboard } from "../board/chessboard";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";

import type { RoomEntryMemory } from "./entry-memory";
import { InvitationShare } from "./invitation-share";
import type { RoomEntrySubmit } from "./room-entry-screen";

export function RoomWaitingScreen({
  memory,
  onSubmit,
}: {
  readonly memory: RoomEntryMemory;
  readonly onSubmit: RoomEntrySubmit;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(memory.subscribe, memory.getSnapshot);
  const [confirmation, setConfirmation] = useState<{
    intent: "replace" | "revoke" | "close";
    version: number;
  } | null>(null);
  const room = state.room;
  if (!room) return state.issue ? <p role="alert">{t(`rooms.errors.${state.issue}`)}</p> : null;
  const blocked = state.busy || state.pending !== null;
  const opponent = room.ownerColor === "white" ? "black" : "white";
  return (
    <section className="my-8 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="grid min-w-0 content-start gap-4">
        <h1 className="font-display text-title font-medium">{t("rooms.waiting")}</h1>
        <p role="status">{t("rooms.waitingColor", { color: t(`players.${opponent}`) })}</p>
        <div className="w-full max-w-[40rem]">
          <Chessboard
            snapshot={room.snapshot}
            orientation={room.viewer.color}
            canMove={false}
            interactionEpoch={String(room.snapshot.version)}
            onMove={() => undefined}
          />
        </div>
      </div>
      <div className="grid min-w-0 content-start gap-5 rounded-panel border border-divider bg-surface p-4 md:p-6">
        <p>{t("rooms.yourColor", { color: t(`players.${room.viewer.color}`) })}</p>
        {state.issuedInvitation ? (
          <InvitationShare key={state.issuedInvitation} invitation={state.issuedInvitation} />
        ) : (
          <p>{t("rooms.replaceHint")}</p>
        )}
        {!room.invitationAvailable ? <p role="status">{t("rooms.revoked")}</p> : null}
        <div className="flex flex-wrap gap-3">
          {room.capabilities.canManageInvitation ? (
            <>
              <Button
                variant="secondary"
                aria-disabled={blocked}
                onClick={() =>
                  setConfirmation({ intent: "replace", version: room.snapshot.version })
                }
              >
                {t("rooms.replace")}
              </Button>
              <Button
                variant="secondary"
                aria-disabled={blocked || !room.invitationAvailable}
                onClick={() =>
                  setConfirmation({ intent: "revoke", version: room.snapshot.version })
                }
              >
                {t("rooms.revoke")}
              </Button>
            </>
          ) : null}
          {room.capabilities.canClose ? (
            <Button
              variant="danger"
              aria-disabled={blocked}
              onClick={() => setConfirmation({ intent: "close", version: room.snapshot.version })}
            >
              {t("rooms.close")}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            aria-disabled={state.busy}
            onClick={() => onSubmit("refresh-room", { gameId: room.snapshot.gameId })}
          >
            {t("rooms.refresh")}
          </Button>
        </div>
        {state.issue ? (
          <p role="alert" className="text-danger">
            {t(`rooms.errors.${state.issue}`)}
          </p>
        ) : null}
        {state.busy ? <p role="status">{t("rooms.working")}</p> : null}
      </div>
      {confirmation?.version === room.snapshot.version && !blocked ? (
        <ConfirmDialog
          title={t(`rooms.${confirmation.intent}`)}
          description={t(`rooms.confirmations.${confirmation.intent}`)}
          cancelLabel={t("rooms.cancel")}
          confirmLabel={t(`rooms.confirmLabels.${confirmation.intent}`)}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const { intent, version } = confirmation;
            setConfirmation(null);
            onSubmit(intent, {
              gameId: room.snapshot.gameId,
              expectedVersion: String(version),
              confirm: "true",
            });
          }}
        />
      ) : null}
    </section>
  );
}
