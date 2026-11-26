import { supabase } from './supabaseClient';

const TABLE_NAMES = [
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
];
const LEGACY_TABLE_PREFIX = 'billing_mvp_local_v1:';
const LEGACY_DATABASE_KEY = 'billing_mvp_local_v2:database';
const LEGACY_ORDER_KEY = 'billing_mvp_client_orders';
const LEGACY_FILE_DATABASE = 'billing-mvp-local-files';
const LEGACY_FILE_STORE = 'objects';
const DEVICE_KEY = 'icanbill_registered_device_v1';
const TAB_KEY = 'icanbill_active_tab_v1';

function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('Secure browser identifiers are unavailable in this browser.');
}

function getStoredId(storage, key) {
  if (typeof storage === 'undefined') {
    throw new Error('Browser storage is unavailable.');
  }
  let value = storage.getItem(key);
  if (!value) {
    value = createId();
    storage.setItem(key, value);
  }
  return value;
}

export function getDeviceSessionIds() {
  return {
    deviceId: getStoredId(globalThis.localStorage, DEVICE_KEY),
    tabId: getStoredId(globalThis.sessionStorage, TAB_KEY),
  };
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

function sameValue(left, right) {
  if (left === null || right === null) return left === right;
  return String(left) === String(right);
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

function projectRow(table, row, expression, tables) {
  const fields = splitExpressions(expression);
  const result = fields.includes('*') ? { ...row } : {};
  fields.forEach(field => {
    const relationMatch = field.match(/^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
    if (relationMatch) {
      const [, relationName, relationFields] = relationMatch;
      if (table === 'invoices' && relationName === 'clients') {
        const client = tables.clients.find(candidate =>
          (row.client_id !== undefined && sameValue(candidate.id, row.client_id)) ||
          (candidate.client_name && candidate.client_name === row.client_name)
        );
        result[relationName] = client
          ? projectRow('clients', client, relationFields, tables)
          : null;
      }
      return;
    }
    if (field !== '*') result[field] = row[field];
  });
  return result;
}

function normalizeInsertedRow(table, source, existingRows) {
  const row = { ...source };
  const now = new Date().toISOString();
  if (row.id === undefined || row.id === null) {
    const maximum = existingRows.reduce((value, existing) => {
      const id = Number(existing.id);
      return Number.isFinite(id) ? Math.max(value, id) : value;
    }, 0);
    row.id = maximum + 1;
  }
  if (table !== 'business_settings') {
    row.created_at = row.created_at || now;
    row.updated_at = row.updated_at || now;
  }
  if (table === 'invoices') {
    if (row.invoiceNo && !row.invoice_no) row.invoice_no = row.invoiceNo;
    if (row.clientName && !row.client_name) row.client_name = row.clientName;
  }
  return row;
}

async function getWorkspaceSnapshot() {
  const { deviceId, tabId } = getDeviceSessionIds();
  const { data, error } = await supabase.rpc('get_workspace_snapshot', {
    p_device_id: deviceId,
    p_tab_id: tabId,
  });
  if (error) throw new Error(error.message);
  if (!data || !data.tables || typeof data.tables !== 'object') {
    throw new Error('The server returned an invalid workspace snapshot.');
  }
  TABLE_NAMES.forEach(table => {
    if (!Array.isArray(data.tables[table])) {
      throw new Error(`The server returned invalid ${table} workspace data.`);
    }
  });
  return data;
}

async function saveWorkspaceSnapshot(snapshot, expectedRevision) {
  const { deviceId, tabId } = getDeviceSessionIds();
  const { data, error } = await supabase.rpc('save_workspace_snapshot', {
    p_snapshot: { tables: snapshot },
    p_expected_revision: expectedRevision,
    p_device_id: deviceId,
    p_tab_id: tabId,
  });
  if (error) throw new Error(error.message);
  return data;
}

function readLegacyWorkspace() {
  const rawDatabase = localStorage.getItem(LEGACY_DATABASE_KEY);
  const database = rawDatabase ? JSON.parse(rawDatabase) : {};
  if (!database || typeof database !== 'object' || Array.isArray(database)) {
    throw new Error('The previous browser workspace is not valid JSON data.');
  }
  const tables = {};
  TABLE_NAMES.forEach(table => {
    const rawRows = database[table] === undefined
      ? localStorage.getItem(`${LEGACY_TABLE_PREFIX}${table}`)
      : null;
    const rows = database[table] === undefined
      ? (rawRows ? JSON.parse(rawRows) : [])
      : database[table];
    if (!Array.isArray(rows)) {
      throw new Error(`The previous ${table} data is not a valid list.`);
    }
    tables[table] = rows;
  });
  return tables;
}

async function readLegacyFiles() {
  if (typeof indexedDB === 'undefined') return [];
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_FILE_DATABASE, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error || new Error('Could not open previous browser file storage.')
    );
  });
  if (!database.objectStoreNames.contains(LEGACY_FILE_STORE)) {
    database.close();
    return [];
  }
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(LEGACY_FILE_STORE, 'readonly');
    const request = transaction.objectStore(LEGACY_FILE_STORE).getAll();
    request.onsuccess = () => {
      database.close();
      resolve(request.result || []);
    };
    request.onerror = () => {
      database.close();
      reject(request.error || new Error('Could not read previous saved files.'));
    };
  });
}

