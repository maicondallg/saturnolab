import { WorkspaceTab } from '../types/notebook';

// The tab strip depends on labels/dirty flags, never cell contents or outputs.
export function createTabHeaderSelector() {
  let previous: { id: string; name: string; kind: WorkspaceTab['kind']; dirty: boolean }[] = [];
  return (state: { tabs: WorkspaceTab[] }) => {
    const same = state.tabs.length === previous.length && state.tabs.every((tab, i) => {
      const header = previous[i];
      return header.id === tab.id && header.name === tab.name && header.kind === tab.kind
        && header.dirty === (tab.kind !== 'launcher' && tab.dirty);
    });
    if (!same) previous = state.tabs.map(tab => ({
      id: tab.id, name: tab.name, kind: tab.kind, dirty: tab.kind !== 'launcher' && tab.dirty,
    }));
    return previous;
  };
}
