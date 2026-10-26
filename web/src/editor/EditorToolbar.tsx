interface EditorToolbarProps {
  canDelete: boolean;
  canRun: boolean;
  onNew: () => void;
  onLoadExample: () => void;
  onAddService: () => void;
  onDeleteService: () => void;
}

export function EditorToolbar({
  canDelete,
  canRun,
  onNew,
  onLoadExample,
  onAddService,
  onDeleteService,
}: EditorToolbarProps) {
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Chain editor">
      <button type="button" onClick={onNew}>
        New three-service chain
      </button>
      <button type="button" onClick={onLoadExample}>
        Load retry storm example
      </button>
      <button type="button" onClick={onAddService}>
        Add service
      </button>
      <button type="button" onClick={onDeleteService} disabled={!canDelete}>
        Delete selected service
      </button>
      <button type="button" disabled={!canRun} aria-describedby="topology-issues">
        Run comparison
      </button>
    </div>
  );
}
