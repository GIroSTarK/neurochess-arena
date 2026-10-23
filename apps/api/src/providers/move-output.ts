import { type AiMoveOutput, aiMoveOutputSchema } from "@neurochess/contracts";

export function parseMoveOutput(text: string): AiMoveOutput | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const output = aiMoveOutputSchema.safeParse(value);
  return output.success ? output.data : null;
}

export function sanitizeMoveOutput(output: AiMoveOutput, apiKey: string): AiMoveOutput {
  const commentary = output.commentary;
  if (
    commentary !== undefined &&
    (commentary.includes("\0") || (apiKey.length > 0 && commentary.includes(apiKey)))
  ) {
    // Optional viewer text must not persist a credential echo or a PostgreSQL-incompatible NUL.
    return { move: output.move };
  }
  return output;
}
