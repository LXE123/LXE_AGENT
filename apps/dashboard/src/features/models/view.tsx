import { useEffect, useMemo, useState } from "react";
import { Brain, Check, CircleCheck, Settings2, Sparkles } from "lucide-react";

import { formatCompactNumber, formatNumber } from "../../shared/format";
import {
  modelDisabledReasonLabel,
  modelsInDisplayOrder,
  modelThinkingLevelLabel,
  modelWithOption,
  reconcileModelSelections
} from "./model";
import { useUiText } from "../../shared/i18n";
import type { ModelPayload } from "../../api/payloads";

function CompactTokenMetric({ value }: { value: number }) {
  const exactValue = formatNumber(value);
  return (
    <dd aria-label={exactValue} title={exactValue}>
      {formatCompactNumber(value)}
    </dd>
  );
}

export function ModelsView({
  models,
  current,
  modelSaving,
  thinkingSaving,
  onCurrentModelChange,
  onThinkingLevelChange,
  onConfigureCredentials
}: {
  models: ModelPayload[];
  current: ModelPayload | null;
  modelSaving: boolean;
  thinkingSaving: boolean;
  onCurrentModelChange: (provider: string, model: string) => void;
  onThinkingLevelChange: (level: string) => void;
  onConfigureCredentials?: () => void;
}) {
  const t = useUiText();
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const displayedModels = useMemo(() => modelsInDisplayOrder(models), [models]);

  useEffect(() => {
    setSelectedModels((existing) => reconcileModelSelections(models, current, existing));
  }, [models, current]);

  return (
    <div className="models-page">
      <section className="models-current-summary" aria-label={t.models.currentModel}>
        <div className="models-current-identity">
          <div className="models-current-icon">
            <CircleCheck size={21} />
          </div>
          <div className="models-current-copy">
            <span>{t.models.currentModel}</span>
            <div className="models-current-name">
              <strong>{current?.label || t.common.none}</strong>
              <code>{current?.model || "-"}</code>
            </div>
          </div>
        </div>
        <div className="models-effective-note">
          <span className="models-effective-dot" aria-hidden="true" />
          {t.models.effectiveNextTurn}
        </div>
        {onConfigureCredentials ? (
          <button className="desktop-inline-settings" onClick={onConfigureCredentials} type="button">
            <Settings2 size={14} />
            配置凭证
          </button>
        ) : null}
      </section>

      <div className="grid-list models-grid">
        {displayedModels.map((model) => {
          const providerActive = current?.provider === model.provider;
          const selectedModel = selectedModels[model.provider] || model.model;
          const selectedOption =
            model.model_options.find((option) => option.model === selectedModel) ||
            model.model_options.find((option) => option.model === model.model) ||
            model.model_options[0];
          const displayedModel = selectedOption
            ? modelWithOption(model, selectedOption, providerActive ? model.thinking_state : undefined)
            : model;
          const selectedIsCurrent = providerActive && current?.model === displayedModel.model;
          const thinkingLevels = displayedModel.thinking_levels || [];
          const showThinkingControl =
            selectedIsCurrent && Boolean(displayedModel.thinking_state?.editable) && thinkingLevels.length > 0;
          const showThinkingReadout = !showThinkingControl && thinkingLevels.length > 0;
          const showThinkingUnsupported = !displayedModel.capabilities.supports_thinking;
          const showThinkingManaged =
            displayedModel.capabilities.supports_thinking &&
            displayedModel.thinking_request_style === "provider-managed" &&
            thinkingLevels.length === 0;
          const showThinkingPanel =
            showThinkingControl || showThinkingReadout || showThinkingUnsupported || showThinkingManaged;
          const switchDisabled = modelSaving || !model.selectable || !selectedOption || selectedIsCurrent;
          return (
            <article
              aria-current={providerActive ? "true" : undefined}
              className={`item-card model-card ${providerActive ? "item-active" : ""}`}
              data-provider={model.provider}
              key={model.provider}
            >
              <div className="model-card-header">
                <div className="item-heading">
                  <div className="item-icon">
                    <Brain size={19} />
                  </div>
                  <div className="model-heading-copy">
                    <h3>{model.label}</h3>
                    <div className="model-heading-model">{displayedModel.model}</div>
                  </div>
                </div>
                {providerActive ? (
                  <span className="model-current-badge">
                    <Check size={13} />
                    {t.models.current}
                  </span>
                ) : null}
              </div>

              <div className="model-select-panel">
                <label className="model-select-label" htmlFor={`model-select-${model.provider}`}>
                  {t.models.model}
                </label>
                <div className="model-select-row">
                  <select
                    aria-label={`${model.label} model`}
                    className="model-select"
                    disabled={!model.selectable || model.model_options.length <= 1 || modelSaving}
                    id={`model-select-${model.provider}`}
                    onChange={(event) =>
                      setSelectedModels((currentSelections) => ({
                        ...currentSelections,
                        [model.provider]: event.target.value
                      }))
                    }
                    value={displayedModel.model}
                  >
                    {model.model_options.map((option) => (
                      <option key={option.model} value={option.model}>
                        {option.model}
                      </option>
                    ))}
                  </select>
                  <button
                    className="model-switch-button"
                    disabled={switchDisabled}
                    onClick={() => onCurrentModelChange(model.provider, displayedModel.model)}
                    type="button"
                  >
                    {selectedIsCurrent ? <Check size={14} /> : <Settings2 size={14} />}
                    <span>
                      {selectedIsCurrent ? t.models.current : modelSaving ? t.models.switching : t.models.setCurrent}
                    </span>
                  </button>
                </div>
                {!model.selectable && model.disabled_reason ? (
                  <div className="model-disabled-reason">{modelDisabledReasonLabel(t, model.disabled_reason)}</div>
                ) : null}
              </div>

              <details className="model-capabilities-details">
                <summary>{t.models.capabilities}</summary>
                <dl className="compact-metrics">
                  <div>
                    <dt>{t.models.context}</dt>
                    <CompactTokenMetric value={displayedModel.capabilities.context_window_tokens} />
                  </div>
                  <div>
                    <dt>{t.models.output}</dt>
                    <CompactTokenMetric
                      value={displayedModel.capabilities.max_tokens
                        ?? displayedModel.capabilities.max_output_tokens
                        ?? 0}
                    />
                  </div>
                  <div>
                    <dt>{t.models.vision}</dt>
                    <dd className={displayedModel.capabilities.supports_vision ? "metric-positive" : undefined}>
                      {displayedModel.capabilities.supports_vision ? t.common.yes : t.common.no}
                    </dd>
                  </div>
                </dl>
              </details>
              {showThinkingPanel ? (
                <div className="model-thinking-panel">
                  <div className="model-thinking-title">
                    <span>
                      <Sparkles size={13} />
                      {t.models.thinking}
                    </span>
                  </div>
                  {showThinkingControl ? (
                    <div
                      className="thinking-level-control"
                      role="group"
                      aria-label={`${model.label} thinking level`}
                    >
                      {thinkingLevels.map((level) => {
                        const selected = displayedModel.thinking_state?.level === level;
                        return (
                          <button
                            aria-pressed={selected}
                            className={selected ? "thinking-level-button active" : "thinking-level-button"}
                            disabled={thinkingSaving}
                            key={level}
                            onClick={() => onThinkingLevelChange(level)}
                            type="button"
                          >
                            {modelThinkingLevelLabel(displayedModel, level)}
                          </button>
                        );
                      })}
                    </div>
                  ) : showThinkingReadout ? (
                    <div className="thinking-level-readout">
                      {thinkingLevels.map((level) => modelThinkingLevelLabel(displayedModel, level)).join(" / ")}
                    </div>
                  ) : showThinkingManaged ? (
                    <div className="thinking-level-readout">{t.models.providerManaged}</div>
                  ) : (
                    <div className="thinking-level-readout">{t.common.notSupported}</div>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
