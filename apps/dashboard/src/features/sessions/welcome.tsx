import { BarChart3, FileText, ListChecks, Truck } from "lucide-react";
import { useUiText } from "../../shared/i18n";

const icons = [BarChart3, Truck, FileText, ListChecks];

export function ConversationWelcome({ onPrompt, disabled }: {
  onPrompt: (prompt: string) => void;
  disabled: boolean;
}) {
  const { taskStart: t } = useUiText();
  return <section className="task-welcome">
    <header className="task-welcome-heading">
      <h1>{t.title}</h1>
      <p>{t.subtitle}</p>
    </header>
    <div className="task-templates" role="group" aria-label={t.templates}>
      {t.prompts.map((item, index) => {
        const Icon = icons[index];
        return <button key={item.label} type="button" disabled={disabled} onClick={() => onPrompt(item.prompt)}>
          <Icon aria-hidden size={16} /><span>{item.label}</span>
        </button>;
      })}
    </div>
  </section>;
}
