import assert from "assert";
import { ChildProcess } from "child_process";
import path from "path";
import {
  commands,
  Position,
  Range,
  Selection,
  TextDocument,
  TextEditor,
  TextEditorDecorationType,
  TextEditorRevealType,
  TextEditorSelectionChangeEvent,
  ThemeColor,
  Uri,
  window,
  workspace,
} from "vscode";
import { doQuery } from "./rg";
import { throttle } from "./throttle";

export interface GrepLine {
  file: string;
  lineNo: number;
  line: string;
  match: { start: number; end: number }[];
}

interface MatchLine {
  file?: string;
  lineNo?: number;
}

interface PendingEdit {
  line: string;
}

export type Summary =
  | {
      type: "done";
      elapsed: string;
      matches: number;
    }
  | { type: "error"; msg: string }
  | {
      type: "start";
      query: string;
    };

type ModeToggleKeys = "regex" | "case" | "word";
interface ToggleableModes {
  regex: "on" | "off";
  case_: "smart" | "strict" | "ignore";
  word: "on" | "off";
}

interface Mode extends ToggleableModes {
  cwd: string;
  docDir?: string;
  workspaceRoot?: string;
  docOrWorkspaceDir: "doc" | "workspace" | undefined;
}

const MAX_LINES_TO_SHOW = 200;

const queryDecoration = window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new ThemeColor("list.hoverBackground"),
  // before: {
  //   contentText: "rg> ",
  //   fontWeight: "bold",
  //   border: "solid 1px gray; border-radius: 5px",
  // },
});
const StatusDecoration = window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new ThemeColor("button.background"),
});
const focusDecoration = window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new ThemeColor("list.activeSelectionBackground"),
});
const matchDecoration = window.createTextEditorDecorationType({
  color: new ThemeColor("errorForeground"),
  fontWeight: "bold",
});
const filenameDecoration = window.createTextEditorDecorationType({
  color: new ThemeColor("terminal.ansiBrightBlue"),
});
const linenumberDecoration = window.createTextEditorDecorationType({
  color: new ThemeColor("terminal.ansiBrightGreen"),
});

function cartesianProduct<T>(...arrays: T[][]) {
  return [...arrays].reduce(
    (a: T[][], b) =>
      a
        .map((x: any) => b.map((y: any) => x.concat(y)))
        .reduce((a: any, b: any) => a.concat(b), []),
    [[]],
  );
}

function toggleableModeToKey(mode: ToggleableModes) {
  return `${mode.case_}|${mode.regex}|${mode.word}`;
}
const allToggleableModeDecorations = Object.fromEntries(
  cartesianProduct(["smart", "ignore", "strict"], ["on", "off"], ["on", "off"]).map(
    ([case_, regex, word]) => {
      const key = toggleableModeToKey({
        case_: case_ as ToggleableModes["case_"],
        regex: regex as ToggleableModes["regex"],
        word: word as ToggleableModes["word"],
      });
      const deco = window.createTextEditorDecorationType({
        after: {
          color: new ThemeColor("textPreformat.foreground"),
          margin: `0;
             position: absolute; left: 80ch; font-size: 0.75rem;
             content: 'Case[${case_}](alt+c) \\00a0 Regex[${regex}](alt+r) \\00a0 Word[${word}](alt+w)'`,
        },
      });
      return [key, deco];
    },
  ),
);

const docDirDeco = window.createTextEditorDecorationType({
  after: {
    color: new ThemeColor("textPreformat.foreground"),
    margin: `; font-size: 0.75rem; position: relative; left: 6ch;
        content: 'Dir[relative](alt+d: toggle; alt+{h,l}: navigate)'`,
  },
});
const workspaceDirDeco = window.createTextEditorDecorationType({
  after: {
    color: new ThemeColor("textPreformat.foreground"),
    margin: `0; font-size: 0.75rem; position: relative; left: 6ch;
        content: 'Dir[workspace](alt+d: toggle; alt+{h,l}: navigate)'`,
  },
});

function longestCommonPrefix(strs: string[]): string {
  let i = 0;

  if (!strs.length) {
    return "";
  }

  while (true) {
    const char = strs[0][i] || "";
    const match = strs.every((str) => str[i] === char);
    if (match) {
      i += 1;
    } else {
      break;
    }
  }
  return strs[0].slice(0, i);
}

