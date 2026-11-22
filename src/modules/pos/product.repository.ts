import { uuidv7 } from '@gymflow/core';
import { TenantRepository } from '../../platform/db/tenant-repository.js';

export type ProductRecord = {
  id: string;
  sku: string;
  name: string;
  priceCents: bigint;
  tracksInventory: boolean;
  isActive: boolean;
};

const SELECT = {
  id: true, sku: true, name: true, priceCents: true,
  tracksInventory: true, isActive: true,
} as const;

export class ProductRepository extends TenantRepository {
  /** Para la pantalla de Módulos: productos vivos en el catálogo. */
  async activeCount(): Promise<number> {
    return this.db.product.count({ where: this.scope({ isActive: true, deletedAt: null }) });
  }

  async findById(id: string): Promise<ProductRecord | null> {
    const row = await this.db.product.findFirst({
      where: this.scope({ id, deletedAt: null }), select: SELECT,
    });
    return row as ProductRecord | null;
  }

  async findManyByIds(ids: readonly string[]): Promise<ProductRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.product.findMany({
      where: this.scope({ id: { in: [...ids] }, deletedAt: null }), select: SELECT,
    });
    return rows as ProductRecord[];
  }

  async list(activeOnly = true): Promise<ProductRecord[]> {
    const rows = await this.db.product.findMany({
      where: this.scope({ deletedAt: null, ...(activeOnly ? { isActive: true } : {}) }),
      select: SELECT,
      orderBy: { name: 'asc' },
    });
    return rows as ProductRecord[];
  }

  async create(input: {
    sku: string; name: string; priceCents: bigint; tracksInventory?: boolean;
  }): Promise<ProductRecord> {
    const row = await this.db.product.create({
      data: {
        id: uuidv7(),
        organizationId: this.organizationId,
        sku: input.sku.toUpperCase(),
        name: input.name,
        priceCents: input.priceCents,
        tracksInventory: input.tracksInventory ?? true,
      },
      select: SELECT,
    });
    return row as ProductRecord;
  }

  async update(id: string, patch: {
    name?: string; priceCents?: bigint; isActive?: boolean;
  }): Promise<ProductRecord | null> {
    const res = await this.db.product.updateMany({
      where: this.scope({ id, deletedAt: null }), data: patch,
    });
    return res.count === 0 ? null : this.findById(id);
  }
}
