/**
 * Before any browser starts: both web apps answer (the single sign-on spec opens tenancy-web too) and the seed
 * file exists, each with a message that says what to start, instead of a timeout in the first spec.
 */
import { BASE_URL, readSeed, TENANCY_WEB_URL } from './stack';

export default async function globalSetup(): Promise<void> {
  readSeed();
  await answers(BASE_URL, 'E2E_BASE_URL');
  await answers(TENANCY_WEB_URL, 'E2E_TENANCY_WEB_URL');
}

async function answers(url: string, variable: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'manual' });
  } catch (error) {
    throw new Error(
      `nothing answers at ${url}: start the stack with the apps (README, Development), or set ${variable}`,
      { cause: error },
    );
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
}
