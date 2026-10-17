/**
 * `schema.zed` is imported as text: esbuild's `text` loader in the bootstrap build and a one-line Jest transform
 * (jest.text-transform.cjs) both hand the file's contents over as the default export.
 */
declare module '*.zed' {
  const text: string;
  export default text;
}
