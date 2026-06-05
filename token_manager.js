// token_manager.js
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function consumeTokens(state, text) {
  const t = estimateTokens(text);
  state.tokenUsed += t;
  return t;
}

export function checkLimit(state) {
  if (state.tokenUsed >= state.tokenLimit) {
    state.blocked = true;
    return true;
  }
  return false;
}
