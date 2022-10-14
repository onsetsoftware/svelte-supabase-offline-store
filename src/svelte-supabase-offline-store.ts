import {
  derived,
  get,
  type Readable,
  type Subscriber,
  type Unsubscriber,
  type Writable,
} from "svelte/store";

import { nanoid } from "nanoid";
import type { PostgrestResponse, SupabaseClient } from "@supabase/supabase-js";
import { localStorageStore } from "@onsetsoftware/svelte-local-storage-store";

const stores: Record<string, OfflineStore<any>> = {};

type Insert<T extends { id: string | number }> = {
  id: number | string;
  type: "Insert";
  data: T;
}

type Update<T extends { id: string | number }> = {
  id: number | string;
  type: "Update";
  data: Partial<T> & Pick<T, "id">;
}

type Delete = {
  id: number | string;
  type: "Delete";
}

type Change<T extends { id: string | number }> = Insert<T> | Update<T> | Delete;

type Changes<T extends { id: string | number }> = Record<
    string | number,
    Change<T>
    >;

export type OfflineStoreOptions = {
  newId?: () => string | number;
}

export class OfflineStore<T extends { id: string | number }> {
  protected store: Readable<T[]>;
  protected data: Writable<T[]>;
  protected changes: Writable<Changes<T>>;
  protected onlineUnsubscriber: Unsubscriber | null = null;

  protected options: OfflineStoreOptions = {
    newId: () => nanoid(),
  }
  
  constructor(
      protected readonly table: string,
      protected supabase: SupabaseClient,
      protected shouldPush: Readable<boolean>,
      options: OfflineStoreOptions = {}
  ) {
    this.options = { ...this.options, ...options };
    
    this.changes = localStorageStore<Changes<T>>("changes/" + table, {});

    this.data = localStorageStore<T[]>(
        "data/" + table,
        [],
        (set: Subscriber<T[]>) => {
          this.loadData().then(this.updateStores(set));

          const subscription = (this.supabase
              .channel("public:" + this.table))
              .on('postgres_changes', { event: '*', schema: '*' }, async () => {
                this.updateStores(set)(await this.loadData());
              })
              .subscribe();

          return () => {
            subscription.unsubscribe();
          };
        }
    );

    this.store = derived([this.data, this.changes], ([$data, $changes]) => {
      if (Object.keys($changes).length > 0) {
        const existingKeys: (number | string)[] = [];

        $data = $data
            .map((item) => {
              existingKeys.push(item.id);
              const change = $changes[item.id];
              if (change) {
                if (change.type === "Delete") {
                  return null;
                }
                if (change.type === "Update") {
                  return { ...item, ...change.data };
                }
              }
              return item;
            })
            .filter((item): item is T => !!item);

        const inserts = Object.values($changes)
            .filter(
                (change): change is Insert<T> =>
                    !existingKeys.includes(change.id) && change.type === "Insert"
            );
        
        $data = [
          ...$data,
          ...inserts
              .map((change: Insert<T>) => change.data),
        ];
      }

      return $data;
    });
  }

  protected initOnlineSync() {
    if (this.onlineUnsubscriber) {
      return;
    }
    this.onlineUnsubscriber = derived(
        [this.shouldPush, this.changes],
        (x) => x
    ).subscribe(([$online, $changes]) => {
      if ($online) {
        Object.values($changes).forEach((change) => {
          if (change.type === "Insert") {
            this.sendInsertItem(change.data as T);
          }
          if (change.type === "Delete") {
            this.sendDeleteItem(change.id);
          }
          if (change.type === "Update") {
            this.sendUpdateItem(change.data);
          }
        });
      }
    });
  }

  subscribe(callback: (value: T[]) => void) {
    this.initOnlineSync();
    const unsubscribe = this.store.subscribe(callback);

    return () => {
      unsubscribe();
      if (this.onlineUnsubscriber) {
        this.onlineUnsubscriber();
        this.onlineUnsubscriber = null;
      }
    };
  }

  private updateStores(dataSetter: Subscriber<T[]>) {
    return ({ data, error }: PostgrestResponse<T>) => {
      if (error) {
        console.error(error);
        return;
      }
      this.data.set(data);
      dataSetter(data);

      this.changes.update((changes) => {
        const existingKeys: (number | string)[] = [];
        data.forEach((item) => {
          existingKeys.push(item.id);
          const change = changes[item.id];
          if (change) {
            if (change.type === "Update") {
              const updated = { ...item, ...change.data };
              if (JSON.stringify(updated) === JSON.stringify(item)) {
                delete changes[item.id];
              }
            }
            if (change.type === "Insert") {
              delete changes[item.id];
            }
          }
        });

        Object.values(changes).forEach((change) => {
          if (!existingKeys.includes(change.id) && change.type !== "Insert") {
            delete changes[change.id];
          }
        });
        return changes;
      });
    };
  }

  private async loadData() {
    return this.supabase.from(this.table).select("*");
  }
  
  public addItem = (item: T, replaceId = true) => {
    if (replaceId) {
      item.id = this.options.newId!();
    }

    this.changes.update((changes) => {
      changes[item.id] = {
        id: item.id,
        type: "Insert",
        data: item,
      };
      return changes;
    });
  };

  public updateItem = (item: Partial<T> & Pick<T, "id">) => {
    this.changes.update((changes) => {
      const change = changes[item.id];
      if (change) {
        if (change.type === "Insert" || change.type === "Update") {
          changes[item.id] = {
            ...changes[item.id],
            data: { ...change.data, ...item },
          };
        }
      } else {
        changes[item.id] = {
          id: item.id,
          type: "Update",
          data: item,
        };
      }
      return changes;
    });
  };

  public deleteItem = (id: string | number) => {
    this.changes.update((changes) => {
      const change = changes[id];
      if (change && change.type === "Insert") {
        delete changes[id];
      } else {
        changes[id] = {
          id,
          type: "Delete",
        };
      }

      return changes;
    });
  };

  private sendInsertItem(item: T) {
    this.supabase
        .from(this.table)
        .insert([item])
        .then(({error }) => {
          if (error) {
            console.error(error);
            return;
          }
        });
  }

  private sendDeleteItem(id: string | number) {
    this.supabase
        .from(this.table)
        .delete()
        .match({ id })
        .then(({error }) => {
          if (error) {
            console.error(error);
            return;
          }
        });
  }

  private sendUpdateItem(item: Partial<T> & Pick<T, "id">) {
    this.supabase
        .from(this.table)
        .update(item)
        .match({ id: item.id })
        .then(({error }) => {
          if (error) {
            console.error(error);
            return;
          }
        });
  }

  get(): T[] {
    return get(this.store);
  }
}

export const offlineStore = <T extends { id: string | number }>(
    table: string,
    supabase: SupabaseClient,
    shouldPush: Readable<boolean>
): OfflineStore<T> & Readable<T[]> => {
  return (
      stores[table] ||
      (stores[table] = new OfflineStore<T>(table, supabase, shouldPush))
  );
};
