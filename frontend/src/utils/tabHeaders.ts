import { WorkspaceTab } from '../types/notebook';

export interface TabHeaderInfo {
  id: string;
  instanceId: string;
  name: string;
  kind: WorkspaceTab['kind'];
  dirty: boolean;
}

// The tab strip depends on labels/dirty flags, never cell contents or outputs.
export function createTabHeaderSelector() {
  let previous: TabHeaderInfo[] = [];
  return (state: { tabs: WorkspaceTab[] }) => {
    const same = state.tabs.length === previous.length && state.tabs.every((tab, i) => {
      const header = previous[i];
      const instId = tab.instanceId || tab.id;
      return header.id === tab.id && header.instanceId === instId && header.name === tab.name
        && header.kind === tab.kind && header.dirty === (tab.kind !== 'launcher' && tab.dirty);
    });
    if (!same) previous = state.tabs.map(tab => ({
      id: tab.id,
      instanceId: tab.instanceId || tab.id,
      name: tab.name,
      kind: tab.kind,
      dirty: tab.kind !== 'launcher' && tab.dirty,
    }));
    return previous;
  };
}
