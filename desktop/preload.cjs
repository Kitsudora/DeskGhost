'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set([
  'bootstrap', 'createWorkspace', 'openWorkspace', 'recoverWorkspace', 'closeWorkspace', 'activateWorkspace',
  'saveWorkspace', 'saveAs', 'exportWorkspace', 'chooseDataFolder', 'updateSettings',
  'createTask', 'updateTask', 'setState', 'moveTask', 'transferTask', 'insertColumn', 'renameColumn', 'renameWorkspace',
  'addCategory', 'addLink', 'connectTask', 'removeLink', 'rewireLink', 'deleteTask', 'restoreTask', 'archiveTask',
  'unarchiveTask', 'undo', 'redo', 'hide', 'summon', 'setRegions', 'quit'
]);

contextBridge.exposeInMainWorld('deskghost', Object.freeze({
  invoke(method, payload = {}) {
    if (!allowed.has(method)) return Promise.reject(new Error('Unsupported desktop operation.'));
    return ipcRenderer.invoke('deskghost:invoke', method, payload);
  },
  onEvent(callback) {
    if (typeof callback !== 'function') throw new TypeError('An event callback is required.');
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('deskghost:event', handler);
    return () => ipcRenderer.removeListener('deskghost:event', handler);
  },
  setInteractive(interactive) { ipcRenderer.send('deskghost:interactive', interactive === true); },
  setRegions(regions, dragging = false) { ipcRenderer.send('deskghost:regions', { regions, dragging: dragging === true }); }
}));
