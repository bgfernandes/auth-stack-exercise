/**
 * The save route's handler (docs/README.md §6.5, §9): a same-origin `POST` of the edit form, as the signed-in
 * user, validated before anything is looked up, enforced by the domain at full consistency, answered with a
 * redirect the browser follows or with the status a replayed `curl` reads. Built with its dependencies so the
 * unit tests fake them; `app/documents/[id]/route.ts` binds it to the app.
 */
import { assertSameOrigin } from '@auth-stack/auth';
import {
  documentValuesSchema,
  isDocumentsError,
  type DocumentsService,
} from '@auth-stack/documents';
import { type UserContext } from '@auth-stack/tenancy/client';

import { type AppLogger } from './log';

export interface DocumentSaverDeps {
  documents: Pick<DocumentsService, 'updateDocument'>;
  /** The app's public URL: what the request's `Origin` must match, and the base of the redirects. */
  appUrl: string;
  /** The user behind the request's session cookie, with a live access token; undefined when there is none. */
  userFromRequest: (request: Request) => Promise<UserContext | undefined>;
  logger: Pick<AppLogger, 'info' | 'warn'>;
}

export type DocumentSaver = (request: Request, documentId: string) => Promise<Response>;

export function createDocumentSaver(deps: DocumentSaverDeps): DocumentSaver {
  const { documents, appUrl, userFromRequest, logger } = deps;
  const redirect = (path: string) => Response.redirect(new URL(path, appUrl), 303);

  return async (request, documentId) => {
    try {
      assertSameOrigin(request, appUrl);
    } catch (error) {
      logger.warn('document.save_rejected', {
        reason: error instanceof Error ? error.message : 'origin',
      });
      return new Response('Forbidden', { status: 403 });
    }
    const user = await userFromRequest(request);
    if (!user) return new Response('Unauthorized', { status: 401 });

    // Validation before any lookup: a bad body answers the same for every ID, so it leaks nothing (§9).
    const form = await formOf(request);
    if (!form) return new Response('Bad Request', { status: 400 });
    const values = documentValuesSchema.safeParse({
      value1: form.get('value1'),
      value2: form.get('value2'),
    });
    if (!values.success)
      return redirect(`/documents/${encodeURIComponent(documentId)}/edit?error=values`);

    try {
      await documents.updateDocument(user, documentId, values.data);
    } catch (error) {
      if (!isDocumentsError(error)) throw error;
      logger.info('document.save_denied', { sub: user.sub, documentId, code: error.code });
      return error.code === 'forbidden'
        ? new Response('Forbidden', { status: 403 })
        : new Response('Not Found', { status: 404 });
    }
    logger.info('document.updated', { sub: user.sub, documentId });
    return redirect(`/dashboard?saved=${encodeURIComponent(documentId)}`);
  };
}

/** The form body, or undefined when the request does not carry one (a crafted request). */
async function formOf(request: Request): Promise<FormData | undefined> {
  try {
    return await request.formData();
  } catch {
    return undefined;
  }
}
