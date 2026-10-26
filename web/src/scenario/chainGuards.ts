import type { Scenario, ValidationIssue } from "../api/types";

export function validateChain(scenario: Scenario, prefix = "scenario"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const serviceIds = new Set(scenario.services.map((service) => service.id));
  const add = (path: string, message: string) => issues.push({ path, message });

  if (scenario.services.length === 0) {
    add(`${prefix}.services`, "must contain at least one service");
  } else if (!serviceIds.has(scenario.entry)) {
    add(`${prefix}.entry`, "entry must reference an existing service");
  }

  const duplicateServiceIds = findDuplicates(
    scenario.services.map((service) => service.id),
    "Service ID",
    (index) => `${prefix}.services[${index}].id`,
    add,
  );
  findDuplicates(
    scenario.links.map((link) => link.id),
    "Link ID",
    (index) => `${prefix}.links[${index}].id`,
    add,
  );

  const outgoing = new Map<string, number[]>();
  const incoming = new Map<string, number[]>();
  const edges = new Set<string>();
  scenario.links.forEach((link, index) => {
    if (!serviceIds.has(link.from)) {
      add(`${prefix}.links[${index}].from`, "must reference an existing service");
    }
    if (!serviceIds.has(link.to)) {
      add(`${prefix}.links[${index}].to`, "must reference an existing service");
    }
    const edge = `${link.from}\0${link.to}`;
    if (edges.has(edge)) {
      add(`${prefix}.links[${index}]`, `Duplicate edge '${link.from} -> ${link.to}' is not allowed`);
    }
    edges.add(edge);
    outgoing.set(link.from, [...(outgoing.get(link.from) ?? []), index]);
    incoming.set(link.to, [...(incoming.get(link.to) ?? []), index]);
  });

  outgoing.forEach((indexes) => {
    indexes.slice(1).forEach((index) => {
      add(`${prefix}.links[${index}].from`, "service must have at most one outgoing link");
    });
  });
  incoming.forEach((indexes) => {
    indexes.slice(1).forEach((index) => {
      add(`${prefix}.links[${index}].to`, "service must have at most one incoming link");
    });
  });

  if (duplicateServiceIds.size > 0) return issues;

  const validOutgoing = new Map<string, number[]>();
  scenario.links.forEach((link, index) => {
    if (serviceIds.has(link.from) && serviceIds.has(link.to)) {
      validOutgoing.set(link.from, [...(validOutgoing.get(link.from) ?? []), index]);
    }
  });
  const states = new Map<string, "visiting" | "visited">();
  const visit = (serviceId: string) => {
    states.set(serviceId, "visiting");
    for (const index of validOutgoing.get(serviceId) ?? []) {
      const target = scenario.links[index].to;
      if (states.get(target) === "visiting") {
        add(`${prefix}.links[${index}].to`, "must not close a cycle");
      } else if (!states.has(target)) {
        visit(target);
      }
    }
    states.set(serviceId, "visited");
  };

  if (serviceIds.has(scenario.entry)) visit(scenario.entry);
  scenario.services.forEach((service) => {
    if (!states.has(service.id)) visit(service.id);
  });

  if (serviceIds.has(scenario.entry)) {
    const reachable = new Set<string>();
    const pending = [scenario.entry];
    while (pending.length > 0) {
      const serviceId = pending.shift()!;
      if (reachable.has(serviceId)) continue;
      reachable.add(serviceId);
      for (const index of validOutgoing.get(serviceId) ?? []) {
        pending.push(scenario.links[index].to);
      }
    }
    scenario.services.forEach((service, index) => {
      if (!reachable.has(service.id)) {
        add(`${prefix}.services[${index}].id`, "service must be connected to the entry chain");
      }
    });
  }

  return issues;
}

function findDuplicates(
  ids: string[],
  label: string,
  path: (index: number) => string,
  add: (path: string, message: string) => void,
): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      duplicates.add(id);
      add(path(index), `${label} '${id}' is duplicated`);
    }
    seen.add(id);
  });
  return duplicates;
}
