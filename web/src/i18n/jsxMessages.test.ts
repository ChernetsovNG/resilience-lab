/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const visibleAttributes = new Set(["title", "aria-label", "aria-description", "placeholder", "alt", "label"]);

/** This guard checks rendered JSX text, not machine attributes, CSS classes or document values. */
function literalMessages(source: string, filename = "component.tsx"): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors: string[] = [];
  const report = (node: ts.Node) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    errors.push(`${filename}:${line + 1}: ${node.getText(file).trim()}`);
  };
  const expression = (node: ts.Expression) => {
    if (ts.isStringLiteralLike(node)) {
      if (node.text.trim() !== "") report(node);
    } else if (ts.isTemplateExpression(node)) {
      if ([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].some((text) => text.trim() !== "")) report(node);
    } else if (ts.isConditionalExpression(node)) {
      expression(node.whenTrue); expression(node.whenFalse);
    } else if (ts.isBinaryExpression(node)) {
      // The left side of && is a condition, not rendered text. || and ?? can render either operand.
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) expression(node.left);
      expression(node.right);
    } else if (ts.isParenthesizedExpression(node)) expression(node.expression);
    // Calls such as t(key, params) and dynamic values are intentional message/data boundaries.
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && node.text.trim() !== "") report(node);
    if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.getText(file)) && node.initializer !== undefined) {
      if (ts.isStringLiteral(node.initializer)) report(node.initializer);
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) expression(node.initializer.expression);
    }
    if (ts.isJsxExpression(node) && node.expression !== undefined && !ts.isJsxAttribute(node.parent)) expression(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}

function components(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? components(path) : entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

describe("JSX message catalog guard", () => {
  it.each([
    "<button>New visible message</button>",
    '<button title="New title" />',
    '<button aria-label="New accessible message" />',
    '<input placeholder="New placeholder" />',
    '<span>{ok ? "New message" : t("key")}</span>',
    '<span>{`New message ${count}`}</span>',
    '<span>{ok && "New message"}</span>',
  ])("rejects uncataloged user text: %s", (source) => {
    expect(literalMessages(source)).not.toEqual([]);
  });
  it("permits messages, dynamic API/document text, and machine attributes", () => {
    expect(literalMessages('<button className="primary" type="button" title={t("app.run")} data-testid="run">{t("app.run")}{label}</button>')).toEqual([]);
  });
  it("contains no literal user messages in production JSX", () => {
    const root = resolve("src");
    expect(components(root).flatMap((path) => literalMessages(readFileSync(path, "utf8"), path))).toEqual([]);
  });
});