export class Panel {
  private queryId = -1;
  private curQuery = "";
  private curMode: Mode = {
    cwd: "/",
    docOrWorkspaceDir: "doc",
    regex: "on",
    case_: "smart",
    word: "off",
  };
  private proc: ChildProcess | undefined;

  private refreshResults = false;
  private pendingEdits: PendingEdit[] = [];
  private pendingSummary: Summary | undefined;
  private applyEdits: () => void;

  private rgPanelEditor: TextEditor | undefined;
  private reqViewColumn: number | undefined;
  private reqDoc: TextDocument | undefined;

  private matchLineInfos: MatchLine[] = [];
  private matchDecorationRegions: Range[] = [];
  private filenameDecorationRegions: Range[] = [];
  private linenumberDecorationRegions: Range[] = [];

  /** index in the arrays, line number = index + 2 */
  private currentFocus: number | undefined = undefined;

  constructor() {
    this.applyEdits = throttle(async () => this._applyEdits(), 200);
  }

  public isRegexOn() {
    return this.curMode.regex === "on";
  }

  public getLastQuery() {
    return this.curQuery;
  }

  public async init(
    rgPanelEditor: TextEditor,
    reqSrcEditor: TextEditor,
    dirMode: "doc" | "workspace" | "last" | undefined,
  ) {
    const reqDoc = reqSrcEditor.document;
    this.rgPanelEditor = rgPanelEditor;
    this.reqViewColumn = reqSrcEditor.viewColumn;
    this.curQuery = "";
    let workspaceRoot = undefined;
    if (workspace.workspaceFolders !== undefined) {
      workspaceRoot = longestCommonPrefix(
        workspace.workspaceFolders.map((f) => f.uri.path),
      );
    }
    let docDir = reqDoc.uri.scheme === "file" ? path.dirname(reqDoc.uri.path) : undefined;
    this.reqDoc = reqDoc;

    if (dirMode === "last") {
      // don't change [curMode]
    } else {
      const cwd =
        dirMode === "doc"
          ? docDir
          : dirMode === "workspace"
            ? workspaceRoot
            : (docDir ?? workspaceRoot);
      if (cwd === undefined) {
        const msg = "Unable to infer cwd from current file or workspace dir";
        window.showErrorMessage(msg);
        throw msg;
      }
      const docOrWorkspaceDir = dirMode ?? (docDir !== undefined ? "doc" : "workspace");
      this.curMode.cwd = cwd;
      this.curMode.docDir = docDir;
      this.curMode.workspaceRoot = workspaceRoot;
      this.curMode.docOrWorkspaceDir = docOrWorkspaceDir;
    }

    const doc = this.rgPanelEditor.document;
    await rgPanelEditor.edit((eb) => {
      const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
      const line1ToEnd = new Range(new Position(1, 0), docEnd);
      eb.replace(line1ToEnd, this.ppCwd());
    });
    this.setDeco();
  }

  public onDocumentClosed(doc: TextDocument) {
    if (this.rgPanelEditor?.document.uri.toString() === doc.uri.toString()) {
      this.quit(true);
    }
  }

  public onChangeSelection(e: TextEditorSelectionChangeEvent) {
    if (
      this.rgPanelEditor?.document.uri.toString() === e.textEditor.document.uri.toString()
    ) {
      const editor = this.rgPanelEditor;
      const doc = editor.document;
      const line0End = doc.lineAt(0).range.end;
      if (editor.selections.length > 1) {
        // reset
        editor.selections = [new Selection(line0End, line0End)];
      } else {
        const sel = editor.selections[0];
        if (sel.active.line === 0 && sel.anchor.line === 0) {
          // ok
        } else {
          const line = sel.active.line;
          if (line >= 2) this.setFocus(line - 2);
          // reset
          editor.selections = [new Selection(line0End, line0End)];
        }
      }
    }
  }

  private static async closeCurrentEditor() {
    await commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    if (
      workspace
        .getConfiguration("workbench.editor")
        .get<boolean>("closeEmptyGroups", true) === false
    ) {
      await commands.executeCommand("workbench.action.closeGroup");
    }
  }

