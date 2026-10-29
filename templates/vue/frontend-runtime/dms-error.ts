import { type DmsErrorData } from "./types";

export function createDmsError(
  input: string | DmsErrorData,
): Error & DmsErrorData {
  const details = typeof input === "string" ? { message: input } : input;
  return Object.assign(
    new Error(details.message ?? details.statusMessage),
    details,
  );
}
