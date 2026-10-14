// Missing SDK events still need reconciliation, but never wake a hidden document to poll.
// Event subscriptions remain connected; revealing the window refreshes immediately.
export function visibleInterval(refresh: () => void, milliseconds: number) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const resume = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (document.hidden) return;
    timer = setInterval(refresh, milliseconds);
    refresh();
  };
  if (!document.hidden) timer = setInterval(refresh, milliseconds);
  document.addEventListener("visibilitychange", resume);
  return () => {
    if (timer !== undefined) clearInterval(timer);
    document.removeEventListener("visibilitychange", resume);
  };
}
