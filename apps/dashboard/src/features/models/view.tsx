import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Cloud, HardDrive, Sparkles } from "lucide-react";

import kimiMoonDust from "../../assets/providers/kimi/kimi-moon-dust.png";
import { formatCompactNumber, formatNumber } from "../../shared/format";
import { ProviderBrandMark, providerBrandKind } from "../../shared/ui/provider-brand-mark";
import {
  distinctProviderCount,
  modelsInDisplayOrder,
  modelThinkingLevelLabel,
  modelWithOption,
  reconcileShowcaseSelections,
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

function ModelArtwork({ provider }: { provider: string }) {
  const brandKind = providerBrandKind(provider);
  if (brandKind === "kimi") {
    return (
      <div className="model-kimi-dust" aria-hidden="true">
        <img alt="" draggable={false} src={kimiMoonDust} />
      </div>
    );
  }
  if (brandKind === "deepseek") {
    return (
      <>
        <div className="model-deepseek-waves" aria-hidden="true">
          <svg preserveAspectRatio="none" viewBox="0 0 600 120">
            <path className="wave-a" d="M0 70 C 90 50, 180 90, 300 72 S 480 52, 600 70 L600 120 L0 120 Z" />
            <path className="wave-b" d="M0 88 C 110 72, 220 104, 340 88 S 510 70, 600 88 L600 120 L0 120 Z" />
          </svg>
        </div>
        <div className="model-brand-watermark" aria-hidden="true">
          <ProviderBrandMark provider={provider} size={142} />
        </div>
      </>
    );
  }
  return (
    <div className="model-brand-watermark" aria-hidden="true">
      <ProviderBrandMark provider={provider} size={142} />
    </div>
  );
}

function CredentialSourceChip({ source }: { source: ModelPayload["credential_source"] }) {
  const t = useUiText();
  const cloud = source === "cloud";
  return (
    <span
      className="model-source-chip"
      data-source={source}
      title={cloud ? t.models.credentialCloudHint : t.models.credentialLocalHint}
    >
      {cloud ? <Cloud aria-hidden size={11} /> : <HardDrive aria-hidden size={11} />}
      {cloud ? t.models.credentialCloud : t.models.credentialLocal}
    </span>
  );
}

function ThinkingSpec({ model, current }: { model: ModelPayload; current: boolean }) {
  const t = useUiText();
  const levels = model.thinking_levels || [];
  const activeLevel = current ? model.thinking_state?.level : "";
  const managed = model.capabilities.supports_thinking
    && model.thinking_request_style === "provider-managed"
    && levels.length === 0;
  return (
    <div className="model-showcase-thinking">
      <div className="model-showcase-thinking-label">
        <Sparkles aria-hidden size={13} />
        <span>{t.models.thinking}</span>
      </div>
      {!model.capabilities.supports_thinking ? (
        <span className="model-showcase-readout">{t.common.notSupported}</span>
      ) : managed ? (
        <span className="model-showcase-readout">{t.models.providerManaged}</span>
      ) : levels.length ? (
        <div className="model-showcase-thinking-levels" aria-label={t.models.thinkingEffort}>
          {levels.map((level) => (
            <span
              aria-current={activeLevel === level ? "true" : undefined}
              className={activeLevel === level ? "active" : undefined}
              key={level}
            >
              {modelThinkingLevelLabel(model, level)}
            </span>
          ))}
        </div>
      ) : (
        <span className="model-showcase-readout">{t.common.yes}</span>
      )}
    </div>
  );
}

export function ModelsView({
  models,
  current,
}: {
  models: ModelPayload[];
  current: ModelPayload | null;
}) {
  const t = useUiText();
  const displayedModels = useMemo(() => modelsInDisplayOrder(models), [models]);
  const variantCount = models.reduce((count, model) => count + model.model_options.length, 0);
  const [showcaseSelections, setShowcaseSelections] = useState<Record<string, string>>(() => (
    reconcileShowcaseSelections(models, current)
  ));

  useEffect(() => {
    setShowcaseSelections((existing) => reconcileShowcaseSelections(models, current, existing));
  }, [current, models]);

  return (
    <div className="models-page models-showcase-page">
      <section className="models-showcase-hero">
        <div className="models-showcase-intro">
          <span>{t.models.galleryEyebrow}</span>
          <h2>{t.models.galleryTitle}</h2>
          <p>{t.models.galleryDescription}</p>
        </div>
        <dl className="models-showcase-counts">
          <div>
            <dt>{t.models.providers}</dt>
            <dd>{formatNumber(distinctProviderCount(models))}</dd>
          </div>
          <div>
            <dt>{t.models.variants}</dt>
            <dd>{formatNumber(variantCount)}</dd>
          </div>
        </dl>
      </section>

      <div className="grid-list models-grid models-showcase-grid">
        {displayedModels.map((model, index) => {
          const sourceKey = `${model.provider}:${model.credential_source}`;
          const providerActive = current?.provider === model.provider
            && current.credential_source === model.credential_source;
          const displayedOption = model.model_options.find(
            (option) => option.model === showcaseSelections[sourceKey],
          ) ?? model.model_options[0];
          const isCurrent = providerActive && current?.model === displayedOption?.model;
          const displayedModel = displayedOption
            ? modelWithOption(model, displayedOption, isCurrent ? current?.thinking_state : undefined)
            : null;
          const selectId = `model-showcase-select-${index}`;
          return (
            <article
              aria-current={providerActive ? "true" : undefined}
              className={`item-card model-card model-showcase-card ${providerActive ? "item-active" : ""}`}
              data-provider={model.provider}
              key={sourceKey}
            >
              <ModelArtwork provider={model.provider} />
              <div className="model-card-header">
                <div className="item-heading">
                  <div className="item-icon">
                    <ProviderBrandMark provider={model.provider} size={23} />
                  </div>
                  <div className="model-heading-copy">
                    <h3>{model.label}</h3>
                    <span>{model.api_style}</span>
                  </div>
                </div>
                {providerActive ? (
                  <span className="model-current-badge">
                    <Check aria-hidden size={13} />
                    {t.models.inUse}
                  </span>
                ) : null}
              </div>

              <div className="model-showcase-provider-state">
                <CredentialSourceChip source={model.credential_source} />
                <span className={model.configured ? "configured" : "unconfigured"}>
                  {model.configured ? t.models.configured : t.models.unconfigured}
                </span>
              </div>

              <div className="model-showcase-variants">
                {displayedModel && displayedOption ? (
                  <section
                    aria-current={isCurrent ? "true" : undefined}
                    className={`model-showcase-variant ${isCurrent ? "current" : ""}`}
                  >
                    <header className="model-showcase-variant-header">
                      <label htmlFor={selectId}>{t.models.displayVariant}</label>
                      <div className="model-showcase-select-wrap">
                        <select
                          aria-label={`${model.label} ${t.models.displayVariant}`}
                          className="model-showcase-select"
                          disabled={model.model_options.length < 2}
                          id={selectId}
                          onChange={(event) => {
                            const selectedModel = event.currentTarget.value;
                            setShowcaseSelections((existing) => ({
                              ...existing,
                              [sourceKey]: selectedModel,
                            }));
                          }}
                          value={displayedOption.model}
                        >
                          {model.model_options.map((option) => (
                            <option key={option.model} value={option.model}>
                              {option.model}
                              {providerActive && current?.model === option.model
                                ? ` · ${t.models.current}`
                                : ""}
                            </option>
                          ))}
                        </select>
                        <ChevronDown aria-hidden size={15} />
                      </div>
                      {isCurrent ? (
                        <span><Check aria-hidden size={12} />{t.models.current}</span>
                      ) : null}
                    </header>
                    <dl className="model-showcase-metrics">
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
                    <ThinkingSpec current={isCurrent} model={displayedModel} />
                  </section>
                ) : (
                  <div className="model-showcase-empty">{t.models.modelOptionUnavailable}</div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
