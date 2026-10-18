/**
 * `@auth-stack/documents`: schema, migrations, and the service of the documents domain (docs/README.md §3.1).
 * Imported by `dashboard-web` in phase 1 and only by `dashboard-api` from phase 2.
 */
export { DocumentsError, isDocumentsError, type DocumentsErrorCode } from './errors';
export {
  documents,
  projects,
  schema,
  type Document,
  type DocumentsSchema,
  type Project,
} from './schema';
export {
  createDocumentsService,
  PERSONAL_PROJECT_NAME,
  WELCOME_DOCUMENT,
  type DocumentsDb,
  type DocumentsService,
  type PersonalWorkspace,
  type VisibleDocument,
} from './service';
export { documentValuesSchema, parseDocumentValues, type DocumentValues } from './values';
