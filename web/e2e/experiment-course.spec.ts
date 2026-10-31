import { expect, test } from "./fixtures";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { selectExperiment } from "./fixtures";
import type { ExperimentFile } from "../src/api/apiTypes";

test.use({ viewport: { width: 1440, height: 900 } });

test("checkout exposes PSP timing and opens its fault even with a collapsed inspector", async ({ page, request }, testInfo) => {
  await page.goto("/");
  await selectExperiment(page, "checkout/checkout.experiment.json");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  const path = "/api/v1/workspace/document?path=checkout%2Fcheckout.experiment.json";
  const before = await (await request.get(path)).json();
  const course = page.getByRole("region", { name: "Experiment course", exact: true });
  await expect(course).toContainText("psp · Slowdown 8× · 20–40 s");
  const canvas = page.getByRole("application", { name: "Model canvas", exact: true });
  const collapsedHeight = (await course.boundingBox())!.height;
  const withCourse = (await canvas.boundingBox())!.height;
  const withoutCourse = await page.locator(".experiment-course").evaluate(element => {
    const band = element as HTMLElement;
    band.style.display = "none";
    const height = document.querySelector('[role="application"][data-testid="rf__wrapper"]')!.getBoundingClientRect().height;
    band.style.display = "";
    return height;
  });
  await expect.poll(async () => (await canvas.boundingBox())!.height).toBe(withCourse);
  expect(withoutCourse - withCourse).toBe(collapsedHeight);
  expect(collapsedHeight).toBe(32);
  await page.getByRole("button", { name: "Experiment course", exact: true }).click();
  expect((await canvas.boundingBox())!.height).toBe(withCourse);
  const badge = page.getByTestId("rf__node-psp").getByRole("button", { name: /Open fault: psp/ });
  await expect(badge).toBeVisible();
  await expect(page.getByTestId("rf__node-payment-service").locator(".fault-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse inspector", exact: true }).click();
  await course.getByRole("button", { name: "psp · Slowdown 8× · 20–40 s", exact: true }).click();
  const target = page.locator('[data-inspector-field="faults.0.target"] select');
  await expect(target).toBeFocused();
  await expect(target).toHaveValue("psp");
  await badge.click();
  await expect(target).toBeFocused();
  expect(await (await request.get(path)).json()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath("course-before.png") });
  const measurement = JSON.stringify({ viewport: "1440x900", withoutCourse, withCourse, expanded: (await canvas.boundingBox())!.height, collapsedHeight });
  await writeFile(testInfo.outputPath("canvas-measurement.json"), measurement);
  await testInfo.attach("canvas-measurement", { body: measurement, contentType: "application/json" });
});

test("a real checkout result shares the course cursor with Timeline and playback and states its conditions", async ({ page }, testInfo) => {
  const directory = resolve("../apps/server/build/e2e-workspace/course-checkout");
  await mkdir(directory);
  try {
    for (const name of ["checkout.model.json", "checkout.layout.json"]) await copyFile(resolve("../examples/checkout", name), resolve(directory, name));
    const experiment: ExperimentFile = JSON.parse(await readFile(resolve("../examples/checkout/checkout.experiment.json"), "utf8"));
    experiment.execution.replications = 2;
    experiment.variants = experiment.variants.filter(variant => ["baseline", "aligned-timeouts"].includes(variant.id));
    await writeFile(resolve(directory, "checkout.experiment.json"), JSON.stringify(experiment));
    await page.goto("/");
    await selectExperiment(page, "course-checkout/checkout.experiment.json");
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Experiment course", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("course-before.png") });
    await page.getByRole("button", { name: "Experiment course", exact: true }).click();
    await page.getByRole("tab", { name: "Baseline", exact: true }).click();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByTestId("job-status")).toHaveText("COMPLETED");
    await expect(page.getByTestId("run-conditions")).toHaveText("Load 30 RPS; faults: psp · Slowdown 8× · 20–40 s");
    await page.getByTestId("rf__node-psp").locator(".block-node > strong").click();
    await page.getByRole("button", { name: "Experiment course", exact: true }).click();
    const axis = page.getByRole("slider", { name: "Experiment time", exact: true });
    await axis.focus();
    await axis.press("Home");
    await axis.press("ArrowRight");
    const playback = page.getByRole("slider", { name: "Playback window", exact: true });
    await expect(playback).toHaveValue("1");
    await expect(page.getByTestId("course-cursor")).toHaveAttribute("data-cursor-window", "1");
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await expect(page.getByTestId("timeline-cursor")).toContainText("Window 1 ·");
    await page.getByRole("region", { name: "Queue", exact: true }).getByRole("slider").press("End");
    const lastWindow = await playback.inputValue();
    expect(Number(lastWindow)).toBeGreaterThan(1);
    await expect(page.getByTestId("course-cursor")).toHaveAttribute("data-cursor-window", lastWindow);
    await playback.fill("2");
    await expect(page.getByTestId("course-cursor")).toHaveAttribute("data-cursor-window", "2");
    await expect(page.getByTestId("timeline-cursor")).toContainText("Window 2 ·");
    await page.getByRole("tab", { name: "Answer", exact: true }).click();
    await page.getByTestId("run-conditions").scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      const strip = (await page.locator(".course-expanded").boundingBox())!;
      const nodes = await page.getByTestId("block-node").all();
      return Math.max(...await Promise.all(nodes.map(async node => {
        const box = (await node.boundingBox())!;
        return box.y + box.height - strip.y;
      })));
    }).toBeLessThanOrEqual(0);
    const caption = (await page.locator(".course-load figcaption").boundingBox())!;
    const label = (await page.locator(".course-load-point").first().boundingBox())!;
    expect(label.y).toBeGreaterThanOrEqual(caption.y + caption.height);
    await page.screenshot({ path: testInfo.outputPath("course-after.png") });
    await page.getByRole("button", { name: "Analysis", exact: true }).click();
    await page.getByRole("button", { name: "Experiment course", exact: true }).click();
    await page.getByTestId("rf__node-psp").getByRole("button", { name: /Open fault: psp/ }).click();
    await expect(page.locator('[data-inspector-field="faults.0.target"] select')).toBeFocused();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
