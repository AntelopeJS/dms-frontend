import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  filesUnder,
  type Problem,
  type SourceCheck,
  TEMPLATE_DIR,
} from "./repository";

export interface DynamicImport {
  argument: string;
  byUrl: boolean;
}

/** A string names a package and `.href` reads a `URL`; anything else is a path computed at run time. */
function isUrlSpecifier(node: ts.Expression): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "href")
  );
}

/**
 * The argument of every `import()` call in a module, read from its syntax
 * tree rather than its text: an `import(` inside a string or a template, the
 * type query a generator writes into a declaration file, is data, not a
 * call, and a comment is neither.
 */
export function dynamicImports(code: string): DynamicImport[] {
  const source = ts.createSourceFile(
    "module.mjs",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found: DynamicImport[] = [];
  const visit = (node: ts.Node): void => {
    const [argument] = ts.isCallExpression(node) ? node.arguments : [];
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      argument !== undefined
    )
      found.push({
        argument: argument.getText(source),
        byUrl: isUrlSpecifier(argument),
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Node reads `C:\...` as a URL whose scheme is `c:` and refuses it with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME: every production render of `server.mjs`
 * then fell back to client rendering. A POSIX path imports fine, so only
 * the template's Node.js sources show the mistake.
 */
function nodeSideImportsByUrl(): Problem[] {
  const files = filesUnder(TEMPLATE_DIR)
    .map((path) => path.slice(TEMPLATE_DIR.length + 1))
    .filter((file) => file.endsWith(".mjs"));
  const specifiers = files.flatMap((file) =>
    dynamicImports(readFileSync(join(TEMPLATE_DIR, file), "utf8")).map(
      (dynamicImport) => ({ file, ...dynamicImport }),
    ),
  );
  const scanned = ["server.mjs", "sfc-global-types.mjs"].filter(
    (file) => !specifiers.some((entry) => entry.file === file),
  );
  return [
    ...scanned.map((file) => `${file} has no dynamic import left to scan`),
    ...specifiers
      .filter(({ byUrl }) => !byUrl)
      .map(
        ({ file, argument }) =>
          `templates/vue/${file} imports ${argument}, which is a path on Windows: import it by URL`,
      ),
  ];
}

export const DYNAMIC_IMPORT_CHECKS: SourceCheck[] = [
  {
    name: "every module of the template's Node.js side is loaded by URL",
    run: nodeSideImportsByUrl,
  },
];
