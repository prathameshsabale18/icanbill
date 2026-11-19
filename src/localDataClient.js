const DATA_PREFIX = 'billing_mvp_local_v1:';
const DATABASE_KEY = 'billing_mvp_local_v2:database';
const FILE_DB_NAME = 'billing-mvp-local-files';
const FILE_STORE_NAME = 'objects';
const TABLE_NAMES = new Set([
  'clients',
  'documents',
  'invoice_items',
  'invoices',
  'orders',
  'payments',
  'products',
  'purchase_order_items',
  'purchase_orders',
  'quotation_items',
  'quotations',
  'suppliers',
  'business_settings',
]);

if (typeof localStorage !== 'undefined') {
  localStorage.removeItem(`${DATA_PREFIX}session`);
  localStorage.removeItem(`${DATA_PREFIX}profiles`);
}

function getLocalStorage() {
  if (typeof localStorage === 'undefined') {
    throw new Error('Local browser storage is unavailable.');
  }

  return localStorage;
}

function readLegacyTable(table) {
  const raw = getLocalStorage().getItem(`${DATA_PREFIX}${table}`);
  if (!raw) return [];

  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) {
    throw new Error(`Stored ${table} data is not a valid list.`);
  }

  return rows;
}

function readDatabase() {
  const raw = getLocalStorage().getItem(DATABASE_KEY);
  const database = raw ? JSON.parse(raw) : {};
  if (!database || typeof database !== 'object' || Array.isArray(database)) {
    throw new Error('Stored local database is not a valid object.');
  }

  TABLE_NAMES.forEach(table => {
    if (database[table] === undefined) {
      database[table] = readLegacyTable(table);
    }
    if (!Array.isArray(database[table])) {
      throw new Error(`Stored ${table} data is not a valid list.`);
    }
  });
  return database;
}

function writeDatabase(database) {
  TABLE_NAMES.forEach(table => {
    if (!Array.isArray(database[table])) {
      throw new Error(`Cannot save invalid ${table} data.`);
    }
  });
  getLocalStorage().setItem(DATABASE_KEY, JSON.stringify(database));
}

function readTable(table) {
  if (!TABLE_NAMES.has(table)) {
    throw new Error(`Unknown local data table: ${table}`);
  }
  return readDatabase()[table];
}

function writeTable(table, rows) {
  const database = readDatabase();
  database[table] = rows;
  writeDatabase(database);
}

function getUniqueKey(table, row) {
  if (table === 'invoices' && row.invoice_no) {
    return `invoice:${String(row.invoice_no).trim().toLowerCase()}`;
  }
  if (table === 'purchase_orders' && row.po_no) {
    const partyId = row.client_id ?? row.supplier_id ?? '';
    return `purchase-order:${row.party_type || 'customer'}:${partyId}:${String(row.po_no).trim().toLowerCase()}`;
  }
  if (table === 'quotations' && row.quotation_no) {
    return `quotation:${String(row.quotation_no).trim().toLowerCase()}`;
  }
  return null;
}

function findDuplicateUniqueKey(table, rows) {
  const seen = new Set();
  for (const row of rows) {
    const key = getUniqueKey(table, row);
    if (!key) continue;
    if (seen.has(key)) return row;
    seen.add(key);
  }
  return null;
}

function splitExpressions(expression) {
  const result = [];
  let current = '';
  let depth = 0;

  for (const character of String(expression || '*')) {
    if (character === ',' && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = '';
      continue;
    }

    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    current += character;
  }

  if (current.trim()) result.push(current.trim());
  return result;
}

function sameValue(left, right) {
  if (left === null || right === null) return left === right;
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return String(left) === String(right);
}

function projectRow(table, row, expression) {
  const fields = splitExpressions(expression);
  const result = fields.includes('*') ? { ...row } : {};

  fields.forEach(field => {
    const relationMatch = field.match(
      /^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/
    );

    if (relationMatch) {
      const [, relationName, relationFields] = relationMatch;
      if (table === 'invoices' && relationName === 'clients') {
        const clients = readTable('clients');
        const client = clients.find(candidate =>
          row.client_id !== undefined &&
          sameValue(candidate.id, row.client_id)
        ) || clients.find(candidate =>
          candidate.client_name &&
          candidate.client_name === row.client_name
        ) || null;

        result[relationName] = client
          ? projectRow('clients', client, relationFields)
          : null;
      }
      return;
    }

    if (field !== '*') {
      result[field] = row[field];
    }
  });

  return result;
}

