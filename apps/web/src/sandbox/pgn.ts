export interface PgnDelivery {
  copy(text: string): Promise<boolean>;
  download(text: string, gameId: string): void;
}

export const browserPgnDelivery: PgnDelivery = {
  async copy(text) {
    try {
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },
  download(text, gameId) {
    const url = URL.createObjectURL(
      new Blob([text], { type: "application/x-chess-pgn;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "neurochess-" + gameId + ".pgn";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
