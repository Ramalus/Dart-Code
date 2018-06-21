import * as vs from "vscode";

export function getActiveDartEditor(): vs.TextEditor | undefined {
	const editor = vs.window.activeTextEditor;
	if (!editor || editor.document.languageId !== "dart")
		return undefined;
	return editor;
}
