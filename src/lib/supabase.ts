/**
 * Supabase-compatible adapter that routes all calls through a local HTTP server
 * running in the Electron main process.
 */

import { LOCAL_SERVER_AUTH_HEADERS, LOCAL_SERVER_BASE_URL } from "@shared/constants";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function localPost(endpoint: string, body: any = {}, options: { retries?: number } = {}) {
  const retries = options.retries ?? 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${LOCAL_SERVER_BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(150 * (attempt + 1));
    }
  }
}

type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "in";

export type SupabaseResult<T = any> = { data: T; error: { message: string } | null };

interface QueryBuilder<T = any> extends PromiseLike<SupabaseResult<T>> {
  select: (columns?: string) => QueryBuilder<T>;
  insert: (data: any | any[]) => QueryBuilder<T>;
  update: (data: any) => QueryBuilder<T>;
  delete: () => QueryBuilder<T>;
  upsert: (data: any | any[], opts?: { onConflict?: string }) => QueryBuilder<T>;
  eq: (column: string, value: any) => QueryBuilder<T>;
  neq: (column: string, value: any) => QueryBuilder<T>;
  in: (column: string, values: any[]) => QueryBuilder<T>;
  or: (filter: string) => QueryBuilder<T>;
  order: (column: string, opts?: { ascending?: boolean }) => QueryBuilder<T>;
  limit: (count: number) => QueryBuilder<T>;
  single: () => Promise<SupabaseResult<T>>;
  maybeSingle: () => Promise<SupabaseResult<T>>;
  // Promise/A+ thenable: must accept both onFulfilled/onRejected and return a Promise
  // of the mapped value. 이전 시그니처(onResolve 1개만)는 await 시 reject 누락 위험.
  then: <TResult1 = SupabaseResult<T>, TResult2 = never>(
    onFulfilled?:
      | ((value: SupabaseResult<T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
}

function createQueryBuilder(table: string): QueryBuilder {
  let _op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  let _data: any = null;
  const _filters: { column: string; op: FilterOp; value: any }[] = [];
  let _orderBy: string | null = null;
  let _ascending = true;
  let _limit: number | null = null;
  let _single = false;
  let _columns: string | null = null;
  let _conflictKeys: string[] = [];
  let _orFilter: string | null = null;

  let _returnData = false;

  const builder: QueryBuilder = {
    select(columns?: string) {
      if (_op === "insert" || _op === "update" || _op === "upsert") {
        _returnData = true;
      } else {
        _op = "select";
      }
      _columns = columns ?? null;
      return builder;
    },
    insert(data: any) { _op = "insert"; _data = data; return builder; },
    update(data: any) { _op = "update"; _data = data; return builder; },
    delete() { _op = "delete"; return builder; },
    upsert(data: any, opts?: { onConflict?: string }) {
      _op = "upsert"; _data = data;
      if (opts?.onConflict) _conflictKeys = opts.onConflict.split(",").map(s => s.trim());
      return builder;
    },
    eq(column: string, value: any) { _filters.push({ column, op: "eq", value }); return builder; },
    neq(column: string, value: any) { _filters.push({ column, op: "neq", value }); return builder; },
    in(column: string, values: any[]) { _filters.push({ column, op: "in", value: values }); return builder; },
    or(filter: string) { _orFilter = filter; return builder; },
    order(column: string, opts?: { ascending?: boolean }) {
      _orderBy = column; _ascending = opts?.ascending ?? true; return builder;
    },
    limit(count: number) { _limit = count; return builder; },
    single() { _single = true; return execute(); },
    maybeSingle() {
      _single = true;
      return execute().then(result => {
        if (result.error?.message === "No rows found" && result.data === null) return { data: null, error: null };
        return result;
      });
    },
    then(onFulfilled, onRejected) { return execute().then(onFulfilled as any, onRejected as any); },
  };

  async function execute(): Promise<{ data: any; error: any }> {
    try {
      const where: Record<string, any> = {};
      for (const f of _filters) {
        if (f.op === "eq") where[f.column] = f.value;
      }

      switch (_op) {
        case "select": {
          const options: any = {};
          if (_orderBy) { options.orderBy = _orderBy; options.ascending = _ascending; }
          if (_limit) options.limit = _limit;
          let rows = await localPost("/db/select", { table, where, options }, { retries: 2 });

          for (const f of _filters) {
            if (f.op === "in") rows = rows.filter((r: any) => f.value.includes(r[f.column]));
            if (f.op === "neq") rows = rows.filter((r: any) => r[f.column] !== f.value);
          }

          if (_orFilter) {
            const conditions = _orFilter.split(",").map(c => c.trim());
            rows = rows.filter((r: any) => {
              return conditions.some(cond => {
                const parts = cond.split(".");
                if (parts.length >= 3) {
                  const col = parts[0], op = parts[1], val = parts.slice(2).join(".");
                  if (op === "eq") {
                    if (val === "true") return r[col] === true || r[col] === 1;
                    if (val === "false") return r[col] === false || r[col] === 0;
                    return String(r[col]) === val;
                  }
                }
                return false;
              });
            });
          }

          if (_single) {
            if (rows.length === 0) return { data: null, error: { message: "No rows found" } };
            return { data: rows[0], error: null };
          }
          return { data: rows, error: null };
        }
        case "insert": {
          const items = Array.isArray(_data) ? _data : [_data];
          const results = [];
          for (const item of items) {
            const row = await localPost("/db/insert", { table, data: item });
            results.push(row);
          }
          const data = Array.isArray(_data) ? results : results[0];
          if (_single) return { data: Array.isArray(data) ? data[0] : data, error: null };
          return { data, error: null };
        }
        case "update": {
          const rows = await localPost("/db/update", { table, data: _data, where });
          if (_single) return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }
        case "delete": {
          await localPost("/db/delete", { table, where });
          return { data: null, error: null };
        }
        case "upsert": {
          const items = Array.isArray(_data) ? _data : [_data];
          const results = [];
          for (const item of items) {
            const conflict = _conflictKeys.length > 0 ? _conflictKeys : ["id"];
            const row = await localPost("/db/upsert", { table, data: item, conflictKeys: conflict });
            results.push(row);
          }
          return { data: results, error: null };
        }
        default:
          return { data: null, error: { message: `Unknown operation: ${_op}` } };
      }
    } catch (err: any) {
      console.error(`[supabase-adapter] ${_op} ${table} error:`, err);
      return { data: null, error: { message: err.message ?? String(err) } };
    }
  }

  return builder;
}

// Storage adapter
function createStorageBucket(bucket: string) {
  return {
    async upload(filePath: string, data: File | Blob | Uint8Array | ArrayBuffer | Buffer, options?: { contentType?: string; upsert?: boolean }) {
      // 바이너리(octet-stream) 전송 — base64 JSON 은 ~33% 팽창 + 거대한 문자열/
      // JSON.stringify 로 대용량(>~250MB)에서 렌더러 fetch 가 "Failed to fetch"
      // 로 죽는다. Blob 바디는 Chromium 이 스트리밍하므로 메모리/크기에 안전하다.
      const blob =
        data instanceof Blob
          ? data
          : data instanceof ArrayBuffer
            ? new Blob([data])
            : new Blob([new Uint8Array(data as Uint8Array)]);
      const qs = new URLSearchParams({ bucket, path: filePath });
      const res = await fetch(`${LOCAL_SERVER_BASE_URL}/storage/upload-raw?${qs.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...LOCAL_SERVER_AUTH_HEADERS },
        body: blob,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    getPublicUrl(filePath: string) {
      return { data: { publicUrl: `${LOCAL_SERVER_BASE_URL}/storage/file/${bucket}/${filePath}` } };
    },
    async remove(filePaths: string[]) {
      return localPost("/storage/remove", { bucket, filePaths });
    },
    async list(folder: string, options?: { limit?: number; offset?: number }) {
      return localPost("/storage/list", { bucket, folder, options });
    },
  };
}

// Functions adapter — AI APIs still use IPC handlers, proxied through local HTTP
const functionsAdapter = {
  async invoke(functionName: string, options: { body: any }) {
    try {
      const res = await fetch(`${LOCAL_SERVER_BASE_URL}/api/${functionName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...LOCAL_SERVER_AUTH_HEADERS },
        body: JSON.stringify(options.body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        const msg = err.error || `HTTP ${res.status}`;
        console.error(`[functions] ${functionName} HTTP error:`, msg);
        throw new Error(msg);
      }
      const data = await res.json();
      if (data && typeof data === "object" && data.error && !data.publicUrl && !data.content) {
        console.error(`[functions] ${functionName} returned error:`, data.error);
        return { data: null, error: { message: data.error } };
      }
      return { data, error: null };
    } catch (err: any) {
      console.error(`[functions] ${functionName} exception:`, err.message);
      return { data: null, error: { message: err.message ?? String(err) } };
    }
  },
};

// Auth adapter (no-op for local)
const authAdapter = {
  async getSession() {
    return { data: { session: { user: { id: "local" } } } };
  },
  async getUser() {
    return { data: { user: { id: "local", email: "local@preflow.app" } } };
  },
  onAuthStateChange(callback: any) {
    callback("SIGNED_IN", { user: { id: "local" } });
    return { data: { subscription: { unsubscribe: () => {} } } };
  },
  async signOut() { return { error: null }; },
  async signInWithPassword(_creds: any) {
    return { data: { session: { user: { id: "local" } } }, error: null };
  },
};

export const supabase = {
  from: (table: string) => createQueryBuilder(table),
  storage: { from: (bucket: string) => createStorageBucket(bucket) },
  functions: functionsAdapter,
  auth: authAdapter,
};
