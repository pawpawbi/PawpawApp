// How the project's errors (shown behind the warning icon in the top bar, and on the Errors
// page) are worded, which step each belongs to, and what "Fix with assistant" asks.
// No browser or Node APIs, so it's tested with plain Node.
import type { ProjectError, WorkflowStage } from './types';

/** The longest error message put into a request to the assistant. */
const MAX_MESSAGE = 2000;

const KINDS: Record<
  ProjectError['kind'],
  { label: string; stage: WorkflowStage; summary: (name: string) => string }
> = {
  source: {
    label: 'Data source',
    stage: 'data',
    summary: (name) => `Couldn't load the data source "${name}"`,
  },
  transform: {
    label: 'Transform',
    stage: 'model',
    summary: (name) =>
      `The transform of ${name} failed, so it shows its original data`,
  },
  transformed: {
    label: 'Transformed table',
    stage: 'model',
    summary: (name) => `Couldn't build the table ${name}`,
  },
  dataset: {
    label: 'Dataset',
    stage: 'visuals',
    summary: (name) => `Couldn't update the dataset ${name}`,
  },
};

/** What kind of thing failed, e.g. "Data source". */
export const errorLabel = (error: ProjectError) => KINDS[error.kind].label;

/** One line saying what failed, e.g. `Couldn't build the table sales_by_region`. */
export const errorSummary = (error: ProjectError) =>
  KINDS[error.kind].summary(error.name);

/** The workflow step to show while the assistant fixes it. */
export const errorStage = (error: ProjectError) => KINDS[error.kind].stage;

/** The message "Fix with assistant" sends, as if the user had typed it. */
export function fixRequest(error: ProjectError): string {
  const message =
    error.message.length > MAX_MESSAGE
      ? `${error.message.slice(0, MAX_MESSAGE).trimEnd()}…`
      : error.message;
  return `${errorSummary(error)}. The error was:\n\n${message}\n\nPlease find out why and fix it.`;
}
