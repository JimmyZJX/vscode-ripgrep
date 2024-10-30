import {
  CancellationToken,
  commands,
  DocumentSymbol,
  DocumentSymbolProvider,
  ExtensionContext,
  languages,
  Position,
  ProviderResult,
  Range,
  SymbolInformation,
  SymbolKind,
  TextDocument,
  TextEditor,
  Uri,
  window,
  workspace,
} from "vscode";
import { DummyFS } from "./dummyFS";
import { Panel } from "./panel";

const RIPGREP_LANGID = "ripgrep-panel";
const DUMMY_FS_SCHEME = "rg-vscode-fake-fs";
const RG_BUFFER_NAME = "VSCode Ripgrep";
let rgBufferCounter = 0;

export const grepPanel = new Panel();

interface EditorGroupSubLayout {
  groups?: EditorGroupSubLayout[];
  size: number;
}

interface EditorGroupLayout extends EditorGroupSubLayout {
  orientation: 0 | 1; // 0: LeftRight, 1: UpDown
}

function numGroups(layout: EditorGroupSubLayout): number {
  if (layout.groups === undefined) return 1;
  return layout.groups.reduce((s, l) => s + numGroups(l), 0);
}

interface FindOpts {
  dirMode?: "doc" | "workspace";
  withSelection?: boolean;
}

async function withInit(fInit: () => Promise<void>) {
  try {
    await fInit();
    await grepPanel.onEdit();
  } catch (e) {
    grepPanel.quit(false);
    throw e;
  }
}

async function redoLast() {
  const reqSrcEditor = window.activeTextEditor;
  if (reqSrcEditor === undefined) return;

  const rgPanelEditor = await panelEditor(grepPanel.getLastQuery());
  withInit(async () => await grepPanel.init(rgPanelEditor, reqSrcEditor, "last"));
}

async function panelEditor(initQuery: string) {
  const file = Uri.from({
    scheme: DUMMY_FS_SCHEME,
    path: `/${RG_BUFFER_NAME}          ${rgBufferCounter++}`,
    query: initQuery,
  });
  const doc = await workspace.openTextDocument(file);
  languages.setTextDocumentLanguage(doc, RIPGREP_LANGID);

  const editorGroupLayout: EditorGroupLayout = await commands.executeCommand(
    "vscode.getEditorLayout",
  );

  if (editorGroupLayout.orientation == 1) {
    if (editorGroupLayout.groups === undefined) {
      throw "Unexpected editor layout (groups is undefined)";
    }
    // updown, add another one in the bottom
    let restHeight = 0;
    for (const sub of editorGroupLayout.groups) {
      const newSize = Math.floor((sub.size * 2) / 3);
      restHeight += sub.size - newSize;
      sub.size = newSize;
    }
    editorGroupLayout.groups.push({ size: restHeight });
  } else {
    // leftright, add into the bottom
    // TODO better way to infer the size of the editor
    editorGroupLayout.orientation = 1;
    editorGroupLayout.groups = [
      { groups: editorGroupLayout.groups, size: 660 },
      { size: 340 },
    ];
  }

  await commands.executeCommand("vscode.setEditorLayout", editorGroupLayout);

  const docLine0End = doc.lineAt(0).range.end;
  const rgPanelEditor = await window.showTextDocument(doc, {
    viewColumn: numGroups(editorGroupLayout),
    selection: new Range(docLine0End, docLine0End),
  });
  try {
    // try to turn vim into insert mode
    await commands.executeCommand("vim.remap", { after: ["A"] });
  } catch {}
  return rgPanelEditor;
}

function getQueryFromDoc(reqSrcEditor: TextEditor, opts: FindOpts) {
  const reqDoc = reqSrcEditor.document;
  const sel = reqSrcEditor.selection;
  let initQuery = reqDoc.getText(new Range(sel.start, sel.end));
  if (initQuery === "" && opts.withSelection) {
    const range = reqDoc.getWordRangeAtPosition(sel.start);
    if (range !== undefined) {
      initQuery = reqDoc.getText(range);
    }
  }
  if (grepPanel.isRegexOn()) {
    initQuery = initQuery.replaceAll(/[\/\\^$+?.()\|\*[\]{}]/g, "\\$&");
  }
  return initQuery;
}

async function find(opts: FindOpts) {
  const reqSrcEditor = window.activeTextEditor;
  if (reqSrcEditor === undefined) return;

  let initQuery = getQueryFromDoc(reqSrcEditor, opts);
  const rgPanelEditor = await panelEditor(initQuery);
  withInit(async () => await grepPanel.init(rgPanelEditor, reqSrcEditor, opts.dirMode));
}

export async function activate(context: ExtensionContext) {
  workspace.registerFileSystemProvider(DUMMY_FS_SCHEME, new DummyFS(), {
    isReadonly: false,
  });
  workspace.onDidChangeTextDocument((e) => {
    if (e.document.languageId == RIPGREP_LANGID) {
      setTimeout(() => grepPanel.onEdit(), 200);
    }
  });
  workspace.onDidCloseTextDocument((doc) => {
    grepPanel.onDocumentClosed(doc);
  });
  window.onDidChangeActiveTextEditor((_te) => {
    grepPanel.quit(false);
  });
  window.onDidChangeTextEditorSelection((e) => {
    grepPanel.onChangeSelection(e);
  });
  context.subscriptions.push(
    commands.registerCommand("ripgrep.enter", async () => grepPanel.enter()),
    commands.registerCommand("ripgrep.quit", async () => grepPanel.quit(true)),
    commands.registerCommand("ripgrep.find", async (args) => {
      args = typeof args === "object" ? args : {};
      await find(args);
    }),
    commands.registerCommand("ripgrep.resume", async () => await redoLast()),
    commands.registerCommand(
      "ripgrep.findInCurrentDir",
      async () => await find({ dirMode: "doc" }),
    ),
    commands.registerCommand(
      "ripgrep.findInWorkspace",
      async () => await find({ dirMode: "workspace" }),
    ),
    commands.registerCommand("ripgrep.moveFocus", (args) => grepPanel.moveFocus(args)),
    commands.registerCommand("ripgrep.dirUp", () => grepPanel.searchDirUp()),
    commands.registerCommand("ripgrep.dirDown", () => grepPanel.searchDirDown()),
    commands.registerCommand("ripgrep.toggleSearchDir", () => grepPanel.toggleDir()),
    commands.registerCommand("ripgrep.toggleCase", () => grepPanel.toggleMode("case")),
    commands.registerCommand("ripgrep.toggleRegex", () => grepPanel.toggleMode("regex")),
    commands.registerCommand("ripgrep.toggleWord", () => grepPanel.toggleMode("word")),
  );
  languages.registerDocumentSymbolProvider(
    { language: "ripgrep-panel" },
    new (class implements DocumentSymbolProvider {
      provideDocumentSymbols(
        doc: TextDocument,
        _token: CancellationToken,
      ): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        if (doc.lineCount >= 2) {
          const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
          const ds1 = new DocumentSymbol(
            "rgpanel-query",
            "",
            SymbolKind.Module,
            new Range(new Position(0, 0), docEnd),
            doc.lineAt(0).range,
          );

          const ds2 = new DocumentSymbol(
            "rgpanel-result",
            "",
            SymbolKind.Module,
            new Range(new Position(1, 0), docEnd),
            doc.lineAt(1).range,
          );
          ds1.children = [ds2];
          return [ds1];
        }
        return [];
      }
    })(),
  );
}

export function deactivate() {}
