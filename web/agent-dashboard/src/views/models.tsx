import { useEffect, useState } from "react";
import { Brain, Settings2 } from "lucide-react";

import { formatNumber } from "../format";
import { modelDisabledReasonLabel, modelThinkingLevelLabel, modelWithOption } from "../lib/models";
import { useUiText } from "../i18n";
import type { ModelPayload } from "../payloads";

export function ModelsView({
  models,
  current,
  modelSaving,
  thinkingSaving,
  onCurrentModelChange,
  onThinkingLevelChange
}: {
  models: ModelPayload[];
  current: ModelPayload | null;
  modelSaving: boolean;
  thinkingSaving: boolean;
  onCurrentModelChange: (provider: string, model: string) => void;
  onThinkingLevelChange: (level: string) => void;
}) {
  const t = useUiText();
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});

  useEffect(() => {
    setSelectedModels((existing) => {
      const next: Record<string, string> = {};
      models.forEach((model) => {
        const optionModels = model.model_options.map((option) => option.model);
        const existingSelection = existing[model.provider];
        if (existingSelection && optionModels.includes(existingSelection) && current?.provider !== model.provider) {
          next[model.provider] = existingSelection;
          return;
        }
        next[model.provider] = optionModels.includes(model.model) ? model.model : optionModels[0] || model.model;
      });
      return next;
    });
  }, [models, current?.provider]);

  return (
    <div className="grid-list models-grid">
      {models.map((model) => {
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
        const showThinkingPanel = showThinkingControl || showThinkingReadout || showThinkingUnsupported;
        const switchDisabled = modelSaving || !model.selectable || !selectedOption || selectedIsCurrent;
        return (
          <article className={`item-card ${providerActive ? "item-active" : ""}`} key={model.provider}>
            <div className="item-heading">
              <div className="item-icon">
                <Brain size={18} />
              </div>
              <div className="model-heading-copy">
                <h3>{model.label}</h3>
                <div className="model-heading-model">{displayedModel.model}</div>
              </div>
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
                  <Settings2 size={14} />
                  <span>{selectedIsCurrent ? t.models.current : modelSaving ? t.models.switching : t.models.setCurrent}</span>
                </button>
              </div>
              {!model.selectable && model.disabled_reason ? (
                <div className="model-disabled-reason">{modelDisabledReasonLabel(t, model.disabled_reason)}</div>
              ) : null}
            </div>
            <dl className="compact-metrics">
              <div>
                <dt>{t.models.context}</dt>
                <dd>{formatNumber(displayedModel.capabilities.context_window_tokens)}</dd>
              </div>
              <div>
                <dt>{t.models.output}</dt>
                <dd>
                  {formatNumber(
                    displayedModel.capabilities.max_tokens ?? displayedModel.capabilities.max_output_tokens ?? 0
                  )}
                </dd>
              </div>
              <div>
                <dt>{t.models.vision}</dt>
                <dd>{displayedModel.capabilities.supports_vision ? t.common.yes : t.common.no}</dd>
              </div>
            </dl>
            {showThinkingPanel ? (
              <div className="model-thinking-panel">
                <div className="model-thinking-title">
                  <span>{t.models.thinking}</span>
                </div>
                {showThinkingControl ? (
                  <div className="thinking-level-control" role="group" aria-label={`${model.label} thinking level`}>
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
                ) : (
                  <div className="thinking-level-readout">{t.common.notSupported}</div>
                )}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
