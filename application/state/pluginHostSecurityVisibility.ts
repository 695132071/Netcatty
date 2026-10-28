/** Native plugin views must yield while a host-owned security dialog is open. */
export function observePluginHostSecurityVisibility(mount: HTMLElement, publish: (visible: boolean) => void): () => void {
  const document = mount.ownerDocument;
  let visible = true;
  const update = () => {
    const blocked = [...document.querySelectorAll('[data-host-security-surface]')].some((surface) => {
      const style = document.defaultView!.getComputedStyle(surface);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && !surface.closest('[hidden], [inert], [aria-hidden="true"]');
    });
    if (visible === !blocked) return;
    visible = !blocked;
    publish(visible);
  };
  const observer = new document.defaultView!.MutationObserver(update);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-host-security-surface'] });
  update();
  // The view lifecycle owns close/retention. Cleanup must never reveal an old view.
  return () => observer.disconnect();
}
