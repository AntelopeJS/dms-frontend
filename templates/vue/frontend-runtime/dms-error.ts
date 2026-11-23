import { type DmsErrorData } from "./types";

function isMessage(input: string | DmsErrorData): input is string {
  return typeof input === "string";
}

export function createDmsError(
  input: string | DmsErrorData,
): Error & DmsErrorData {
  const details = isMessage(input) ? { message: input } : input;
  return Object.assign(
    new Error(details.message ?? details.statusMessage),
    details,
  );
}
