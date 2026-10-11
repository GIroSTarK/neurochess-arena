import type { AnalysisScore, PositionFacts } from "./protocol";

export class UciLines {
  private partial = "";

  push(chunk: unknown): string[] {
    if (typeof chunk !== "string") throw new Error("engine_protocol_error");
    if (new TextEncoder().encode(this.partial + chunk).length > 65536) {
      throw new Error("resource_limit");
    }
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    if (lines.some((line) => new TextEncoder().encode(line).length > 16384)) {
      throw new Error("resource_limit");
    }
    return lines.map((line) => line.trim());
  }
}

function integer(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export function parseScore(
  line: string,
  position: Pick<PositionFacts, "turn" | "checkmate">,
): { depth: number; score: AnalysisScore } | undefined {
  const tokens = line.split(/\s+/);
  if (tokens[0] !== "info" || tokens.includes("string")) return undefined;
  const fields = tokens.slice(0, tokens.includes("pv") ? tokens.indexOf("pv") : undefined);
  if (fields.includes("lowerbound") || fields.includes("upperbound")) return undefined;
  const once = (key: string) => fields.indexOf(key) === fields.lastIndexOf(key);
  if (!["depth", "score", "multipv"].every(once)) return undefined;
  const after = (key: string) =>
    fields.includes(key) ? fields[fields.indexOf(key) + 1] : undefined;
  const depth = integer(after("depth"));
  if (depth === undefined || depth < 0 || depth > 18) return undefined;
  if (fields.includes("multipv") && after("multipv") !== "1") return undefined;
  const kind = after("score");
  const value = integer(fields[fields.indexOf("score") + 2]);
  if (value === undefined) return undefined;
  const opponent = position.turn === "white" ? "black" : "white";
  if (kind === "cp" && Math.abs(value) <= 100000) {
    return {
      depth,
      score: { kind, value: value === 0 ? 0 : value * (position.turn === "white" ? 1 : -1) },
    };
  }
  if (kind === "mate" && Math.abs(value) <= 128 && (value !== 0 || position.checkmate)) {
    return {
      depth,
      score: { kind, winner: value > 0 ? position.turn : opponent, moves: Math.abs(value) },
    };
  }
  return undefined;
}

export function parseCompletion(line: string, noLegalMoves: boolean): boolean {
  const match =
    /^bestmove (\(none\)|0000|[a-h][1-8][a-h][1-8][qrbn]?)(?: ponder [a-h][1-8][a-h][1-8][qrbn]?)?$/.exec(
      line,
    );
  if (!match) return false;
  return match[1] === "(none)" || match[1] === "0000" ? noLegalMoves : !noLegalMoves;
}

export function profileCommands(options: readonly string[]): string[] {
  const settings = [
    ["Threads", 1],
    ["Hash", 16],
    ["MultiPV", 1],
    ["Ponder", false],
    ["UCI_LimitStrength", false],
    ["Skill Level", 20],
    ["UCI_Chess960", false],
  ] as const;
  return settings.map(([name, value]) => {
    const prefix = `option name ${name} type `;
    const matches = options.filter((option) => option.startsWith(prefix));
    const description = matches[0]?.slice(prefix.length);
    if (matches.length !== 1 || description === undefined) throw new Error("engine_protocol_error");
    if (typeof value === "boolean") {
      if (!/^check default (true|false)$/.test(description)) {
        throw new Error("engine_protocol_error");
      }
    } else {
      const range = /^spin default -?\d+ min (-?\d+) max (-?\d+)$/.exec(description);
      if (!range || Number(range[1]) > value || Number(range[2]) < value) {
        throw new Error("engine_protocol_error");
      }
    }
    return `setoption name ${name} value ${String(value)}`;
  });
}
