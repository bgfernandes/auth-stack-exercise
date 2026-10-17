/**
 * The documents database (docs/README.md §5.2): projects under an organization that lives in tenancy
 * (referenced by value, never joined across databases) and the documents whose two values the dashboard edits.
 * Roles and shares are relationships in SpiceDB (§5); `documents.zedtoken` is the permission snapshot stored
 * with the content (§7.3).
 */
import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The tenancy organization, by value. */
    organizationId: uuid('organization_id').notNull(),
    name: text('name').notNull(),
    /** The "Personal" project provisioning creates in each personal organization (§6.4); one per organization. */
    isPersonal: boolean('is_personal').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('projects_organization_id').on(table.organizationId),
    uniqueIndex('projects_one_personal_per_organization')
      .on(table.organizationId)
      .where(sql`${table.isPersonal}`),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    /** Denormalized from the project for filtering by organization. */
    organizationId: uuid('organization_id').notNull(),
    name: text('name').notNull(),
    value1: text('value_1').notNull(),
    value2: text('value_2').notNull(),
    /**
     * The ZedToken of the fully consistent check or relationship write the last content change ran under;
     * every read of the row checks `at_least_as_fresh` with it (§7.3). Written in the same statement as the
     * content, so it is never missing.
     */
    zedtoken: text('zedtoken').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** The `sub` of the last writer (the creator for a seeded or provisioned document). */
    updatedBy: text('updated_by').notNull(),
  },
  (table) => [
    index('documents_project_id').on(table.projectId),
    index('documents_organization_id').on(table.organizationId),
  ],
);

export type Project = typeof projects.$inferSelect;
export type Document = typeof documents.$inferSelect;

export const schema = { projects, documents };
export type DocumentsSchema = typeof schema;
