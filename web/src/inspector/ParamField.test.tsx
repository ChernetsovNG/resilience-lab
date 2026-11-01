import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Catalog, ParamDescriptor } from "../api/apiTypes";
import { ParamField } from "./ParamField";
import catalog from "../test/catalog.json";
import { initialParams } from "../workspace/initialParams";

it.each([
  ["call", "circuitBreaker", "Open duration", "openDuration", "7s"],
  ["call", "retryBudget", "Budget window", "window", "5s"],
  ["call", "fallback", "Fallback processing time", "processing", "2ms"],
  ["service", "rateLimit", "Token rate", "rate", "50/s"],
  ["service", "healthCheck", "Probe timeout", "timeout", "500ms"],
  ["call", "outlierDetection", "Base ejection time", "baseEjection", "10s"],
  ["router", "outlierDetection", "Base ejection time", "baseEjection", "10s"],
])("edits %s %s while preserving its other fields", (typeId, name, title, field, value) => {
  const descriptor = catalog.types.find(type => type.id === typeId)!.params.find(param => param.name === name)! as ParamDescriptor;
  const initial = initialParams(descriptor.fields);
  const onCommit = vi.fn();
  render(<ParamField descriptor={descriptor} value={initial} path={name} editable
    isOverridden={() => false} onCommit={onCommit} onValidity={vi.fn()} />);
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: title });
  expect(input.readOnly).toBe(false);
  fireEvent.change(input, { target: { value } }); fireEvent.blur(input);
  expect(onCommit).toHaveBeenCalledExactlyOnceWith({ ...initial, [field]: value });
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

it("shows an empty optional array without serializing null or committing a value", () => {
  const descriptor = (catalog as Catalog).types.find(type => type.id === "client")!.params.find(param => param.name === "classes")!;
  const onCommit = vi.fn();
  render(<ParamField descriptor={descriptor} value={null} path="classes" editable
    isOverridden={() => false} onValidity={() => {}} onCommit={onCommit} />);
  const field = screen.getByRole<HTMLTextAreaElement>("textbox");
  expect(field.value).toBe("");
  expect(field.placeholder).toBe("Not set");
  expect(onCommit).not.toHaveBeenCalled();
});
