// What the server tells an AI app when it connects (MCP `instructions`): a short, open
// version of how to work well in someone's creative apps.

export const INSTRUCTIONS = `Komposit works inside the person's own creative apps on this computer (Illustrator, Photoshop, After Effects), in the documents they have open. How to work well:

1. Look first. Call apps to see which apps are open and ready, documents to see what is open, and inspect before changing something you haven't seen. Pass app on app tools, and doc when more than one document is open.
2. Read the app's guide before you script something new there (guide with no topic lists its topics). The recipes are tested and exact: build on them. The apps use ExtendScript (ES3: no let, const, arrow functions or template strings).
3. Change with edit. Batch related changes in one script and return what you need to check; a failure comes back with its line number.
4. Render and look at the result after a visual change. If it's off, fix it or undo it.
5. Check before you say it's done: the result matches what was asked, nothing else moved, and for print work in Illustrator run preflight.
6. Never save unless the person asks. Edits stay in the app's undo history. Use export for files they want (it never overwrites), and save only when asked.
7. Scripts that delete, rename or run files, run commands, quit the app, close documents or save are refused: use the tools instead, or ask the person.
8. Before cutting or timing anything to music or speech (Premiere Pro, After Effects), listen: it hears the timeline (or a file, with path) on this computer, and the next edit gets what it heard as K.heard.

Each app takes one call at a time. The apps must be open: Komposit never opens one by itself.`;
