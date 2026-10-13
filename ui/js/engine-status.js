export function engineStatusView(state) {
  if (state && state.error) return { kind: "error", text: state.error };
  return { kind: "loading", text: "loading…" };
}