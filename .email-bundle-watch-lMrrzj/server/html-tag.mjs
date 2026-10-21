const HTML_ATTRIBUTE = /([^\s=]+)(?:="[^"]*")?/g;

/**
 * The document's `<html>` tag: the template's attributes, overridden by those
 * the render produced (`lang`, `data-scale`…), so none appears twice.
 */
export function htmlTag(templateAttributes, renderedAttributes) {
  const rendered = new Set(
    [...renderedAttributes.matchAll(HTML_ATTRIBUTE)].map((match) => match[1]),
  );
  const kept = [...templateAttributes.matchAll(HTML_ATTRIBUTE)]
    .filter((match) => !rendered.has(match[1]))
    .map((match) => match[0]);
  return `<html ${[...kept, renderedAttributes.trim()].filter(Boolean).join(" ")}>`;
}