  public async quit(backToStart: boolean) {
    this.proc?.kill();
    const panelEditor = this.rgPanelEditor;
    if (panelEditor !== undefined) {
      this.rgPanelEditor = undefined;

      const doc = panelEditor.document;
      const activeEditor = window.activeTextEditor;
      if (
        activeEditor !== undefined &&
        activeEditor.document.uri.toString() === doc.uri.toString()
      ) {
        await Panel.closeCurrentEditor();
      } else {
        // try to switch to the panel editor doc on the same view column
        await window.showTextDocument(doc, {
          preserveFocus: false,
          viewColumn: panelEditor.viewColumn,
        });
        const activeEditor = window.activeTextEditor;
        if (
          activeEditor !== undefined &&
          activeEditor.document.uri.toString() === doc.uri.toString()
        ) {
          await Panel.closeCurrentEditor();
        }
      }

      // try to remove decorations on the preview editor
      const editor = window.activeTextEditor;
      if (editor !== undefined) {
        editor.setDecorations(focusDecoration, []);
      }
      if (backToStart) {
        if (this.reqDoc !== undefined) {
          const editor = await window.showTextDocument(this.reqDoc, {
            viewColumn: this.reqViewColumn,
            preserveFocus: false,
            preview: false,
          });
          await vimEsc();
          editor.revealRange(editor.selection, TextEditorRevealType.InCenter);
        }
      }
    }
  }

  public isQueryId(queryId: number) {
    return this.queryId === queryId;
  }

  private static lastModeDeco: TextEditorDecorationType | undefined = undefined;
  private setDeco() {
    const editor = this.rgPanelEditor;
    if (editor === undefined) return;

    editor.setDecorations(queryDecoration, [new Range(0, 0, 0, 0)]);
    editor.setDecorations(StatusDecoration, [new Range(1, 0, 1, 0)]);

    if (Panel.lastModeDeco !== undefined) {
      editor.setDecorations(Panel.lastModeDeco, []);
    }
    const modeDeco = allToggleableModeDecorations[toggleableModeToKey(this.curMode)];
    Panel.lastModeDeco = modeDeco;
    editor.setDecorations(modeDeco, [new Range(0, 0, 0, 0)]);

    const line1End = editor.document.lineAt(1).range.end;
    const line1EndRange = [new Range(line1End, line1End)];
    if (this.curMode.docOrWorkspaceDir === "doc") {
      editor.setDecorations(workspaceDirDeco, []);
      editor.setDecorations(docDirDeco, line1EndRange);
    } else if (this.curMode.docOrWorkspaceDir === "workspace") {
      editor.setDecorations(docDirDeco, []);
      editor.setDecorations(workspaceDirDeco, line1EndRange);
    }
  }

  /** returns new query id or undefined if not changed */
  public async onEdit() {
    if (this.rgPanelEditor === undefined) return undefined;
    const doc = this.rgPanelEditor.document;
    const query = doc.getText(doc.lineAt(0).range).replace(/^rg> /, "");

    if (this.curQuery === query) {
      // do nothing to prevent infinite loop
    } else {
      this.rgPanelEditor.revealRange(new Range(0, 0, 0, 0));
      assert(this.curMode !== undefined, "unexpected undefined mode");
      await this.newQuery(query);
    }
  }

  public async searchDirUp() {
    const mode = this.curMode;
    const lastSlash = mode.cwd.replace(/\/$/, "").lastIndexOf("/");
    if (lastSlash > 0) {
      mode.cwd = mode.cwd.slice(0, lastSlash);
      await this.newQuery();
    }
  }

  public async searchDirDown() {
    const mode = this.curMode;
    const fullDir = mode.docOrWorkspaceDir === "doc" ? mode.docDir : mode.workspaceRoot;
    if (fullDir !== undefined && fullDir.startsWith(mode.cwd)) {
      const idxOfSlash = mode.cwd.replace(/\/$/, "").length;
      const nextSlash = (fullDir + "/").indexOf("/", idxOfSlash + 1);
      if (nextSlash > 0) {
        mode.cwd = fullDir.slice(0, nextSlash);
        await this.newQuery();
      }
    }
  }

  /** returns new query id or undefined if not changed */
  public async toggleDir() {
    if (this.rgPanelEditor === undefined) return undefined;
    assert(this.curMode !== undefined, "unexpected undefined mode");
    const mode = this.curMode;
    if (mode.docOrWorkspaceDir === "doc" && mode.workspaceRoot !== undefined) {
      mode.docOrWorkspaceDir = "workspace";
      mode.cwd = mode.workspaceRoot;
    } else if (mode.docOrWorkspaceDir === "workspace" && mode.docDir !== undefined) {
      mode.docOrWorkspaceDir = "doc";
      mode.cwd = mode.docDir;
    } else {
      // not changed
      return undefined;
    }
    await this.newQuery();
  }

