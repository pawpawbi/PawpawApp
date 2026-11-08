// Loaded with `node --import` by `npm run test:node`. The app's code imports its own modules
// without an extension (Vite resolves them); Node's TypeScript support needs ".ts", so this
// resolver adds it for relative imports.
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