function normalizeInsertedRow(table, source, existingRows) {
  const row = { ...source };
  const now = new Date().toISOString();

  if (row.id === undefined || row.id === null) {
    const numericIds = existingRows
      .map(existing => Number(existing.id))
      .filter(Number.isFinite);
    row.id = numericIds.length
      ? Math.max(...numericIds) + 1
      : 1;
  }

  if (table !== 'business_settings') {
    row.created_at = row.created_at || now;
    row.updated_at = row.updated_at || now;
  }

  if (table === 'invoices') {
    if (row.invoiceNo && !row.invoice_no) {
      row.invoice_no = row.invoiceNo;
    }
    if (row.clientName && !row.client_name) {
      row.client_name = row.clientName;
    }
  }

  return row;
}

class LocalQuery {
  constructor(table) {
    if (!TABLE_NAMES.has(table)) {
      throw new Error(`Unknown local data table: ${table}`);
    }

    this.table = table;
    this.operation = 'select';
    this.values = null;
    this.columns = '*';
    this.filters = [];
    this.orders = [];
    this.start = null;
    this.end = null;
    this.rowLimit = null;
    this.singleResult = false;
    this.allowNoResult = false;
    this.countRequested = false;
    this.headOnly = false;
    this.promise = null;
  }

  select(columns = '*', options = {}) {
    this.columns = columns;
    this.countRequested = options.count === 'exact';
    this.headOnly = options.head === true;
    return this;
  }

  insert(values) {
    this.operation = 'insert';
    this.values = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values) {
    this.operation = 'update';
    this.values = values || {};
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  eq(column, value) {
    this.filters.push(row => sameValue(row[column], value));
    return this;
  }

  neq(column, value) {
    this.filters.push(row => !sameValue(row[column], value));
    return this;
  }

  in(column, values) {
    this.filters.push(row =>
      Array.isArray(values) &&
      values.some(value => sameValue(row[column], value))
    );
    return this;
  }

  order(column, options = {}) {
    this.orders.push({
      column,
      ascending: options.ascending !== false,
    });
    return this;
  }

  range(start, end) {
    this.start = start;
    this.end = end;
    return this;
  }

  limit(count) {
    this.rowLimit = count;
    return this;
  }

  single() {
    this.singleResult = true;
    return this;
  }

  maybeSingle() {
    this.singleResult = true;
    this.allowNoResult = true;
    return this;
  }

  async execute() {
    try {
      const allRows = readTable(this.table);

      if (this.operation === 'insert') {
        const additions = this.values.map(value =>
          normalizeInsertedRow(this.table, value, allRows)
        );

        const duplicate = findDuplicateUniqueKey(
          this.table,
          [...allRows, ...additions]
        );
        if (duplicate) {
          const label = this.table === 'invoices'
            ? 'Invoice number'
            : this.table === 'purchase_orders'
              ? 'Purchase order number'
              : 'Quotation number';
          const value = duplicate.invoice_no || duplicate.po_no || duplicate.quotation_no;
          return {
            data: null,
            error: {
              code: '23505',
              message: `${label} already exists: ${value}`,
            },
          };
        }

        writeTable(this.table, [...allRows, ...additions]);
        return { data: additions, error: null };
      }

      const matches = row =>
        this.filters.every(filter => filter(row));

      if (this.operation === 'update') {
        let changed = false;
        const updatedRows = allRows.map(row => {
          if (!matches(row)) return row;
          changed = true;
          return {
            ...row,
            ...this.values,
            updated_at: new Date().toISOString(),
          };
        });

        const duplicate = findDuplicateUniqueKey(this.table, updatedRows);
        if (duplicate) {
          const value = duplicate.invoice_no || duplicate.po_no || duplicate.quotation_no;
          return {
            data: null,
            error: {
              code: '23505',
              message: `A duplicate record number already exists: ${value}`,
            },
          };
        }

        if (changed) writeTable(this.table, updatedRows);
        return { data: null, error: null };
      }

      if (this.operation === 'delete') {
        const remainingRows = allRows.filter(row => !matches(row));
        if (remainingRows.length !== allRows.length) {
          writeTable(this.table, remainingRows);
        }
        return { data: null, error: null };
      }

      let rows = allRows.filter(matches);
      const count = rows.length;

      this.orders.slice().reverse().forEach(order => {
        rows.sort((left, right) => {
          const leftValue = left[order.column];
          const rightValue = right[order.column];
          let comparison = 0;

          if (leftValue === rightValue) return 0;
          if (leftValue === undefined || leftValue === null) comparison = -1;
          else if (rightValue === undefined || rightValue === null) comparison = 1;
          else if (
            typeof leftValue === 'number' &&
            typeof rightValue === 'number'
          ) {
            comparison = leftValue - rightValue;
          } else {
            comparison = String(leftValue).localeCompare(String(rightValue));
          }

          return order.ascending ? comparison : -comparison;
        });
      });

      if (this.start !== null || this.end !== null) {
        const start = Math.max(0, this.start || 0);
        const end = this.end === null
          ? undefined
          : Math.max(start, this.end + 1);
        rows = rows.slice(start, end);
      } else if (this.rowLimit !== null) {
        rows = rows.slice(0, Math.max(0, this.rowLimit));
      }

      if (this.headOnly) {
        return {
          data: null,
          count: this.countRequested ? count : null,
          error: null,
        };
      }

      const projectedRows = rows.map(row =>
        projectRow(this.table, row, this.columns)
      );

      if (this.singleResult) {
        if (projectedRows.length === 1) {
          return {
            data: projectedRows[0],
            count: this.countRequested ? count : null,
            error: null,
          };
        }

        if (projectedRows.length === 0 && this.allowNoResult) {
          return {
            data: null,
            count: this.countRequested ? count : null,
            error: null,
          };
        }

        return {
          data: null,
          count: this.countRequested ? count : null,
          error: {
            code: 'PGRST116',
            message: `Expected one row from ${this.table}, received ${projectedRows.length}.`,
          },
        };
      }

      return {
        data: projectedRows,
        count: this.countRequested ? count : null,
        error: null,
      };
    } catch (error) {
      return {
        data: null,
        error: {
          code: 'LOCAL_STORAGE_ERROR',
          message: error.message,
        },
      };
    }
  }

  then(resolve, reject) {
    if (!this.promise) this.promise = this.execute();
    return this.promise.then(resolve, reject);
  }
}

function openFileDatabase() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('Local browser file storage is unavailable.')
    );
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FILE_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FILE_STORE_NAME)) {
        database.createObjectStore(FILE_STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error || new Error('Could not open local file storage.')
    );
  });
}

