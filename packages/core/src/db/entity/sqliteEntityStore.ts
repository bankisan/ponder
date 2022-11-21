import type Sqlite from "better-sqlite3";

import {
  DerivedField,
  FieldKind,
  PonderSchema,
  ScalarField,
} from "@/schema/types";

import { EntityFilter, EntityStore } from "./entityStore";
import { sqlOperatorsForFilterType } from "./utils";

export class SqliteEntityStore implements EntityStore {
  db: Sqlite.Database;
  schema?: PonderSchema;

  constructor(db: Sqlite.Database) {
    this.db = db;
  }

  async migrate(schema: PonderSchema) {
    schema.entities.forEach((entity) => {
      // Drop the table if it already exists
      this.db.prepare(`DROP TABLE IF EXISTS "${entity.name}"`).run();

      // Build the create table statement using field migration fragments.
      // TODO: Update this so the generation of the field migration fragments happens here
      // instead of when the PonderSchema gets built.
      const columnStatements = entity.fields
        .filter(
          // This type guard is wrong, could actually be any FieldKind that's not derived (obvs)
          (field): field is ScalarField => field.kind !== FieldKind.DERIVED
        )
        .map((field) => field.migrateUpStatement);

      this.db
        .prepare(
          `CREATE TABLE "${entity.name}" (${columnStatements.join(", ")})`
        )
        .run();
    });

    this.schema = schema;
  }

  async getEntity<T extends Record<string, unknown>>(
    entityName: string,
    id: string
  ): Promise<T | null> {
    if (!this.schema) {
      throw new Error(`EntityStore has not been initialized with a schema yet`);
    }

    const statement = `SELECT "${entityName}".* FROM "${entityName}" WHERE "${entityName}"."id" = @id`;
    const instance = this.db.prepare(statement).get({ id });

    if (!instance) return null;

    return this.deserialize(entityName, instance);
  }

  async insertEntity<T extends Record<string, unknown>>(
    entityName: string,
    id: string,
    instance: T
  ): Promise<T> {
    if (!this.schema) {
      throw new Error(`EntityStore has not been initialized with a schema yet`);
    }

    if (instance.id && instance.id !== id) {
      throw new Error(
        `Invalid ${entityName}.insert(id, instance): If instance.id is defined, it must match id`
      );
    }

    const columnStatements = Object.entries(instance).map(
      ([fieldName, value]) => ({
        column: `"${fieldName}"`,
        value: `'${value}'`,
      })
    );

    const insertFragment = `(${columnStatements
      .map((s) => s.column)
      .join(", ")}) VALUES (${columnStatements
      .map((s) => s.value)
      .join(", ")})`;

    const statement = `INSERT INTO "${entityName}" ${insertFragment} RETURNING *`;
    const insertedEntity = this.db.prepare(statement).get();

    return this.deserialize(entityName, insertedEntity);
  }

  async updateEntity<T extends Record<string, unknown>>(
    entityName: string,
    id: string,
    instance: Partial<T>
  ): Promise<T> {
    if (!this.schema) {
      throw new Error(`EntityStore has not been initialized with a schema yet`);
    }

    const columnStatements = Object.entries(instance).map(
      ([fieldName, value]) => ({
        column: `"${fieldName}"`,
        value: `'${value}'`,
      })
    );

    const updateFragment = columnStatements
      .filter(({ column }) => column !== "id")
      .map(({ column, value }) => `${column} = ${value}`)
      .join(", ");

    const statement = `UPDATE "${entityName}" SET ${updateFragment} WHERE "id" = @id RETURNING *`;
    const updatedEntity = this.db.prepare(statement).get({ id });

    return this.deserialize(entityName, updatedEntity);
  }

  async upsertEntity<T extends Record<string, unknown>>(
    entityName: string,
    id: string,
    instance: T
  ): Promise<T> {
    if (!this.schema) {
      throw new Error(`EntityStore has not been initialized with a schema yet`);
    }

    const columnStatements = Object.entries(instance).map(
      ([fieldName, value]) => ({
        column: `"${fieldName}"`,
        value: `'${value}'`,
      })
    );

    const insertFragment = `(${columnStatements
      .map((s) => s.column)
      .join(", ")}) VALUES (${columnStatements
      .map((s) => s.value)
      .join(", ")})`;

    const updateFragment = columnStatements
      .filter(({ column }) => column !== "id")
      .map(({ column, value }) => `${column} = ${value}`)
      .join(", ");

    const statement = `INSERT INTO "${entityName}" ${insertFragment} ON CONFLICT("id") DO UPDATE SET ${updateFragment} RETURNING *`;

    const upsertedEntity = this.db.prepare(statement).get({ id });

    return this.deserialize(entityName, upsertedEntity);
  }

