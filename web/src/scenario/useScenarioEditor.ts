import { useReducer } from "react";
import type {
  DegradationSpec,
  Execution,
  LinkSpec,
  Scenario,
  ServiceSpec,
  ValidationIssue,
  WorkloadSpec,
} from "../api/types";
import { validateChain } from "./chainGuards";
import {
  createDefaultExecution,
  createRetryStormExample,
  createThreeServiceChain,
} from "./factory";

export type ActiveVariantId = "baseline" | "candidate";

export interface ScenarioEditorState {
  baseline: Scenario;
  candidate: Scenario;
  execution: Execution;
  activeVariantId: ActiveVariantId;
  issues: ValidationIssue[];
}

type Action =
  | { type: "new" }
  | { type: "load-retry-storm" }
  | { type: "select"; variantId: ActiveVariantId }
  | { type: "add-service"; service: ServiceSpec }
  | { type: "delete-service"; serviceId: string }
  | { type: "connect"; link: LinkSpec }
  | {
      type: "update-service";
      variantId: ActiveVariantId;
      serviceId: string;
      patch: Partial<ServiceSpec>;
    }
  | { type: "update-link"; linkId: string; patch: Partial<LinkSpec> }
  | { type: "update-workload"; patch: Partial<WorkloadSpec> }
  | { type: "update-degradation"; degradation: DegradationSpec | null }
  | { type: "update-execution"; patch: Partial<Execution> };

function initialState(): ScenarioEditorState {
  return withIssues({
    baseline: createThreeServiceChain(),
    candidate: createThreeServiceChain(),
    execution: createDefaultExecution(),
    activeVariantId: "baseline",
    issues: [],
  });
}

function withIssues(state: ScenarioEditorState): ScenarioEditorState {
  return {
    ...state,
    issues: [
      ...validateChain(state.baseline, "baseline"),
      ...validateChain(state.candidate, "candidate"),
    ],
  };
}

function updateActive(
  state: ScenarioEditorState,
  update: (scenario: Scenario) => Scenario,
): ScenarioEditorState {
  return withIssues({
    ...state,
    [state.activeVariantId]: update(state[state.activeVariantId]),
  });
}

function nextId(existingIds: string[], prefix: string): string {
  let index = existingIds.length + 1;
  while (existingIds.includes(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

export function scenarioEditorReducer(
  state: ScenarioEditorState,
  action: Action,
): ScenarioEditorState {
  switch (action.type) {
    case "new":
      return initialState();
    case "load-retry-storm": {
      const { experiment } = createRetryStormExample();
      return withIssues({
        baseline: experiment.variants[0].scenario,
        candidate: experiment.variants[1].scenario,
        execution: experiment.execution,
        activeVariantId: "baseline",
        issues: [],
      });
    }
    case "select":
      return { ...state, activeVariantId: action.variantId };
    case "add-service":
      return updateActive(state, (scenario) => ({
        ...scenario,
        services: [...scenario.services, action.service],
      }));
    case "delete-service":
      return updateActive(state, (scenario) => {
        const services = scenario.services.filter((service) => service.id !== action.serviceId);
        return {
          ...scenario,
          entry: scenario.entry === action.serviceId ? (services[0]?.id ?? "") : scenario.entry,
          services,
          links: scenario.links.filter(
            (link) => link.from !== action.serviceId && link.to !== action.serviceId,
          ),
          degradation:
            scenario.degradation?.serviceId === action.serviceId ? null : scenario.degradation,
        };
      });
    case "connect":
      return updateActive(state, (scenario) => {
        if (
          scenario.links.some(
            (link) => link.from === action.link.from && link.to === action.link.to,
          )
        ) {
          return scenario;
        }
        return { ...scenario, links: [...scenario.links, action.link] };
      });
    case "update-service":
      return withIssues({
        ...state,
        [action.variantId]: {
          ...state[action.variantId],
          services: state[action.variantId].services.map((service) =>
            service.id === action.serviceId ? { ...service, ...action.patch } : service,
          ),
        },
      });
    case "update-link":
      return updateActive(state, (scenario) => ({
        ...scenario,
        links: scenario.links.map((link) =>
          link.id === action.linkId ? { ...link, ...action.patch } : link,
        ),
      }));
    case "update-workload":
      return updateActive(state, (scenario) => ({
        ...scenario,
        workload: { ...scenario.workload, ...action.patch },
      }));
    case "update-degradation":
      return updateActive(state, (scenario) => ({
        ...scenario,
        degradation: action.degradation,
      }));
    case "update-execution":
      return { ...state, execution: { ...state.execution, ...action.patch } };
  }
}

export function useScenarioEditor() {
  const [state, dispatch] = useReducer(scenarioEditorReducer, undefined, initialState);
  const active = () => state[state.activeVariantId];

  return {
    ...state,
    newThreeServiceChain: () => dispatch({ type: "new" }),
    loadRetryStormExample: () => dispatch({ type: "load-retry-storm" }),
    selectActiveVariant: (variantId: ActiveVariantId) => dispatch({ type: "select", variantId }),
    addService: () => {
      const scenario = active();
      const id = nextId(scenario.services.map((service) => service.id), "service");
      dispatch({
        type: "add-service",
        service: {
          id,
          handlers: 4,
          queueCapacity: 32,
          processing: { kind: "FIXED", meanMs: 10, stdDevMs: null },
          failureRate: 0,
        },
      });
      return id;
    },
    deleteService: (serviceId: string) => dispatch({ type: "delete-service", serviceId }),
    connectServices: (from: string, to: string) => {
      const scenario = active();
      const template = scenario.links[0] ?? createThreeServiceChain().links[0];
      dispatch({
        type: "connect",
        link: {
          ...template,
          id: nextId(scenario.links.map((link) => link.id), "link"),
          from,
          to,
        },
      });
    },
    updateService: (variantId: ActiveVariantId, serviceId: string, patch: Partial<ServiceSpec>) =>
      dispatch({ type: "update-service", variantId, serviceId, patch }),
    updateLink: (linkId: string, patch: Partial<LinkSpec>) =>
      dispatch({ type: "update-link", linkId, patch }),
    updateWorkload: (patch: Partial<WorkloadSpec>) =>
      dispatch({ type: "update-workload", patch }),
    updateDegradation: (degradation: DegradationSpec | null) =>
      dispatch({ type: "update-degradation", degradation }),
    updateExecution: (patch: Partial<Execution>) =>
      dispatch({ type: "update-execution", patch }),
  };
}
