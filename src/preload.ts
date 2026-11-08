// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AccountApi,
  AssistantApi,
  AssistantEvent,
  DataApi,
  DataProgress,
  Project,
  ProjectsApi,
  PublishApi,
  PublishProgress,
  PythonApi,
  ReportApi,
} from './shared/types';

const projects: ProjectsApi = {
  listRecent: () => ipcRenderer.invoke('projects:list-recent'),
  create: () => ipcRenderer.invoke('projects:create'),
  open: () => ipcRenderer.invoke('projects:open'),
  openRecent: (path) => ipcRenderer.invoke('projects:open-recent', path),
  save: () => ipcRenderer.invoke('projects:save'),
  close: () => ipcRenderer.invoke('projects:close'),
  rename: (name) => ipcRenderer.invoke('projects:rename', name),
  delete: () => ipcRenderer.invoke('projects:delete'),
  loadChat: () => ipcRenderer.invoke('projects:load-chat'),
  appendChat: (messages, stage) =>
    ipcRenderer.invoke('projects:append-chat', messages, stage),
  setStage: (stage) => ipcRenderer.invoke('projects:set-stage', stage),
  onChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, project: Project) =>
      callback(project);
    ipcRenderer.on('project:changed', listener);
    return () => ipcRenderer.removeListener('project:changed', listener);
  },
};

const data: DataApi = {
  catalog: () => ipcRenderer.invoke('data:catalog'),
  listSources: () => ipcRenderer.invoke('data:list-sources'),
  saveSource: (input) => ipcRenderer.invoke('data:save-source', input),
  removeSource: (id) => ipcRenderer.invoke('data:remove-source', id),
  discover: (id) => ipcRenderer.invoke('data:discover', id),
  load: (id, resources) => ipcRenderer.invoke('data:load', id, resources),
  stop: (id) => ipcRenderer.invoke('data:stop', id),
  listTables: () => ipcRenderer.invoke('data:list-tables'),
  describeTables: () => ipcRenderer.invoke('data:describe-tables'),
  loadDiagram: () => ipcRenderer.invoke('data:load-diagram'),
  saveDiagram: (diagram) => ipcRenderer.invoke('data:save-diagram', diagram),
  getTransform: (table) => ipcRenderer.invoke('data:get-transform', table),
  previewTransform: (sql, kind) =>
    ipcRenderer.invoke('data:preview-transform', sql, kind),
  listTransformed: () => ipcRenderer.invoke('data:list-transformed'),
  saveTransformed: (input) =>
    ipcRenderer.invoke('data:save-transformed', input),
  refreshAll: () => ipcRenderer.invoke('data:refresh-all'),
  applyTransform: (table, sql) =>
    ipcRenderer.invoke('data:apply-transform', table, sql),
  removeTransform: (table) =>
    ipcRenderer.invoke('data:remove-transform', table),
  deleteTable: (table) => ipcRenderer.invoke('data:delete-table', table),
  previewTable: (table, limit) =>
    ipcRenderer.invoke('data:preview-table', table, limit),
  pickPaths: (kind, filters) =>
    ipcRenderer.invoke('data:pick-paths', kind, filters),
  onProgress: (callback) => {
    const listener = (_event: IpcRendererEvent, progress: DataProgress) =>
      callback(progress);
    ipcRenderer.on('data:progress', listener);
    return () => ipcRenderer.removeListener('data:progress', listener);
  },
};

const python: PythonApi = {
  info: () => ipcRenderer.invoke('python:info'),
};

