import type { ServiceSpec } from "../api/types";
import { DistributionFields } from "./DistributionFields";
import { NumberField } from "./NumberField";

interface ServiceInspectorProps {
  service: ServiceSpec;
  onChange: (patch: Partial<ServiceSpec>) => void;
}

export function ServiceInspector({ service, onChange }: ServiceInspectorProps) {
  return (
    <form className="parameter-form" aria-label="Service parameters" onSubmit={(event) => event.preventDefault()}>
      <fieldset>
        <legend>Service {service.id}</legend>
        <NumberField
          label="Handlers"
          name="handlers"
          value={service.handlers}
          min={1}
          max={2_147_483_647}
          integer
          hint="Integer greater than zero."
          errorMessage="Must be an integer greater than 0."
          onCommit={(handlers) => {
            if (handlers !== null) onChange({ handlers });
          }}
        />
        <NumberField
          label="Queue capacity"
          name="queueCapacity"
          value={service.queueCapacity}
          min={0}
          max={2_147_483_647}
          integer
          hint="Non-negative integer; zero disables queuing."
          errorMessage="Must be a non-negative integer."
          onCommit={(queueCapacity) => {
            if (queueCapacity !== null) onChange({ queueCapacity });
          }}
        />
        <DistributionFields
          label="Processing"
          name="processing"
          distribution={service.processing}
          onChange={(processing) => onChange({ processing })}
        />
        <NumberField
          label="Service failure rate"
          name="serviceFailureRate"
          value={service.failureRate}
          min={0}
          max={1}
          hint="Finite probability from 0 through 1."
          errorMessage="Must be between 0 and 1."
          onCommit={(failureRate) => {
            if (failureRate !== null) onChange({ failureRate });
          }}
        />
      </fieldset>
    </form>
  );
}
