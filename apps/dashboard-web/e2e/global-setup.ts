/**
 * Before any browser starts: the app answers and the seed file exists, each with a message that says what to
 * start, instead of a timeout in the first spec.
 */
import { BASE_URL, readSeed } from './stack';

export default async function globalSetup(): Promise<void> {
  readSeed();
  let response: Response;
  try {
    response = await fetch(BASE_URL, { redirect: 'manual' });
  } catch (error) {
    throw new Error(
      `nothing answers at ${BASE_URL}: start the stack with the apps (README, Development), or set E2E_BASE_URL`,
      { cause: error },
    );
  }
  if (!response.ok) throw new Error(`${BASE_URL} answered ${response.status}`);
}