async function migrateLegacyData(userId) {
  try {
    if (!userId) throw new Error('The signed-in account could not be identified.');
    const marker = `icanbill_cloud_data_migrated:${userId}`;
    if (localStorage.getItem(marker) === 'complete') return { warning: '' };
    const dataWasImported = localStorage.getItem(marker) === 'data-imported';

    const legacyTables = readLegacyWorkspace();
    legacyTables.invoices = legacyTables.invoices.map(invoice => ({
      ...invoice,
      invoice_no: invoice.invoice_no || invoice.invoiceNo,
      client_name: invoice.client_name || invoice.clientName,
    }));
    const rawOrders = localStorage.getItem(LEGACY_ORDER_KEY);
    if (rawOrders) {
      const oldOrders = JSON.parse(rawOrders);
      if (!Array.isArray(oldOrders)) {
        throw new Error('The previous client requirements are not a valid list.');
      }
      let nextOrderId = legacyTables.orders.reduce((maximum, row) =>
        Number.isFinite(Number(row.id)) ? Math.max(maximum, Number(row.id)) : maximum
      , 0) + 1;
      const migratedOrders = oldOrders.map(order => ({
        ...order,
        id: nextOrderId++,
        created_at: order.created_at || order.createdAt || new Date().toISOString(),
        updated_at: order.updated_at || new Date().toISOString(),
      }));
      legacyTables.orders.push(...migratedOrders);
    }
    const hasLegacyRows = TABLE_NAMES.some(table =>
      table !== 'business_settings' && legacyTables[table].length > 0
    ) || legacyTables.business_settings.length > 0;
    const snapshot = await getWorkspaceSnapshot();
    const hasCloudRows = TABLE_NAMES.some(table => snapshot.tables[table].length > 0);

    if (hasLegacyRows && !hasCloudRows && !dataWasImported) {
      await saveWorkspaceSnapshot(legacyTables, snapshot.revision);
      localStorage.setItem(marker, 'data-imported');
    } else if (hasLegacyRows && hasCloudRows && !dataWasImported) {
      return {
        warning: 'Older records remain in this browser. They were not merged because this account already has cloud data.',
      };
    }

    const fileRows = await readLegacyFiles();
    const referencedFiles = new Set([
      ...legacyTables.documents.map(row => `documents:${row.storage_path}`),
      ...legacyTables.invoices.map(row => `invoice-pdfs:${row.pdf_storage_path}`),
      ...(dataWasImported || !hasLegacyRows
        ? snapshot.tables.documents.map(row => `documents:${row.storage_path}`)
        : []),
      ...(dataWasImported || !hasLegacyRows
        ? snapshot.tables.invoices.map(row => `invoice-pdfs:${row.pdf_storage_path}`)
        : []),
    ].filter(value => !value.endsWith(':undefined') && !value.endsWith(':')));
    const { data: organizationId, error: organizationError } = await supabase.rpc(
      'ensure_current_organization'
    );
    if (organizationError) throw new Error(organizationError.message);

    const migratedFileKeys = [];
    for (const file of fileRows) {
      const separator = String(file.key || '').indexOf(':');
      if (separator < 0) continue;
      const bucket = file.key.slice(0, separator);
      const path = file.key.slice(separator + 1);
      if (!referencedFiles.has(`${bucket}:${path}`)) continue;
      if (!['documents', 'invoice-pdfs'].includes(bucket)) continue;
      const { error } = await supabase.storage.from(bucket).upload(
        `${organizationId}/${path}`,
        file.blob,
        { contentType: file.contentType || file.blob?.type, upsert: true }
      );
      if (error) throw new Error(`Could not move a saved file to cloud storage: ${error.message}`);
      migratedFileKeys.push(file.key);
    }

    if (hasLegacyRows && (dataWasImported || !hasCloudRows)) {
      localStorage.removeItem(LEGACY_DATABASE_KEY);
      localStorage.removeItem(LEGACY_ORDER_KEY);
      TABLE_NAMES.forEach(table => localStorage.removeItem(`${LEGACY_TABLE_PREFIX}${table}`));
    }
    if (migratedFileKeys.length) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(LEGACY_FILE_DATABASE, 1);
        request.onerror = () => reject(
          request.error || new Error('Could not open previous browser file storage.')
        );
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(LEGACY_FILE_STORE)) {
            database.close();
            resolve();
            return;
          }
          const transaction = database.transaction(LEGACY_FILE_STORE, 'readwrite');
          const store = transaction.objectStore(LEGACY_FILE_STORE);
          migratedFileKeys.forEach(key => store.delete(key));
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => {
            database.close();
            reject(transaction.error || new Error('Could not remove migrated local files.'));
          };
        };
      });
    }

    localStorage.setItem(marker, 'complete');
    return {
      warning: hasLegacyRows && hasCloudRows && !dataWasImported
        ? 'Older records remain in this browser. They were not merged because this account already has cloud data.'
        : '',
    };
  } catch (error) {
    return {
      warning: `Some earlier browser data could not be moved to the cloud: ${error.message}`,
    };
  }
}

