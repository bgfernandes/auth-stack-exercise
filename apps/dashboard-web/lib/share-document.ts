/**
 * The share route's handler (docs/README.md §6.8, §9): a same-origin `POST` of the share form carrying the
 * session's synchronizer token, as the signed-in user, one choice per member (`role:<sub>` is `none`, `viewer`, or `editor`), turned into the set the API
 * replaces the document's direct shares with, and answered with a redirect the browser follows or with the
 * status a replayed `curl` reads. The API is the control: the page lists member IDs, but a crafted one is refused
 * there (`not_a_member`), never pre-empted here. Built with its dependencies so the unit tests fake them;
 * `app/documents/[id]/shares/route.ts` binds it to the app.
 */
import { assertSameOrigin, CSRF_FIELD } from '@auth-stack/auth';
import {
  isDocumentsClientError,
  type DocumentsClient,
  type DocumentShares,
} from '@auth-stack/documents/client';
import { type UserContext } from '@auth-stack/tenancy/client';

import { refusalOf } from './api-refusal';
import { type AppLogger } from './log';

export interface DocumentSharerDeps {
  documents: Pick<DocumentsClient, 'setDocumentShares'>;
  /** The app's public URL: what the request's `Origin` must match, and the base of the redirects. */
  appUrl: string;
  /** The user behind the request's session cookie, with a live access token; undefined when there is none. */
  userFromRequest: (request: Request) => Promise<UserContext | undefined>;
  /** Whether the posted `csrf_token` is the session's (§9, "CSRF"): the third layer, after the origin check. */
  verifyCsrfToken: (presented: unknown) => Promise<boolean>;
  logger: Pick<AppLogger, 'info' | 'warn'>;
}

export type DocumentSharer = (request: Request, documentId: string) => Promise<Response>;

const STATUS_OF = { unauthenticated: 401, forbidden: 403, not_found: 404 } as const;
const TEXT_OF = {
  unauthenticated: 'Unauthorized',
  forbidden: 'Forbidden',
  not_found: 'Not Found',
} as const;
const FIELD = 'role:';
const ROLES = new Set(['none', 'viewer', 'editor']);

export function createDocumentSharer(deps: DocumentSharerDeps): DocumentSharer {
  const { documents, appUrl, userFromRequest, verifyCsrfToken, logger } = deps;
  const redirect = (path: string) => Response.redirect(new URL(path, appUrl), 303);

  return async (request, documentId) => {
    try {
      assertSameOrigin(request, appUrl);
    } catch (error) {
      logger.warn('document.share_rejected', {
        reason: error instanceof Error ? error.message : 'origin',
      });
      return new Response('Forbidden', { status: 403 });
    }
    const user = await userFromRequest(request);
    if (!user) return new Response('Unauthorized', { status: 401 });

    // The form's shape before any lookup (§9): a crafted body answers the same for every ID.
    const form = await formOf(request);
    if (!form) return new Response('Bad Request', { status: 400 });
    if (!(await verifyCsrfToken(form.get(CSRF_FIELD)))) {
      logger.warn('document.share_rejected', { reason: 'csrf_token_invalid' });
      return new Response('Forbidden', { status: 403 });
    }
    const shares = sharesOf(form);
    if (!shares) return new Response('Bad Request', { status: 400 });

    try {
      await documents.setDocumentShares(user, documentId, shares);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal) {
        logger.info('document.share_denied', { sub: user.sub, documentId, code: refusal });
        return new Response(TEXT_OF[refusal], { status: STATUS_OF[refusal] });
      }
      // A chosen member who is no member of the organization any more: back to the form, which lists who is.
      if (isDocumentsClientError(error) && error.code === 'not_a_member') {
        logger.info('document.share_denied', { sub: user.sub, documentId, code: error.code });
        return redirect(`/documents/${encodeURIComponent(documentId)}/share?error=member`);
      }
      throw error;
    }
    logger.info('document.shared', {
      sub: user.sub,
      documentId,
      editors: shares.editors.length,
      viewers: shares.viewers.length,
    });
    return redirect(`/dashboard?shared=${encodeURIComponent(documentId)}`);
  };
}

/** The set the form describes: one known role per `role:<sub>` field, no member twice; undefined otherwise. */
export function sharesOf(form: FormData): DocumentShares | undefined {
  const shares: DocumentShares = { editors: [], viewers: [] };
  const seen = new Set<string>();
  for (const [key, value] of form.entries()) {
    if (!key.startsWith(FIELD)) continue;
    const sub = key.slice(FIELD.length);
    if (!sub || seen.has(sub) || typeof value !== 'string' || !ROLES.has(value)) return undefined;
    seen.add(sub);
    if (value === 'editor') shares.editors.push(sub);
    else if (value === 'viewer') shares.viewers.push(sub);
  }
  return shares;
}

/** The form body, or undefined when the request does not carry one (a crafted request). */
async function formOf(request: Request): Promise<FormData | undefined> {
  try {
    return await request.formData();
  } catch {
    return undefined;
  }
}