const report: ReportApi = {
  get: () => ipcRenderer.invoke('report:get'),
  createSite: () => ipcRenderer.invoke('report:create-site'),
  createPage: (title) => ipcRenderer.invoke('report:create-page', title),
  rename: (title) => ipcRenderer.invoke('report:rename', title),
  renamePage: (id, title) =>
    ipcRenderer.invoke('report:rename-page', id, title),
  deletePage: (id) => ipcRenderer.invoke('report:delete-page', id),
  readFile: (path) => ipcRenderer.invoke('report:read-file', path),
  writeFile: (path, content) =>
    ipcRenderer.invoke('report:write-file', path, content),
  listDatasets: () => ipcRenderer.invoke('report:list-datasets'),
  saveDataset: (name, sql) =>
    ipcRenderer.invoke('report:save-dataset', name, sql),
  deleteDataset: (name) => ipcRenderer.invoke('report:delete-dataset', name),
  refreshDatasets: () => ipcRenderer.invoke('report:refresh-datasets'),
  exportSite: () => ipcRenderer.invoke('report:export'),
  exportFile: () => ipcRenderer.invoke('report:export-file'),
  onNavigated: (callback) => {
    const listener = (_event: IpcRendererEvent, pageId: string) =>
      callback(pageId);
    ipcRenderer.on('report:navigated', listener);
    return () => ipcRenderer.removeListener('report:navigated', listener);
  },
};

const assistant: AssistantApi = {
  getSettings: () => ipcRenderer.invoke('assistant:get-settings'),
  saveSettings: (provider, model) =>
    ipcRenderer.invoke('assistant:save-settings', provider, model),
  setKey: (provider, key) =>
    ipcRenderer.invoke('assistant:set-key', provider, key),
  removeKey: (provider) => ipcRenderer.invoke('assistant:remove-key', provider),
  listModels: (provider) =>
    ipcRenderer.invoke('assistant:list-models', provider),
  send: (text) => ipcRenderer.invoke('assistant:send', text),
  retry: () => ipcRenderer.invoke('assistant:retry'),
  answer: (id, answer) => ipcRenderer.invoke('assistant:answer', id, answer),
  setPermissions: (permissions) =>
    ipcRenderer.invoke('assistant:set-permissions', permissions),
  listChanges: () => ipcRenderer.invoke('assistant:list-changes'),
  undo: (id, force) => ipcRenderer.invoke('assistant:undo', id, force),
  stop: () => ipcRenderer.invoke('assistant:stop'),
  onEvent: (callback) => {
    const listener = (_event: IpcRendererEvent, event: AssistantEvent) =>
      callback(event);
    ipcRenderer.on('assistant:event', listener);
    return () => ipcRenderer.removeListener('assistant:event', listener);
  },
};

const account: AccountApi = {
  get: () => ipcRenderer.invoke('account:get'),
  signUp: (email, password) =>
    ipcRenderer.invoke('account:sign-up', email, password),
  signIn: (email, password) =>
    ipcRenderer.invoke('account:sign-in', email, password),
  signOut: () => ipcRenderer.invoke('account:sign-out'),
  openReport: (reportId, url) =>
    ipcRenderer.invoke('account:open-report', reportId, url),
};

const publish: PublishApi = {
  get: () => ipcRenderer.invoke('publish:get'),
  toPawpawBI: (options) => ipcRenderer.invoke('publish:to-pawpawbi', options),
  targets: () => ipcRenderer.invoke('publish:targets'),
  list: () => ipcRenderer.invoke('publish:list'),
  forget: (projectPath) => ipcRenderer.invoke('publish:forget', projectPath),
  refresh: (projectPath) => ipcRenderer.invoke('publish:refresh', projectPath),
  addFiles: () => ipcRenderer.invoke('publish:add-files'),
  onProgress: (callback) => {
    const listener = (_event: IpcRendererEvent, progress: PublishProgress) =>
      callback(progress);
    ipcRenderer.on('publish:progress', listener);
    return () => ipcRenderer.removeListener('publish:progress', listener);
  },
};

// Expose a small, explicit API to the renderer (available as window.api).
contextBridge.exposeInMainWorld('api', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  projects,
  data,
  python,
  report,
  assistant,
  account,
  publish,
});