class WorkspaceQuery {
  constructor(table) {
    if (!TABLE_NAMES.includes(table)) {
      throw new Error(`Unknown workspace data table: ${table}`);
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
      Array.isArray(values) && values.some(value => sameValue(row[column], value))
    );
    return this;
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
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
      const snapshot = await getWorkspaceSnapshot();
      const tables = snapshot.tables;
      const allRows = tables[this.table];
      const matches = row => this.filters.every(filter => filter(row));

      if (this.operation === 'insert') {
        const additions = this.values.map(value =>
          normalizeInsertedRow(this.table, value, allRows)
        );
        const duplicate = findDuplicateUniqueKey(this.table, [...allRows, ...additions]);
        if (duplicate) {
          const label = this.table === 'invoices'
            ? 'Invoice number'
            : this.table === 'purchase_orders'
              ? 'Purchase order number'
              : 'Quotation number';
          const value = duplicate.invoice_no || duplicate.po_no || duplicate.quotation_no;
          return {
            data: null,
            error: { code: '23505', message: `${label} already exists: ${value}` },
          };
        }
        tables[this.table].push(...additions);
        await saveWorkspaceSnapshot(tables, snapshot.revision);
        return { data: additions.map(row => projectRow(this.table, row, this.columns, tables)), error: null };
      }

      if (this.operation === 'update') {
        let changed = false;
        const updateValues = { ...this.values };
        if (this.table === 'invoices') {
          if (updateValues.invoiceNo && !updateValues.invoice_no) {
            updateValues.invoice_no = updateValues.invoiceNo;
          }
          if (updateValues.clientName && !updateValues.client_name) {
            updateValues.client_name = updateValues.clientName;
          }
        }
        const updatedRows = allRows.map(row => {
          if (!matches(row)) return row;
          changed = true;
          return { ...row, ...updateValues, updated_at: new Date().toISOString() };
        });
        const duplicate = findDuplicateUniqueKey(this.table, updatedRows);
        if (duplicate) {
          return {
            data: null,
            error: { code: '23505', message: 'A duplicate record number already exists.' },
          };
        }
        if (changed) {
          tables[this.table] = updatedRows;
          await saveWorkspaceSnapshot(tables, snapshot.revision);
        }
        return { data: null, error: null };
      }

      if (this.operation === 'delete') {
        const remainingRows = allRows.filter(row => !matches(row));
        if (remainingRows.length !== allRows.length) {
          tables[this.table] = remainingRows;
          await saveWorkspaceSnapshot(tables, snapshot.revision);
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
          else if (typeof leftValue === 'number' && typeof rightValue === 'number') {
            comparison = leftValue - rightValue;
          } else {
            comparison = String(leftValue).localeCompare(String(rightValue));
          }
          return order.ascending ? comparison : -comparison;
        });
      });

      if (this.start !== null || this.end !== null) {
        const start = Math.max(0, this.start || 0);
        const end = this.end === null ? undefined : Math.max(start, this.end + 1);
        rows = rows.slice(start, end);
      } else if (this.rowLimit !== null) {
        rows = rows.slice(0, Math.max(0, this.rowLimit));
      }

      if (this.headOnly) {
        return { data: null, count: this.countRequested ? count : null, error: null };
      }

      const projectedRows = rows.map(row => projectRow(this.table, row, this.columns, tables));
      if (this.singleResult) {
        if (projectedRows.length === 1) {
          return { data: projectedRows[0], count: this.countRequested ? count : null, error: null };
        }
        if (!projectedRows.length && this.allowNoResult) {
          return { data: null, count: this.countRequested ? count : null, error: null };
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
      return { data: projectedRows, count: this.countRequested ? count : null, error: null };
    } catch (error) {
      return {
        data: null,
        error: { code: 'WORKSPACE_ERROR', message: error.message },
      };
    }
  }

  then(resolve, reject) {
    if (!this.promise) this.promise = this.execute();
    return this.promise.then(resolve, reject);
  }
}

