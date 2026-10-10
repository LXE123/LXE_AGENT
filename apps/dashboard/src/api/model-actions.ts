import { useMutation, useQueryClient } from "@tanstack/react-query";
import { callDashboard } from "./client";
import { dashboardQueryKeys } from "./query-keys";
import { queryError } from "./queries";
import type { ApiList, ModelPayload } from "./payloads";
import { modelDisabledReasonLabel, modelWithOption, modelWithThinkingLevel, resolveModelSelection } from "../features/models/model";
import { useUiText } from "../shared/i18n";

function modelsWithCurrentModel(
  current: ApiList<ModelPayload> | undefined,
  model: ModelPayload,
): ApiList<ModelPayload> | undefined {
  if (!current) return current;
  return {
    ...current,
    items: current.items.map((item) =>
      item.provider === model.provider && item.credential_source === model.credential_source
        ? { ...item, ...model }
        : item
    ),
  };
}

export function useModelActions({ current, models, onError }: {
  current: ModelPayload | undefined;
  models: ModelPayload[];
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const t = useUiText();
  const thinkingMutation = useMutation<
    ModelPayload,
    unknown,
    string,
    { current?: ModelPayload; models?: ApiList<ModelPayload> }
  >({
    mutationFn: (level) => callDashboard({ operation: "models.thinking.update", input: { level } }),
    onMutate: async (level) => {
      onError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.models.all });
      const current = queryClient.getQueryData<ModelPayload>(dashboardQueryKeys.models.current);
      const models = queryClient.getQueryData<ApiList<ModelPayload>>(dashboardQueryKeys.models.list);
      if (current) {
        const optimistic = modelWithThinkingLevel(current, level);
        queryClient.setQueryData(dashboardQueryKeys.models.current, optimistic);
        queryClient.setQueryData(dashboardQueryKeys.models.list, modelsWithCurrentModel(models, optimistic));
      }
      return { current, models };
    },
    onSuccess: (current) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, current);
      queryClient.setQueryData<ApiList<ModelPayload> | undefined>(
        dashboardQueryKeys.models.list,
        (models) => modelsWithCurrentModel(models, current),
      );
    },
    onError: (cause, _level, context) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, context?.current);
      queryClient.setQueryData(dashboardQueryKeys.models.list, context?.models);
      onError(queryError(cause));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.models.all });
    },
  });

  const modelMutation = useMutation<
    ModelPayload,
    unknown,
    {
      provider: string;
      model: string;
      credentialSource: "local" | "cloud";
      optimistic: ModelPayload;
    },
    { current?: ModelPayload; models?: ApiList<ModelPayload> }
  >({
    mutationFn: ({ provider, model, credentialSource }) => callDashboard({
      operation: "models.update",
      input: { provider, model, credential_source: credentialSource },
    }),
    onMutate: async ({ optimistic }) => {
      onError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.models.all });
      const current = queryClient.getQueryData<ModelPayload>(dashboardQueryKeys.models.current);
      const models = queryClient.getQueryData<ApiList<ModelPayload>>(dashboardQueryKeys.models.list);
      queryClient.setQueryData(dashboardQueryKeys.models.current, optimistic);
      queryClient.setQueryData(dashboardQueryKeys.models.list, modelsWithCurrentModel(models, optimistic));
      return { current, models };
    },
    onSuccess: (current) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, current);
      queryClient.setQueryData<ApiList<ModelPayload> | undefined>(
        dashboardQueryKeys.models.list,
        (models) => modelsWithCurrentModel(models, current),
      );
    },
    onError: (cause, _variables, context) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, context?.current);
      queryClient.setQueryData(dashboardQueryKeys.models.list, context?.models);
      onError(modelDisabledReasonLabel(t, queryError(cause)));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.models.all });
    },
  });

  function setCurrentThinkingLevel(level: string) {
    if (!current || thinkingMutation.isPending || !current.thinking_state?.editable) return;
    thinkingMutation.mutate(level);
  }

  function setCurrentModel(
    provider: string,
    modelName: string,
    credentialSource: "local" | "cloud",
  ) {
    if (modelMutation.isPending) return;
    const selection = resolveModelSelection(
      models, provider, modelName, credentialSource,
    );
    if (!selection) {
      onError(t.models.modelOptionUnavailable);
      return;
    }
    const { providerModel, selectedOption } = selection;
    if (!providerModel.selectable) {
      onError(
        providerModel.disabled_reason ? modelDisabledReasonLabel(t, providerModel.disabled_reason) : t.models.providerNotSelectable
      );
      return;
    }

    const optimistic = modelWithOption(
      providerModel,
      selectedOption,
      current?.thinking_state,
    );
    modelMutation.mutate({ provider, model: modelName, credentialSource, optimistic });
  }

  return { setCurrentModel, setCurrentThinkingLevel,
    modelSaving: modelMutation.isPending, thinkingSaving: thinkingMutation.isPending } as const;
}
