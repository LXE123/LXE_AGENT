import type { Language } from "../i18n";
import { useUiText } from "../i18n";

export function LanguageSwitch({
  language,
  onLanguageChange
}: {
  language: Language;
  onLanguageChange: (language: Language) => void;
}) {
  const t = useUiText();
  return (
    <div className="language-switch" role="group" aria-label={t.language.label}>
      {(["zh", "en"] as const).map((option) => (
        <button
          aria-pressed={language === option}
          className={language === option ? "language-option active" : "language-option"}
          key={option}
          onClick={() => onLanguageChange(option)}
          type="button"
        >
          {option === "zh" ? t.language.zh : t.language.en}
        </button>
      ))}
    </div>
  );
}
