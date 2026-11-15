// Signals between parts of the project screen, e.g. from the assistant's chat to the screen
// showing what it changed. Plain reactive values, so a screen that isn't showing yet still sees
// the latest one when it appears.
import { ref } from 'vue';
import type { PickedElement } from './shared/types';

/**
 * The part of a report page the user selected in Build visuals; the chat attaches it to the
 * next message and clears this.
 */
export const pickedElement = ref<PickedElement | null>(null);

/** Goes up each time the assistant (or an undo) changes the project: screens reload. */
export const projectChanged = ref(0);

/** A report page the assistant asked to show; Build visuals shows it and clears this. */
export const pageToShow = ref<string | null>(null);

/**
 * A message to send the assistant for the user, e.g. from "Fix with assistant" on the Errors
 * page. The chat sends it (or, while it can't, puts it in the message box) and clears this.
 */
export const assistantRequest = ref<string | null>(null);
