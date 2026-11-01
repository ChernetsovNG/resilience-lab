import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ParamDescriptor } from "../api/apiTypes";
import { ParamField } from "./ParamField";
import catalog from "../test/catalog.json";
import { initialParams } from "../workspace/initialParams";

it.each([
  ["call", "circuitBreaker"], ["call", "retryBudget"], ["call", "fallback"],
  ["service", "rateLimit"], ["service", "healthCheck"],
  ["call", "outlierDetection"], ["router", "outlierDetection"],
])("keeps %s %s read-only until the policy editor is available", (typeId, name) => {
  const descriptor = catalog.types.find(type => type.id === typeId)!.params.find(param => param.name === name)! as ParamDescriptor;
  render(<ParamField descriptor={descriptor} value={initialParams(descriptor.fields)} path={name} editable
    isOverridden={() => false} onCommit={vi.fn()} onValidity={vi.fn()} />);
  for (const input of screen.getAllByRole("textbox")) expect(input).toHaveProperty("readOnly", true);
});

it("shows catalog arrays as read-only JSON without committing a lossy string", () => {
  const entries = [{ name: "first" }, { name: "second" }];
  const descriptor: ParamDescriptor = { name: "entries", kind: "ARRAY", title: "Entries", description: "",
    required: false, fields: [], options: [], units: [], sweepable: false };
  const onCommit = vi.fn();
  render(<ParamField descriptor={descriptor} value={entries} path="entries" editable
    isOverridden={() => false} onCommit={onCommit} onValidity={vi.fn()} />);

  const field = screen.getByRole("textbox", { name: "Entries" }) as HTMLTextAreaElement;
  expect(field.readOnly).toBe(true);
  expect(JSON.parse(field.value)).toEqual(entries);
  fireEvent.blur(field);
  expect(onCommit).not.toHaveBeenCalled();
});
