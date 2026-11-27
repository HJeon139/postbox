// A model’s own tool-call markup, left in the text a backend streams as the reply (#1916). On deepseek-3.2, Kiro’s
// message chunks end with `<｜DSML｜function_calls` where the model then called a tool (recorded in
// tests/fixtures/kiro-cli/tool-load-deepseek.jsonl, kiro-cli 3.6.2), and the person saw it in the reply. Only a marker
// that ends the chunk goes, with the space before it: words that mention it elsewhere, in code or a sentence, stay.
// DeepSeek’s recorded chunks are whole messages. Kiro streams other models in token-sized chunks (mcp-failed.jsonl,
// isolated-deny.jsonl), and a marker split across chunks like those isn’t caught here.

/** DeepSeek’s tool-call marker at the end of a chunk: fullwidth bars, a name, its `>` if it has one, then only space. */
// A backtick before it is a quote in inline code that a token-sized chunk ended (#1916), not the model’s call.
const TRAILING_MARKER = /\s*(?<!`)<｜DSML｜[A-Za-z_]+>?\s*$/u;

/** The chunk without a tool-call marker at its end. @param {string} text */
export const withoutToolMarkup = (text) => text.replace(TRAILING_MARKER, '');
