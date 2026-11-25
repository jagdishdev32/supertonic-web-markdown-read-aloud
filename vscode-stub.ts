// Stand-in for the 'vscode' module when bundling repo sources outside VS Code.
// voices.ts only reads vscode.env.language (UI language for display names).
export const env = { language: 'en' };
export default { env };
