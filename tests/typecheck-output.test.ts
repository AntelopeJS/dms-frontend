import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERBOSE_OUTPUT_HINT } from "../src/child-output";
import {
  describeTypeCheckErrors,
  parseTypeCheckOutput,
} from "../src/typecheck-output";

const RERUN = "ajs dms verify-source";

/** `vue-tsc --pretty` output, colors removed and paths mapped to the source. */
const ONE_ERROR = [
  "./frontend-vue/app/components/Callout.vue:17:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
  "",
  '17 const auditTypeError: number = "not a number"',
  "         ~~~~~~~~~~~~~~",
  "",
  "",
  "Found 1 error in ./frontend-vue/app/components/Callout.vue:17",
  "",
];

const THREE_ERRORS = [
  "./frontend-vue/app/components/Callout.vue:17:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
  "",
  '17 const auditTypeError: number = "not a number"',
  "         ~~~~~~~~~~~~~~",
  "",
  "./frontend-vue/app/pages/index.vue:3:7 - error TS2322: Type '{ a: string; }' is not assignable to type 'Foo'.",
  "  Types of property 'a' are incompatible.",
  "    Type 'string' is not assignable to type 'number'.",
  "",
  '3 const f: Foo = { a: "x" }',
  "        ~",
  "",
  "./frontend-vue/app/pages/index.vue:9:1 - error TS2304: Cannot find name 'missing'.",
  "",
  "9 missing()",
  "  ~~~~~~~",
  "",
  "",
  "Found 3 errors in 2 files.",
  "",
  "Errors  Files",
  "     1  ./frontend-vue/app/components/Callout.vue:17",
  "     2  ./frontend-vue/app/pages/index.vue:3",
];

describe("vue-tsc output", () => {
  it("reads each error with its message chain and code frame", () => {
    const { errors, count } = parseTypeCheckOutput(THREE_ERRORS);
    assert.equal(count, 3);
    assert.deepEqual(errors[1], {
      location: "./frontend-vue/app/pages/index.vue:3:7",
      code: "TS2322",
      message: [
        "Type '{ a: string; }' is not assignable to type 'Foo'.",
        "Types of property 'a' are incompatible.",
        "Type 'string' is not assignable to type 'number'.",
      ],
      frame: ['3 const f: Foo = { a: "x" }', "        ~"],
    });
    assert.deepEqual(errors[2].frame, ["9 missing()", "  ~~~~~~~"]);
  });

  it("reports a single error as the problem itself", () => {
    const problem = describeTypeCheckErrors(
      parseTypeCheckOutput(ONE_ERROR),
      RERUN,
    );
    assert.deepEqual(problem, {
      title: "./frontend-vue/app/components/Callout.vue:17:7  TS2322",
      reason: "Type 'string' is not assignable to type 'number'.",
      fixes: ["Fix the error and run ajs dms verify-source again"],
      details: [
        '17 const auditTypeError: number = "not a number"',
        "         ~~~~~~~~~~~~~~",
      ],
    });
  });

  it("lists several errors under their count", () => {
    const problem = describeTypeCheckErrors(
      parseTypeCheckOutput(THREE_ERRORS),
      RERUN,
    );
    assert.equal(problem?.title, "3 type errors");
    assert.deepEqual(problem?.fixes, [
      "Fix the errors and run ajs dms verify-source again",
    ]);
    assert.deepEqual(problem?.details?.slice(0, 4), [
      "./frontend-vue/app/components/Callout.vue:17:7  TS2322",
      "  Type 'string' is not assignable to type 'number'.",
      '  17 const auditTypeError: number = "not a number"',
      "           ~~~~~~~~~~~~~~",
    ]);
    assert.ok(!problem?.details?.includes(VERBOSE_OUTPUT_HINT));
  });

  it("counts the errors it does not spell out", () => {
    const lines = Array.from({ length: 7 }, (_, index) => [
      `./frontend-vue/app/a.ts:${index + 1}:1 - error TS2304: Cannot find name 'x${index}'.`,
      "",
    ]).flat();
    const problem = describeTypeCheckErrors(
      parseTypeCheckOutput([...lines, "Found 9 errors in the same file"]),
      RERUN,
    );
    assert.equal(problem?.title, "9 type errors");
    assert.deepEqual(problem?.details?.slice(-2), [
      "… and 4 more errors",
      VERBOSE_OUTPUT_HINT,
    ]);
  });

  it("finds nothing in output without type errors", () => {
    const report = parseTypeCheckOutput([
      "node:internal/modules/cjs/loader:1228",
      "Error: Cannot find module 'vue-tsc'",
    ]);
    assert.deepEqual(report, { errors: [], count: 0 });
    assert.equal(describeTypeCheckErrors(report, RERUN), undefined);
  });
});
