export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const compactionSummaryProviderText = (summary: string): string =>
  `${COMPACTION_SUMMARY_PREFIX}${summary.trim()}${COMPACTION_SUMMARY_SUFFIX}`;
