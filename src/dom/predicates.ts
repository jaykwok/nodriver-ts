/**
 * @internal Single-source-of-truth browser-side DOM predicates shared across `Element`, `Locator`,
 * `query()`, and MCP element inspection. Keep every function completely self-contained so it can
 * be safely serialized via `.toString()` into Chromium isolated worlds.
 */

export function isElementVisible(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true }))
    return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function isElementEnabled(el: HTMLElement): boolean {
  return !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
}

export function isInComposedTree(target: Node | null, ancestor: Node): boolean {
  for (let n: Node | null = target; n; n = n.parentNode ?? (n as ShadowRoot).host)
    if (n === ancestor) return true;
  return false;
}
