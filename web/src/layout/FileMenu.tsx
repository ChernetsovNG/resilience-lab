import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { copyExperiment, downloadDocuments, newExperiment, readImports } from "../workspace/fileActions";
import type { Workspace } from "../workspace/useWorkspace";

type FileAction = "new" | "saveAs" | "import";

/** File commands use server workspace documents; native File/Blob transfer copies to and from the browser. */
export function FileMenu({ workspace, disabled, onOpened }: { workspace: Workspace; disabled: boolean; onOpened: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [action, setAction] = useState<FileAction | null>(null);
  const [directory, setDirectory] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [working, setWorking] = useState(false);
  const title = t(`file.${action ?? "menu"}`);

  useEffect(() => {
    if (action !== null) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [action]);

  const start = (next: FileAction) => {
    menu.current?.hidePopover?.();
    if (next === "new" && workspace.dirty && !window.confirm(t("app.confirm.discardChanges"))) return;
    setDirectory(""); setFiles([]); setAction(next);
  };
  const submit = async () => {
    if (action === null || working) return;
    if (action === "import" && workspace.dirty && !window.confirm(t("app.confirm.discardChanges"))) return;
    setWorking(true);
    try {
      const drafts = action === "new" ? newExperiment(directory)
        : action === "saveAs" && workspace.loaded !== null ? copyExperiment(workspace.loaded, directory)
        : await readImports(files, directory);
      const replaced = action === "import" ? (paths: string[]) => window.confirm(t("file.replaceConfirm", { paths: paths.join("\n") })) : undefined;
      if (await workspace.storeDocuments(drafts, replaced)) onOpened();
    } catch (error) { workspace.reportProblem(error); }
    finally { setWorking(false); setAction(null); }
  };
  const download = async () => {
    menu.current?.hidePopover?.();
    if (workspace.dirty && !window.confirm(t("file.saveBeforeExport"))) return;
    const documents = await workspace.exportFiles(workspace.dirty);
    if (documents !== null) downloadDocuments(documents);
  };

  return <div className="file-menu" onKeyDown={event => {
    if (event.key === "Escape") event.stopPropagation();
  }}>
    <button type="button" popoverTarget="file-menu" disabled={disabled || working}>{t("file.menu")}</button>
    <div id="file-menu" ref={menu} popover="auto" className="file-menu-panel">
      <button type="button" disabled={disabled} onClick={() => start("new")}>{t("file.new")}</button>
      <button type="button" disabled={disabled || workspace.loaded === null} onClick={() => start("saveAs")}>{t("file.saveAs")}</button>
      <button type="button" disabled={disabled} onClick={() => start("import")}>{t("file.import")}</button>
      <button type="button" disabled={disabled || workspace.loaded === null || workspace.conflict || workspace.externalChange !== null}
        onClick={() => void download()}>{t("file.export")}</button>
    </div>
    <dialog ref={dialog} className="file-dialog" aria-label={title} onClose={() => setAction(null)}
      onKeyDown={event => event.stopPropagation()}
      onCancel={event => { if (working) event.preventDefault(); else setAction(null); }}>
      {action === null ? null : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <h2>{title}</h2>
        <p>{t("file.locationHint")}</p>
        <label>{t("file.directory")}<input autoFocus required value={directory} disabled={working}
          onChange={event => setDirectory(event.target.value)} /></label>
        {action !== "import" ? null : <label>{t("file.files")}<input type="file" multiple required
          accept=".model.json,.layout.json,.experiment.json" disabled={working}
          onChange={event => setFiles(Array.from(event.target.files ?? []))} /></label>}
        <div className="file-dialog-actions">
          <button type="button" disabled={working} onClick={() => setAction(null)}>{t("file.cancel")}</button>
          <button type="submit" disabled={working}>{working ? t("file.working") : title}</button>
        </div>
      </form>}
    </dialog>
  </div>;
}