  async deleteEntity(entityName: string, id: string): Promise<boolean> {
    if (!this.schema) {
      throw new Error(`EntityStore has not been initialized with a schema yet`);
    }

    const statement = `DELETE FROM "${entityName}" WHERE "id" = @id`;

    const { changes } = this.db.prepare(statement).run({ id: id });

    // `changes` is equal to the number of rows that were updated/inserted/deleted by the query.
    return changes === 1;
  }

  async getEntities<T>(
    entityName: string,
    filter?: EntityFilter
  ): Promise<T[]> {
    if (!this.schema) {
      throw new Error(`EntityStore has not been initialized with a schema yet`);
    }

    const where = filter?.where;
    const first = filter?.first;
    const skip = filter?.skip;
    const orderBy = filter?.orderBy;
    const orderDirection = filter?.orderDirection;

    const fragments = [];

    if (where) {
      const whereFragments: string[] = [];

      for (const [field, value] of Object.entries(where)) {
        const [fieldName, rawFilterType] = field.split(/_(.*)/s);

        // This is a hack to handle the = operator, which the regex above doesn't handle
        const filterType = rawFilterType === undefined ? "" : rawFilterType;

        const sqlOperators = sqlOperatorsForFilterType[filterType];
        if (!sqlOperators) {
          throw new Error(
            `SQL operators not found for filter type: ${filterType}`
          );
        }

        const { operator, patternPrefix, patternSuffix, isList } = sqlOperators;

        let finalValue = value;

        if (patternPrefix) finalValue = patternPrefix + finalValue;
        if (patternSuffix) finalValue = finalValue + patternSuffix;

        if (isList) {
          finalValue = `(${(finalValue as (string | number)[]).join(",")})`;
        } else {
          finalValue = `'${finalValue}'`;
        }

        whereFragments.push(`"${fieldName}" ${operator} ${finalValue}`);
      }

      fragments.push(`WHERE ${whereFragments.join(" AND ")}`);
    }

    if (orderBy) {
      fragments.push(`ORDER BY "${orderBy}"`);
    }

    if (orderDirection) {
      fragments.push(`${orderDirection}`);
    }

    if (first) {
      fragments.push(`LIMIT ${first}`);
    }

    if (skip) {
      if (!first) {
        fragments.push(`LIMIT -1`); // Must add a no-op limit for SQLite to handle offset
      }
      fragments.push(`OFFSET ${skip}`);
    }

    const statement = `SELECT * FROM "${entityName}" ${fragments.join(" ")}`;

    const instances = this.db.prepare(statement).all();

    return instances.map((instance) =>
      this.deserialize<T>(entityName, instance)
    );
  }

  async getEntityDerivedField(
    entityName: string,
    id: string,
    derivedFieldName: string
  ) {
    if (!this.schema) {
      throw new Error(`EntityStore has not been initialized with a schema yet`);
    }

    const entity = this.schema.entityByName[entityName];
    if (!entity) {
      throw new Error(`Entity not found in schema: ${entityName}`);
    }

    const derivedField = entity.fields.find(
      (field): field is DerivedField =>
        field.kind === FieldKind.DERIVED && field.name === derivedFieldName
    );

    if (!derivedField) {
      throw new Error(
        `Derived field not found: ${entityName}.${derivedFieldName}`
      );
    }

    const derivedFieldInstances = await this.getEntities(
      derivedField.derivedFromEntityName,
      {
        where: {
          [`${derivedField.derivedFromFieldName}`]: id,
        },
      }
    );

    return derivedFieldInstances;
  }

  deserialize<T>(entityName: string, instance: Record<string, unknown>) {
    if (!this.schema) {
      throw new Error(`EntityStore has not been initialized with a schema yet`);
    }

    const entity = this.schema.entityByName[entityName];
    if (!entity) {
      throw new Error(`Entity not found in schema: ${entityName}`);
    }

    const deserializedInstance = { ...instance };

    // For each property on the instance, look for a field defined on the entity
    // with the same name and apply any required deserialization transforms.
    Object.entries(instance).forEach(([fieldName, value]) => {
      const field = entity.fieldByName[fieldName];
      if (!field) return;

      switch (field.kind) {
        case FieldKind.LIST: {
          deserializedInstance[fieldName] = (value as string).split(",");
          break;
        }
        default: {
          deserializedInstance[fieldName] = value;
        }
      }
    });

    return deserializedInstance as T;
  }
}
