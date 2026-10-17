/**
 * The tenancy database (docs/README.md §5.1): the users mirror and the organizations with their
 * authentication-context policy. Membership and roles are relationships in SpiceDB, not rows here (§5).
 * `invitations` (ticket 17a) and `authz_decisions` (phase 3) arrive with their tickets.
 */
import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { type Policy } from './client/policy.js';

/** Created just in time at first login (§6.4); the IdP is the source of truth, this is a mirror. */
export const users = pgTable('users', {
  /** The Zitadel `sub`. */
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** The organization provisioning creates for each account (§5.1); not a security boundary. */
    isPersonal: boolean('is_personal').notNull().default(false),
    /** Set for personal organizations; the partial unique index below allows one per user. */
    ownerId: text('owner_id').references(() => users.id),
    /** Authentication-context floors (§9.1), validated by `policySchema` on write. */
    policy: jsonb('policy').$type<Policy>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('organizations_one_personal_per_owner')
      .on(table.ownerId)
      .where(sql`${table.isPersonal}`),
  ],
);

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;

export const schema = { users, organizations };
export type TenancySchema = typeof schema;