function getStoragePrefix(bucket, path) {
  return supabase.rpc('ensure_current_organization').then(({ data, error }) => {
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Could not determine the active workspace.');
    return `${data}/${String(path).replace(/^\/+/, '')}`;
  }).then(storagePath => ({ bucket, storagePath }));
}

export const localData = {
  migrateLegacyData,

  from(table) {
    return new WorkspaceQuery(table);
  },

  async atomic(mutator) {
    try {
      if (typeof mutator !== 'function') {
        throw new Error('An atomic update function is required.');
      }
      const snapshot = await getWorkspaceSnapshot();
      const staged = JSON.parse(JSON.stringify(snapshot.tables));
      const result = mutator(staged);
      if (result && typeof result.then === 'function') {
        throw new Error('Workspace atomic updates must be synchronous.');
      }
      TABLE_NAMES.forEach(table => {
        if (!Array.isArray(staged[table])) {
          throw new Error(`Atomic update produced invalid ${table} data.`);
        }
      });
      await saveWorkspaceSnapshot(staged, snapshot.revision);
      return { data: result, error: null };
    } catch (error) {
      return {
        data: null,
        error: { code: 'WORKSPACE_ERROR', message: error.message },
      };
    }
  },

  storage: {
    from(bucket) {
      return {
        async upload(path, file, options = {}) {
          try {
            const { storagePath } = await getStoragePrefix(bucket, path);
            return await supabase.storage.from(bucket).upload(storagePath, file, {
              contentType: options.contentType || file.type,
              upsert: options.upsert === true,
            });
          } catch (error) {
            return { data: null, error: { message: error.message } };
          }
        },

        async download(path) {
          try {
            const { storagePath } = await getStoragePrefix(bucket, path);
            return await supabase.storage.from(bucket).download(storagePath);
          } catch (error) {
            return { data: null, error: { message: error.message } };
          }
        },

        async remove(paths) {
          try {
            const prefixedPaths = await Promise.all(paths.map(async path => {
              const { storagePath } = await getStoragePrefix(bucket, path);
              return storagePath;
            }));
            return await supabase.storage.from(bucket).remove(prefixedPaths);
          } catch (error) {
            return { data: null, error: { message: error.message } };
          }
        },

        async createSignedUrl(path, expiresIn = 60) {
          const { storagePath } = await getStoragePrefix(bucket, path);
          return supabase.storage.from(bucket).createSignedUrl(storagePath, expiresIn);
        },

        getPublicUrl(path) {
          const { data } = supabase.storage.from(bucket).getPublicUrl(path);
          return { data };
        },
      };
    },
  },
};
