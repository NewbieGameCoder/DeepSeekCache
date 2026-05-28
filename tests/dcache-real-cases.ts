export const REAL_CACHE_COMPARISON_CASES = [
  {
    id: "approval-risk",
    prompt:
      "REAL-CACHE-APPROVAL-RISK: In under 30 words, summarize APAC invoice approval risk controls for a regional rollout. Mention maker-checker, SOX evidence, and ERP queues. Do not use tools.",
  },
  {
    id: "audit-evidence",
    prompt:
      "REAL-CACHE-AUDIT-EVIDENCE: In under 30 words, summarize APAC invoice approval audit evidence and exception reporting. Mention retention, owners, ERP queues, and monthly close. Do not use tools.",
  },
  {
    id: "compact-continuation",
    prompt:
      "REAL-CACHE-COMPACT-CONTINUATION: In under 30 words, compact-style continuation: APAC approvals, SOX evidence, exception reporting, owner governance, and monthly close. Do not use tools.",
  },
] as const;
