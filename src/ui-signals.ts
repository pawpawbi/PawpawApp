// Signals between parts of the project screen, e.g. from the assistant's chat to the screen
// showing what it changed. Plain reactive values, so a screen that isn't showing yet still sees
// the latest one when it appears.
import { ref } from 'vue';

/** Goes up each time the assistant (or an undo) changes the project: screens reload. */
export const projectChanged = ref(0);

/** A report page the assistant asked to show; Build visuals shows it and clears this. */
export const pageToShow = ref<string | null>(null);
