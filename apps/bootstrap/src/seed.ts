/** The seeded users of docs/README.md §6.3. Ticket 12 adds the organization, projects, and documents. */
export interface SeedUser {
  /** Key in seed.json and in the end-to-end tests. */
  key: string;
  /** Username and email; an email as username keeps the login name free of the organization domain suffix. */
  email: string;
  givenName: string;
  familyName: string;
}

export const SEED_USERS: readonly SeedUser[] = [
  { key: 'alice', email: 'alice@example.com', givenName: 'Alice', familyName: 'Adams' },
  { key: 'bob', email: 'bob@example.com', givenName: 'Bob', familyName: 'Baker' },
  { key: 'carol', email: 'carol@example.com', givenName: 'Carol', familyName: 'Clark' },
];
