import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";
import { callDashboard } from "./client";
import { dashboardQueryKeys } from "./query-keys";
import { queryError } from "./queries";
import type { ApiList, ModelPayload } from "./payloads";
import { modelDisabledReasonLabel, modelWithOption, modelWithThinkingLevel, resolveModelSelection } from "../features/models/model";
import { useUiText } from "../shared/i18n";

function modelsWithCurrentModel(current: ApiList<ModelPayload> | undefined, model: ModelPayload): ApiList<ModelPayload> | undefined {
  if (!current) return current;
  return { ...current, items: current.items.map(item => item.provider === model.provider
    && item.credential_source === model.credential_source ? { ...item, ...model } : item) };
}

const currentKey = (sessionId?: string) => sessionId
  ? dashboardQueryKeys.models.session(sessionId) : dashboardQueryKeys.models.current;
type ModelChange = {
  session_id?: string; selection_version?: number; optimistic: ModelPayload;
} & ({ kind: "model"; provider: string; model: string; credential_source: "local" | "cloud" }
  | { kind: "thinking"; level: string });

export function useModelActions({ current, models, sessionId, onError }: {
  current: ModelPayload | undefined;
  models: ModelPayload[];
  sessionId?: string;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const t = useUiText();
  const selectedSession = useRef(sessionId);
  useLayoutEffect(() => { selectedSession.current = sessionId; }, [sessionId]);
  const mutationKey = ["model-selection", sessionId ?? "default"];
  const modelSaving = useIsMutating({ mutationKey, predicate: mutation => (mutation.state.variables as ModelChange)?.kind === "model" }) > 0;
  const thinkingSaving = useIsMutating({ mutationKey, predicate: mutation => (mutation.state.variables as ModelChange)?.kind === "thinking" }) > 0;
  const mutation = useMutation<ModelPayload, unknown, ModelChange, { current?: ModelPayload; models?: ApiList<ModelPayload> }>({
    mutationKey,
    mutationFn: change => {
      const scope = change.session_id ? { session_id: change.session_id, selection_version: change.selection_version } : {};
      return change.kind === "thinking"
        ? callDashboard({ operation: "models.thinking.update", input: { ...scope, level: change.level } })
        : callDashboard({ operation: "models.update", input: { ...scope, provider: change.provider, model: change.model, credential_source: change.credential_source } });
    },
    onMutate: async change => {
      onError("");
      const key = currentKey(change.session_id);
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const before = queryClient.getQueryData<ModelPayload>(key);
      const list = queryClient.getQueryData<ApiList<ModelPayload>>(dashboardQueryKeys.models.list);
      queryClient.setQueryData(key, change.optimistic);
      if (!change.session_id) queryClient.setQueryData(dashboardQueryKeys.models.list, modelsWithCurrentModel(list, change.optimistic));
      return { current: before, models: list };
    },
    onSuccess: (accepted, change) => {
      queryClient.setQueryData<ModelPayload>(currentKey(change.session_id), previous =>
        (previous?.selection_version ?? 0) > (accepted.selection_version ?? 0) ? previous : accepted);
      if (!change.session_id) queryClient.setQueryData<ApiList<ModelPayload> | undefined>(
        dashboardQueryKeys.models.list, list => modelsWithCurrentModel(list, accepted));
    },
    onError: (cause, change, before) => {
      queryClient.setQueryData<ModelPayload>(currentKey(change.session_id), previous =>
        (previous?.selection_version ?? 0) > (change.selection_version ?? 0) ? previous : before?.current);
      if (!change.session_id) queryClient.setQueryData(dashboardQueryKeys.models.list, before?.models);
      if (selectedSession.current === change.session_id) onError(modelDisabledReasonLabel(t, queryError(cause)));
    },
    onSettled: async (_result, _error, change) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: currentKey(change.session_id), exact: true }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.models.current, exact: true }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.models.list, exact: true }),
      ]);
    },
  });

  const scope = sessionId ? { session_id: sessionId, selection_version: current?.selection_version } : {};
  function setCurrentThinkingLevel(level: string) {
    if (!current || modelSaving || thinkingSaving || !current.thinking_state.editable) return;
    mutation.mutate({ ...scope, kind: "thinking", level, optimistic: modelWithThinkingLevel(current, level) });
  }
  function setCurrentModel(provider: string, model: string, credential_source: "local" | "cloud") {
    if (modelSaving || thinkingSaving) return;
    const selection = resolveModelSelection(models, provider, model, credential_source);
    if (!selection) { onError(t.models.modelOptionUnavailable); return; }
    const { providerModel, selectedOption } = selection;
    if (!providerModel.selectable) {
      onError(providerModel.disabled_reason ? modelDisabledReasonLabel(t, providerModel.disabled_reason) : t.models.providerNotSelectable);
      return;
    }
    const sameModel = current?.provider === provider && current.model === model && current.credential_source === credential_source;
    const optimistic = { ...modelWithOption(providerModel, selectedOption, !sessionId || sameModel ? current?.thinking_state : undefined), ...scope };
    mutation.mutate({ ...scope, kind: "model", provider, model, credential_source, optimistic });
  }
  return { setCurrentModel, setCurrentThinkingLevel, modelSaving, thinkingSaving } as const;
}
