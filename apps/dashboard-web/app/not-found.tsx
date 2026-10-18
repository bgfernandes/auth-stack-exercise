import Link from 'next/link';

/** The 404 page: a document that does not exist, or one the user may not learn exists (docs/README.md §6.5). */
export default function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <p>There is nothing at this address.</p>
      <p>
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
