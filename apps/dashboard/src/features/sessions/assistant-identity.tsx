import { assistantMood } from "./assistant-identity-model";
import { RedPandaAvatar } from "../../shared/ui/red-panda-avatar";
import { useUiText } from "../../shared/i18n";
import "./assistant-identity.css";

export function AssistantIdentity({ status }: { status?: string }) {
  const t = useUiText();
  return <div className="assistant-identity" data-assistant-state={status}>
    <RedPandaAvatar mood={assistantMood(status)} /><span>{t.app.title}</span>
  </div>;
}
