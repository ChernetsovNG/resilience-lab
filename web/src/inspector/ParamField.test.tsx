import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Catalog } from "../api/apiTypes";
import generatedCatalog from "../test/catalog.json";
import { ParamField } from "./ParamField";

it("shows catalog arrays as read-only JSON without committing a lossy string", () => {
  const points = [{ time: "0s", rate: "10/s" }, { time: "1s", rate: "20/s" }];
  const descriptor = (generatedCatalog as Catalog).types.find(type => type.id === "client")!
    .params.find(param => param.name === "load")!.fields.find(field => field.name === "points")!;
  const onCommit = vi.fn();
  render(<ParamField descriptor={descriptor} value={points} path="load.points" editable
    isOverridden={() => false} onCommit={onCommit} onValidity={vi.fn()} />);

  const field = screen.getByRole("textbox", { name: "Load points" }) as HTMLTextAreaElement;
  expect(field.readOnly).toBe(true);
  expect(JSON.parse(field.value)).toEqual(points);
  fireEvent.blur(field);
  expect(onCommit).not.toHaveBeenCalled();
});
