import type { ToolExecutionErrorCode } from "@lxe/runtime";

export interface VerifiedFailureMapping {
  mappingId: string;
  operation: string;
  verifiedReason: string;
  errorCode: ToolExecutionErrorCode;
  replacement: string;
  retryability: "retryable" | "not_retryable";
  localCode?: string;
  providerCode?: number | string;
  providerSubcode?: number | string;
}

const VERIFIED_FAILURE_MAPPINGS: readonly VerifiedFailureMapping[] = Object.freeze([
  {
    mappingId: "local:feishu_message_not_returned:v1",
    operation: "feishu_im_bot_fetch_resource.validate",
    localCode: "message_not_returned_by_feishu",
    verifiedReason: "message_not_returned_by_feishu",
    errorCode: "not_found",
    replacement: "Feishu did not return the message needed to validate this resource.",
    retryability: "not_retryable",
  },
  {
    mappingId: "local:feishu_interactive_card_resource:v1",
    operation: "feishu_im_bot_fetch_resource.validate",
    localCode: "interactive_card_not_downloadable_resource",
    verifiedReason: "interactive_card_not_downloadable_resource",
    errorCode: "failed_precondition",
    replacement: "Interactive Card image and icon keys are not downloadable message resources.",
    retryability: "not_retryable",
  },
  {
    mappingId: "local:feishu_resource_not_declared:v1",
    operation: "feishu_im_bot_fetch_resource.validate",
    localCode: "resource_not_declared_by_message",
    verifiedReason: "resource_not_declared_by_message",
    errorCode: "failed_precondition",
    replacement: "The requested resource key and type are not declared by the Feishu message.",
    retryability: "not_retryable",
  },
]);

export function findVerifiedFeishuFailureMapping(input: {
  operation: string;
  localCode?: string;
  providerCode?: number | string;
  providerSubcode?: number | string;
}): VerifiedFailureMapping | undefined {
  return VERIFIED_FAILURE_MAPPINGS.find((mapping) =>
    mapping.operation === input.operation
    && mapping.localCode === input.localCode
    && mapping.providerCode === input.providerCode
    && mapping.providerSubcode === input.providerSubcode);
}
