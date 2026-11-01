import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { t } from "../i18n";
import { formatNumber, formatSize } from "../i18n/format";
import { MessageError } from "../i18n/MessageError";
import { api } from "../api/apiClient";
import type { DocumentEntry, RunStorageEntry } from "../api/apiTypes";
import { copyModel, documentsToDelete, downloadDocuments, newExperiment, newModel, readImports, runsToDelete } from "../workspace/fileActions";
import type { Workspace } from "../workspace/useWorkspace";
import { useConfirmation } from "../components/useConfirmation";

type FileAction = "new" | "newExperiment" | "saveAs" | "import" | "deleteModel" | "deleteExperiment" | "cleanupObsolete";

/** Creation shortcuts share the File menu's dialog and unsaved-change confirmation. */
export interface FileMenuHandle {
  start: (action: "new" | "newExperiment") => Promise<void>;
}

/** File commands use server workspace documents; native File/Blob transfer copies to and from the browser. */
export function FileMenu({ workspace, disabled, onOpened, ref }: { workspace: Workspace; disabled: boolean; onOpened: () => void; ref?: Ref<FileMenuHandle> }) {
  const { confirm, confirmDocumentSwitch, confirmationDialog } = useConfirmation();
  const menu = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [action, setAction] = useState<FileAction | null>(null);
  const [directory, setDirectory] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [deletion, setDeletion] = useState<DocumentEntry[]>([]);
  const [runDeletion, setRunDeletion] = useState<RunStorageEntry[]>([]);
  const [obsolete, setObsolete] = useState<RunStorageEntry[]>([]);
  const [working, setWorking] = useState(false);
  const deleting = action === "deleteModel" || action === "deleteExperiment";
  const cleanup = action === "cleanupObsolete";
  const title = t(`file.${action ?? "menu"}`);

  useEffect(() => {
    if (action !== null) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [action]);

  const refreshObsolete = async () => {
    try { setObsolete(await api.obsoleteRuns()); }
    catch (error) { setObsolete([]); workspace.reportProblem(error); }
  };

  const start = async (next: FileAction) => {
    if (disabled || working) return;
    if (next === "newExperiment" && workspace.loaded === null) return;
    menu.current?.hidePopover?.();
    const deleting = next === "deleteModel" || next === "deleteExperiment";
    if ((next === "new" || next === "newExperiment") && workspace.dirty &&
      !await confirmDocumentSwitch(workspace.save)) return;
    if (deleting && workspace.dirty &&
      !await confirm({ title: t("app.confirm.discardChanges"),
        confirmLabel: t("app.confirm.discardAction"), cancelLabel: t("app.confirm.stayAction") })) return;
    setDirectory(""); setFiles([]); setDeletion([]); setRunDeletion([]); setAction(next);
    if (next === "cleanupObsolete" || (deleting && workspace.loaded !== null)) {
      setWorking(true);
      try {
        if (next === "cleanupObsolete") setRunDeletion(await api.obsoleteRuns());
        else {
          const documents = await documentsToDelete(workspace.loaded!, next === "deleteModel" ? "model" : "experiment");
          const runs = await runsToDelete(documents);
          setDeletion(documents); setRunDeletion(runs);
        }
      }
      catch (error) { workspace.reportProblem(error); setAction(null); }
      finally { setWorking(false); }
    }
  };
  useImperativeHandle(ref, () => ({ start }));
  const submit = async () => {
    if (action === null || working) return;
    if (action === "import" && workspace.dirty && !await confirm({ title: t("app.confirm.discardChanges"),
      confirmLabel: t("app.confirm.discardAction"), cancelLabel: t("app.confirm.stayAction") })) return;
    setWorking(true);
    try {
      if (deleting) {
        onOpened();
        await workspace.removeDocuments(deletion, true, runDeletion);
        return;
      }
      if (cleanup) {
        let deleted: string[] = [];
        try {
          const latest = await api.obsoleteRuns();
          if (runDeletion.some(run => !latest.some(current => current.directory === run.directory &&
            current.experiment === run.experiment && current.sizeBytes === run.sizeBytes))) {
            throw new MessageError("file.runDeletePlanChanged");
          }
          for (const run of runDeletion) {
            await api.deleteRunDirectory(run.directory);
            deleted.push(run.directory);
          }
        } catch (error) {
          let verified = false;
          try {
            const [readable, obsolete] = await Promise.all([api.runs(), api.obsoleteRuns()]);
            const stored = new Set([...readable, ...obsolete].map(run => run.directory));
            deleted = runDeletion.filter(run => !stored.has(run.directory)).map(run => run.directory);
            verified = true;
          } catch { /* Keep only acknowledged deletions if storage cannot be listed. */ }
          throw new MessageError(verified ? "file.partialDelete" : "file.deleteUncertain", {
            deleted: deleted.join(", ") || t("file.noFilesDeleted"),
            remaining: runDeletion.filter(run => !deleted.includes(run.directory)).map(run => run.directory).join(", ") || t("file.noFilesDeleted"),
            reason: error instanceof Error ? error.message : t("app.workspace.requestFailed"),
          });
        } finally { await refreshObsolete(); }
        return;
      }
      const drafts = action === "new" ? newModel(directory)
        : action === "newExperiment" && workspace.loaded !== null ? newExperiment(workspace.loaded, directory)
        : action === "saveAs" && workspace.loaded !== null ? await copyModel(workspace.loaded, directory)
        : await readImports(files, directory);
      const replaced = action === "import" ? (paths: string[]) => confirm({ title: t("file.replaceTitle"),
        message: t("file.replaceConfirm", { paths: paths.join("\n") }),
        confirmLabel: t("file.replaceAction"), cancelLabel: t("file.keepDocumentsAction") }) : undefined;
      if (await workspace.storeDocuments(drafts, replaced, action === "import")) onOpened();
    } catch (error) { workspace.reportProblem(error); }
    finally { setWorking(false); setAction(null); }
  };
  const download = async () => {
    menu.current?.hidePopover?.();
    const needsSave = workspace.dirty || workspace.loaded?.versions.experiment === null;
    if (needsSave && !await confirm({ title: t("file.saveBeforeExport"),
      confirmLabel: t("file.saveAndExportAction"), cancelLabel: t("file.cancelExportAction") })) return;
    const documents = await workspace.exportFiles(needsSave);
    if (documents !== null) downloadDocuments(documents);
  };

  return <div className="file-menu" onKeyDown={event => {
    if (event.key === "Escape") event.stopPropagation();
  }}>
    <button type="button" popoverTarget="file-menu" disabled={disabled || working} onClick={() => void refreshObsolete()}>{t("file.menu")}</button>
    <div id="file-menu" ref={menu} popover="auto" className="file-menu-panel">
      <button type="button" disabled={disabled} onClick={() => start("new")}>{t("file.new")}</button>
      <button type="button" disabled={disabled || workspace.loaded === null} onClick={() => start("newExperiment")}>{t("file.newExperiment")}</button>
      <button type="button" disabled={disabled || workspace.loaded === null} onClick={() => start("saveAs")}>{t("file.saveAs")}</button>
      <button type="button" disabled={disabled} onClick={() => start("import")}>{t("file.import")}</button>
      <button type="button" disabled={disabled || workspace.loaded === null || workspace.conflict || workspace.externalChange !== null}
        onClick={() => void download()}>{t("file.export")}</button>
      <button type="button" disabled={disabled || workspace.loaded === null} onClick={() => void start("deleteModel")}>{t("file.deleteModel")}</button>
      <button type="button" disabled={disabled || workspace.loaded === null || workspace.loaded.versions.experiment === null}
        onClick={() => void start("deleteExperiment")}>{t("file.deleteExperiment")}</button>
      <button type="button" disabled={disabled || obsolete.length === 0} title={obsolete.length === 0 ? t("file.noObsoleteRuns") : undefined}
        onClick={() => void start("cleanupObsolete")}>{t("file.cleanupObsolete")}</button>
    </div>
    <dialog ref={dialog} className="file-dialog" aria-label={title} onClose={() => setAction(null)}
      onKeyDown={event => event.stopPropagation()}
      onCancel={event => { if (working) event.preventDefault(); else setAction(null); }}>
      {action === null ? null : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <h2>{title}</h2>
        {deleting || cleanup ? <>
          <p>{t(cleanup ? "file.obsoleteConfirm" : "file.deleteConfirm")}</p>
          <ul>{deletion.map(entry => <li key={entry.path}>{entry.path}</li>)}</ul>
          {cleanup ? <ul>{runDeletion.map(run => <li key={run.directory}>{t("file.obsoleteRun", { name: run.experiment ?? run.directory, size: formatSize(run.sizeBytes) })}</li>)}</ul> : null}
          <p>{t("file.deleteRuns", { count: formatNumber(runDeletion.length), size: formatSize(runDeletion.reduce((sum, run) => sum + run.sizeBytes, 0)) })}</p>
        </> : <>
        <p>{t("file.locationHint")}</p>
        <label>{t(action === "new" || action === "saveAs" ? "file.modelName" : action === "newExperiment" ? "file.experimentName" : "file.directory")}<input autoFocus required value={directory} disabled={working}
          onChange={event => setDirectory(event.target.value)} /></label>
        {action !== "import" ? null : <label>{t("file.files")}<input type="file" multiple required
          accept=".model.json,.layout.json,.experiment.json" disabled={working}
          onChange={event => setFiles(Array.from(event.target.files ?? []))} /></label>}
        </>}
        <div className="file-dialog-actions">
          <button type="button" disabled={working} onClick={() => setAction(null)}>{t("file.cancel")}</button>
          <button type="submit" disabled={working || (deleting && deletion.length === 0) || (cleanup && runDeletion.length === 0)}>{working ? t("file.working") : deleting || cleanup ? t("file.delete") : title}</button>
        </div>
      </form>}
    </dialog>
    {confirmationDialog}
  </div>;
}
