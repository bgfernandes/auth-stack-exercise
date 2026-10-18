import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { documentForEdit } from '../../../../lib/documents';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}

/**
 * The edit form (docs/README.md §6.5): shown only after `edit` passed at least as fresh as the row's token
 * (§7.3). A user who may only view the document gets the forbidden page; one who may not see it gets the
 * not-found page, so the URL reveals nothing. The form posts to `POST /documents/:id`.
 */
export default async function EditDocumentPage({ params, searchParams }: Props) {
  const { id } = await params;
  const result = await documentForEdit(id);
  if (result.state === 'unauthenticated') redirect('/auth/login');
  if (result.state === 'not_found') notFound();
  if (result.state === 'forbidden') return <Forbidden />;
  const { document } = result;
  const { error } = await searchParams;
  return (
    <main>
      <p>
        <Link href="/dashboard">Back to the dashboard</Link>
      </p>
      <h1>{document.name}</h1>
      {error !== undefined && (
        <p className="error" role="alert">
          Each value must be 1 to 200 characters. Nothing was saved.
        </p>
      )}
      <form method="post" action={`/documents/${document.id}`}>
        <p>
          <label htmlFor="value1">Value 1</label>
          <input
            id="value1"
            name="value1"
            defaultValue={document.value1}
            required
            maxLength={200}
          />
        </p>
        <p>
          <label htmlFor="value2">Value 2</label>
          <input
            id="value2"
            name="value2"
            defaultValue={document.value2}
            required
            maxLength={200}
          />
        </p>
        <button type="submit">Save</button>
      </form>
    </main>
  );
}

function Forbidden() {
  return (
    <main>
      <h1>Read-only</h1>
      <p>You can view this document but not edit it.</p>
      <p>
        <Link href="/dashboard">Back to the dashboard</Link>
      </p>
    </main>
  );
}
