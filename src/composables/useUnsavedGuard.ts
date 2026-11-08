import type { Ref } from 'vue';

/**
 * Asks before leaving something with unsaved edits. `confirmLeave()` is true when there's
 * nothing to lose or the user chose to discard it.
 */
export function useUnsavedGuard(dirty: Ref<boolean>, message: string) {
  const confirmLeave = () => !dirty.value || window.confirm(message);
  return { confirmLeave };
}
