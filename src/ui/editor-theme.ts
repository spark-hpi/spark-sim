// Editor in the style of spark-hpi.de: colours, font and size from the CSS variables (Settings and theme switch
// apply without rebuilding the editor), syntax colours like the website code highlighting.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { Theme } from "./viewer.ts";

const style = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--syn-fn)" },
  { tag: [t.className, t.definition(t.className)], color: "var(--syn-fn)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.self], color: "var(--syn-num)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-str)" },
  { tag: [t.standard(t.variableName), t.special(t.variableName)], color: "var(--syn-builtin)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.propertyName], color: "var(--syn-num)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--fg)" },
]);

export function editorTheme(theme: Theme): Extension {
  const base = EditorView.theme(
    {
      "&": { color: "var(--fg)", backgroundColor: "transparent", height: "100%", fontSize: "var(--ed-size)" },
      ".cm-content": { fontFamily: "var(--ed-font)", caretColor: "var(--link)" },
      ".cm-scroller": { fontFamily: "var(--ed-font)", lineHeight: "1.55" },
      ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", border: "none", borderRight: "1px solid var(--rule-soft)" },
      ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--fg) 5%, transparent)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg)" },
      ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--link)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "color-mix(in oklab, var(--link) 30%, transparent) !important",
      },
      ".cm-matchingBracket": { outline: "1px solid var(--link)", backgroundColor: "transparent" },
      ".cm-foldPlaceholder": { background: "transparent", border: "1px solid var(--rule)", color: "var(--muted)" },
      ".cm-tooltip": { background: "var(--bg)", border: "1px solid var(--fg)", boxShadow: "4px 4px 0 var(--fg)", fontFamily: "var(--mono)" },
      ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--fg)", color: "var(--bg)" },
      ".cm-tooltip.cm-completionInfo": { maxWidth: "420px", padding: "6px 9px", fontFamily: "var(--serif)", fontSize: "var(--serif-s)" },
      ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--ed-font)", fontSize: "calc(var(--ed-size) * 0.93)" },
      ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "1em" },
      ".cm-panels": { background: "var(--bg)", color: "var(--fg)", borderColor: "var(--rule)" },
      ".cm-panel.cm-search": { fontFamily: "var(--mono)", fontSize: "var(--fs)" },
      ".cm-panel.cm-search input, .cm-panel.cm-search button": { font: "inherit", border: "1px solid var(--rule)", borderRadius: "0", background: "transparent", color: "var(--fg)" },
      ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warn) 30%, transparent)" },
      ".cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--link) 40%, transparent)" },
      ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--danger)", textUnderlineOffset: "3px" },
      ".cm-diagnostic-error": { borderLeft: "4px solid var(--danger)", fontFamily: "var(--ed-font)" },
    },
    { dark: theme === "dark" },
  );
  return [base, syntaxHighlighting(style)];
}
