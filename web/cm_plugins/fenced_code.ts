import { Decoration, EditorState, syntaxTree } from "../deps.ts";
import type { Client } from "../client.ts";
import {
  decoratorStateField,
  invisibleDecoration,
  isCursorInRange,
} from "./util.ts";
import { MarkdownWidget } from "./markdown_widget.ts";
import { IFrameWidget } from "./iframe_widget.ts";

export function fencedCodePlugin(editor: Client) {
  return decoratorStateField((state: EditorState) => {
    const widgets: any[] = [];
    syntaxTree(state).iterate({
      enter({ from, to, name, node }) {
        if (name === "FencedCode") {
          if (isCursorInRange(state, [from, to])) return;
          const text = state.sliceDoc(from, to);
          const [_, lang] = text.match(/^```(\w+)?/)!;
          const codeWidgetCallback = editor.system.codeWidgetHook
            .codeWidgetCallbacks
            .get(lang);
          const renderMode = editor.system.codeWidgetHook.codeWidgetModes.get(
            lang,
          );
          if (codeWidgetCallback) {
            // We got a custom renderer!
            const lineStrings = text.split("\n");

            const lines: { from: number; to: number }[] = [];
            let fromIt = from;
            for (const line of lineStrings) {
              lines.push({
                from: fromIt,
                to: fromIt + line.length,
              });
              fromIt += line.length + 1;
            }

            const firstLine = lines[0], lastLine = lines[lines.length - 1];

            // In case of doubt, back out
            if (!firstLine || !lastLine) return;

            widgets.push(
              invisibleDecoration.range(firstLine.from, firstLine.to),
            );
            widgets.push(
              invisibleDecoration.range(lastLine.from, lastLine.to),
            );
            widgets.push(
              Decoration.line({
                class: "sb-fenced-code-iframe",
              }).range(firstLine.from),
            );
            widgets.push(
              Decoration.line({
                class: "sb-fenced-code-hide",
              }).range(lastLine.from),
            );

            lines.slice(1, lines.length - 1).forEach((line) => {
              widgets.push(
                Decoration.line({ class: "sb-line-table-outside" }).range(
                  line.from,
                ),
              );
            });

            const widget = renderMode === "markdown"
              ? new MarkdownWidget(
                from + lineStrings[0].length + 1,
                to - lineStrings[lineStrings.length - 1].length - 1,
                editor,
                lineStrings.slice(1, lineStrings.length - 1).join("\n"),
                codeWidgetCallback,
              )
              : new IFrameWidget(
                from + lineStrings[0].length + 1,
                to - lineStrings[lineStrings.length - 1].length - 1,
                editor,
                lineStrings.slice(1, lineStrings.length - 1).join("\n"),
                codeWidgetCallback,
              );
            widgets.push(
              Decoration.widget({
                widget: widget,
              }).range(from),
            );
            return false;
          }
          return true;
        }
        if (
          name === "CodeMark"
        ) {
          const parent = node.parent!;
          // Hide ONLY if CodeMark is not insine backticks (InlineCode) and the cursor is placed outside
          if (
            parent.node.name !== "InlineCode" &&
            !isCursorInRange(state, [parent.from, parent.to])
          ) {
            widgets.push(
              Decoration.line({
                class: "sb-line-code-outside",
              }).range(state.doc.lineAt(from).from),
            );
          }
        }
      },
    });
    return Decoration.set(widgets, true);
  });
}
