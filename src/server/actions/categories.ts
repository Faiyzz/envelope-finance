/**
 * Category actions - TD-05 §9
 */

import { z } from 'zod';
import { defineAction } from '@/server/actions/pipeline';
import { requireUser } from '@/server/auth/session';
import { getPool } from '@/server/db/client';
import { uuidv7 } from 'uuidv7';
import { ValidationError, NotFound, Conflict, RuleViolation } from '@/domain/errors';

const DEFAULT_CATEGORIES = {
  expense: [
    { name: 'Electricity', group: 'home' },
    { name: 'Gas', group: 'home' },
    { name: 'Water', group: 'home' },
    { name: 'Internet', group: 'home' },
    { name: 'Rent', group: 'home' },
    { name: 'Groceries', group: 'home' },
    { name: 'Household', group: 'home' },
    { name: 'Maintenance', group: 'home' },
    { name: 'Daily Items', group: 'home' },
    { name: 'Eggs', group: 'home' },
    { name: 'Vegetables', group: 'home' },
    { name: 'Other (Home)', group: 'home', isSystem: true },
    { name: 'Food', group: 'personal' },
    { name: 'Fuel', group: 'personal' },
    { name: 'Shopping', group: 'personal' },
    { name: 'Entertainment', group: 'personal' },
    { name: 'Transport', group: 'personal' },
    { name: 'Health', group: 'personal' },
    { name: 'Other (Personal)', group: 'personal', isSystem: true },
    { name: 'Uncategorized', group: null, isSystem: true },
  ],
  income: [
    { name: 'Salary', group: 'other' },
    { name: 'Business', group: 'other' },
    { name: 'Gift', group: 'other' },
    { name: 'Committee payout', group: 'other' },
    { name: 'Other income', group: 'other' },
    { name: 'Uncategorized', group: null, isSystem: true },
  ],
};

/**
 * Seed default categories for a user
 */