  public async toggleMode(key: ModeToggleKeys) {
    const mode = this.curMode;
    if (key === "case") {
      mode.case_ =
        mode.case_ === "smart" ? "ignore" : mode.case_ === "ignore" ? "strict" : "smart";
    } else if (key === "regex") {
      mode.regex = mode.regex === "on" ? "off" : "on";
    } else if (key === "word") {
      mode.word = mode.word === "on" ? "off" : "on";
    }
    await this.newQuery();
  }

  private ppCwd() {
    const cwd = this.curMode.cwd;
    if (cwd.length > 40) {
      return `[...${this.curMode.cwd.slice(-37)}]`;
    }
    return `[${this.curMode.cwd}]`;
  }

  // TODO support mode change
  private async newQuery(rawQuery?: string): Promise<void> {
    this.queryId++;
    // TODO this.curModes=modes;
    if (rawQuery !== undefined) this.curQuery = rawQuery;
    const query = this.curQuery;

    this.proc?.kill();
    this.proc = undefined;

    // erase all edits and decorations
    this.refreshResults = true;
    this.pendingEdits = [];
    this.matchLineInfos = [];
    this.matchDecorationRegions = [];
    this.filenameDecorationRegions = [];
    this.linenumberDecorationRegions = [];
    this.pendingSummary = { type: "start", query };

    if (this.rgPanelEditor !== undefined) {
      const doc = this.rgPanelEditor.document;
      await this.rgPanelEditor.edit((eb) => {
        const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
        const line1ToEnd = new Range(new Position(1, 0), docEnd);
        eb.replace(
          line1ToEnd,
          this.ppCwd() + (query ? ` processing query [${query}]` : ""),
        );
      });
      this.setDeco();
    }

    this.currentFocus = undefined;
    this.rgPanelEditor?.setDecorations(focusDecoration, []);
    this.rgPanelEditor?.setDecorations(matchDecoration, []);
    // TODO remove filename and line number decorations

    if (query !== "") {
      doQuery(
        {
          query,
          dir: [],
          cwd: Uri.from({ scheme: "file", path: this.curMode.cwd }).fsPath,
          case: this.curMode.case_,
          regex: this.curMode.regex,
          word: this.curMode.word,
        },
        this.queryId,
      );
    }
  }

  public manageProc(proc: ChildProcess, queryId: number) {
    if (queryId === this.queryId) {
      this.proc = proc;
    } else {
      proc.kill();
    }
  }

  public async enter() {
    await this.quit(false);
    if (this.currentFocus === undefined) return;
    const info = this.matchLineInfos[this.currentFocus];
    const f = info.file;
    const l = info.lineNo;
    if (info !== undefined && f !== undefined && l !== undefined) {
      const viewColumn = this.reqViewColumn ?? 1;
      const file = Uri.file(path.join(this.curMode!.cwd, f));
      const doc = await workspace.openTextDocument(file);
      const lineL = doc.lineAt(l - 1).range;
      const editor = await window.showTextDocument(doc, {
        viewColumn,
        preserveFocus: false,
        preview: false,
      });
      editor.selections = [new Selection(lineL.start, lineL.start)];
      editor.setDecorations(focusDecoration, []);
      vimEsc(l);
    }
  }

  public moveFocus(dir: string) {
    if (this.matchLineInfos.length === 0) return;
    let focus = this.currentFocus ?? 0;
    switch (dir) {
      case "up":
        focus = Math.max(0, focus - 1);
        break;
      case "up5":
        focus = Math.max(0, focus - 5);
        break;
      case "down":
        focus = Math.min(this.matchLineInfos.length - 1, focus + 1);
        break;
      case "down5":
        focus = Math.min(this.matchLineInfos.length - 1, focus + 5);
        break;
      default:
        window.showErrorMessage(`Unknown move direction "${dir}"`);
    }
    this.setFocus(focus);
  }

