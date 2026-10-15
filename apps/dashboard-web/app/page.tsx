import { cookies } from 'next/headers';

import { CLAIMS_COOKIE } from '../lib/oidc';

const SHOWN_CLAIMS = ['sub', 'email', 'iss', 'aud', 'auth_time', 'amr', 'sid', 'name', 'exp'];

export default async function Page() {
  const raw = (await cookies()).get(CLAIMS_COOKIE)?.value;
  const claims = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;

  return (
    <main>
      <h1>dashboard-web</h1>
      {claims ? (
        <>
          <p>ID token claims from the last login:</p>
          <table>
            <tbody>
              {SHOWN_CLAIMS.map((name) => (
                <tr key={name}>
                  <th style={{ textAlign: 'left', paddingRight: '1rem' }}>{name}</th>
                  <td data-claim={name}>{JSON.stringify(claims[name])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p>Not logged in.</p>
      )}
      <p>
        <a href="/auth/login">Log in</a>
      </p>
    </main>
  );
}
