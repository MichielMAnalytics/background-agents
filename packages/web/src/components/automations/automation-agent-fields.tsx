"use client";

import { type ModelCategory } from "@open-inspect/shared/models";
import {
  getHarnessLabel,
  HARNESS_IDS,
  getHarnessReasoningConfig,
  isValidHarness,
} from "@open-inspect/shared/harnesses";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronDownIcon, ModelIcon } from "@/components/ui/icons";
import { formatModelNameLower } from "@/lib/format";
import { getPublicSandboxProvider } from "@/lib/sandbox-provider";
import { sandboxSettingCapabilities } from "@open-inspect/shared/types/integrations";
import { FieldDescription } from "./automation-form-field";
import { effectiveReasoningEffort, type AutomationAgentDraft } from "./automation-form-policy";

const DEFAULT_REASONING_VALUE = "__default__";
const INHERIT_TIME_BUDGET_VALUE = "__inherit__";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Presets within MIN/MAX_AUTOMATION_SANDBOX_TIMEOUT_MS. */
const TIME_BUDGET_OPTIONS_MS = [
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  4 * HOUR_MS,
  8 * HOUR_MS,
  12 * HOUR_MS,
  24 * HOUR_MS,
];

/**
 * Exact label for a time budget. An override set through the API need not be a preset, and a
 * rounded label would make it indistinguishable from the preset it rounds to.
 */
export function formatTimeBudget(ms: number): string {
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((ms % MINUTE_MS) / 1000);
  const parts = [
    hours > 0 && unit(hours, "hour"),
    minutes > 0 && unit(minutes, "minute"),
    seconds > 0 && unit(seconds, "second"),
  ].filter(Boolean);
  return parts.join(" ");
}

interface AutomationAgentFieldsProps {
  value: AutomationAgentDraft;
  resolvedModel: string;
  enabledModelOptions: ModelCategory[];
  /** Why no listed model can be submitted, shown under the picker. */
  modelError?: string;
  onChange: (value: AutomationAgentDraft) => void;
}

export function AutomationAgentFields({
  value,
  resolvedModel,
  enabledModelOptions,
  modelError = "",
  onChange,
}: AutomationAgentFieldsProps) {
  const reasoningConfig = getHarnessReasoningConfig(value.harness, resolvedModel);
  const reasoningEffort = effectiveReasoningEffort(
    value.harness,
    resolvedModel,
    value.reasoningEffort
  );
  const supportsTimeBudget = sandboxSettingCapabilities(getPublicSandboxProvider()).timeout;
  // An override set through the API to a value outside the presets still shows as selected.
  const timeBudgetOptions =
    value.sandboxTimeoutMs === null || TIME_BUDGET_OPTIONS_MS.includes(value.sandboxTimeoutMs)
      ? TIME_BUDGET_OPTIONS_MS
      : [...TIME_BUDGET_OPTIONS_MS, value.sandboxTimeoutMs].sort((a, b) => a - b);
  const modelGroups: ComboboxGroup[] = enabledModelOptions.map((group) => ({
    category: group.category,
    options: group.models.map((model) => ({
      value: model.id,
      label: model.name,
      description: model.description,
    })),
  }));

  const changeModel = (model: string) => {
    onChange({
      ...value,
      model,
      reasoningEffort: effectiveReasoningEffort(value.harness, model, value.reasoningEffort),
    });
  };

  return (
    <>
      <div>
        <label
          htmlFor="automation-harness"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Agent
        </label>
        <Select
          value={value.harness}
          onValueChange={(harness) => {
            if (isValidHarness(harness))
              onChange({
                ...value,
                harness,
                reasoningEffort: effectiveReasoningEffort(
                  harness,
                  resolvedModel,
                  value.reasoningEffort
                ),
              });
          }}
        >
          <SelectTrigger id="automation-harness" className="w-full" aria-label="Agent harness">
            <SelectValue>{getHarnessLabel(value.harness)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {HARNESS_IDS.map((harness) => (
              <SelectItem key={harness} value={harness}>
                {getHarnessLabel(harness)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          Agent harness that runs each session this automation creates. It decides which models are
          available below.
        </FieldDescription>
      </div>

      <div>
        <label
          id="automation-model-label"
          htmlFor="automation-model"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Model
        </label>
        <Combobox
          id="automation-model"
          labelId="automation-model-label"
          value={resolvedModel}
          onChange={changeModel}
          items={modelGroups}
          dropdownWidth="w-56"
          triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
        >
          <ModelIcon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="truncate flex-1 text-left">{formatModelNameLower(resolvedModel)}</span>
          <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
        </Combobox>
        <FieldDescription>
          Model used for the agent on each run of this automation.
        </FieldDescription>
        {modelError && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {modelError}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="automation-reasoning-effort"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Reasoning Effort
        </label>
        <Select
          value={reasoningConfig ? reasoningEffort || DEFAULT_REASONING_VALUE : ""}
          onValueChange={(reasoningEffort) =>
            onChange({
              ...value,
              reasoningEffort: reasoningEffort === DEFAULT_REASONING_VALUE ? "" : reasoningEffort,
            })
          }
          disabled={!reasoningConfig}
        >
          <SelectTrigger id="automation-reasoning-effort" className="w-full">
            <SelectValue
              placeholder={reasoningConfig ? "Use model default" : "Not supported for this model"}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_REASONING_VALUE}>Use model default</SelectItem>
            {(reasoningConfig?.efforts ?? []).map((effort) => (
              <SelectItem key={effort} value={effort}>
                {effort}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          For models that support it, overrides how much chain-of-thought style reasoning is
          allowed. &quot;Use model default&quot; leaves the choice to the model.
        </FieldDescription>
      </div>

      {supportsTimeBudget && (
        <div>
          <label
            htmlFor="automation-time-budget"
            className="block text-sm font-medium text-foreground mb-1.5"
          >
            Time budget
          </label>
          <Select
            value={
              value.sandboxTimeoutMs === null
                ? INHERIT_TIME_BUDGET_VALUE
                : String(value.sandboxTimeoutMs)
            }
            onValueChange={(selected) =>
              onChange({
                ...value,
                sandboxTimeoutMs: selected === INHERIT_TIME_BUDGET_VALUE ? null : Number(selected),
              })
            }
          >
            <SelectTrigger id="automation-time-budget" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT_TIME_BUDGET_VALUE}>Repository default</SelectItem>
              {timeBudgetOptions.map((ms) => (
                <SelectItem key={ms} value={String(ms)}>
                  {formatTimeBudget(ms)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            How long each run may work before it is stopped. Replaces the sandbox timeout this
            automation&apos;s runs would otherwise inherit from their repository or environment.
          </FieldDescription>
        </div>
      )}
    </>
  );
}
