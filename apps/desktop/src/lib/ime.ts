/**
 * True while an IME (e.g. Chinese/Japanese input) is composing. The Enter
 * that confirms a candidate must not send or select. `keyCode` 229 covers
 * WebKit/WebView2, which can report the confirming keydown with
 * `isComposing` already false.
 */
export function isImeComposing(event: {
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