export async function seedDefaultCategories(userId: string, pool: any): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const kind of ['expense', 'income'] as const) {
      const list: ReadonlyArray<{ name: string; group: string | null; isSystem?: boolean }> = DEFAULT_CATEGORIES[kind];
      for (const cat of list) {
        const sortOrder = list.indexOf(cat);
        await client.query(
          `INSERT INTO categories (id, user_id, name, kind, group_name, is_system, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, kind, lower(btrim(name))) DO NOTHING`,
          [uuidv7(), userId, cat.name, kind, cat.group, cat.isSystem || false, sortOrder]
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const CreateCategorySchema = z.object({
  kind: z.enum(['expense', 'income']),
  name: z.string().trim().min(1).max(40),
  group: z.enum(['home', 'personal', 'other']).optional(),
});

export const createCategory = defineAction({
  name: 'categories.create',
  input: CreateCategorySchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    // Check name uniqueness per kind
    const existing = await pool.query(
      `SELECT id FROM categories 
       WHERE user_id = $1 AND kind = $2 AND lower(btrim(name)) = lower(btrim($3))`,
      [userId, input.kind, input.name]
    );

    if (existing.rows.length > 0) {
      throw new ValidationError({ name: 'Category name already exists' });
    }

    const sortOrderResult = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order 
       FROM categories 
       WHERE user_id = $1 AND kind = $2`,
      [userId, input.kind]
    );
    const sortOrder = sortOrderResult.rows[0].next_order;

    await pool.query(
      `INSERT INTO categories (id, user_id, name, kind, group_name, is_system, sort_order)
       VALUES ($1, $2, $3, $4, $5, false, $6)`,
      [uuidv7(), userId, input.name.trim(), input.kind, input.group || null, sortOrder]
    );

    return { success: true };
  },
  revalidate: () => ['/'],
});

const RenameCategorySchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().optional(),
  name: z.string().trim().min(1).max(40),
});

export const renameCategory = defineAction({
  name: 'categories.rename',
  input: RenameCategorySchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load category
      const catResult = await client.query(
        `SELECT id, is_system, kind, updated_at FROM categories 
         WHERE id = $1 AND user_id = $2`,
        [input.id, userId]
      );

      if (catResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Category not found');
      }

      const cat = catResult.rows[0];

      if (cat.is_system) {
        await client.query('ROLLBACK');
        throw new RuleViolation('System categories cannot be renamed');
      }

      // Optimistic concurrency
      if (input.updatedAt && new Date(cat.updated_at).getTime() !== new Date(input.updatedAt).getTime()) {
        await client.query('ROLLBACK');
        throw new Conflict('This was changed on another device. Reload to see the latest.');
      }

      // Check name uniqueness
      const existing = await client.query(
        `SELECT id FROM categories 
         WHERE user_id = $1 AND kind = $2 AND lower(btrim(name)) = lower(btrim($3)) AND id != $4`,
        [userId, cat.kind, input.name, input.id]
      );

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new ValidationError({ name: 'Category name already exists' });
      }

      await client.query(
        'UPDATE categories SET name = $1 WHERE id = $2 AND user_id = $3',
        [input.name.trim(), input.id, userId]
      );

      await client.query('COMMIT');

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/'],
});

export const archiveCategory = defineAction({
  name: 'categories.archive',
  input: z.object({
    id: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const catResult = await client.query(
        `SELECT id, is_system FROM categories 
         WHERE id = $1 AND user_id = $2`,
        [input.id, userId]
      );

      if (catResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Category not found');
      }

      if (catResult.rows[0].is_system) {
        await client.query('ROLLBACK');
        throw new RuleViolation('System categories cannot be archived');
      }

      await client.query(
        `UPDATE categories SET status = 'archived' WHERE id = $1 AND user_id = $2`,
        [input.id, userId]
      );

      await client.query('COMMIT');

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/'],
});

export const unarchiveCategory = defineAction({
  name: 'categories.unarchive',
  input: z.object({
    id: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();

    await pool.query(
      `UPDATE categories SET status = 'active' WHERE id = $1 AND user_id = $2`,
      [input.id, userId]
    );

    return { success: true };
  },
  revalidate: () => ['/'],
});

export const deleteCategory = defineAction({
  name: 'categories.delete',
  input: z.object({
    id: z.string().uuid(),
  }),
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if category is system
      const catResult = await client.query(
        `SELECT id, is_system FROM categories 
         WHERE id = $1 AND user_id = $2`,
        [input.id, userId]
      );

      if (catResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFound('Category not found');
      }

      if (catResult.rows[0].is_system) {
        await client.query('ROLLBACK');
        throw new RuleViolation('System categories cannot be deleted');
      }

      // Check if anything references this category (including soft-deleted transactions)
      const refCheck = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM transactions WHERE user_id = $1 AND category_id = $2
         ) AS has_refs`,
        [userId, input.id]
      );

      if (refCheck.rows[0].has_refs) {
        await client.query('ROLLBACK');
        throw new RuleViolation('This category is used in transactions. Delete or recategorize them first.');
      }

      await client.query(
        'DELETE FROM categories WHERE id = $1 AND user_id = $2',
        [input.id, userId]
      );

      await client.query('COMMIT');

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/'],
});

const MergeCategoriesSchema = z.object({
  fromId: z.string().uuid(),
  intoId: z.string().uuid(),
});

export const mergeCategories = defineAction({
  name: 'categories.merge',
  input: MergeCategoriesSchema,
  async run(ctx, input) {
    const { userId } = await requireUser();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Load both categories
      const catsResult = await client.query(
        `SELECT id, kind, is_system FROM categories 
         WHERE id IN ($1, $2) AND user_id = $3`,
        [input.fromId, input.intoId, userId]
      );

      if (catsResult.rows.length !== 2) {
        await client.query('ROLLBACK');
        throw new NotFound('One or both categories not found');
      }

      const fromCat = catsResult.rows.find((r: any) => r.id === input.fromId);
      const intoCat = catsResult.rows.find((r: any) => r.id === input.intoId);

      // Validate same kind
      if (fromCat.kind !== intoCat.kind) {
        await client.query('ROLLBACK');
        throw new ValidationError({ merge: 'Can only merge categories of the same kind' });
      }

      // System categories cannot be source
      if (fromCat.is_system) {
        await client.query('ROLLBACK');
        throw new RuleViolation('System categories cannot be merged from');
      }

      // Update transactions
      await client.query(
        `UPDATE transactions 
         SET category_id = $1 
         WHERE user_id = $2 AND category_id = $3`,
        [input.intoId, userId, input.fromId]
      );

      // Archive source category
      await client.query(
        `UPDATE categories SET status = 'archived' WHERE id = $1 AND user_id = $2`,
        [input.fromId, userId]
      );

      await client.query('COMMIT');

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  revalidate: () => ['/'],
});
