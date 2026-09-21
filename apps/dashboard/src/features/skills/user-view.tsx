import { useEffect, useState } from "react";
import type { CliCommandPayload, SkillPayload, UserSkillPayload } from "@lxe/desktop-protocol";
import { queryError, useUserSkillsQuery, useUserSkillContentQuery, useUserSkillMutation } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import { SkillDetailDialog } from "../../shared/ui/skill-detail-dialog";
import type { DetailTarget } from "../../shared/ui/detail-target";
import { SkillsView } from "./view";

export type SkillConversationAction = "create" | "use";

function UserSkillPreview({ skill, close, onUse, onRecycled }: {
  skill: UserSkillPayload;
  close: () => void;
  onUse: () => void;
  onRecycled: (id: string, path: string) => void;
}) {
  const t = useUiText();
  const [path, setPath] = useState("SKILL.md");
  const manifestQuery = useUserSkillContentQuery(skill.id, "SKILL.md");
  const query = useUserSkillContentQuery(skill.id, path);
  const data = query.data;
  const mutation = useUserSkillMutation(onRecycled);
  return <SkillDetailDialog skill={skill} title={skill.name} close={close}
    files={(data?.files ?? manifestQuery.data?.files)?.map(file => file.path) ?? ["SKILL.md"]} selectedFile={path} onSelectFile={setPath}
    content={data?.content} binary={data?.binary} truncated={data?.truncated}
    loading={query.isPending} error={queryError(query.error)}
    notice={<>
      {!skill.available ? <p role="status">{!skill.enabled ? t.userSkills.disabled : t.userSkills.unavailable}</p> : null}
      {skill.unavailable_reason && skill.unavailable_reason !== "disabled" ? <p className="user-skill-error">{
        skill.unavailable_reason === "permission_or_connector" ? t.userSkills.permission : skill.unavailable_reason
      }</p> : null}
      {mutation.isError ? <p role="alert">{queryError(mutation.error)}</p> : null}
    </>}
    footer={<>
      <button className="skill-recycle-button" type="button" disabled={mutation.isPending}
        onClick={() => mutation.mutate(skill)}>{t.userSkills.delete}</button>
      <button type="button" disabled={!skill.available || mutation.isPending} onClick={onUse}>{t.userSkills.use}</button>
    </>} />;
}

export function SkillsCatalogView({ skills, commands, onOpen, onConversation }: {
  skills: SkillPayload[];
  commands: CliCommandPayload[];
  onOpen: (target: DetailTarget) => void;
  onConversation: (action: SkillConversationAction, skill?: SkillPayload) => void;
}) {
  const t = useUiText();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recycled, setRecycled] = useState("");
  const query = useUserSkillsQuery();
  const selected = query.data?.items.find(skill => skill.id === selectedId);
  useEffect(() => {
    if (query.data && !selected) setSelectedId(null);
  }, [query.data, selected]);
  return <>
    {query.isError ? <p role="alert">{queryError(query.error)}</p> : null}
    {recycled ? <p role="status">{t.userSkills.recycled} <span className="mono user-skill-location">{recycled}</span></p> : null}
    {query.isPending ? <p role="status">{t.skillModal.loadingContent}</p> : null}
    <SkillsView skills={skills} commands={commands} userSkills={query.data?.items ?? []} onOpen={onOpen}
      onOpenUser={skill => setSelectedId(skill.id)} />
    {selected ? <UserSkillPreview key={selected.id} skill={selected} close={() => setSelectedId(null)}
      onUse={() => { setSelectedId(null); onConversation("use", selected); }}
      onRecycled={(_id, path) => { setRecycled(path); setSelectedId(null); }} /> : null}
  </>;
}
