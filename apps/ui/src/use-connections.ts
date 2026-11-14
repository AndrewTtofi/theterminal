import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** The last attempt to read the list failed; `refresh()` retries. */
  loadError: boolean;
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
  const [loadError, setLoadError] = useState(false);
  // Every refresh and every completed write takes a new number; a list response is applied only if its
  // request is still the latest, so an older read never overwrites a newer write or read.
  const seq = useRef(0);
  const loadedRef = useRef(false);
  const latestRead = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++seq.current;
    latestRead.current = mine;
    void api.listConnections().then(
      (l) => {
        if (mine !== seq.current) {
          // Superseded. A newer read will answer; if only a write came after this read and nothing was
          // ever loaded, read again so the list still becomes known.
          if (mine === latestRead.current && !loadedRef.current) refresh();
          return;
        }
        loadedRef.current = true;
        setList(l);
        setLoaded(true);
        setLoadError(false);
      },
      () => {
        if (mine === latestRead.current) setLoadError(true);
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    void api.getConnectionCatalog().then(setCatalog, () => {});
  }, [refresh]);

  return useMemo(() => {
    const upsert = (c: Connection) => {
      seq.current++;
      setList((prev) => (prev.some((p) => p.id === c.id) ? prev.map((p) => (p.id === c.id ? c : p)) : [...prev, c]));
    };
    return {
      catalog,
      list,
      loaded,
      loadError,
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
        seq.current++;
        setList((prev) => prev.filter((p) => p.id !== id));
      },
      test: async (id) => {
        const r = await api.testConnection(id);
        const status = { state: r.ok ? "ok" : "failed", message: r.message, testedAt: new Date().toISOString() } as const;
        seq.current++;
        setList((prev) => prev.map((p) => (p.id === id ? { ...p, status } : p)));
        return r;
      },
    };
  }, [catalog, list, loaded, loadError, refresh]);
}
