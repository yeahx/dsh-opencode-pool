// llm-pi-ai forwards pi-ai's disjoint input/cacheRead/cacheWrite counters.
// inputTokens is uncached input, not total prompt tokens.
export function cacheHitRate(state) {
  const values = [state.inputTokens ?? 0, state.cacheReadTokens ?? 0, state.cacheWriteTokens ?? 0]
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return undefined
  const total = values.reduce((sum, value) => sum + value, 0)
  return total > 0 && Number.isFinite(total) ? values[1] / total : undefined
}