async function withFileStore(mode, action) {
  const database = await openFileDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(FILE_STORE_NAME, mode);
    const store = transaction.objectStore(FILE_STORE_NAME);
    let result;

    try {
      result = action(store);
    } catch (error) {
      database.close();
      reject(error);
      return;
    }

    transaction.oncomplete = () => {
      database.close();
      resolve(result?.result);
    };
    transaction.onerror = () => {
      database.close();
      reject(
        transaction.error ||
        new Error('Local file storage operation failed.')
      );
    };
    transaction.onabort = () => {
      database.close();
      reject(
        transaction.error ||
        new Error('Local file storage operation was cancelled.')
      );
    };
  });
}

export const localData = {
  from(table) {
    return new LocalQuery(table);
  },

  async atomic(mutator) {
    const update = () => {
      try {
        if (typeof mutator !== 'function') {
          throw new Error('An atomic update function is required.');
        }
        const database = readDatabase();
        const staged = JSON.parse(JSON.stringify(database));
        const result = mutator(staged);
        if (result && typeof result.then === 'function') {
          throw new Error('Local atomic updates must be synchronous.');
        }
        TABLE_NAMES.forEach(table => {
          if (!Array.isArray(staged[table])) {
            throw new Error(`Atomic update produced invalid ${table} data.`);
          }
        });
        writeDatabase(staged);
        return { data: result, error: null };
      } catch (error) {
        return {
          data: null,
          error: {
            code: 'LOCAL_STORAGE_ERROR',
            message: error.message,
          },
        };
      }
    };

    try {
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('icanbill-local-database-write', update);
      }
      return update();
    } catch (error) {
      return {
        data: null,
        error: {
          code: 'LOCAL_STORAGE_ERROR',
          message: error.message,
        },
      };
    }
  },

  storage: {
    from(bucket) {
      const fileKey = path => `${bucket}:${path}`;

      return {
        async upload(path, blob, options = {}) {
          try {
            const key = fileKey(path);
            const existing = await withFileStore('readonly', store =>
              store.get(key)
            );
            if (existing && !options.upsert) {
              return {
                data: null,
                error: { message: 'A file already exists at this path.' },
              };
            }

            await withFileStore('readwrite', store =>
              store.put({
                key,
                blob,
                contentType: options.contentType || blob.type,
              })
            );
            return { data: { path }, error: null };
          } catch (error) {
            return { data: null, error: { message: error.message } };
          }
        },

        async download(path) {
          try {
            const file = await withFileStore('readonly', store =>
              store.get(fileKey(path))
            );
            if (!file?.blob) {
              return {
                data: null,
                error: { message: 'The locally saved file was not found.' },
              };
            }
            return { data: file.blob, error: null };
          } catch (error) {
            return { data: null, error: { message: error.message } };
          }
        },

        async remove(paths) {
          try {
            await withFileStore('readwrite', store => {
              paths.forEach(path => store.delete(fileKey(path)));
            });
            return { data: paths, error: null };
          } catch (error) {
            return { data: null, error: { message: error.message } };
          }
        },

        getPublicUrl(path) {
          return {
            data: { publicUrl: `local://${fileKey(path)}` },
          };
        },
      };
    },
  },
};
