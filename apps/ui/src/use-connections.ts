import { useCallback, useEffect, useMemo, useState } from "react";
import { CONNECTION_CATALOG } from "@theterminal/shared";
import type { CatalogEntry, Connection } from "@theterminal/shared";
import { api } from "./api";
import type { ConnectionPatch, NewConnection } from "./api";

/** The connections the side bar and the editor tabs share. Writes reject with the server's ApiError. */
export type ConnectionsModel = {
  catalog: CatalogEntry[];
  list: Connection[];
  /** True once the list was read from the server; until then nothing is known to be missing. */
  loaded: boolean;
  refresh(): void;
  add(i: NewConnection): Promise<Connection>;
  update(id: string, patch: ConnectionPatch): Promise<Connection>;
  remove(id: string): Promise<void>;
  test(id: string): Promise<{ ok: boolean; message: string }>;
};

export function useConnections(): ConnectionsModel {
  // The shared catalog is the same code the server serves; it shows the list before the server answers.
  const [catalog, setCatalog] = useState<CatalogEntry[]>(() => [...CONNECTION_CATALOG]);
  const [list, setList] = useState<Connection[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    void api.listConnections().then(
      (l) => {
        setList(l);
        setLoaded(true);
      },
      () => {},
    );
  }, []);

  useEffect(() => {
    refresh();
    void api.getConnectionCatalog().then(setCatalog, () => {});
  }, [refresh]);

  return useMemo(() => {
    const upsert = (c: Connection) =>
      setList((prev) => (prev.some((p) => p.id === c.id) ? prev.map((p) => (p.id === c.id ? c : p)) : [...prev, c]));
    return {
      catalog,
      list,
      loaded,
      refresh,
      add: async (i) => {
        const c = await api.addConnection(i);
        upsert(c);
        return c;
      },
      update: async (id, patch) => {
        const c = await api.updateConnection(id, patch);
        upsert(c);
        return c;
      },
      remove: async (id) => {
        await api.removeConnection(id);
        setList((prev) => prev.filter((p) => p.id !== id));
      },
      test: async (id) => {
        const r = await api.testConnection(id);
        const status = { state: r.ok ? "ok" : "failed", message: r.message, testedAt: new Date().toISOString() } as const;
        setList((prev) => prev.map((p) => (p.id === id ? { ...p, status } : p)));
        return r;
      },
    };
  }, [catalog, list, loaded, refresh]);
}
