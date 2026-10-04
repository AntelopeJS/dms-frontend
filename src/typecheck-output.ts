// What the CLI makes of the output of `vue-tsc --pretty`: the type errors it
// reported, each with its message and code frame, as one problem.

import { type CliProblem, pluralize } from "@antelopejs/core/cli";
import { VERBOSE_OUTPUT_HINT } from "./child-output";
import { ellipsis } from "./output";

/** `app/Callout.vue:17:7 - error TS2322: Type 'string' is not …` */
const ERROR_LINE = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/;
/** `Found 3 errors in 2 files.`, then a table of the files. */
const SUMMARY_LINE = /^Found (\d+) errors?\b/;
/** A message chain continues on the lines right below the error line. */
const CONTINUATION_LINE = /^\s+\S/;

/** Errors a failure report spells out; the others are counted. */
const SHOWN_ERRORS = 5;
const DETAIL_INDENT = "  ";

export interface TypeCheckError {
  /** `frontend-vue/app/components/Callout.vue:17:7` */
  location: string;
  code: string;
  message: string[];
  frame: string[];
}

export interface TypeCheckReport {
  errors: TypeCheckError[];
  /** As vue-tsc counted them: more than `errors` when the output was cut. */
  count: number;
}

function readError(header: RegExpExecArray, body: string[]): TypeCheckError {
  const [, file, line, column, code, message] = header;
  const firstBlank = body.findIndex((entry) => entry.trim() === "");
  const chainEnd = firstBlank < 0 ? body.length : firstBlank;
  const chain = body
    .slice(0, chainEnd)
    .filter((entry) => CONTINUATION_LINE.test(entry));
  return {
    location: `${file}:${line}:${column}`,
    code,
    message: [message, ...chain.map((entry) => entry.trim())],
    frame: body
      .slice(chainEnd)
      .filter((entry) => entry.trim() !== "")
      .map((entry) => entry.trimEnd()),
  };
}

/**
 * Reads the type errors out of `vue-tsc --pretty` output, without colors and
 * with workspace paths already mapped back to their sources.
 */
export function parseTypeCheckOutput(lines: string[]): TypeCheckReport {
  const errors: TypeCheckError[] = [];
  let header: RegExpExecArray | undefined;
  let body: string[] = [];
  let count: number | undefined;
  const close = () => {
    if (header) errors.push(readError(header, body));
    header = undefined;
    body = [];
  };
  for (const line of lines) {
    const error = ERROR_LINE.exec(line);
    const summary = SUMMARY_LINE.exec(line);
    if (error || summary) close();
    if (error) header = error;
    else if (summary) count = Number(summary[1]);
    else if (header) body.push(line);
  }
  close();
  return { errors, count: Math.max(count ?? 0, errors.length) };
}

/**
 * The type errors as one problem. A single error is the problem itself:
 * where it is, its message and its code frame. Several are listed under
 * their count, the first ones in full.
 *
 * `rerun` is the command the user runs once the errors are fixed.
 */
export function describeTypeCheckErrors(
  report: TypeCheckReport,
  rerun: string,
): CliProblem | undefined {
  const { errors, count } = report;
  const [first] = errors;
  if (!first) return undefined;
  if (count === 1) {
    const [reason, ...chain] = first.message;
    return {
      title: `${first.location}  ${first.code}`,
      reason,
      fixes: [`Fix the error and run ${rerun} again`],
      details: [...chain, ...first.frame],
    };
  }
  const shown = errors.slice(0, SHOWN_ERRORS);
  const hidden = count - shown.length;
  return {
    title: pluralize(count, "type error"),
    fixes: [`Fix the errors and run ${rerun} again`],
    details: [
      ...shown.flatMap((error) => [
        `${error.location}  ${error.code}`,
        ...[...error.message, ...error.frame].map(
          (line) => `${DETAIL_INDENT}${line}`,
        ),
      ]),
      ...(hidden > 0
        ? [
            `${ellipsis()} and ${pluralize(hidden, "more error")}`,
            VERBOSE_OUTPUT_HINT,
          ]
        : []),
    ],
  };
}
