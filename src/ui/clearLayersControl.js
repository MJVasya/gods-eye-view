/** Keep the clear action focusable while busy; the caller owns its transaction. */
export function bindClearLayersControl(button, clear) {
  let destroyed = false;
  const click = () => {
    if (destroyed) return;
    // The caller marks the button busy through setBusy while its transaction
    // runs; honor that ARIA state so a second press mid-clear cannot stack
    // another run on top of the first.
    if (button?.getAttribute?.('aria-disabled') === 'true') return;
    void clear();
  };
  button?.addEventListener('click', click);
  return {
    setBusy(busy) {
      if (destroyed || !button) return;
      button.setAttribute('aria-disabled', String(busy));
      button.setAttribute('aria-busy', String(busy));
      button.setAttribute(
        'aria-label',
        busy ? 'Clearing selected data layers' : 'Clear selected data layers',
      );
    },
    destroy() {
      destroyed = true;
      button?.removeEventListener('click', click);
    },
  };
}
