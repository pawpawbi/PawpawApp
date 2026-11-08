// The guided report-building workflow the assistant walks the user through. Also used by the
// main process (the assistant's context and its welcome message), so no browser-only code here.
import type { WorkflowStage } from './shared/types';

export const STAGES: { id: WorkflowStage; label: string }[] = [
  { id: 'data', label: 'Add data' },
  { id: 'model', label: 'Model data' },
  { id: 'visuals', label: 'Build visuals' },
];

export const INTRO_MESSAGE = `Hi! Let's build your report together. We'll work through three steps:

1. Add data: connect a file, spreadsheet or database.
2. Model the data: I'll check how your tables fit together and ask you to clarify anything ambiguous, like how two tables join or how dates should be grouped.
3. Build visuals: tell me what you want to see, and we'll build the report's pages and charts.

To start, where does your data live? For example, "a CSV export of monthly sales" or "our Postgres orders database".`;
