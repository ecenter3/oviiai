import { z } from 'zod';

/** 介面規格 §1：`?page=1&size=20` → `{ items, total, page, size }` */
export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}
