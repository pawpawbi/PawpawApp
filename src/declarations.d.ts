/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css';

declare module '*?raw' {
  const text: string;
  export default text;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface Window {
  api: {
    getAppVersion: () => Promise<string>;
    projects: import('./shared/types').ProjectsApi;
    data: import('./shared/types').DataApi;
    python: import('./shared/types').PythonApi;
    report: import('./shared/types').ReportApi;
    assistant: import('./shared/types').AssistantApi;
    account: import('./shared/types').AccountApi;
    publish: import('./shared/types').PublishApi;
  };
}
