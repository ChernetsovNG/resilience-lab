import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ParamDescriptor } from "../api/apiTypes";
import { ParamField } from "./ParamField";

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
