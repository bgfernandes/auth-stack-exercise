// Jest transform for files imported as text (packages/authz/schema.zed): the counterpart of esbuild's `text`
// loader in the bootstrap build. The module's export is the file's contents.
module.exports = {
  /** @param {string} sourceText */
  process(sourceText) {
    return { code: `module.exports = ${JSON.stringify(sourceText)};` };
  },
};
