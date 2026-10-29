/** Transactions, rather than per-operation tombstones, serialize cross-document recovery. */
const databases = new WeakMap<IDBFactory, Promise<IDBDatabase>>();
const databaseName = 'harness.operation-recovery.v2';

function openDatabase(): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error('浏览器无法提供持久操作恢复数据库，尚未发送新请求。'));
  const existing = databases.get(factory);
  if (existing) return existing;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let abandoned = false;
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('operations', { keyPath: 'id' });
      request.result.createObjectStore('meta');
    };
    request.onerror = () => reject(request.error ?? new Error('无法打开操作恢复数据库。'));
    request.onblocked = () => {
      abandoned = true;
      reject(new Error('操作恢复数据库升级被其他页面阻塞，请关闭旧页面后重新检查。'));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (abandoned) { database.close(); return; }
      database.onversionchange = () => { database.close(); databases.delete(factory); };
      database.onclose = () => databases.delete(factory);
      resolve(database);
    };
  });
  databases.set(factory, opening);
  void opening.catch(() => { if (databases.get(factory) === opening) databases.delete(factory); });
  return opening;
}

export function stored<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('操作恢复数据库请求失败。'));
  });
}

/** The callback may await IDB requests only; completion means the whole transaction committed. */
export async function operationTransaction<T>(
  run: (operations: IDBObjectStore, meta: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(['operations', 'meta'], 'readwrite', { durability: 'strict' });
    let value: T, failure: unknown, finished = false;
    transaction.oncomplete = () => {
      finished = true;
      if (failure) reject(failure); else resolve(value);
    };
    transaction.onabort = () => {
      finished = true;
      reject(failure ?? transaction.error ?? new Error('操作恢复事务未提交，原记录仍保留。'));
    };
    transaction.onerror = () => { /* onabort owns rejection after rollback. */ };
    void run(transaction.objectStore('operations'), transaction.objectStore('meta')).then(
      (result) => { value = result; },
      (error) => {
        failure = error;
        if (!finished) {
          try { transaction.abort(); } catch { reject(error); }
        } else reject(error);
      },
    );
  });
}
