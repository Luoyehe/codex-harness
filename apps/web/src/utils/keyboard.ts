interface CompositionKeyEvent {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

/** DOM and React key events; 229 covers IMEs that clear isComposing on commit. */
export function isComposingKey(event: CompositionKeyEvent): boolean {
  return event.isComposing === true || event.keyCode === 229
    || event.nativeEvent?.isComposing === true || event.nativeEvent?.keyCode === 229;
}