  private async setFocus(to: number) {
    if (this.matchLineInfos[to] === undefined) return;
    this.currentFocus = to;

    if (this.rgPanelEditor !== undefined) {
      const line = to + 2;
      this.rgPanelEditor.setDecorations(focusDecoration, [new Range(line, 0, line, 0)]);
      this.rgPanelEditor.revealRange(new Range(line - 1, 0, line + 1, 0));

      const info = this.matchLineInfos[to];
      const f = info.file;
      const l = info.lineNo;
      if (info !== undefined && f !== undefined && l !== undefined) {
        const viewColumn = this.reqViewColumn ?? 1;
        const file = Uri.file(path.join(this.curMode.cwd, f));
        const editor = await window.showTextDocument(file, {
          viewColumn,
          preserveFocus: true,
          preview: true,
        });
        const lineL = editor.document.lineAt(l - 1).range;
        editor.setDecorations(focusDecoration, [lineL]);
        editor.revealRange(lineL, TextEditorRevealType.InCenter);
      }
    }
  }

  public onGrepLines(gls: GrepLine[], queryId: number) {
    if (queryId !== this.queryId) return;

    let nextLine = this.matchLineInfos.length + 2;
    for (const gl of gls) {
      if (nextLine >= MAX_LINES_TO_SHOW) {
        if (nextLine == MAX_LINES_TO_SHOW) {
          // show max lines message
          this.pendingEdits.push({ line: "\n...more results omitted" });
          this.matchLineInfos.push({});
        }
        nextLine++;
        break;
      }
      const linePre = `${gl.file}:${gl.lineNo}:`;
      const linePreLen = linePre.length;
      this.pendingEdits.push({ line: `\n${linePre}${gl.line}` });
      this.matchLineInfos.push({ file: gl.file, lineNo: gl.lineNo });
      for (const { start, end } of gl.match) {
        this.filenameDecorationRegions.push(
          new Range(nextLine, 0, nextLine, gl.file.length),
        );
        this.linenumberDecorationRegions.push(
          new Range(
            nextLine,
            gl.file.length + 1,
            nextLine,
            gl.file.length + 1 + gl.lineNo.toString().length,
          ),
        );
        this.matchDecorationRegions.push(
          new Range(nextLine, linePreLen + start, nextLine, linePreLen + end),
        );
      }
      nextLine++;
    }
    this.applyEdits();
  }

  async _applyEdits() {
    if (this.rgPanelEditor === undefined) return;
    if (
      this.pendingEdits.length === 0 &&
      this.pendingSummary === undefined &&
      !this.refreshResults
    )
      return;
    const edits = this.pendingEdits;
    const toAdd = edits.map((pe) => pe.line).join("");
    this.pendingEdits = [];
    await this.rgPanelEditor.edit(
      (eb) => {
        if (this.rgPanelEditor === undefined) return;
        const doc = this.rgPanelEditor.document;
        const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
        if (this.refreshResults) {
          this.refreshResults = false;
          eb.replace(new Range(doc.lineAt(1).range.end, docEnd), toAdd);
        } else {
          eb.insert(docEnd, toAdd);
        }
        if (this.pendingSummary) {
          const s = this.pendingSummary;
          this.pendingSummary = undefined;
          if (s.type === "done") {
            eb.replace(
              doc.lineAt(1).range,
              `${this.ppCwd()} Done: ${s.matches} matches (${s.elapsed})`,
            );
          } else if (s.type === "start") {
            eb.replace(
              doc.lineAt(1).range,
              `${this.ppCwd()} processing query [${s.query}]`,
            );
          } else if (s.type === "error") {
            eb.replace(doc.lineAt(1).range, `[${this.curMode.cwd}] ERROR: ${s.msg}`);
          }
        }
      },
      { undoStopAfter: false, undoStopBefore: false },
    );

    this.rgPanelEditor?.setDecorations(matchDecoration, this.matchDecorationRegions);
    this.rgPanelEditor?.setDecorations(
      filenameDecoration,
      this.filenameDecorationRegions,
    );
    this.rgPanelEditor?.setDecorations(
      linenumberDecoration,
      this.linenumberDecorationRegions,
    );
    this.setDeco();

    if (this.currentFocus === undefined) {
      await this.setFocus(0);
    }
  }

  public onSummary(summary: Summary, queryId: number) {
    if (queryId !== this.queryId) return;
    this.pendingSummary = summary;
    this.applyEdits();
  }
}

async function vimEsc(goToLine?: number) {
  let vimCmds = ["<Esc>"];
  if (goToLine !== undefined) {
    vimCmds = [...`${goToLine}ggzz`, "<Esc>"];
  }
  try {
    await commands.executeCommand("vim.remap", { after: vimCmds });
  } catch {}
}
