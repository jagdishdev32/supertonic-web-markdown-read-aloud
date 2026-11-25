/**
 * Pure-Node façade over the extension's own modules for the standalone web app.
 * Bundled with esbuild (vscode stubbed out) and required by server.mjs.
 */
export { renderMarkdownHtml } from './src/markdown/render';
export { normalizeForSpeech, applyPronunciations } from './src/markdown/normalize';
export { detectLocale, detectReliableLocale } from './src/languageDetector';
export {
  pickVoice,
  displayName,
  localeDisplay,
  curatedPair,
  allCuratedLocales,
  voicesForLocale,
  getVoice,
} from './src/voices';
export {
  SupertonicHttpEngine,
  SUPERTONIC_DEFAULT_ENDPOINT,
  SUPERTONIC_MAX_INPUT_LENGTH,
  supertonicStyleFor,
} from './src/engines/supertonicHttpEngine';
export { EdgeEngine } from './src/engines/edgeEngine';
